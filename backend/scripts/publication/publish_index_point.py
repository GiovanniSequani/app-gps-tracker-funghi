from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import load_dotenv

from backend.config.index_config import INDEX_FEATURES_TEMPLATE, INDEX_OUTPUT_TEMPLATE
from backend.config.paths import OUT_PUBLIC_INDEX_POINT_DIR
from backend.src.publication.index_point import build_index_point_dataset
from backend.src.publication.supabase import IndexPointPublisher, SupabaseClient


ROOT_DIR = Path(__file__).resolve().parents[3]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build and atomically publish exact point scores and compact porcini diagnostics."
    )
    parser.add_argument("--index-date", required=True, help="Index date YYYY-MM-DD.")
    parser.add_argument("--index", default=None, help="Source index NetCDF.")
    parser.add_argument("--features", default=None, help="Source feature NetCDF.")
    parser.add_argument("--output-root", default=str(OUT_PUBLIC_INDEX_POINT_DIR))
    parser.add_argument("--chunk-size", type=int, default=50)
    parser.add_argument("--env-file", default=str(ROOT_DIR / "backend" / ".env"))
    parser.add_argument("--bucket", default=None)
    parser.add_argument("--dry-run", action="store_true", help="Build locally without upload.")
    args = parser.parse_args()

    index_path = Path(args.index or str(INDEX_OUTPUT_TEMPLATE).format(date=args.index_date))
    features_path = Path(args.features or str(INDEX_FEATURES_TEMPLATE).format(date=args.index_date))
    if not index_path.is_file():
        raise FileNotFoundError(f"index NetCDF not found: {index_path}")
    if not features_path.is_file():
        raise FileNotFoundError(f"feature NetCDF not found: {features_path}")

    dataset = build_index_point_dataset(
        index_path,
        features_path,
        Path(args.output_root),
        index_date=args.index_date,
        chunk_size=args.chunk_size,
    )
    print(
        f"[INDEX POINT BUILD] date={dataset.index_date} version={dataset.version} "
        f"grid={dataset.manifest['rows']}x{dataset.manifest['cols']} "
        f"chunks={len(dataset.chunks)} bytes={dataset.total_chunk_bytes} "
        f"raw_bytes={dataset.total_raw_chunk_bytes}"
    )
    print(f"[INDEX POINT BUILD] manifest={dataset.output_dir / 'manifest.json'}")
    print(f"[INDEX POINT BUILD] sha256={dataset.dataset_sha256}")
    if args.dry_run:
        print("[INDEX POINT DRY RUN] local validation complete; Supabase was not contacted")
        return

    env_file = Path(args.env_file)
    if env_file.is_file():
        load_dotenv(env_file, override=False)
    bucket = args.bucket or os.getenv("SUPABASE_INDEX_DATA_BUCKET", "index-data")
    client = SupabaseClient.from_env(env_file)
    client.ensure_public_storage_bucket(bucket)
    result = IndexPointPublisher(client, bucket=bucket).publish(dataset)
    print(
        f"[INDEX POINT PUBLISH] action={result.action} version={result.version} "
        f"uploaded_objects={result.uploaded_objects} deleted_objects={result.deleted_objects}"
    )


if __name__ == "__main__":
    main()
