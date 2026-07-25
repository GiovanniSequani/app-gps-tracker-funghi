from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import load_dotenv

from backend.config.paths import FINAL_STATIC_DIR, OUT_PUBLIC_TERRAIN_DIR
from backend.src.publication.supabase import SupabaseClient, TerrainPublisher
from backend.src.publication.terrain import build_terrain_dataset


ROOT_DIR = Path(__file__).resolve().parents[3]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build and publish the versioned static terrain binary dataset."
    )
    parser.add_argument("--version", default="v1")
    parser.add_argument(
        "--source",
        default=str(FINAL_STATIC_DIR / "terrain_static_003deg.nc"),
    )
    parser.add_argument(
        "--output-root",
        default=str(OUT_PUBLIC_TERRAIN_DIR),
    )
    parser.add_argument("--chunk-size", type=int, default=50)
    parser.add_argument("--tpi-lower-m", type=float, default=-10.0)
    parser.add_argument("--tpi-upper-m", type=float, default=10.0)
    parser.add_argument(
        "--env-file",
        default=str(ROOT_DIR / "backend" / ".env"),
    )
    parser.add_argument("--bucket", default=None)
    parser.add_argument("--dry-run", action="store_true", help="Build locally without upload.")
    args = parser.parse_args()

    dataset = build_terrain_dataset(
        Path(args.source),
        Path(args.output_root),
        version=args.version,
        chunk_size=args.chunk_size,
        tpi_lower_m=args.tpi_lower_m,
        tpi_upper_m=args.tpi_upper_m,
    )
    manifest_path = dataset.output_dir / "manifest.json"
    print(
        f"[TERRAIN BUILD] version={dataset.version} grid="
        f"{dataset.manifest['rows']}x{dataset.manifest['cols']} "
        f"chunks={len(dataset.chunks)} bytes={dataset.total_chunk_bytes}"
    )
    print(f"[TERRAIN BUILD] manifest={manifest_path}")
    print(f"[TERRAIN BUILD] sha256={dataset.dataset_sha256}")

    if args.dry_run:
        print("[TERRAIN DRY RUN] local validation complete; Supabase was not contacted")
        return

    env_file = Path(args.env_file)
    if env_file.is_file():
        load_dotenv(env_file, override=False)
    bucket = args.bucket or os.getenv("SUPABASE_TERRAIN_BUCKET", "terrain")
    client = SupabaseClient.from_env(env_file)
    client.ensure_public_storage_bucket(bucket)
    result = TerrainPublisher(client, bucket=bucket).publish(dataset)
    print(
        f"[TERRAIN PUBLISH] action={result.action} version={result.version} "
        f"uploaded_objects={result.uploaded_objects} deleted_objects={result.deleted_objects}"
    )


if __name__ == "__main__":
    main()
