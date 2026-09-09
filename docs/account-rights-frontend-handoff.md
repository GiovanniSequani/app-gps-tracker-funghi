# Frontend handoff: export and account deletion

The base rights contract is active in production. Export-ready email and cloud
worker automation described below are planned and not implemented yet.

## Authenticated web and mobile

Export is available to `active` and `restricted` users:

```text
rpc('request_my_data_export')
```

Repeated requests return the current pending/ready job; the database enforces
the rate limit. Read only the signed-in user's `account_export_jobs` row. When
`status=ready` and `expires_at` is in the future, download `storage_path` from
the private `user-data-exports` bucket with the user's JWT. Never create a
public or long-lived signed URL. Show `pending/building/retry/ready/expired`
honestly and advise exporting before confirming deletion.

Start account deletion with:

```text
rpc('request_my_account_deletion_verification')
```

Always show the same “check your email” result. The email link opens the public
confirmation page, which submits the token once to:

```text
rpc('confirm_account_deletion', { p_verification_token: token })
```

After confirmation, clear private GPX/export state locally and treat the
account as `deletion_pending`. Do not poll Storage or simulate completion. Auth
will eventually become invalid after the backend hard-delete stage.

## Public web channel (`BE-ACCOUNT-006`)

Add a public deletion-request page with one email field. Call:

```text
rpc('request_external_account_deletion', { p_email: email })
```

The response is intentionally identical for existing, unknown and rate-limited
emails. Never display “account found”, inspect timings, or ask for GPX,
coordinates, password or identity documents. The emailed token is the identity
proof and arrives in the URL fragment `#token=...`, which is not sent to
Cloudflare. The public confirmation route must remove the fragment from the
address bar immediately after reading it, never log or persist it, then call
`confirm_account_deletion` once.

## Web handoff

Replace the current “non disponibile” notices with export/deletion UI only
after the three migrations and rights switch are ready in staging. Preserve
the server-authoritative lifecycle gate and map invariants. Add the public
email request and token callback route; never expose service-role or IMAP
credentials.

### Export-ready email (`WEB-004` / `BE-EMAIL-004`)

After `request_my_data_export`, replace wording that suggests an immediate
download with a clear background status, for example: “Stiamo preparando il
tuo archivio. Riceverai un'email quando sara' pronto; il link di download avra'
una scadenza.” Keep showing the real job status in the account panel.

The notification link must open the HTTPS account area only. If logged out,
require authentication and then reload the user's RLS-protected export job.
Download only when `status=ready` and `expires_at` is in the future. For an
expired job, offer a new request and do not call Storage. Do not read a Storage
path, signed URL, token or email address from the link. Deploy this promise only
after `BE-EMAIL-004` is live. While the worker remains a manually launched
daily pipeline, clearly describe the email as asynchronous rather than
immediate. `OPS-004` will later reduce the delay to approximately 1-5 minutes
without changing this frontend contract.

## Mobile handoff

Add export status/download and email-confirmed deletion to the account area.
Open the public HTTPS confirmation callback externally or with the existing
safe Auth/deep-link boundary. On `deletion_pending`, purge private GPX from UI
state without remounting/recentering the map. Never put verification tokens in
logs, analytics or persistent storage.
