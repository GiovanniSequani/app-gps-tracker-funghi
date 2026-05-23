from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from backend.config.domain import BBOX, TARGET_CRS, TARGET_STEP_DEG
from backend.config.meteo import DAILY_FINAL_VARIABLES, INTERMEDIATE_METEO_DIR

UTC = timezone.utc
EXPECTED_DAILY_VARS = tuple(DAILY_FINAL_VARIABLES)


# ------------------------------------------------------------------------------
# Utility path
# ------------------------------------------------------------------------------

def ensure_output_dir() -> Path:
    INTERMEDIATE_METEO_DIR.mkdir(parents=True, exist_ok=True)
    return INTERMEDIATE_METEO_DIR


def default_daily_candidates_path() -> Path:
    return INTERMEDIATE_METEO_DIR / "daily_candidates.nc"


def default_daily_target_path() -> Path:
    return INTERMEDIATE_METEO_DIR / "daily_003deg.nc"


# ------------------------------------------------------------------------------
# I/O
# ------------------------------------------------------------------------------

def open_dataset(path: Path) -> xr.Dataset:
    if not path.is_file():
        raise FileNotFoundError(f"File non trovato: {path}")

    ds = xr.open_dataset(path)
    try:
        ds.load()
        ds_mem = ds.copy(deep=True)
    finally:
        ds.close()

    return ds_mem


def save_dataset(ds: xr.Dataset, out_path: Path, overwrite: bool) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if out_path.exists() and not overwrite:
        raise FileExistsError(
            f"Output già esistente: {out_path}. Usa --overwrite per sovrascrivere."
        )

    encoding: dict[str, dict] = {
        "time": {"dtype": "i8"},
        "lat": {"dtype": "f4"},
        "lon": {"dtype": "f4"},
    }

    if "n_hours" in ds.coords:
        encoding["n_hours"] = {"dtype": "i2"}

    for var_name in EXPECTED_DAILY_VARS:
        if var_name in ds.data_vars:
            encoding[var_name] = {"zlib": True, "complevel": 4, "dtype": "f4"}

    ds.to_netcdf(out_path, encoding=encoding)


# ------------------------------------------------------------------------------
# Validation
# ------------------------------------------------------------------------------

def validate_daily_candidates(ds: xr.Dataset, source_path: Path) -> None:
    missing_vars = [name for name in EXPECTED_DAILY_VARS if name not in ds.data_vars]
    if missing_vars:
        raise RuntimeError(
            f"Dataset daily incompleto in {source_path}. Variabili mancanti: {missing_vars}"
        )

    for coord_name in ("time", "lat", "lon"):
        if coord_name not in ds.coords:
            raise RuntimeError(
                f"Coordinata mancante '{coord_name}' in {source_path}. "
                f"Coords disponibili: {list(ds.coords)}"
            )

    expected_dims = ("time", "lat", "lon")
    for var_name in EXPECTED_DAILY_VARS:
        if ds[var_name].dims != expected_dims:
            raise RuntimeError(
                f"Variabile {var_name} con dims non attese in {source_path}: "
                f"{ds[var_name].dims} invece di {expected_dims}"
            )

    if ds.sizes["time"] == 0:
        raise RuntimeError(f"Dataset daily vuoto in {source_path}")

    lat = ds["lat"].values
    lon = ds["lon"].values

    if lat.ndim != 1 or lon.ndim != 1:
        raise RuntimeError(f"lat/lon devono essere 1D in {source_path}")

    if lat.size < 2 or lon.size < 2:
        raise RuntimeError(f"Griglia troppo piccola in {source_path}")

    if np.any(np.diff(lat) <= 0):
        raise RuntimeError(f"lat non strettamente crescente in {source_path}")
    if np.any(np.diff(lon) <= 0):
        raise RuntimeError(f"lon non strettamente crescente in {source_path}")


# ------------------------------------------------------------------------------
# Target grid
# ------------------------------------------------------------------------------

def build_target_grid(
    bbox: dict[str, float],
    step_deg: float,
) -> tuple[np.ndarray, np.ndarray]:
    west = bbox["west"]
    south = bbox["south"]
    east = bbox["east"]
    north = bbox["north"]

    width = int(round((east - west) / step_deg))
    height = int(round((north - south) / step_deg))

    lons = west + (np.arange(width, dtype=np.float64) + 0.5) * step_deg
    lats_desc = north - (np.arange(height, dtype=np.float64) + 0.5) * step_deg
    lats = lats_desc[::-1].copy()

    return lats.astype(np.float32), lons.astype(np.float32)


