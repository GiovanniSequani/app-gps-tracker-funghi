from __future__ import annotations

import argparse
from pathlib import Path

import xarray as xr

from backend.config.index_config import (
    DEFAULT_SPECIES,
    INDEX_FEATURES_TEMPLATE,
    INDEX_OUTPUT_TEMPLATE,
)
from backend.src.index.scoring import compute_all_indices


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute mushroom suitability index from feature NetCDF.")
    parser.add_argument("--date", default=None, help="Target date YYYY-MM-DD. Required if --features is omitted.")
    parser.add_argument("--features", default=None, help="Input feature NetCDF.")
    parser.add_argument("--species", nargs="+", choices=list(DEFAULT_SPECIES), default=list(DEFAULT_SPECIES))
    parser.add_argument("--output", default=None, help="Output index NetCDF.")
    args = parser.parse_args()

    if args.features is None and args.date is None:
        raise SystemExit("Use --date YYYY-MM-DD or pass --features.")

    features_path = args.features or str(INDEX_FEATURES_TEMPLATE).format(date=args.date)
    ds = xr.open_dataset(features_path)
    target_date = args.date or ds.attrs.get("target_date")
    if not target_date:
        target_date = str(ds["time"].values[-1])[:10]

    out = compute_all_indices(ds, list(args.species))
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

