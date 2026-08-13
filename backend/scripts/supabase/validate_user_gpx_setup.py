from __future__ import annotations

import argparse
from pathlib import Path

from backend.src.accounts.gpx_setup import validate_gpx_setup_audit
from backend.src.publication.supabase import SupabaseClient


ROOT_DIR = Path(__file__).resolve().parents[3]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Read-only validation of the Supabase user/GPX archive setup."
    )
    parser.add_argument(
        "--env-file",
        default=str(ROOT_DIR / "backend" / ".env"),
        help="Backend env containing SUPABASE_URL and the service-role key.",
    )
    args = parser.parse_args()

    client = SupabaseClient.from_env(Path(args.env_file))
    summary = validate_gpx_setup_audit(client.rpc("user_gpx_setup_audit", {}))
    print(
        "[USER GPX SETUP] ok "
        f"max_tracks={summary.max_tracks_per_user} "
        f"max_compressed_bytes={summary.max_compressed_bytes} "
        f"max_uncompressed_bytes={summary.max_uncompressed_bytes} "
        f"profiles={summary.profile_count} tracks={summary.track_count}"
    )


if __name__ == "__main__":
    main()
