from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path

import xarray as xr

from backend.config.index_config import (
    DEFAULT_SPECIES,
    INDEX_OUTPUT_TEMPLATE,
    INDEX_FEATURES_TEMPLATE,
    RECOVERY_LOOKBACK_DAYS,
)
from backend.src.index.scoring import RecoveryHistory, compute_all_indices


def parse_index_date(path: Path) -> datetime | None:
    stem = path.stem
    prefix = "funghi_index_"
    if not stem.startswith(prefix):
        return None
    raw_date = stem[len(prefix):]
    try:
        return datetime.strptime(raw_date, "%Y-%m-%d")
    except ValueError:
        return None


def load_recovery_history(
    history_dir: Path,
    target_date: str,
    species_list: list[str],
    lookback_days: int = RECOVERY_LOOKBACK_DAYS,
) -> RecoveryHistory:
    try:
        target = datetime.strptime(target_date, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"target_date must be YYYY-MM-DD, got: {target_date}") from exc

    history: RecoveryHistory = {species: [] for species in species_list}
    if not history_dir.is_dir():
        print(f"[RECOVERY] history dir not found, recovery history disabled: {history_dir}")
        return history

    candidates: list[tuple[int, Path]] = []
    for path in sorted(history_dir.glob("funghi_index_*.nc")):
        item_date = parse_index_date(path)
        if item_date is None:
            continue
        lag = (target - item_date).days
        if 1 <= lag <= lookback_days:
            candidates.append((lag, path))

    if not candidates:
        print("[RECOVERY] no previous index NetCDFs found in lookback window")
        return history

    loaded = 0
    for lag, path in sorted(candidates):
        try:
            previous = xr.open_dataset(path)
            previous.load()
            previous.close()
        except Exception as exc:
            print(f"[RECOVERY] skip unreadable history file {path.name}: {type(exc).__name__}: {exc}")
            continue
        for species in species_list:
            history[species].append((lag, previous))
        loaded += 1

    print(f"[RECOVERY] loaded {loaded} previous index file(s) from {history_dir}")
    return history


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute mushroom suitability index from feature NetCDF.")
    parser.add_argument("--date", default=None, help="Target date YYYY-MM-DD. Required if --features is omitted.")
    parser.add_argument("--features", default=None, help="Input feature NetCDF.")
    parser.add_argument("--species", nargs="+", choices=list(DEFAULT_SPECIES), default=list(DEFAULT_SPECIES))
    parser.add_argument("--output", default=None, help="Output index NetCDF.")
    parser.add_argument("--no-recovery", action="store_true", help="Disable temporal recovery and write base scores only.")
    parser.add_argument(
        "--history-dir",
        default=None,
        help="Directory containing previous funghi_index_YYYY-MM-DD.nc files for recovery.",
    )
    args = parser.parse_args()

    if args.features is None and args.date is None:
        raise SystemExit("Use --date YYYY-MM-DD or pass --features.")

    features_path = args.features or str(INDEX_FEATURES_TEMPLATE).format(date=args.date)
    ds = xr.open_dataset(features_path)
    target_date = args.date or ds.attrs.get("target_date")
    if not target_date:
        target_date = str(ds["time"].values[-1])[:10]

    history_dir = Path(args.history_dir) if args.history_dir else Path(str(INDEX_OUTPUT_TEMPLATE)).parent
    recovery_history = (
        load_recovery_history(history_dir, str(target_date), list(args.species))
        if not args.no_recovery
        else None
    )

    out = compute_all_indices(
        ds,
        list(args.species),
        recovery_history=recovery_history,
        enable_recovery=not args.no_recovery,
    )
    output_path = args.output or str(INDEX_OUTPUT_TEMPLATE).format(date=target_date)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    out.to_netcdf(output_path)

    print(f"[OK] Index dataset written: {output_path}")
    for species in args.species:
        score = out[f"{species}_score"]
        print(
            f"     {species}: min={float(score.min()):.1f} "
            f"mean={float(score.mean()):.1f} max={float(score.max()):.1f}"
        )


if __name__ == "__main__":
    main()
