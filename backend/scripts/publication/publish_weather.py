from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import load_dotenv

from backend.config.paths import OUT_INDEX_NC_DIR, OUT_PUBLIC_WEATHER_DIR
from backend.src.publication.supabase import (
    SupabaseClient,
    WeatherPublisher,
    latest_tile_index_date,
    weather_publication_decision,
)
from backend.src.publication.weather import build_weather_dataset
from backend.src.meteo.time_series import save_composite_window


ROOT_DIR = Path(__file__).resolve().parents[3]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build and atomically publish the 20-day public weather dataset."
    )
    parser.add_argument("--index-date", required=True, help="Published index date YYYY-MM-DD.")
    parser.add_argument(
        "--source",
        default=None,
        help="Prepared weather source override. Default: temporary HRS/ICON composite.",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Local build directory. Defaults to backend/outputs/publication/weather/<date>.",
    )
    parser.add_argument(
        "--env-file",
        default=str(ROOT_DIR / "backend" / ".env"),
        help="Backend-only Supabase environment file.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Validate and build locally without upload.")
    parser.add_argument(
        "--skip-index-check",
        action="store_true",
        help="Allow local contract testing when the matching index NetCDF is absent.",
    )
    parser.add_argument("--batch-size", type=int, default=None)
    args = parser.parse_args()

    index_path = OUT_INDEX_NC_DIR / f"funghi_index_{args.index_date}.nc"
    if not args.skip_index_check and not index_path.is_file():
        raise FileNotFoundError(
            f"matching published index NetCDF not found: {index_path}"
        )

    composite_path: Path | None = None
    if args.source:
        source_path = Path(args.source)
    else:
        composite_path = OUT_PUBLIC_WEATHER_DIR / ".staging" / f"weather_source_{args.index_date}.nc"
        save_composite_window(args.index_date, 20, composite_path)
        source_path = composite_path
    try:
        dataset = build_weather_dataset(source_path, args.index_date)
    finally:
        if composite_path and composite_path.exists():
            composite_path.unlink()
    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else OUT_PUBLIC_WEATHER_DIR / args.index_date
    )
    metadata_path, values_path = dataset.save_local(output_dir)
    payload_bytes = sum(values.nbytes for values in dataset.values.values())
    print(
        f"[WEATHER BUILD] version={dataset.version} dates={dataset.dates[0]}..{dataset.dates[-1]} "
        f"grid={dataset.rows}x{dataset.cols} cells={dataset.expected_cells}"
    )
    print(
        f"[WEATHER BUILD] quantized_payload={payload_bytes} bytes "
        f"metadata={metadata_path} local_values={values_path}"
    )
    print(f"[WEATHER BUILD] sha256={dataset.content_sha256}")

    if args.dry_run:
        print("[WEATHER DRY RUN] local validation complete; Supabase was not contacted")
        return

    env_file = Path(args.env_file)
    if env_file.is_file():
        load_dotenv(env_file, override=False)
    if args.batch_size is not None:
        batch_size = args.batch_size
    else:
        try:
            batch_size = int(os.getenv("SUPABASE_WEATHER_BATCH_SIZE", "200"))
        except ValueError:
            batch_size = 200
    client = SupabaseClient.from_env(env_file)
    latest_index_date = latest_tile_index_date(client)
    decision = weather_publication_decision(dataset.version, latest_index_date)
    if decision == "skip_older":
        print(
            f"[WEATHER SKIP] requested={dataset.version} "
            f"latest_supabase_index={latest_index_date}; current weather was not changed"
        )
        return
    result = WeatherPublisher(client, batch_size=batch_size).publish(dataset)
    print(
        f"[WEATHER PUBLISH] action={result.action} version={result.version} "
        f"uploaded_cells={result.uploaded_cells}"
    )
    if result.storage_stats:
        print(f"[WEATHER POSTGRES] {result.storage_stats}")


if __name__ == "__main__":
    main()
