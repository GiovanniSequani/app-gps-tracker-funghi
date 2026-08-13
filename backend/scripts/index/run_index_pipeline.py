from __future__ import annotations

import argparse
import sys

from backend.scripts.pipeline_logging import run_logged_cmd


def run_cmd(cmd: list[str]) -> None:
    returncode = run_logged_cmd(cmd)
    if returncode != 0:
        raise RuntimeError(f"Command failed with exit code {returncode}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run feature build and mushroom index scoring.")
    parser.add_argument("--date", default=None, help="Target date YYYY-MM-DD. Defaults to latest meteo date.")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--species", nargs="+", choices=["porcini", "finferli"], default=["porcini", "finferli"])
    parser.add_argument("--meteo-dir", default=None, help="Directory containing yearly ICON-RUC/HRS series.")
    args = parser.parse_args()

    py = args.python
    build_cmd = [py, "-m", "backend.scripts.index.01_build_index_features"]
    if args.date:
        build_cmd += ["--date", args.date]
    if args.meteo_dir:
        build_cmd += ["--meteo-dir", args.meteo_dir]
    run_cmd(build_cmd)

    compute_cmd = [py, "-m", "backend.scripts.index.02_compute_funghi_index"]
    if args.date:
        compute_cmd += ["--date", args.date]
    else:
        from backend.config.index_config import INDEX_FEATURES_TEMPLATE
        from pathlib import Path

        feature_dir = Path(str(INDEX_FEATURES_TEMPLATE)).parent
        latest = sorted(feature_dir.glob("index_features_*.nc"))[-1]
        compute_cmd += ["--features", str(latest)]
    compute_cmd += ["--species", *args.species]
    run_cmd(compute_cmd)

    print("\nDone")


if __name__ == "__main__":
    main()
