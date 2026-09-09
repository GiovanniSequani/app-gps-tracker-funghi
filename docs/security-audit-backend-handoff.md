# Handoff client - hardening account/GPX 2026-09-09

Migration backend: `202609090001_security_audit_backend_hardening.sql`.

Web e mobile non devono modificare il normale upload: reserve, upload privato e
`finalize_my_gpx_track` restano compatibili. Dopo finalize la traccia può avere
`validation_status` `pending`, `legacy_unverified`, `validating`, `validated` o
`rejected`. Se mostrato, usare “verifica in corso”; per `rejected`, informare
che il file non è valido e permettere la cancellazione metadata. Il client non
può promuovere lo stato.

Se un client chiamava `has_current_contributor_access(other_uuid)`, deve usare
`get_my_account_access_state()` oppure il booleano owner-only
`has_my_current_contributor_access()`.

Upload/export possono restituire errori per quote configurabili. Non duplicare
soglie nel frontend. Nessun endpoint, bucket o path pubblico nuovo è richiesto.
