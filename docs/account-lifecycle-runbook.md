# Account lifecycle runbook

## Current status

Base migrations and follow-up fixes are applied to Supabase production. On 6
September 2026 the public web bundle and legal routes were verified live with
effective Terms 1.0 and Privacy 1.0. The pre-cutover RPC audit reported five
restricted profiles, zero legal events, an empty outbox, complete archive gates,
`lifecycle_enabled=false` and `account_rights_enabled=false`. The atomic script
`202609060001_enable_account_lifecycle_v1.sql` was then applied successfully:
the remote configuration now has lifecycle enabled with versions `1.0/1.0`,
while rights remains disabled. One controlled lifecycle email was sent on 6
September after applying the record-name fix; no other lifecycle email was
sent. There is no
separate staging project: destructive tests must use only disposable accounts,
never personal accounts.

The first authorized one-message dispatcher run on 6 September stopped before
claiming or sending any email. Production returned SQLSTATE `55000` from
`prepare_account_lifecycle_daily`: the function declared a PL/pgSQL record named
`profile` and also used `profile` as a SQL alias before assigning the record.
Apply the idempotent follow-up
`202609060002_fix_lifecycle_prepare_record_name.sql` before retrying the
dispatcher. A read-only preview after the failed run still reported exactly one
dispatchable email; no lifecycle email was sent.

## Components

- `202608290001_contributor_account_contract.sql`: profile states and one-time
  legacy backfill, with no retrodated legal deadline;
- `202608310001_account_lifecycle_and_email_outbox.sql`: disabled-by-default
  gate, lifecycle RPCs, meaningful activity, 24/36-month transitions, trusted
  selectors, outbox and leased daily-run lock;
- `202609060002_fix_lifecycle_prepare_record_name.sql`: production follow-up
  that removes the PL/pgSQL record/SQL-alias ambiguity in the daily preparer;
- `python -m backend.scripts.accounts.run_account_lifecycle`: the only daily
  command. `--dry-run` previews; `--send` mutates and dispatches sequentially.

The outbox contains user ID, event code, deadline/version payload and technical
status, but no GPX, marker, coordinate or copied recipient address. The email
is resolved from `auth.users` only while claimed. A unique `dedupe_key`, a
claim token, `SKIP LOCKED`, a global lease, capped attempts and exponential
backoff make database recovery idempotent. SMTP cannot provide strict
exactly-once delivery if a process dies after Gmail accepts a message but before
the database records `sent`; a stable `Message-ID` reduces diagnostics
ambiguity, but a rare duplicate remains a protocol-level residual risk.

Lifecycle email bodies are selected by `event_type`, not shared across all
notifications. Terms events explain the document update, required action,
deadline and consequence; inactivity events explain the inactivity threshold,
how to resume activity and the deletion deadline; deletion verification has its
own confirmation instructions. Deadlines are rendered as calendar dates
(`YYYY-MM-DD`), without technical timestamps. No GPX, coordinates or finding
data are included. This is backend code only and requires no Supabase
migration; deploy the backend before the next dispatcher run.

Template-only testing is isolated from Supabase:

```powershell
python -m backend.scripts.accounts.preview_lifecycle_emails --preview
python -m backend.scripts.accounts.preview_lifecycle_emails --send --pause-seconds 2
```

The command builds local fictitious `ClaimedEmail` artifacts and uses the same
SMTP sender as production. It never reads or changes profiles, lifecycle state,
job locks or outbox rows. The recipient is fixed to
`funghitracker@gmail.com`, subjects are prefixed with `[TEST]`, and the external
deletion token is deliberately invalid. On 6 September 2026 all 11 templates
were accepted by Gmail (`sent=11`) without SMTP errors.

## Secret storage

The future dispatcher uses a second Gmail App Password, independent from the
one stored by Supabase Auth. Store it only in the secret environment of the
always-on backend as `ACCOUNT_LIFECYCLE_SMTP_APP_PASSWORD`; never in Supabase
tables, client builds, repository, scheduler command line or logs. The other
names are documented in `backend/.env.example`. Do not create this credential
until the controlled production-cutover phase. In production it belongs only in
the worker secret store (not a repository file, task command line or client).

## Controlled production cutover

1. Freeze effective Terms and Privacy versions and publish their exact web URLs.
2. Apply `202608290001`, then `202608310001` to the current production project
   while both switches remain disabled.
3. Confirm `account_lifecycle_setup_audit()` reports
   `lifecycle_enabled=false`; test legacy/new users, cross-user REST, every GPX
   RPC and Storage operation.
4. Deploy web/mobile handling from
   `docs/account-lifecycle-frontend-handoff.md` while the gate is still off.
5. Configure the dedicated dispatcher secret and an always-on daily scheduler.
6. In one controlled transaction set `current_terms_version`,
   `current_privacy_version` and finally `lifecycle_enabled=true`. Never invent
   versions before the legal documents become effective.
7. Run `--dry-run`, inspect counts, then run `--send` with a very low daily
   limit against controlled accounts before allowing real recipients.
