# Account rights, export and deletion runbook

## Current status

The rights migrations are installed and `account_rights_enabled=true` in
production since 6 September 2026. `lifecycle_enabled=true` and legal versions
1.0/1.0 were preserved. The export bucket is private. The controlled cutover
used only disposable accounts and left zero export and external-request rows;
no real account or user GPX was modified. There is no separate staging project.

## Architecture

`202609010001_account_rights_export_deletion.sql` adds a second independent
cutover switch: `account_rights_enabled=false`. It provides:

- authenticated export requests for `active` and `restricted` accounts;
- a private `user-data-exports` bucket and ready/expiry RLS;
- one-time email verification for authenticated or external deletion requests;
- a generic external response that does not reveal whether an email exists;
- resumable deletion stages: Gmail, Storage, application database, Supabase Auth;
- exact-path Storage cleanup derived from `storage.objects` for only that user;
- 24-month service-email retention and 30-day cleanup of verification records;
- rate limits, leases, bounded retries and exponential backoff.

The verification token is valid for 48 hours by default because the existing
outbox dispatcher runs once daily; it is single-use, stored only as a hash in
the request table, and scrubbed from the outbox after delivery or expiry.

An export ZIP contains `account.json`, profile, legal events, track metadata,
marker metadata, minimal service-email events and every raw GPX object that
exists. Already-gzipped GPX files are copied without recompression and Storage
is streamed in 1 MiB chunks. The local ZIP exists only in a temporary directory.
The remote object is private and normally expires after 24 hours.

Supabase installs `pgcrypto` under the `extensions` schema. The follow-up
`202609050002_fix_account_rights_pgcrypto_resolution.sql` qualifies every
cryptographic call made from `SECURITY DEFINER` functions with an empty
`search_path`. It also defers token generation until after the rights switch,
so the public non-enumerating endpoint remains a harmless accepted no-op while
rights are disabled.

Deletion is fail-closed. Database rows are not removed until the worker has
verified that both private buckets contain no object under the user folder and
that automated Gmail cleanup completed. Auth is hard-deleted last with
`should_soft_delete=false`. A crash after Auth accepted the deletion is safe:
retry treats a missing Auth user as already deleted and finishes the anonymous
job audit row. Existing JWTs can remain cryptographically valid until expiry,
but profile/RLS data are already gone and refresh sessions are removed by Auth.

## Gmail boundary

SMTP cannot delete sent mail. The rights worker uses Gmail IMAP over TLS with
the dedicated lifecycle App Password. It deletes only:

- lifecycle messages with the exact backend `Message-ID`;
- Supabase Auth messages whose decoded subject exactly equals one of the
  configured automated subjects;
- for account deletion, only exact Auth subjects addressed exactly to that
  account email.

Search matches are re-read and checked before deletion. Do not add assistance
or free-form subjects to `ACCOUNT_AUTH_SERVICE_EMAIL_SUBJECTS_JSON`. If the
allow-list or IMAP access is missing, deletion stops at `email_cleanup`; it must
never claim completion by broadly deleting the mailbox. Verification tokens
are removed from the outbox immediately after send, cancellation or expiry.

## Backend command

Run from repository root only after the controlled production cutover:

```powershell
python -m backend.scripts.accounts.run_account_rights --dry-run
python -m backend.scripts.accounts.run_account_rights --run --max-exports 3 --max-deletions 3
```

The live command performs, in order: prepare/recover leases, build exports,
remove expired exports, clean service email older than 24 months, then process
deletion jobs. Logs contain counts and error class only, never email, token,
coordinates, paths or user ID.

## Export-ready notification (`BE-EMAIL-004`)

Apply `202609070001_export_ready_email.sql` after the existing rights cutover
migrations. It extends the existing outbox with `export_ready` and replaces
`complete_account_export` so the transition to `ready` and the enqueue happen
in the same database transaction. The dedupe key is unique per export job. The
payload contains only the export ID and expiry timestamp: no Storage path,
signed URL, token, email, GPX, marker or coordinate.

The dispatcher sends the expiry as `YYYY-MM-DD` and links only to the HTTPS
account area. The user must authenticate and existing RLS authorizes the ZIP.
An SMTP failure retries only the notification; it never invalidates or removes
an already ready export. Under the current manual pipeline, an export created
by the rights step is normally emailed by the next daily lifecycle dispatcher
run because lifecycle currently runs before rights. `OPS-004` will reduce this
latency to 1-5 minutes without changing the client contract.

Controlled template test:

```powershell
python -m backend.scripts.accounts.preview_lifecycle_emails --preview --event export_ready
python -m backend.scripts.accounts.preview_lifecycle_emails --send --event export_ready --pause-seconds 0
```

