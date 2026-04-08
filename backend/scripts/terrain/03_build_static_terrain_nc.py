from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from netCDF4 import Dataset
from osgeo import gdal, osr  # type: ignore
from scipy.ndimage import uniform_filter


from backend.config.paths import INT_TERRAIN_DIR, INT_FOREST_DIR

try:
    from backend.config.paths import FINAL_STATIC_DIR
except ImportError:
    BACKEND_DIR = Path(__file__).resolve().parents[2]
    FINAL_STATIC_DIR = BACKEND_DIR / "data" / "final" / "static"

from backend.config.domain import BBOX, TARGET_CRS, TARGET_STEP_DEG


gdal.UseExceptions()


DLT_NON_FOREST = 0
DLT_BROADLEAF = 1
DLT_CONIFER = 2
DLT_NODATA = 255

DEM_NODATA = -9999.0
PROJECTED_CRS = "EPSG:3035"


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def build_target_grid(
    bbox: dict[str, float],
    step_deg: float,
) -> tuple[int, int, tuple[float, float, float, float, float, float], np.ndarray, np.ndarray]:
    west = bbox["west"]
    south = bbox["south"]
    east = bbox["east"]
    north = bbox["north"]

    width = int(round((east - west) / step_deg))
    height = int(round((north - south) / step_deg))

    gt = (west, step_deg, 0.0, north, 0.0, -step_deg)

    lons = west + (np.arange(width, dtype=np.float64) + 0.5) * step_deg
    lats_desc = north - (np.arange(height, dtype=np.float64) + 0.5) * step_deg

    return width, height, gt, lons.astype(np.float32), lats_desc.astype(np.float32)


def warp_dem_to_projected_mem(
    dem_path: Path,
    dst_crs: str = PROJECTED_CRS,
    xres: float = 30.0,
    yres: float = 30.0,
) -> gdal.Dataset:
    ds = gdal.Open(str(dem_path))
    if ds is None:
        raise RuntimeError(f"Impossibile aprire DEM: {dem_path}")

    warped = gdal.Warp(
        "",
        ds,
        format="MEM",
        dstSRS=dst_crs,
        xRes=xres,
        yRes=yres,
        resampleAlg="bilinear",
        srcNodata=DEM_NODATA,
        dstNodata=DEM_NODATA,
        multithread=True,
    )
    if warped is None:
        raise RuntimeError("gdal.Warp fallito durante la reproiezione metrica del DEM")
    return warped


def read_raster_array(ds: gdal.Dataset) -> tuple[np.ndarray, tuple[float, float, float, float, float, float], str, float | None]:
    band = ds.GetRasterBand(1)
    arr = band.ReadAsArray().astype(np.float32)
    gt = ds.GetGeoTransform()
    proj = ds.GetProjection()
    nodata = band.GetNoDataValue()
    return arr, gt, proj, nodata


def fill_nan_nearest_rows_cols(arr: np.ndarray) -> np.ndarray:
    """
    Fallback semplice per rimuovere NaN residui prima dei gradienti.
    Assume pochi NaN ai bordi.
    """
    out = arr.copy()
    if not np.isnan(out).any():
        return out

    # fill verticale
    for _ in range(2):
        mask = np.isnan(out)
        if not mask.any():
            break
        up = np.roll(out, 1, axis=0)
        down = np.roll(out, -1, axis=0)
        left = np.roll(out, 1, axis=1)
        right = np.roll(out, -1, axis=1)

        replace = np.where(np.isfinite(up), up,
                  np.where(np.isfinite(down), down,
                  np.where(np.isfinite(left), left,
                  np.where(np.isfinite(right), right, np.nan))))
        out[mask] = replace[mask]

    # eventuali residui
    out = np.where(np.isfinite(out), out, np.nanmean(out))
    return out.astype(np.float32)


