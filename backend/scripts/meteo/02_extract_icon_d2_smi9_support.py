from __future__ import annotations

import argparse
import importlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from backend.config.domain import BBOX, TARGET_CRS
from backend.config.meteo import ICON_D2_RAW_DIR, ICON_D2_RAW_VARIABLES, INTERMEDIATE_METEO_DIR

extract_d2 = importlib.import_module("backend.scripts.meteo.02_extract_hourly_fields")
extract_ruc = importlib.import_module("backend.scripts.meteo.02_extract_icon_d2_ruc_hourly_fields")

UTC = timezone.utc
DEFAULT_SUPPORT_NC = INTERMEDIATE_METEO_DIR / "icon_d2_smi9_support.nc"


def parse_run_steps(value: str) -> tuple[str, list[int]]:
    if ":" not in value:
        raise ValueError(f"Formato --run-step non valido: {value}. Atteso YYYYmmddHH:1,2,3")
    run, raw_steps = value.split(":", 1)
    extract_d2.parse_run_yyyymmddhh(run)
    steps = sorted({int(part) for part in raw_steps.split(",") if part.strip()})
    if not steps:
        raise ValueError(f"Nessun lead in --run-step {value}")
    bad = [step for step in steps if step < 0]
    if bad:
        raise ValueError(f"Lead time negativi non validi per {run}: {bad}")
    return run, steps


def build_steps_by_run(args: argparse.Namespace) -> dict[str, list[int]]:
    if args.run_step:
        out: dict[str, set[int]] = {}
        for value in args.run_step:
            run, steps = parse_run_steps(value)
            out.setdefault(run, set()).update(steps)
        return {run: sorted(steps) for run, steps in sorted(out.items())}

    if not args.runs:
        raise ValueError("Passa --run-step oppure --runs")

    steps = sorted(set(args.steps or []))
    if not steps:
        raise ValueError("Con --runs devi passare anche --steps")
    bad = [step for step in steps if step < 0]
    if bad:
        raise ValueError(f"Lead time negativi non validi: {bad}")

    out = {}
    for run in args.runs:
        extract_d2.parse_run_yyyymmddhh(run)
        out[run] = steps
    return out


def infer_step_deg(values: np.ndarray) -> np.float32:
    if values.size < 2:
        return np.float32(np.nan)
    diffs = np.diff(values.astype(np.float64))
    return np.float32(np.nanmedian(np.abs(diffs)))


def grids_equal(a: np.ndarray, b: np.ndarray) -> bool:
    return np.array_equal(a.astype(np.float32), b.astype(np.float32))


def regrid_regular_to_target(
    values: np.ndarray,
    source_lats: np.ndarray,
    source_lons: np.ndarray,
    target_lats: np.ndarray,
    target_lons: np.ndarray,
) -> np.ndarray:
    if grids_equal(source_lats, target_lats) and grids_equal(source_lons, target_lons):
        return values.astype(np.float32)

    da = xr.DataArray(
        values.astype(np.float32),
        dims=("lat", "lon"),
        coords={"lat": source_lats.astype(np.float32), "lon": source_lons.astype(np.float32)},
    )
    linear = da.interp(lat=target_lats, lon=target_lons, method="linear").values.astype(np.float32)
    if np.isfinite(linear).all():
        return linear

    nearest = da.interp(lat=target_lats, lon=target_lons, method="nearest").values.astype(np.float32)
    return np.where(np.isfinite(linear), linear, nearest).astype(np.float32)


def extract_smi9(
    run: str,
    step: int,
    raw_dir: Path,
    target_lats: np.ndarray,
    target_lons: np.ndarray,
) -> tuple[np.datetime64, np.datetime64, np.ndarray]:
    run_dt = extract_d2.parse_run_yyyymmddhh(run)
    run_dir = raw_dir / run
    level = int(ICON_D2_RAW_VARIABLES["smi9"]["levels"][0])
    smi9_file = extract_d2.find_soil_level_file(run_dir, "smi", level, step)
    arr, source_lats, source_lons, valid_time = extract_d2.extract_regular_variable(smi9_file, BBOX, "smi9")
    expected = run_dt + timedelta(hours=step)
    if valid_time != expected:
        raise RuntimeError(
            f"valid_time inatteso per {run} step={step}: cfgrib={valid_time.isoformat()} "
            f"atteso={expected.isoformat()}"
        )
    regridded = regrid_regular_to_target(arr, source_lats, source_lons, target_lats, target_lons)
    if not np.isfinite(regridded).all():
        raise RuntimeError(f"smi9 contiene NaN dopo il regrid per {run} step={step}")
    valid_np = np.datetime64(valid_time.replace(tzinfo=None), "s")
    run_np = np.datetime64(run_dt.replace(tzinfo=None), "s")
    return valid_np, run_np, regridded


