# Email Auth: configurazione e collaudo

Questo runbook copre `BE-EMAIL-001` e `EMAIL-CONFIRM-001`. Non copre il
dispatcher o la retention delle comunicazioni (`BE-EMAIL-002/003`). Nessuna
App Password deve essere salvata nel repository, in file `.env`, nei log o in
comandi copiati nella shell.

## Hardening SEC-AUD-001/002/004 - 9 settembre 2026

Il contratto corrente usa esclusivamente questi callback HTTPS, sia per web
sia per mobile:

```text
https://web-funghi-index.pages.dev/auth/confirm
https://web-funghi-index.pages.dev/auth/recovery
```

Il web disabilita `detectSessionInUrl`, riconosce callback soltanto sui due path
esatti, acquisisce `token_hash` dal fragment e riscrive immediatamente la URL
prima del render. Il mobile accetta gli stessi URL soltanto dall'origin esatto
e li riceve tramite Android App Links verificati o iOS Universal Links. Lo
schema custom `funghitracker` non e' un callback Auth e non deve mai ricevere
token, bearer o credenziali monouso.

Il codice e i test locali sono completati. Lo stato resta `IN-PROGRESS` finche'
template Supabase, file di associazione sul dominio, build firmata e flussi
reali con account usa-e-getta non sono verificati.

## Stato verificato il 31 agosto 2026

- L'endpoint pubblico `/auth/v1/settings` restituisce provider email attivo,
  signup attivo e `mailer_autoconfirm=false`: la conferma email e quindi
  attualmente richiesta.
- Mobile e web chiamano `signUp()` senza `emailRedirectTo`; Supabase usa quindi
  il Site URL configurato come fallback.
- Il mobile non dichiara uno URL scheme Auth e usa `detectSessionInUrl=false`.
- Non esiste ancora un flusso client per `resetPasswordForEmail()` e
  `updateUser({password})`.
- Il sito di produzione dichiarato dal repository web,
  `https://web-funghi-index.pages.dev/`, ha risposto HTTP 200 al controllo del
  31 agosto 2026.
- SMTP personalizzato, Site URL, allow-list e template non sono leggibili con
  anon/service-role key. Servono Dashboard o un Management API access token.
- Dopo la configurazione manuale, l'audit Management API del 31 agosto 2026 ha
  verificato con esito positivo Gmail `smtp.gmail.com:587`, identita mittente,
  Site URL, redirect, conferma obbligatoria e template email/recovery. La
  registrazione/conferma e il recupero password sono stati successivamente
  collaudati con invii reali sia da web sia da mobile. Il token Management
  temporaneo risulta rimosso dal file `backend/.env`.

## Diagnosi del vecchio errore

I log storici mostravano richieste `/verify` con referer
`http://localhost:3000` e `One-time token not found`. Il redirect localhost e
spiegato: nessun client passava un redirect esplicito e il Site URL Supabase
era rimasto al valore predefinito. Il redirect errato non elimina pero il token:
`One-time token not found` significa che il link era gia stato consumato,
invalidato da un nuovo invio oppure era scaduto. I tentativi ripetuti osservati
non permettono di distinguere retroattivamente queste cause.

Per evitare il caso noto dei link scanner, le nuove callback non devono
verificare automaticamente il token al semplice caricamento della pagina:
mostrano prima un pulsante esplicito e chiamano `verifyOtp()` solo dopo il tap.

## Operazioni manuali Google

1. Accedere all'account `funghitracker@gmail.com` e abilitare la verifica in
   due passaggi.
2. In **Account Google > Sicurezza > Password per le app**, creare una password
   dedicata, con nome riconoscibile come `Supabase FunghiTracker Auth`.
3. Copiarla direttamente nel campo password SMTP di Supabase. Non comunicarla
   in chat e non conservarla in repository o `.env`.
4. Se il menu App Password non compare, verificare che 2FA sia completata e
   che l'account non usi una configurazione Google che vieta le App Password.

Rotazione: creare prima una nuova App Password, sostituirla in Supabase,
eseguire conferma e recovery reali, quindi revocare quella precedente. In caso
di sospetta esposizione, revocare subito la password e sospendere gli invii
finche il nuovo test non passa.