def compute_slope_aspect_tpi(
    dem_arr: np.ndarray,
    pixel_size_m: float,
    nodata: float | None,
    tpi_radius_m: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    arr = dem_arr.astype(np.float32)

    if nodata is not None:
        arr = np.where(arr == nodata, np.nan, arr)

    valid = np.isfinite(arr).astype(np.float32)
    arr_filled = fill_nan_nearest_rows_cols(arr)

    # gradienti in metri
    dzdy, dzdx = np.gradient(arr_filled, pixel_size_m, pixel_size_m)

    slope_rad = np.arctan(np.sqrt(dzdx**2 + dzdy**2))
    slope_deg = np.degrees(slope_rad).astype(np.float32)

    aspect_deg = np.degrees(np.arctan2(dzdx, -dzdy))
    aspect_deg = np.where(aspect_deg < 0, aspect_deg + 360.0, aspect_deg).astype(np.float32)

    # TPI = cella - media locale
    radius_px = max(1, int(round(tpi_radius_m / pixel_size_m)))
    size = 2 * radius_px + 1

    arr_zero = np.where(np.isfinite(arr), arr, 0.0).astype(np.float32)

    sum_f = uniform_filter(arr_zero, size=size, mode="nearest") * (size * size)
    cnt_f = uniform_filter(valid, size=size, mode="nearest") * (size * size)
    mean_f = np.where(cnt_f > 0, sum_f / cnt_f, np.nan).astype(np.float32)

    tpi = (arr - mean_f).astype(np.float32)

    # rimetti NaN dove input non valido
    slope_deg = np.where(np.isfinite(arr), slope_deg, np.nan).astype(np.float32)
    aspect_deg = np.where(np.isfinite(arr), aspect_deg, np.nan).astype(np.float32)
    tpi = np.where(np.isfinite(arr), tpi, np.nan).astype(np.float32)

    return slope_deg, aspect_deg, tpi


def array_to_mem_raster(
    arr: np.ndarray,
    gt: tuple[float, float, float, float, float, float],
    proj_wkt: str,
    gdal_dtype: int = gdal.GDT_Float32,
    nodata: float | int | None = None,
) -> gdal.Dataset:
    ny, nx = arr.shape
    ds = gdal.GetDriverByName("MEM").Create("", nx, ny, 1, gdal_dtype)
    ds.SetGeoTransform(gt)
    ds.SetProjection(proj_wkt)
    band = ds.GetRasterBand(1)
    band.WriteArray(arr)
    if nodata is not None:
        band.SetNoDataValue(float(nodata))
    band.FlushCache()
    return ds


def warp_to_target_array(
    src: str | gdal.Dataset,
    bbox: dict[str, float],
    dst_crs: str,
    width: int,
    height: int,
    resample_alg: str,
    dst_nodata: float = np.nan,
    output_type: int = gdal.GDT_Float32,
) -> np.ndarray:
    warped = gdal.Warp(
        "",
        src,
        format="MEM",
        outputBounds=[bbox["west"], bbox["south"], bbox["east"], bbox["north"]],
        dstSRS=dst_crs,
        width=width,
        height=height,
        resampleAlg=resample_alg,
        dstNodata=dst_nodata,
        outputType=output_type,
        multithread=True,
    )
    if warped is None:
        raise RuntimeError(f"gdal.Warp fallito con resample={resample_alg}")

    arr = warped.GetRasterBand(1).ReadAsArray().astype(np.float32)
    return arr


def circular_mean_deg_to_target(
    aspect_deg_src: np.ndarray,
    gt_src: tuple[float, float, float, float, float, float],
    proj_src: str,
    bbox: dict[str, float],
    dst_crs: str,
    width: int,
    height: int,
) -> np.ndarray:
    aspect_rad = np.deg2rad(aspect_deg_src.astype(np.float32))
    sin_arr = np.sin(aspect_rad).astype(np.float32)
    cos_arr = np.cos(aspect_rad).astype(np.float32)

    valid = np.isfinite(aspect_deg_src)
    sin_arr = np.where(valid, sin_arr, np.nan).astype(np.float32)
    cos_arr = np.where(valid, cos_arr, np.nan).astype(np.float32)

    sin_ds = array_to_mem_raster(sin_arr, gt_src, proj_src, nodata=np.nan)
    cos_ds = array_to_mem_raster(cos_arr, gt_src, proj_src, nodata=np.nan)

    sin_t = warp_to_target_array(
        sin_ds, bbox, dst_crs, width, height,
        resample_alg="average", dst_nodata=np.nan
    )
    cos_t = warp_to_target_array(
        cos_ds, bbox, dst_crs, width, height,
        resample_alg="average", dst_nodata=np.nan
    )

    aspect = np.degrees(np.arctan2(sin_t, cos_t)).astype(np.float32)
    aspect = np.where(aspect < 0, aspect + 360.0, aspect).astype(np.float32)

    norm = np.sqrt(sin_t**2 + cos_t**2)
    aspect = np.where(norm > 1e-6, aspect, np.nan).astype(np.float32)
    return aspect


def compute_forest_percentages_to_target(
    forest_path: Path,
    bbox: dict[str, float],
    dst_crs: str,
    width: int,
    height: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ds = gdal.Open(str(forest_path))
    if ds is None:
        raise RuntimeError(f"Impossibile aprire raster forestale: {forest_path}")

    arr, gt, proj, nodata = read_raster_array(ds)
    nodata_value = DLT_NODATA if nodata is None else int(nodata)

    broadleaf_mask = np.where(arr == DLT_BROADLEAF, 1.0, 0.0).astype(np.float32)
    conifer_mask = np.where(arr == DLT_CONIFER, 1.0, 0.0).astype(np.float32)
    non_forest_mask = np.where(arr == DLT_NON_FOREST, 1.0, 0.0).astype(np.float32)

    invalid = arr == nodata_value
    broadleaf_mask[invalid] = np.nan
    conifer_mask[invalid] = np.nan
    non_forest_mask[invalid] = np.nan

    broadleaf_ds = array_to_mem_raster(broadleaf_mask, gt, proj, nodata=np.nan)
    conifer_ds = array_to_mem_raster(conifer_mask, gt, proj, nodata=np.nan)
    non_forest_ds = array_to_mem_raster(non_forest_mask, gt, proj, nodata=np.nan)

    pct_broadleaf = 100.0 * warp_to_target_array(
        broadleaf_ds, bbox, dst_crs, width, height,
        resample_alg="average", dst_nodata=np.nan
    )
    pct_conifer = 100.0 * warp_to_target_array(
        conifer_ds, bbox, dst_crs, width, height,
        resample_alg="average", dst_nodata=np.nan
    )
    pct_non_forest = 100.0 * warp_to_target_array(
        non_forest_ds, bbox, dst_crs, width, height,
        resample_alg="average", dst_nodata=np.nan
    )

    return pct_broadleaf.astype(np.float32), pct_conifer.astype(np.float32), pct_non_forest.astype(np.float32)


def flip_to_lat_ascending(arr: np.ndarray) -> np.ndarray:
    return np.flipud(arr).astype(np.float32)


def save_terrain_netcdf(
    out_path: Path,
    lats_desc: np.ndarray,
    lons: np.ndarray,
    elevation: np.ndarray,
    slope: np.ndarray,
    tpi: np.ndarray,
    aspect_deg: np.ndarray,
    pct_broadleaf: np.ndarray,
    pct_conifer: np.ndarray,
    pct_non_forest: np.ndarray,
    source_dem: str,
    source_forest: str,
    tpi_radius_m: float,
    target_step_deg: float,
) -> None:
    ensure_dir(out_path.parent)

    lats = lats_desc[::-1].copy().astype(np.float32)

    elevation = flip_to_lat_ascending(elevation)
    slope = flip_to_lat_ascending(slope)
    tpi = flip_to_lat_ascending(tpi)
    aspect_deg = flip_to_lat_ascending(aspect_deg)
    pct_broadleaf = flip_to_lat_ascending(pct_broadleaf)
    pct_conifer = flip_to_lat_ascending(pct_conifer)
    pct_non_forest = flip_to_lat_ascending(pct_non_forest)

    fill_value = np.float32(np.nan)

    with Dataset(out_path, "w", format="NETCDF4") as ds:
        ds.createDimension("lat", len(lats))
        ds.createDimension("lon", len(lons))

        lat_var = ds.createVariable("lat", "f4", ("lat",))
        lon_var = ds.createVariable("lon", "f4", ("lon",))

        lat_var[:] = lats
        lon_var[:] = lons

        lat_var.units = "degrees_north"
        lon_var.units = "degrees_east"
        lat_var.long_name = "latitude"
        lon_var.long_name = "longitude"

        def make_var(name: str, long_name: str, units: str, data: np.ndarray):
            v = ds.createVariable(name, "f4", ("lat", "lon"), zlib=True, complevel=4, fill_value=fill_value)
            v[:, :] = data
            v.long_name = long_name
            v.units = units
            v.coordinates = "lat lon"
            return v

        make_var("elevation", "Terrain elevation aggregated to 0.003 degree grid", "m", elevation)
        make_var("slope", "Terrain slope aggregated to 0.003 degree grid", "degree", slope)

        tpi_var = make_var("tpi", "Topographic Position Index aggregated to 0.003 degree grid", "m", tpi)
        tpi_var.radius_m = np.float32(tpi_radius_m)

        aspect_var = make_var("aspect_deg", "Circular mean terrain aspect aggregated to 0.003 degree grid", "degree", aspect_deg)
        aspect_var.valid_range = np.array([0.0, 360.0], dtype=np.float32)

        make_var("pct_broadleaf", "Percentage of broadleaf pixels within 0.003 degree cell", "percent", pct_broadleaf)
        make_var("pct_conifer", "Percentage of conifer pixels within 0.003 degree cell", "percent", pct_conifer)
        make_var("pct_non_forest", "Percentage of non-forest pixels within 0.003 degree cell", "percent", pct_non_forest)

        ds.title = "Static terrain dataset for mushroom growth index"
        ds.summary = "Static topographic and forest-cover predictors aggregated to 0.003 degree grid"
        ds.created_utc = datetime.now(timezone.utc).isoformat()
        ds.target_crs = TARGET_CRS
        ds.target_step_deg = np.float32(target_step_deg)
        ds.bbox_west = np.float32(BBOX["west"])
        ds.bbox_south = np.float32(BBOX["south"])
        ds.bbox_east = np.float32(BBOX["east"])
        ds.bbox_north = np.float32(BBOX["north"])
        ds.source_dem = source_dem
        ds.source_forest = source_forest
        ds.projected_crs_for_derivatives = PROJECTED_CRS
        ds.tpi_radius_m = np.float32(tpi_radius_m)
        ds.forest_classes = "0=non_forest,1=broadleaf,2=conifer,255=nodata"

    print(f"[OK] NetCDF salvato in: {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dem",
        default=str(INT_TERRAIN_DIR / "dem_work.tif"),
        help="DEM di lavoro preparato da prepare_dem.py",
    )
    parser.add_argument(
        "--forest",
        default=str(INT_FOREST_DIR / "dlt_2023_work.tif"),
        help="Raster forestale di lavoro preparato da prepare_forest.py",
    )
    parser.add_argument(
        "--out",
        default=str(FINAL_STATIC_DIR / "terrain_static_003deg.nc"),
        help="NetCDF statico finale",
    )
    parser.add_argument(
        "--tpi-radius-m",
        type=float,
        default=300.0,
        help="Raggio in metri usato per il TPI",
    )
    parser.add_argument(
        "--dem-projected-res-m",
        type=float,
        default=30.0,
        help="Risoluzione in metri per la reproiezione metrica del DEM",
    )
    args = parser.parse_args()

    dem_path = Path(args.dem)
    forest_path = Path(args.forest)
    out_path = Path(args.out)

    print("=" * 72)
    print("BUILD STATIC TERRAIN NETCDF")
    print(f"DEM                : {dem_path}")
    print(f"FOREST             : {forest_path}")
    print(f"OUTPUT             : {out_path}")
    print(f"TPI RADIUS (m)     : {args.tpi_radius_m}")
    print(f"TARGET STEP (deg)  : {TARGET_STEP_DEG}")
    print("=" * 72)

    width, height, target_gt, lons, lats_desc = build_target_grid(BBOX, TARGET_STEP_DEG)

    print("[1/5] Reproiezione DEM in CRS metrico...")
    dem_proj_ds = warp_dem_to_projected_mem(
        dem_path,
        dst_crs=PROJECTED_CRS,
        xres=args.dem_projected_res_m,
        yres=args.dem_projected_res_m,
    )
    dem_arr, dem_gt, dem_proj_wkt, dem_nodata = read_raster_array(dem_proj_ds)
    pixel_size_m = float(abs(dem_gt[1]))

    print("[2/5] Calcolo slope, aspect, tpi...")
    slope_arr, aspect_arr, tpi_arr = compute_slope_aspect_tpi(
        dem_arr=dem_arr,
        pixel_size_m=pixel_size_m,
        nodata=dem_nodata,
        tpi_radius_m=args.tpi_radius_m,
    )

    print("[3/5] Aggregazione DEM e derivati alla griglia finale 0.003°...")
    dem_ds_mem = array_to_mem_raster(dem_arr, dem_gt, dem_proj_wkt, nodata=np.nan if dem_nodata is None else dem_nodata)
    slope_ds_mem = array_to_mem_raster(slope_arr, dem_gt, dem_proj_wkt, nodata=np.nan)
    tpi_ds_mem = array_to_mem_raster(tpi_arr, dem_gt, dem_proj_wkt, nodata=np.nan)

    elevation_target = warp_to_target_array(
        dem_ds_mem, BBOX, TARGET_CRS, width, height,
        resample_alg="average", dst_nodata=np.nan
    )
    slope_target = warp_to_target_array(
        slope_ds_mem, BBOX, TARGET_CRS, width, height,
        resample_alg="average", dst_nodata=np.nan
    )
    tpi_target = warp_to_target_array(
        tpi_ds_mem, BBOX, TARGET_CRS, width, height,
        resample_alg="average", dst_nodata=np.nan
    )

    aspect_target = circular_mean_deg_to_target(
        aspect_deg_src=aspect_arr,
        gt_src=dem_gt,
        proj_src=dem_proj_wkt,
        bbox=BBOX,
        dst_crs=TARGET_CRS,
        width=width,
        height=height,
    )

    print("[4/5] Calcolo percentuali forestali...")
    pct_broadleaf, pct_conifer, pct_non_forest = compute_forest_percentages_to_target(
        forest_path=forest_path,
        bbox=BBOX,
        dst_crs=TARGET_CRS,
        width=width,
        height=height,
    )

    print("[5/5] Scrittura NetCDF...")
    save_terrain_netcdf(
        out_path=out_path,
        lats_desc=lats_desc,
        lons=lons,
        elevation=elevation_target,
        slope=slope_target,
        tpi=tpi_target,
        aspect_deg=aspect_target,
        pct_broadleaf=pct_broadleaf,
        pct_conifer=pct_conifer,
        pct_non_forest=pct_non_forest,
        source_dem=str(dem_path),
        source_forest=str(forest_path),
        tpi_radius_m=args.tpi_radius_m,
        target_step_deg=TARGET_STEP_DEG,
    )

    print("Done.")


if __name__ == "__main__":
    main()