On 7 September 2026 Gmail SMTP accepted one isolated `export_ready` template
test sent to the controlled project inbox. On 8 September 2026, after applying
the migration, a disposable production account verified the full path: request,
private ZIP, owner-only download, one queued `export_ready` row with minimal
payload, SMTP acceptance of that exact queued template and final
Storage/database/Auth cleanup. No test
account, object, export row or outbox row remained.

## Planned cloud automation

`OPS-004` will run this rights worker from an always-available backend every
1-5 minutes, so export generation no longer depends on the operator's PC or a
manual command. Lifecycle transitions remain daily. The deployment must keep
service-role and SMTP/IMAP credentials only in cloud secrets and reuse the
existing claims, retries and idempotency; frontend RPCs and Storage paths do not
change.

`BE-EMAIL-004` uses the existing outbox as described above. The cloud worker
will dispatch it promptly after the ZIP is committed as ready. The email links
to the HTTPS account area, not to a public or long-lived signed Storage URL,
and never attaches the location-rich ZIP.

While operation remains local, rights are run as the third step of
`backend\scripts\run_daily_account_pipeline.bat`, capped at 20 exports and 100
deletions per invocation. It remains separate from the fungus/weather pipeline.

After `202609090001`, the account pipeline has four stages: expired pending
upload cleanup, GPX admission, lifecycle, then rights. The rights worker itself
processes deletion jobs before export construction and maintenance. Expired
export cleanup is bounded by `--max-expired-exports`,
`--max-expired-export-bytes` and `--max-expired-export-seconds`; defaults are
20 objects, 1 GiB and 120 seconds per run. The
SQL claim will not lease an object larger than the remaining byte budget.

Export requests calculate `input_size_bytes` from server-validated GPX only.
The database enforces per-export and aggregate tenant 24-hour input budgets.
Unknown email addresses sent to the public deletion RPC receive the same
generic response but create no row and consume no global delivery quota.

```powershell
python -m backend.scripts.accounts.run_account_rights --run --max-exports 20 --max-deletions 100 --email-cleanup-limit 20 --max-expired-exports 20 --max-expired-export-bytes 1073741824 --max-expired-export-seconds 120
```

## Controlled production cutover

Completed on 6 September 2026.

1. Apply migrations in order: `202608290001`, `202608310001`, then
   `202609010001`, followed by the signup and pgcrypto follow-ups through
   `202609050002`, in the current production project while both switches remain
   disabled.
2. Confirm `account_rights_setup_audit()` reports disabled and a private export
   bucket.
3. Configure exact current Auth template subjects, the public deletion callback
   URL, IMAP and the dedicated lifecycle App Password in backend secrets.
4. Test controlled empty, full and restricted accounts; inject Storage and Auth
   failures; verify ZIP expiry and cross-user denial.
5. Deploy frontend handoffs while rights remain disabled.
6. Set `account_rights_enabled=true` only in a monitored production window. Run
   `--dry-run`, then `--run` against disposable accounts.
7. Configure an always-on daily scheduler only after the controlled mailbox and
   hard-delete tests pass.

Follow-up migrations used by the cutover are
`202609060003_fix_account_deletion_callback_grant.sql` and
`202609060004_enable_account_rights.sql`. The former restores only the public
one-time callback grant; the latter validates lifecycle, legal versions,
private Storage and grants before changing only the rights switch.

### Production evidence (disposable accounts only)

- two active accounts with synthetic GPX and mushroom markers were isolated by
  Postgres RLS and private Storage policies in both directions;
- a complete export ZIP was built, downloaded by its owner and denied to the
  other account; raw GPX and marker contents matched the source;
- expiry removed the job and object; a fresh non-cached download was denied;
- the external request sent one real verification email, the anonymous
  callback succeeded once and token replay was rejected;
- an injected Storage failure resumed at `storage_cleanup`; an injected Auth
  failure resumed at `auth_cleanup`; the final retry removed Storage,
  application rows and Auth in order;
- the final audit reported rights enabled, private bucket and zero test residue.

During this test Gmail exposed two IMAP interoperability defects: mailbox names
such as `[Gmail]/Sent Mail` and SEARCH values containing spaces were not quoted.
`backend/src/accounts/rights.py` now quotes both, with regression tests and a
real non-destructive IMAP query.

## Recovery

Export and deletion claims expire after 30 minutes. Retry resumes the current
stage; it never restarts or skips completed destructive stages. Storage and
Gmail deletion are idempotent. Export upload uses a canonical per-job path, so
a retry replaces only that unfinished export. Deletion retries are capped at
100 attempts with one-day maximum backoff; an exhausted job requires operator
review before the legal 30-day deadline.

Disabling `account_rights_enabled` stops new requests and daily transitions but
does not undo a partially completed deletion. Pause the worker and inspect the
job stage; never manually mark it complete.

No current modelling pipeline stores user-linked derived artifacts outside the
GPX/marker tables and registered Storage objects. If that changes, the new
artifact location must be added to the deletion state machine before use.