8. Verify first authenticated display starts a 365-day deadline, while an
   unopened/email-only legacy account still has no deadline.

The 6 September lifecycle-only cutover was applied as one transaction. The
post-cutover public config and service-role audit confirmed `1.0/1.0`, lifecycle
enabled, rights disabled, all five existing profiles still restricted, no legal
event, no queued email and all archive gates present. Complete the authenticated
web acceptance test before any email dispatch.

The authenticated web test is complete: acceptance produced an active 1.0/1.0
profile, refusal preserved `restricted/terms_refused`, and both deadlines were
anchored to the real first notice display plus 365 days. The accepted account's
initial email was cancelled. The controlled refusal email was then sent once
after `202609060002`; the final preview reported zero dispatchable emails.
Public index access correctly remained independent from contributor-account
restrictions.

Commands, always from repository root:

```powershell
python -m backend.scripts.accounts.run_account_lifecycle --dry-run
python -m backend.scripts.accounts.run_account_lifecycle --send --daily-limit 5 --pause-seconds 10
```

Never use `--send` before the legal cutover and explicit authorization for real
communications.

## Temporary local daily pipeline

Until the backend is moved to an always-available cloud VM, launch once per day
from Windows:

```powershell
backend\scripts\run_daily_account_pipeline.bat
```

Use the non-mutating mode before the first live run, after configuration or
migration changes, and whenever an output is unexpected:

```powershell
backend\scripts\run_daily_account_pipeline.bat --dry-run
```

The launcher changes to the repository root and delegates to the testable
Python orchestrator. It runs, in strict order: expired `pending_upload` cleanup,
lifecycle transitions/email, then export/deletion/retention rights. A non-zero
step stops the pipeline immediately. Live limits are 100 lifecycle emails with
a five-second pause, 20 exports, 100 deletions and 20 old-email cleanup rows.
Each invocation writes one combined log under
`backend/logs/account-lifecycle/`; the directory is gitignored and child
commands emit only aggregate counts and technical error classes.

Before relying on the 100-email limit, apply the idempotent migration
`202609060005_account_pipeline_operational_limits.sql`. The database currently
caps the CLI value, so changing only the `.bat` is insufficient. The migration
sets limit 100 and pause 5 without changing either lifecycle or rights switch.
The limit must be reviewed deliberately as the number of users grows and after
checking Gmail quota and delivery behaviour.

If a step fails, inspect that execution's log and rerun the complete pipeline
after correcting the cause. Claims, leases and deduplication make this safe;
skipping a day delays work but does not lose it.

After applying `202609060002`, first repeat `--dry-run` and require
`enabled=True`, no due state transitions, and the expected controlled email
count. Then retry with `--send --daily-limit 1 --pause-seconds 0`. Stop if the
recipient or event count differs from the previously authorized controlled
message.

## Incomplete GPX uploads

`202608310001` also adds a server-side cleanup for reservations that remain
`pending_upload`. The configured default is 24 hours, deliberately longer than
an ordinary mobile upload. It claims a bounded batch with `SKIP LOCKED`, deletes
only the exact `user-gpx` object of that reservation, verifies the object is
gone, and only then removes its metadata. `ready` tracks are never candidates.
A failed Storage deletion returns the reservation to `pending_upload`; a worker
crash is reclaimable after the 15-minute claim lease.

After that migration and before enabling lifecycle access, schedule this
separate backend-only command once per day (or run it with the other daily
workers). Start with the aggregate-only preview:

```powershell
python -m backend.scripts.accounts.cleanup_pending_gpx_uploads --dry-run
python -m backend.scripts.accounts.cleanup_pending_gpx_uploads --run
```

## Recovery and rollback

A process error releases the daily run as `available`; claimed email becomes
`retry` with backoff. A crashed claim is reclaimed after 15 minutes. Repeating
the same UTC day resumes its attempt counter and cannot exceed the database or
CLI daily limit. A completed day is not rerun; pending messages resume next day.

Emergency access rollback is to set `lifecycle_enabled=false`. This restores
legacy archive access but does not erase states, deadlines, events or outbox.
Disable the scheduler separately. Do not delete outbox rows as a rollback.

Physical account deletion, export and Gmail/outbox retention are implemented by
the separate disabled-by-default block documented in
`docs/account-rights-runbook.md`. Production cutover remains incomplete.

## Immediate signup recovery (before lifecycle cutover)

Apply `202609040001_fix_disabled_lifecycle_signup_contract.sql` and then
`202609050001_fix_legacy_web_signup_contract.sql` in the Supabase SQL Editor
after the two lifecycle prerequisites. Both only replace the Auth profile
trigger. The follow-up also accepts the deployed web transition payload, which
contains terms and privacy acceptance but intentionally no raw-GPX consent.
An omitted consent is stored as `false` and `legacy-disabled`, never invented as
research authorization.

After it reports success, register one disposable account using the current
web or mobile client, then verify that a profile is created and the archive is
usable while the switch remains disabled. Do not enable the lifecycle switch or
run lifecycle email dispatch as part of this recovery.