# ------------------------------------------------------------------------------
# Regrid
# ------------------------------------------------------------------------------

def regrid_daily_to_target(ds_in: xr.Dataset) -> xr.Dataset:
    target_lats, target_lons = build_target_grid(BBOX, TARGET_STEP_DEG)

    # siamo già in EPSG:4326 su griglia regular lat/lon: interp lineare basta
    daily_vars = list(EXPECTED_DAILY_VARS)

    ds_out = ds_in[daily_vars].interp(
        lat=xr.DataArray(target_lats, dims="lat"),
        lon=xr.DataArray(target_lons, dims="lon"),
        method="linear",
        kwargs={"fill_value": np.nan},
    )

    coords = {
        "time": ds_in["time"].values.astype("datetime64[s]"),
        "lat": target_lats,
        "lon": target_lons,
    }

    if "n_hours" in ds_in.coords:
        coords["n_hours"] = ("time", ds_in["n_hours"].values.astype(np.int16))

    ds_out = xr.Dataset(
        data_vars={
            var_name: (("time", "lat", "lon"), ds_out[var_name].values.astype(np.float32))
            for var_name in EXPECTED_DAILY_VARS
        },
        coords=coords,
        attrs={
            "title": "Daily weather fields regridded to project target grid",
            "summary": (
                "Daily candidate fields interpolated from the native ICON-D2 regular lat/lon grid "
                "to the common project target grid."
            ),
            "source": ds_in.attrs.get("source", "DWD ICON-D2 open data"),
            "input_timezone_daily": ds_in.attrs.get("timezone_daily", ""),
            "source_latest_run_time_utc": ds_in.attrs.get("source_latest_run_time_utc", ""),
            "target_crs": TARGET_CRS,
            "target_step_deg": np.float32(TARGET_STEP_DEG),
            "bbox_south": np.float32(BBOX["south"]),
            "bbox_north": np.float32(BBOX["north"]),
            "bbox_west": np.float32(BBOX["west"]),
            "bbox_east": np.float32(BBOX["east"]),
            "regrid_method": "xarray.interp linear on regular lat/lon grid",
            "created_utc": datetime.now(UTC).isoformat(),
        },
    )

    ds_out["time"].attrs.update(ds_in["time"].attrs)
    ds_out["lat"].attrs.update(long_name="latitude", units="degrees_north")
    ds_out["lon"].attrs.update(long_name="longitude", units="degrees_east")

    for var_name in EXPECTED_DAILY_VARS:
        ds_out[var_name].attrs.update(ds_in[var_name].attrs)

    if "n_hours" in ds_out.coords:
        ds_out["n_hours"].attrs.update(ds_in["n_hours"].attrs)

    return ds_out


# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Regrida i campi daily intermedi alla griglia target comune del progetto "
            f"({TARGET_CRS}, step={TARGET_STEP_DEG}°)."
        )
    )
    parser.add_argument(
        "--daily",
        type=str,
        default=str(default_daily_candidates_path()),
        help="Path input daily_candidates.nc",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=str(default_daily_target_path()),
        help="Path output daily_003deg.nc",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Sovrascrive l'output se esiste già.",
    )
    args = parser.parse_args()

    daily_path = Path(args.daily)
    out_path = Path(args.out)

    print("=" * 78)
    print("REGRID DAILY TO TARGET GRID")
    print(f"Input daily        : {daily_path}")
    print(f"Output             : {out_path}")
    print(f"Target CRS         : {TARGET_CRS}")
    print(f"Target step deg    : {TARGET_STEP_DEG}")
    print("=" * 78)

    ds_in = open_dataset(daily_path)
    validate_daily_candidates(ds_in, daily_path)

    ds_out = regrid_daily_to_target(ds_in)
    save_dataset(ds_out, out_path, overwrite=args.overwrite)

    print("\nOutput:")
    print(out_path.resolve())
    print(f"n_days             : {ds_out.sizes['time']}")
    print(f"grid               : {ds_out.sizes['lat']} x {ds_out.sizes['lon']}")
    print(f"time start         : {str(ds_out['time'].values[0])}")
    print(f"time end           : {str(ds_out['time'].values[-1])}")
    print("\nDone OK")


if __name__ == "__main__":
    main()