def latest_by_valid_time(
    records: list[tuple[np.datetime64, np.datetime64, np.ndarray]]
) -> list[tuple[np.datetime64, np.datetime64, np.ndarray]]:
    chosen: dict[int, tuple[np.datetime64, np.datetime64, np.ndarray]] = {}
    for valid_time, run_time, arr in sorted(records, key=lambda item: (item[0], item[1])):
        key = int(valid_time.astype("datetime64[s]").astype(np.int64))
        chosen[key] = (valid_time, run_time, arr)
    return [chosen[key] for key in sorted(chosen)]


def save_support_dataset(ds: xr.Dataset, out_path: Path, overwrite: bool) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists() and not overwrite:
        raise FileExistsError(f"Output gia' esistente: {out_path}. Usa --overwrite.")
    encoding = {
        "smi9": {"zlib": True, "complevel": 4, "dtype": "f4"},
        "valid_time": {"dtype": "i8"},
        "d2_run_time": {"dtype": "i8"},
        "lat": {"dtype": "f4"},
        "lon": {"dtype": "f4"},
    }
    ds.to_netcdf(out_path, encoding=encoding)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Estrae solo smi9 da ICON-D2 come supporto per la pipeline ICON-D2-RUC."
    )
    parser.add_argument("--run-step", action="append", default=[], help="Specifica YYYYmmddHH:1,2,3. Ripetibile.")
    parser.add_argument("--runs", nargs="+", default=None, help="Run ICON-D2 YYYYmmddHH. Richiede --steps.")
    parser.add_argument("--steps", nargs="+", type=int, default=None, help="Lead da estrarre per tutte le run in --runs.")
    parser.add_argument("--raw-dir", default=str(ICON_D2_RAW_DIR))
    parser.add_argument("--out", default=str(DEFAULT_SUPPORT_NC))
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument(
        "--target-grid-nc",
        default=str(INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"),
        help="NetCDF da cui copiare lat/lon target. Default: hourly_buffer.nc.",
    )
    args = parser.parse_args()

    steps_by_run = build_steps_by_run(args)
    raw_dir = Path(args.raw_dir)
    out_path = Path(args.out)
    target_lats, target_lons, target_grid_source = extract_ruc.load_target_grid(
        Path(args.target_grid_nc) if args.target_grid_nc else None
    )

    print("ICON-D2 SMI9 SUPPORT EXTRACT")
    print(
        f"runs={len(steps_by_run)} target_grid={target_lats.size}x{target_lons.size} "
        f"target_source={target_grid_source} out={out_path}"
    )

    records: list[tuple[np.datetime64, np.datetime64, np.ndarray]] = []
    for run, steps in steps_by_run.items():
        print(f"  run={run} steps={steps}")
        for step in steps:
            valid_time, run_time, arr = extract_smi9(run, step, raw_dir, target_lats, target_lons)
            records.append((valid_time, run_time, arr))

    if not records:
        raise RuntimeError("Nessun record smi9 estratto")

    records = latest_by_valid_time(records)
    valid_times = np.array([record[0] for record in records], dtype="datetime64[s]")
    d2_run_times = np.array([record[1] for record in records], dtype="datetime64[s]")
    smi9 = np.stack([record[2] for record in records]).astype(np.float32)

    ds_out = xr.Dataset(
        data_vars={"smi9": (("valid_time", "lat", "lon"), smi9)},
        coords={
            "valid_time": valid_times,
            "lat": target_lats.astype(np.float32),
            "lon": target_lons.astype(np.float32),
            "d2_run_time": ("valid_time", d2_run_times),
        },
        attrs={
            "title": "ICON-D2 smi9 support for ICON-D2-RUC hourly pipeline",
            "summary": "Contains only smi9 on the project hourly target grid. It is merged into RUC hourly outputs before buffer update.",
            "source": "DWD ICON-D2 open data",
            "target_crs": TARGET_CRS,
            "target_grid_source": target_grid_source,
            "target_lat_step_deg": infer_step_deg(target_lats),
            "target_lon_step_deg": infer_step_deg(target_lons),
            "bbox_south": np.float32(BBOX["south"]),
            "bbox_north": np.float32(BBOX["north"]),
            "bbox_west": np.float32(BBOX["west"]),
            "bbox_east": np.float32(BBOX["east"]),
            "created_utc": datetime.now(UTC).isoformat(),
        },
    )
    ds_out["valid_time"].attrs.update(long_name="forecast valid time", timezone="UTC")
    ds_out["d2_run_time"].attrs.update(long_name="ICON-D2 run time used for smi9", timezone="UTC")
    ds_out["lat"].attrs.update(long_name="latitude", units="degrees_north")
    ds_out["lon"].attrs.update(long_name="longitude", units="degrees_east")
    ds_out["smi9"].attrs.update(long_name="soil moisture index, soil level 9", units="1")

    save_support_dataset(ds_out, out_path, overwrite=args.overwrite)
    print(
        f"[OK] SMI9 support written: {out_path} "
        f"valid_time={str(valid_times[0])}..{str(valid_times[-1])}"
    )


if __name__ == "__main__":
    main()
