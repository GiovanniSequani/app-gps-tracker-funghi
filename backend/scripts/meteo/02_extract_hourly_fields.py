from __future__ import annotations

import argparse
import bz2
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from backend.config.domain import BBOX
from backend.config.meteo import (
    ICON_D2_RAW_DIR,
    INTERMEDIATE_METEO_DIR,
    MIN_LEAD_HOURS,
    PRECIP_HOURLY_MODE,
)

UTC = timezone.utc
EXPECTED_VARS = ("t2m", "rh2m", "gust10m", "precip")


# ------------------------------------------------------------------------------
# Utility tempo / path
# ------------------------------------------------------------------------------

def parse_run_yyyymmddhh(run_str: str) -> datetime:
    try:
        return datetime.strptime(run_str, "%Y%m%d%H").replace(tzinfo=UTC)
    except ValueError as exc:
        raise ValueError(
            f"Formato run non valido: {run_str}. Atteso YYYYmmddHH"
        ) from exc



def format_run(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H")



def ensure_output_dir() -> Path:
    INTERMEDIATE_METEO_DIR.mkdir(parents=True, exist_ok=True)
    return INTERMEDIATE_METEO_DIR


# ------------------------------------------------------------------------------
# File lookup
# ------------------------------------------------------------------------------

def find_single_level_file(run_dir: Path, dwd_var_dir: str, step: int) -> Path:
    step_str = f"_{step:03d}_"
    files = sorted((run_dir / dwd_var_dir).glob(f"*{step_str}*.grib2.bz2"))
    if not files:
        raise FileNotFoundError(
            f"Nessun file trovato per variabile {dwd_var_dir}, step={step}, in {run_dir / dwd_var_dir}"
        )
    if len(files) > 1:
        raise RuntimeError(
            f"Trovati più file del previsto per {dwd_var_dir}, step={step}: {files}"
        )
    return files[0]


# ------------------------------------------------------------------------------
# Lettura GRIB bz2
# ------------------------------------------------------------------------------

def open_bz2_grib_dataset(path: Path) -> xr.Dataset:
    """
    Decomprime temporaneamente il .grib2.bz2 e lo apre con cfgrib.
    """
    with bz2.open(path, "rb") as f_in, tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
        tmp.write(f_in.read())
        tmp_path = Path(tmp.name)

    try:
        ds = xr.open_dataset(tmp_path, engine="cfgrib")
        ds.load()
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass

    return ds


# ------------------------------------------------------------------------------
# Grid helpers
# ------------------------------------------------------------------------------

def detect_lat_lon_names(ds: xr.Dataset) -> tuple[str, str]:
    lat_candidates = ["latitude", "lat"]
    lon_candidates = ["longitude", "lon"]

    lat_name = next((n for n in lat_candidates if n in ds.coords), None)
    lon_name = next((n for n in lon_candidates if n in ds.coords), None)

    if lat_name is None or lon_name is None:
        raise KeyError(
            f"Coordinate lat/lon non trovate nel dataset. Coords disponibili: {list(ds.coords)}"
        )

    return lat_name, lon_name



def detect_main_var_name(ds: xr.Dataset) -> str:
    data_vars = list(ds.data_vars)
    if len(data_vars) != 1:
        raise RuntimeError(
            f"Attesa una sola data_var nel GRIB aperto, trovate: {data_vars}"
        )
    return data_vars[0]



def normalize_longitudes(lon: np.ndarray) -> np.ndarray:
    lon = lon.copy()
    lon = np.where(lon > 180.0, lon - 360.0, lon)
    return lon



def ensure_lat_lon_ascending(
    data_2d: np.ndarray,
    lat_1d: np.ndarray,
    lon_1d: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    out = data_2d
    lats = lat_1d.copy()
    lons = lon_1d.copy()

    if lats[0] > lats[-1]:
        lats = lats[::-1]
        out = np.flipud(out)

    if lons[0] > lons[-1]:
        lons = lons[::-1]
        out = np.fliplr(out)

    return out.astype(np.float32), lats.astype(np.float32), lons.astype(np.float32)



def subset_regular_grid(
    data_2d: np.ndarray,
    lat_1d: np.ndarray,
    lon_1d: np.ndarray,
    bbox: dict,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lat_mask = (lat_1d >= bbox["south"]) & (lat_1d <= bbox["north"])
    lon_mask = (lon_1d >= bbox["west"]) & (lon_1d <= bbox["east"])

    if not np.any(lat_mask):
        raise RuntimeError("Nessuna latitudine della griglia regolare ricade nel BBOX")
    if not np.any(lon_mask):
        raise RuntimeError("Nessuna longitudine della griglia regolare ricade nel BBOX")

    out = data_2d[np.ix_(lat_mask, lon_mask)]
    out_lats = lat_1d[lat_mask]
    out_lons = lon_1d[lon_mask]

    return ensure_lat_lon_ascending(out, out_lats, out_lons)


# ------------------------------------------------------------------------------
# Estrazione variabili
# ------------------------------------------------------------------------------

def reduce_regular_field_to_2d(
    da: xr.DataArray,
    file_path: Path,
    var_role: str,
) -> np.ndarray:
    da = da.squeeze()

    if da.ndim == 2:
        return da.values.astype(np.float32)

    if da.ndim == 3:
        spatial_names = {"lat", "latitude", "lon", "longitude"}
        extra_dims = [d for d in da.dims if d not in spatial_names]

        if len(extra_dims) != 1:
            raise RuntimeError(
                f"Impossibile ridurre a 2D {file_path}. Dims trovate: {da.dims}, shape={da.shape}"
            )

        extra_dim = extra_dims[0]

        if var_role == "precip":
            print(
                f"  [INFO] precip con asse extra '{extra_dim}' shape={da.shape} -> somma lungo '{extra_dim}'"
            )
            da2 = da.sum(dim=extra_dim, skipna=True)
            if da2.ndim != 2:
                raise RuntimeError(
                    f"Dopo aggregazione precip non si ottiene un 2D in {file_path}. Dims={da2.dims}, shape={da2.shape}"
                )
            return da2.values.astype(np.float32)

        raise RuntimeError(
            f"Variabile {var_role} non attesa con 3 dimensioni in {file_path}. Dims={da.dims}, shape={da.shape}"
        )

    raise RuntimeError(
        f"Attesa variabile 2D regolare, trovata shape={da.shape} in {file_path}"
    )



def infer_valid_time(ds: xr.Dataset) -> datetime:
    if "valid_time" in ds.coords:
        vt = ds["valid_time"].values
        if np.ndim(vt) > 0:
            vt = np.asarray(vt).ravel()[-1]
        return np.datetime64(vt).astype("datetime64[s]").tolist().replace(tzinfo=UTC)

    if "time" in ds.coords and "step" in ds.coords:
        t = ds["time"].values
        s = ds["step"].values

        t64 = np.asarray(t).ravel()[0].astype("datetime64[s]")
        s64 = np.asarray(s).ravel()[0].astype("timedelta64[s]")
        vt64 = t64 + s64
        return vt64.tolist().replace(tzinfo=UTC)

    if "time" in ds.coords:
        t = ds["time"].values
        t64 = np.asarray(t).ravel()[0].astype("datetime64[s]")
        return t64.tolist().replace(tzinfo=UTC)

    raise RuntimeError("Impossibile inferire valid_time dal dataset cfgrib")



def extract_regular_variable(
    file_path: Path,
    bbox: dict,
    var_role: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, datetime]:
    ds = open_bz2_grib_dataset(file_path)
    lat_name, lon_name = detect_lat_lon_names(ds)
    var_name = detect_main_var_name(ds)

    data = ds[var_name]
    lats = ds[lat_name].values
    lons = normalize_longitudes(ds[lon_name].values)

    if lats.ndim != 1 or lons.ndim != 1:
        raise RuntimeError(
            f"Attese coordinate 1D per griglia regolare, trovate lat.ndim={lats.ndim}, lon.ndim={lons.ndim}"
        )

    arr2d = reduce_regular_field_to_2d(da=data, file_path=file_path, var_role=var_role)
    out, out_lats, out_lons = subset_regular_grid(
        arr2d,
        lats.astype(np.float32),
        lons.astype(np.float32),
        bbox,
    )
    valid_time = infer_valid_time(ds)
    return out, out_lats, out_lons, valid_time


# ------------------------------------------------------------------------------
# Output helpers
# ------------------------------------------------------------------------------

def sort_dataset_by_valid_time(ds: xr.Dataset) -> xr.Dataset:
    return ds.sortby("valid_time")



def ensure_no_duplicate_valid_time(ds: xr.Dataset) -> None:
    vt = ds["valid_time"].values.astype("datetime64[s]")
    unique_vt, counts = np.unique(vt, return_counts=True)
    if np.any(counts > 1):
        dup = unique_vt[counts > 1]
        raise RuntimeError(
            f"valid_time duplicati nel dataset hourly della singola run: {[str(x) for x in dup[:10]]}"
        )



def save_hourly_dataset(ds_out: xr.Dataset, out_path: Path, overwrite: bool) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists() and not overwrite:
        raise FileExistsError(f"Output già esistente: {out_path}. Usa --overwrite per sovrascrivere.")

    encoding: dict[str, dict] = {
        "valid_time": {"dtype": "i8"},
        "lat": {"dtype": "f4"},
        "lon": {"dtype": "f4"},
    }
    for var_name in EXPECTED_VARS:
        encoding[var_name] = {"zlib": True, "complevel": 4, "dtype": "f4"}

    ds_out.to_netcdf(out_path, encoding=encoding)


# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Estrae i campi orari da una run ICON-D2 raw e costruisce un NetCDF intermedio coerente."
    )
    parser.add_argument(
        "--run",
        required=True,
        type=str,
        help="Run target in formato YYYYmmddHH",
    )
    parser.add_argument(
        "--steps",
        nargs="+",
        type=int,
        default=None,
        help="Lead time da estrarre. Se omesso, auto-detect dai file t_2m presenti.",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=None,
        help="Path output del NetCDF hourly. Default: backend/data/intermediate/meteo/icon_d2_hourly_<run>.nc",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Sovrascrive l'output se esiste già.",
    )
    args = parser.parse_args()

    run_dt = parse_run_yyyymmddhh(args.run)
    run_str = format_run(run_dt)
    run_dir = ICON_D2_RAW_DIR / run_str

    if not run_dir.is_dir():
        raise FileNotFoundError(f"Directory run non trovata: {run_dir}")

    if args.steps is None:
        t2m_dir = run_dir / "t_2m"
        step_files = sorted(t2m_dir.glob("*.grib2.bz2"))
        if not step_files:
            raise FileNotFoundError(f"Nessun file t_2m trovato in {t2m_dir}")

        steps = sorted({
            int(p.name.split("_")[-4])
            for p in step_files
        })
    else:
        steps = sorted(set(args.steps))

    steps = [s for s in steps if s >= MIN_LEAD_HOURS]
    if not steps:
        raise RuntimeError(
            f"Nessun lead time disponibile dopo filtro MIN_LEAD_HOURS={MIN_LEAD_HOURS}"
        )

    print("=" * 78)
    print("ICON-D2 EXTRACT HOURLY FIELDS")
    print(f"Run                : {run_str} UTC")
    print(f"Steps              : {steps}")
    print(f"Min lead hours     : {MIN_LEAD_HOURS}")
    print("=" * 78)

    time_list: list[np.datetime64] = []
    t2m_list: list[np.ndarray] = []
    rh2m_list: list[np.ndarray] = []
    gust_list: list[np.ndarray] = []
    precip_cumulative_list: list[np.ndarray] = []

    ref_lats: np.ndarray | None = None
    ref_lons: np.ndarray | None = None

    for step in steps:
        print(f"\n[STEP {step:03d}]")

        t2m_file = find_single_level_file(run_dir, "t_2m", step)
        rh2m_file = find_single_level_file(run_dir, "relhum_2m", step)
        gust_file = find_single_level_file(run_dir, "vmax_10m", step)
        precip_file = find_single_level_file(run_dir, "tot_prec", step)

        t2m_arr, lats, lons, vt = extract_regular_variable(t2m_file, BBOX, "t2m")
        rh2m_arr, lats2, lons2, vt2 = extract_regular_variable(rh2m_file, BBOX, "rh2m")
        gust_arr, lats3, lons3, vt3 = extract_regular_variable(gust_file, BBOX, "gust10m")
        precip_arr, lats4, lons4, vt4 = extract_regular_variable(precip_file, BBOX, "precip")

        if ref_lats is None:
            ref_lats = lats
            ref_lons = lons
        else:
            if not np.array_equal(ref_lats, lats) or not np.array_equal(ref_lons, lons):
                raise RuntimeError("Griglia regular incoerente tra step diversi")

        if not (np.array_equal(lats, lats2) and np.array_equal(lons, lons2)):
            raise RuntimeError("Griglia t2m e rh2m non coerente")
        if not (np.array_equal(lats, lats3) and np.array_equal(lons, lons3)):
            raise RuntimeError("Griglia t2m e gust10m non coerente")
        if not (np.array_equal(lats, lats4) and np.array_equal(lons, lons4)):
            raise RuntimeError("Griglia t2m e precip non coerente")

        if not (vt == vt2 == vt3):
            raise RuntimeError(
                f"Valid time incoerente tra t2m/rh2m/gust allo step {step}: {vt}, {vt2}, {vt3}"
            )

        if vt4 != vt:
            print(
                f"  [INFO] precip valid_time diverso allo step {step}: {vt4.isoformat()} -> riallineato a {vt.isoformat()}"
            )

        time_list.append(np.datetime64(vt.replace(tzinfo=None), "s"))
        t2m_list.append(t2m_arr)
        rh2m_list.append(rh2m_arr)
        gust_list.append(gust_arr)
        precip_cumulative_list.append(precip_arr)

        print(f"  valid_time       : {vt.isoformat()}")
        print(f"  grid shape       : {t2m_arr.shape}")

    assert ref_lats is not None and ref_lons is not None

    precip_list: list[np.ndarray] = []
    for i, arr_cum in enumerate(precip_cumulative_list):
        if i == 0:
            arr_hourly = arr_cum.copy()
        else:
            arr_hourly = arr_cum - precip_cumulative_list[i - 1]
        arr_hourly = np.where(arr_hourly < 0, 0.0, arr_hourly).astype(np.float32)
        precip_list.append(arr_hourly)

    t2m_data = np.stack(t2m_list).astype(np.float32) - np.float32(273.15)
    rh2m_data = np.stack(rh2m_list).astype(np.float32)
    gust_data = np.stack(gust_list).astype(np.float32) * np.float32(3.6)
    precip_data = np.stack(precip_list).astype(np.float32)  # 1 kg m-2 = 1 mm

    ds_out = xr.Dataset(
        data_vars={
            "t2m": (("valid_time", "lat", "lon"), t2m_data),
            "rh2m": (("valid_time", "lat", "lon"), rh2m_data),
            "gust10m": (("valid_time", "lat", "lon"), gust_data),
            "precip": (("valid_time", "lat", "lon"), precip_data),
        },
        coords={
            "valid_time": np.array(time_list, dtype="datetime64[s]"),
            "lat": ref_lats.astype(np.float32),
            "lon": ref_lons.astype(np.float32),
        },
        attrs={
            "title": "ICON-D2 hourly fields extracted from one run",
            "summary": "Intermediate hourly dataset built from raw ICON-D2 files for the project BBOX.",
            "source": "DWD ICON-D2 open data",
            "run_time_utc": run_dt.isoformat(),
            "bbox_south": BBOX["south"],
            "bbox_north": BBOX["north"],
            "bbox_west": BBOX["west"],
            "bbox_east": BBOX["east"],
            "min_lead_hours": MIN_LEAD_HOURS,
            "precip_mode": PRECIP_HOURLY_MODE,
            "created_utc": datetime.now(UTC).isoformat(),
            "note": "Soil variables temporarily excluded in v1 because current cfgrib/ecCodes stack does not expose lat/lon for ICON-D2 unstructured soil files.",
        },
    )

    ds_out = sort_dataset_by_valid_time(ds_out)
    ensure_no_duplicate_valid_time(ds_out)

    ds_out["valid_time"].attrs.update(long_name="forecast valid time", timezone="UTC")
    ds_out["lat"].attrs.update(long_name="latitude", units="degrees_north")
    ds_out["lon"].attrs.update(long_name="longitude", units="degrees_east")

    ds_out["t2m"].attrs.update(long_name="2 m air temperature", units="degC")
    ds_out["rh2m"].attrs.update(long_name="2 m relative humidity", units="%")
    ds_out["gust10m"].attrs.update(long_name="10 m maximum wind gust", units="km h-1")
    ds_out["precip"].attrs.update(long_name="hourly precipitation for the last hour", units="mm")

    out_dir = ensure_output_dir()
    out_path = Path(args.out) if args.out else (out_dir / f"icon_d2_hourly_{run_str}.nc")
    save_hourly_dataset(ds_out, out_path, overwrite=args.overwrite)

    print("\nOutput:")
    print(out_path.resolve())
    print("\nDone ✓")


if __name__ == "__main__":
    main()
