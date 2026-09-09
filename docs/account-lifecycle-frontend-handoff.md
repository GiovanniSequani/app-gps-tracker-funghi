# Frontend contract: contributor account lifecycle

This is a prepared contract, not yet active in production.

## Shared contract

Read the public server contract:

```text
rpc('get_account_lifecycle_public_config')
```

It returns `lifecycle_enabled`, current Terms/Privacy versions and
`reaccept_days`. After cutover, signup metadata must include:

```json
{
  "username": "mario_rossi",
  "terms_accepted": true,
  "privacy_acknowledged": true,
  "terms_version": "<exact server value>",
  "privacy_version": "<exact server value>",
  "terms_acceptance_source": "web or mobile"
}
```

After every interactive login/foreground return, call
`get_my_account_access()`. If `needs_terms_action`, show the exact current
documents. Only after the screen is actually visible call:

```text
record_my_legal_notice_seen(terms_version, privacy_version, source)
```

This server event starts the 365-day deadline and is safe to repeat. Buttons
call `accept_current_contributor_terms(...)` or
`refuse_current_contributor_terms(...)`. Never infer access from JWT alone;
use `full_access`. Restricted users retain legal/acceptance UI plus the
separate export and deletion workflows documented in
`docs/account-rights-frontend-handoff.md`.

Record real use with
`record_my_meaningful_activity('interactive_login' | 'foreground_session' |
'account_action')`. Call it only for explicit foreground interaction, never for
token refresh, background fetch, retry, polling or push receipt. Archive REST,
Storage and edit RPCs are available only when `full_access=true`; handle the
server's restricted error as authoritative.

## Handoff web

Implement the shared contract using source `web`: load server versions before
signup, route authenticated outdated/restricted users to the legal screen,
record `notice_seen` only after render, expose accept/refuse, and record
meaningful activity only on real interactive login/foreground use. Do not add
service-role credentials or bypass GPX failures. Preserve the existing Auth
email/recovery callback.

## Handoff mobile

Implement the shared contract using source `mobile`: fetch exact server
versions before signup, gate archive screens on `full_access`, present current
documents before recording `notice_seen`, expose accept/refuse, and record
meaningful activity only when the signed-in app genuinely enters foreground.
Background tasks, token refresh and deep-link processing must not touch the
activity timestamp. Preserve map-camera invariants and existing Auth deep links.
