from __future__ import annotations

import argparse
from pathlib import Path

from backend.src.accounts.gpx_validation import validate_gpx_gzip


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate a local .gpx.gz before trusted use.")
    parser.add_argument("path", type=Path)
    parser.add_argument("--max-compressed-bytes", type=int, default=10 * 1024 * 1024)
    parser.add_argument("--max-uncompressed-bytes", type=int, default=50 * 1024 * 1024)
    args = parser.parse_args()

    result = validate_gpx_gzip(
        args.path,
        max_compressed_bytes=args.max_compressed_bytes,
        max_uncompressed_bytes=args.max_uncompressed_bytes,
    )
    print(
        "[GPX VALIDATION] ok "
        f"compressed_bytes={result.compressed_size_bytes} "
        f"uncompressed_bytes={result.uncompressed_size_bytes} "
        f"track_points={result.track_point_count} "
        f"sha256={result.content_sha256}"
    )


if __name__ == "__main__":
    main()