## Operazioni manuali Supabase

In **Authentication > Email/SMTP settings**, abilitare Custom SMTP:

```text
Sender email: funghitracker@gmail.com
Sender name:  FunghiTracker
Host:         smtp.gmail.com
Port:         587
Username:     funghitracker@gmail.com
Password:     App Password Google (solo nel secret Dashboard)
TLS:          abilitato / STARTTLS
```

In **Authentication > URL Configuration**:

```text
Site URL
https://web-funghi-index.pages.dev

Additional Redirect URLs
https://web-funghi-index.pages.dev/auth/confirm
https://web-funghi-index.pages.dev/auth/recovery
http://localhost:5173/auth/confirm
http://localhost:5173/auth/recovery
```

Usare path esatti in produzione, senza wildcard. `localhost` resta soltanto
nella allow-list di sviluppo e non deve mai essere il Site URL.
Rimuovere dalla allow-list `funghitracker://auth/confirm`,
`funghitracker://auth/recovery` e il vecchio
`https://web-funghi-index.pages.dev/auth/mobile-confirm`.

Lasciare **Confirm email** attivo. Controllare inoltre che il rate limit email
sia prudente e compatibile con Gmail; non alzarlo per aggirare errori di
configurazione.

I template **Confirm signup** e **Reset password** devono usare `TokenHash` e
la callback esplicita scelta dal client, per esempio:

```html
<!-- Conferma: il client passa /auth/confirm come RedirectTo -->
<a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}&type=email">
  Conferma indirizzo email
</a>

<!-- Recovery: il client passa /auth/recovery come RedirectTo -->
<a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}&type=recovery">
  Reimposta password
</a>
```

La callback deve accettare soltanto `type=email` o `type=recovery`, non deve
scrivere token o email nei log e deve richiedere un tap prima di chiamare
`verifyOtp({token_hash, type})`.

Il fragment e' intenzionale: non viene inviato nella richiesta HTTP iniziale a
Cloudflare e quindi non entra nella query dei log edge. Non sostituirlo con una
query. Il supporto client alla vecchia query e' solo transitorio: la callback
la cancella prima del render, ma non puo' annullare l'eventuale registrazione
della prima richiesta gia' avvenuta al provider.

## Associazioni verificate mobile

L'Expo config dichiara `applinks:web-funghi-index.pages.dev` su iOS e intent
HTTPS Android `autoVerify=true` limitati a `/auth/confirm` e
`/auth/recovery`. Prima della build candidata pubblicare, senza redirect:

`https://web-funghi-index.pages.dev/.well-known/assetlinks.json`

```json
[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"com.giovannisequani.funghitracker","sha256_cert_fingerprints":["<SHA256_PLAY_APP_SIGNING>"]}}]
```

Inserire anche il fingerprint EAS se APK preview e AAB Play sono firmati da
certificati diversi. Il valore e' il fingerprint pubblico, mai la keystore.

`https://web-funghi-index.pages.dev/.well-known/apple-app-site-association`

```json
{"applinks":{"details":[{"appIDs":["<APPLE_TEAM_ID>.com.giovannisequani.funghitracker"],"components":[{"/":"/auth/confirm"},{"/":"/auth/recovery"}]}]}}
```

Il file Apple non ha estensione. Entrambi devono rispondere `200`, content type
JSON, senza redirect e senza fallback HTML. Fingerprint di produzione e Team
ID non sono presenti nel repository: non usare placeholder nel deploy.

Dopo una conferma o un recupero completati, i link della callback web devono
portare a `https://web-funghi-index.pages.dev/mappa/`, non a `/`: la root e ora
la home pubblica. Il `RedirectTo` dell'email resta invece la callback esatta
`/auth/confirm` o `/auth/recovery`, perche la verifica deve avvenire prima del
ritorno alla mappa.

## Audit backend senza esporre segreti

Il controllo pubblico usa la chiave gia presente nel backend:

```powershell
python -m backend.scripts.supabase.audit_auth_email_setup
```

Per controllare anche Site URL, redirect e SMTP, creare temporaneamente un
Personal Access Token Supabase, impostarlo soltanto nella sessione PowerShell e
revocarlo appena finito:

