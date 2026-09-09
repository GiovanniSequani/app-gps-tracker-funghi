from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from backend.src.accounts.pending_uploads import (
    SupabasePendingUploadStorage,
    SupabasePendingUploadStore,
    cleanup_expired_pending_uploads,
)
from backend.src.publication.supabase import SupabaseClient


DEFAULT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Clean expired incomplete GPX upload reservations")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="show only aggregate eligible counts")
    mode.add_argument("--run", action="store_true", help="delete only claimed expired pending uploads")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--limit", type=int, default=None, help="cap this run at 1..500")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.env_file.is_file():
        load_dotenv(args.env_file, override=False)
    try:
        client = SupabaseClient.from_env(args.env_file)
        store = SupabasePendingUploadStore(client)
        now = datetime.now(timezone.utc)
        if args.dry_run:
            preview = store.preview(now)
            print(
                "[PENDING GPX PREVIEW] "
                f"ttl_hours={preview.get('ttl_hours')} limit={preview.get('cleanup_limit')} "
                f"eligible={preview.get('eligible', 0)} reclaimable={preview.get('reclaimable_claims', 0)}"
            )
            return
        result = cleanup_expired_pending_uploads(
            store, SupabasePendingUploadStorage(client), now=now, limit=args.limit
        )
        print(
            "[PENDING GPX CLEANUP] "
            f"claimed={result.claimed} cleaned={result.cleaned} failed={result.failed}"
        )
        if result.failed:
            raise SystemExit(1)
    except Exception as exc:
        # Do not emit Storage paths, user IDs, raw server responses or secrets.
        print(f"[PENDING GPX CLEANUP] failed error={type(exc).__name__}")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
