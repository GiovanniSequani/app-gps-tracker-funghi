from __future__ import annotations

import argparse
from pathlib import Path

from dotenv import load_dotenv

from backend.src.accounts.gpx_admission import (
    SupabaseAdmissionStorage,
    SupabaseAdmissionStore,
    validate_pending_gpx,
)
from backend.src.publication.supabase import SupabaseClient


DEFAULT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def main() -> None:
    parser = argparse.ArgumentParser(description="Server-side admission of uploaded GPX archives")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--run", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    args = parser.parse_args()
    if args.env_file.is_file():
        load_dotenv(args.env_file, override=False)
    try:
        client = SupabaseClient.from_env(args.env_file)
        store = SupabaseAdmissionStore(client)
        if args.dry_run:
            preview = store.preview()
            print(
                "[GPX ADMISSION PREVIEW] "
                f"eligible={preview.get('eligible', 0)} limit={preview.get('batch_limit', 0)}"
            )
            return
        result = validate_pending_gpx(store, SupabaseAdmissionStorage(client), limit=args.limit)
        print(
            "[GPX ADMISSION] "
            f"claimed={result.claimed} validated={result.validated} "
            f"rejected={result.rejected} failed={result.failed}"
        )
        if result.failed:
            raise SystemExit(1)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[GPX ADMISSION] failed error={type(exc).__name__}")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