```powershell
$authAuditCredential = Get-Credential -UserName token -Message "Supabase access token"
$env:SUPABASE_ACCESS_TOKEN = $authAuditCredential.GetNetworkCredential().Password
python -m backend.scripts.supabase.audit_auth_email_setup --require-management
Remove-Item Env:SUPABASE_ACCESS_TOKEN
Remove-Variable authAuditCredential
```

Lo script non legge né stampa la password SMTP, token o destinatari.

## Collaudo reale richiesto prima di `DONE`

Usare indirizzi di test controllati e non riportarli nei log o nella roadmap.

1. Registrazione web: arriva una sola email; il primo tap conferma; login
   riuscito; `email_confirmed_at` valorizzato; nessun URL contiene localhost.
2. Registrazione mobile: stesso test tramite App/Universal Link verificato,
   app chiusa e aperta;
   callback riconosciuta e login successivo riuscito.
3. Recovery web e mobile: richiesta con messaggio non enumerativo, callback,
   nuova password, login con nuova password e rifiuto della vecchia.
4. Sviluppo locale: solo i callback `localhost:5173` sono accettati.
5. Link riaperto: errore comprensibile e nessun crash; il token resta one-shot.
6. Verificare Auth logs e Gmail Sent senza copiare email, token o link nel
   repository. Annotare nella roadmap soltanto esito, data e tipo di prova.

## Handoff web (`EMAIL-CONFIRM-001`)

Implementare `/auth/confirm` e `/auth/recovery` nel sito statico Cloudflare.
Passare sempre il callback esplicito a `signUp({options.emailRedirectTo})` e
`resetPasswordForEmail({redirectTo})`, usando origin Cloudflare in produzione e
`localhost:5173` solo in sviluppo. Le pagine devono validare `type` e
`token_hash`, richiedere un click prima di `verifyOtp`, gestire token già usato
e, per recovery, chiamare `updateUser({password})`. Aggiungere test e fallback
SPA Cloudflare; non loggare token o email.

## Handoff mobile (`EMAIL-CONFIRM-001`)

Usare soltanto i callback HTTPS verificati indicati sopra, con gestione cold e
warm start e validazione stretta di origin, path, type e token. Non inoltrare
mai la credenziale a uno schema custom. Passare `emailRedirectTo` e
`redirectTo` espliciti; richiedere un tap prima di `verifyOtp`; recovery termina
con `updateUser({password})`. Non cambiare camera o mount della mappa e non
loggare URL Auth, token o email.

## Lifecycle dispatcher and retention (`BE-EMAIL-002/003`)

The separate backend lifecycle credential is not the App Password configured
inside Supabase Auth. SMTP dispatch and narrowly scoped Gmail IMAP cleanup are
documented in `account-lifecycle-runbook.md` and
`account-rights-runbook.md`. IMAP cleanup accepts only exact automated Auth
subjects configured as backend secrets; it must never search/delete support
mail broadly.

## Deliverability of lifecycle email

On 7 September 2026 a message delivered to Gmail Spam was inspected with
`SPF=PASS`, `DKIM=PASS (gmail.com)` and `DMARC=PASS`. This rules out a current
SMTP authentication or DNS failure. The initial sender is a low-volume personal
Gmail mailbox and links to the public Cloudflare Pages site, so Gmail can still
apply reputation/content heuristics.

The backend therefore sends a human-readable `FunghiTracker <...>` From
identity, an explicit Reply-To, RFC Date and a stable Message-ID aligned with
the authenticated Gmail domain. It does not add trackers, hidden pixels,
marketing headers or an unsubscribe link to transactional account notices.
Set these backend-only optional settings if a different display/reply address
is required:

```text
ACCOUNT_LIFECYCLE_SMTP_FROM_NAME=FunghiTracker
ACCOUNT_LIFECYCLE_SMTP_REPLY_TO=
```

Mark genuine test mail as "Non spam" while testing. This can help a recipient's
mailbox but is not a deliverability guarantee. The durable solution before a
larger rollout is the already planned move to a verified FunghiTracker domain
and transactional provider, with SPF, DKIM and DMARC aligned to that domain.
Do not change the From mailbox to such a domain until its authentication is
configured; otherwise deliverability becomes worse.
