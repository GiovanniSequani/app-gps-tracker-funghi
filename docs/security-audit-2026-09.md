# Security assessment pre-release — settembre 2026

Data assessment: 2026-09-09

Fase: remediation documentata; verifiche runtime e release ancora aperte

Remediation 2026-09-09: implementazione locale avviata per `SEC-AUD-001`,
`SEC-AUD-002` e `SEC-AUD-004`. I tre finding restano aperti fino alle verifiche
runtime e di configurazione descritte nelle rispettive sezioni.

Decisione pre-release: **BLOCKED**

## Sintesi esecutiva

L'assessment non ha dimostrato vulnerabilita' `Critical` direttamente
sfruttabili nel comportamento corrente, ma ha identificato tre finding `High`,
undici `Medium` e quattro `Low`. La pubblicazione Android non dovrebbe procedere
finche' almeno i finding `SEC-AUD-001`, `SEC-AUD-002` e `SEC-AUD-003` non sono
corretti e verificati su una build di release. Anche i finding Medium che
riguardano credenziali Auth negli URL, ammissione GPX, dipendenze e dataset
correnti richiedono una correzione o un'accettazione del rischio esplicita.

I problemi con maggiore impatto sono:

- i link Auth mobile inoltrano una credenziale monouso a uno schema URI custom
  che un'altra applicazione puo' registrare;
- il client web accetta globalmente una sessione Supabase valida presente nel
  fragment di qualunque URL, consentendo session swapping/login CSRF;
- il client mobile conserva sessione e dati di localizzazione in storage non
  sicuro mentre il backup Android resta abilitato per default.
- quote GPX solo per utente e un export che ricopia tutti i GPX consentono di
  moltiplicare storage, egress e lavoro del worker tramite account usa-e-getta;
- il cleanup degli export scaduti non ha un limite per esecuzione e puo'
  ritardare le successive cancellazioni account.

La base di autorizzazione e' invece solida a livello statico: le policy RLS e
Storage legano le righe e gli oggetti a `auth.uid()`, i path privati sono
canonici, i signed URL GPX durano 60 secondi e i worker export/cancellazione
usano claim, lease e grant `service_role`. Le suite automatiche sono verdi.
Queste evidenze non sostituiscono pero' un nuovo test runtime a due account
contro lo stato di produzione attuale.

## Regole di severita'

| Severita' | Criterio usato |
|---|---|
| Critical | compromissione immediata e ripetibile su larga scala, senza prerequisiti realistici |
| High | account takeover o divulgazione di posizione/sessione con prerequisiti realistici |
| Medium | impatto importante ma limitato da interazione, ownership, quota o compromissione aggiuntiva |
| Low | leakage limitato, hardening o rischio la cui sfruttabilita' corrente non e' dimostrata |

La severita' di progetto non coincide automaticamente con il CVSS di una
dipendenza: viene considerata anche la raggiungibilita' nel codice FunghiTracker.

## Asset, attori e threat model

### Asset

- credenziali Auth, access token, refresh token, sessioni e callback di
  conferma/recovery;
- GPX, tracce locali, waypoint, dati derivati e relative informazioni di
  localizzazione;
- profilo, stato lifecycle, versioni legali accettate, export e richieste di
  cancellazione;
- separazione tra account e integrita' di RLS, RPC, Storage e job backend;
- diritto `full_access` e riservatezza commerciale dell'indice recente;
- disponibilita' e costi di Supabase, Storage, CDN, email e pipeline;
- segreti backend, chiavi di firma, credenziali EAS e integrita' degli update
  OTA;
- integrita' dei GPX eventualmente ammessi nel modelling.

### Attori considerati

- attaccante remoto non autenticato;
- utente autenticato malevolo con un normale account contributore;
- secondo utente che tenta IDOR o accesso cross-account;
- applicazione mobile ostile installata sullo stesso dispositivo;
- destinatario di un file GPX malevolo;
- soggetto con accesso a backup, dispositivo, log CDN o history Git;
- compromissione della supply chain di build/update.

### Confini di fiducia

1. web/mobile → Supabase Auth e API con chiave pubblica e bearer session;
2. PostgREST/RPC → Postgres con RLS e funzioni `SECURITY DEFINER`;
3. client → Storage privato/pubblico e signed URL;
4. worker backend → Supabase con `service_role`;
5. email → callback HTTPS → browser → deep link mobile;
6. app sandbox → backup/cloud transfer del dispositivo;
7. EAS Build/Update → bundle installato;
8. pipeline pubblicazione → bucket pubblici/CDN.

### Scenari prioritari

- intercettare o iniettare una sessione durante conferma/recovery;
- leggere o modificare GPX/export di un altro utente;
- aggirare restriction, riaccettazione documenti o `full_access`;
- far accettare a Storage contenuti non GPX o causare decompressione/parse
  incontrollati;
- esaurire quote globali di cancellazione, storage o CDN;
- recuperare sessioni/coordinate da backup, cache, log, artifact o history;
- consegnare codice web/mobile alterato tramite dipendenza o update.
- degradare sito e servizi con traffico volumetrico, richieste applicative
  costose, moltiplicazione di account o retry sincronizzati;
- esaurire storage, egress, compute, quota email o tempo del worker senza
  superare il limite del singolo account.

## Ambito e metodo

Sono stati letti integralmente i documenti richiesti: `AGENTS.md`, indice docs,
rollout account/privacy, runbook lifecycle, runbook diritti, preflight cutover,
contratto account/GPX, contratto dati pubblici e regole camera. Il rollout e'
stato trattato come target/stato operativo dichiarato; migration e codice sono
stati trattati come evidenza tecnica corrente.

L'analisi ha coperto:

- `mobile/`: Expo config, Auth, deep link, GPX, cache/file locali, logging,
  rete, permessi, EAS e test;
- `backend/`: migration SQL, RPC, RLS, Storage, lifecycle, export,
  cancellazione, outbox, validator GPX, retry/lease e test;
- `../web-funghi-index`: Auth, callback, GPX, MapLibre, CSP/header, routing,
  dipendenze, test e build;
- working tree, file tracciati/ignorati, 70 commit del repository principale e
  50 commit del repository web;
- endpoint pubblici con un numero minimo di richieste read-only.

Checklist di riferimento: OWASP ASVS 4, OWASP API Security Top 10 2023 e OWASP
MASVS/MASTG. Sono state privilegiate le superfici effettivamente presenti.

## Test eseguiti

### Automatici locali

| Test | Esito |
|---|---|
| `python -m pytest backend/tests -q` | 179 passed; solo warning della cache pytest non scrivibile |
| `mobile`: `npm.cmd test` | 42 file passed, 2 skipped; 213 test passed, 3 skipped |
| `mobile`: `npm.cmd run typecheck` | passed |
| `web`: `npm.cmd test` | 36 file e 128 test passed |
| `web`: `npm.cmd run build` | passed; warning non-security per chunk JS superiore a 500 kB |

I test web hanno richiesto accesso in scrittura alla cache Vite e a `dist/` nel
repository sibling; la prima esecuzione era bloccata dalla sandbox, la
riesecuzione autorizzata e' passata. Non e' stato modificato codice sorgente.

### Verifiche statiche e controllate

- tracciamento sorgente di signup, login, reset, callback, logout e storage
  sessione;
- revisione di grant, RLS, policy Storage e RPC, inclusi owner check, path
  canonici, `FOR UPDATE`, advisory lock, claim e lease;
- ricerca di sink XSS (`innerHTML`, `dangerouslySetInnerHTML`, `setHTML`) e
  verifica dell'uso React/`setDOMContent` corrente;
- analisi GPX di gzip, limiti, parser XML, filename, upload/finalize/delete ed
  export ZIP;
- probe locale su byte generati per decompressione gzip. Non e' stato creato
  ne' eseguito un payload di esaurimento memoria; il probe ha confermato che il
  controllo ISIZE mobile evita l'allocazione oltre il limite nel percorso
  testato, mentre il web decomprime prima di controllare il limite;
- `npm audit --omit=dev` e risalita delle catene di dipendenza;
- scansione secret-safe del working tree e della history: l'output ha mostrato
  solo regola, file e commit, mai il valore candidato;
- verifica di `.gitignore`, `.easignore`, file tracciati e artifact locali;
- audit Auth read-only: provider email attivo, signup abilitato, conferma email
  obbligatoria;
- tre richieste `HEAD` anonime a pointer/manifests Storage documentati: tutti
  hanno risposto `200` senza scaricare il body;
- richieste `HEAD` alle pagine web pubbliche: CSP presente; callback Auth con
  `no-store` e `no-referrer`; HSTS assente. La variante senza slash della pagina
  cancellazione non riceve gli header specifici.
- una richiesta `HEAD` alla root e una all'asset JavaScript del sito hanno
  restituito `200` da Cloudflare; tre `HEAD` sequenziali, anonime e senza body al
  manifest tile pubblico hanno restituito `200`, `Cache-Control: no-cache` e
  `CF-Cache-Status: REVALIDATED`. Non sono state fatte richieste parallele.

### Comandi riproducibili senza segreti

```powershell
python -m pytest backend/tests -q

Push-Location mobile
npm.cmd test
npm.cmd run typecheck
npm.cmd audit --omit=dev --json
Pop-Location

Push-Location ..\web-funghi-index
npm.cmd test
npm.cmd run build
npm.cmd audit --omit=dev --json
Pop-Location

python -m backend.scripts.supabase.audit_auth_email_setup
git rev-list --all --count
git ls-files
git check-ignore -v backend\.env mobile\.env mobile\android mobile\dist
```

Per gli endpoint Storage usare esclusivamente `HEAD` sui tre oggetti pubblici
documentati (`index-data/current.json`, `index-history/current.json`,
`tiles/tile_sets.json`). Non aggiungere header Auth e non scaricare i dataset.

Per riprodurre la sola verifica edge, con un massimo di tre richieste
sequenziali e senza body:

```powershell
$site = Invoke-WebRequest 'https://web-funghi-index.pages.dev/' -Method Head
$site.StatusCode
$site.Headers['Server']

$publicBase = 'https://<project-ref>.supabase.co'
1..3 | ForEach-Object {
    $head = Invoke-WebRequest "$publicBase/storage/v1/object/public/tiles/tile_sets.json" -Method Head
    [pscustomobject]@{
        Status = $head.StatusCode
        CacheControl = $head.Headers['Cache-Control']
        CacheStatus = $head.Headers['CF-Cache-Status']
    }
}
```

Non aumentare il numero, non parallelizzare e non usare questo comando come
load test. Sostituire soltanto il project ref pubblico gia' configurato nei
client; non usare chiavi o header Auth.

## Limiti espliciti

- Non erano disponibili in questa sessione due credenziali usa-e-getta
  controllate dal proprietario. Non sono stati quindi ripetuti i test runtime
  cross-user, reset/recovery, logout, signed URL, export e cancellazione. Le
  prove descritte nei runbook del 2026-09-06/08 sono evidenza storica, non una
  nuova conferma dello stato corrente.
- Non e' stato interrogato alcun record di produzione e non sono stati letti
  body di Storage pubblico o privato. Non sono stati usati account reali.
- Nessuna email e' stata inviata. Nessun test di brute force, flood, DoS,
  concorrenza distruttiva o quota e' stato eseguito.
- Mancava un access token Supabase Management. Redirect allow-list, template
  gestiti, SMTP, durata JWT, policy password, CAPTCHA e rate limit Dashboard
  sono `NOT TESTED`.
- Non era disponibile un AAB/APK/IPA di produzione. Manifest finale, firma Play,
  Network Security Config, permission effettive, source map inclusi e logcat di
  release sono `NOT TESTED`. Il progetto nativo locale e' ignorato da EAS ed e'
  stato usato solo come indizio, non come prova del binario finale.
- Non e' stato eseguito un pentest browser con sessioni reali ne' installata
  un'app concorrente per intercettare deep link.
- Configurazioni specifiche WAF/CDN, limiti di spesa, quota Supabase/Expo e
  retention dei log del provider non erano osservabili dal repository.

## Valutazione DoS e DDoS

### Esito

La robustezza e' **parziale e non sufficiente per chiudere il gate di release**.
La superficie statica del sito e gli endpoint Supabase hanno una mitigazione
volumetrica edge fornita dai rispettivi provider. Questo riduce il rischio di
flood L3/L4 e di parte degli attacchi L7, ma non impedisce richieste valide e
costose, abuso distribuito di account, egress, storage o starvation del worker.
Nessun servizio puo' essere dichiarato "DDoS-proof" sulla sola base del CDN.

### Controlli positivi verificati

- Il sito live risponde tramite Cloudflare. Cloudflare dichiara protezione DDoS
  automatica e senza misurazione L3/L4/L7 per tutti i piani e servizi; Pages
  serve inoltre gli asset statici tramite Tiered Cache:
  [DDoS Protection](https://developers.cloudflare.com/ddos-protection/about/),
  [Pages caching](https://developers.cloudflare.com/pages/configuration/serving-pages/).
- Supabase dichiara protezione DDoS edge tramite Cloudflare e blocco
  infrastrutturale di abuso ripetuto; Storage instrada gli asset attraverso il
  CDN. Le tre richieste controllate al manifest tile hanno confermato il
  passaggio dall'edge, non la capacita' sotto carico:
  [Supabase Security](https://supabase.com/docs/guides/security),
  [Storage CDN](https://supabase.com/docs/guides/storage/cdn/fundamentals).
- Chunk e manifest versionati di terreno/indice usano URL immutabili e cache di
  un anno; i client mantengono cache in memoria e annullano le richieste di
  dettaglio superate. L'archivio limita a tre i download GPX concorrenti.
- GPX ha limiti nominali di 10 MiB compressi, 50 MiB decompressi e 50 tracce per
  utente. Export, cancellazioni ed email usano claim, lease, tentativi massimi e
  backoff; la pipeline pubblicazione usa timeout e retry con jitter.

### Superfici che impediscono un esito `DONE`

| Superficie | Vettore di disponibilita' | Esito |
|---|---|---|
| GPX web/server | decompressione e ammissione di contenuto non valido | `IMPLEMENTED, RUNTIME NEGATIVE TEST PENDING`: `SEC-AUD-005`, `SEC-AUD-006` |
| Dataset pubblici | scraping diretto, egress e bypass del gate client | `RISK ACCEPTED 1.9.0`: `SEC-AUD-008` |
| Cancellazione esterna | esaurimento anonimo della quota globale | `IMPLEMENTED, RUNTIME PENDING`: `SEC-AUD-009` |
| GPX/export | moltiplicazione della quota tramite piu' account | `PARTIAL`: budget DB attivi, edge/signup pending (`SEC-AUD-016`) |
| Worker diritti | backlog export scaduti senza budget per run | `IMPLEMENTED, RUNTIME BACKLOG TEST PENDING`: `SEC-AUD-017` |
| Client mobile/web | retry e polling fissi durante outage | `IMPLEMENTED, RUNTIME PENDING`: `SEC-AUD-018` |

### Limiti della verifica

- Non e' stato eseguito traffico concorrente o un load/stress test in
  produzione. Un test di capacita' va svolto su staging o con limiti concordati
  col provider, come raccomanda la
  [checklist produzione Supabase](https://supabase.com/docs/guides/deployment/going-into-prod).
- Non erano disponibili i pannelli Cloudflare/Supabase: piano Smart CDN,
  regole WAF/rate limit, CAPTCHA, alert DDoS, compute, Spend Cap e soglie egress
  restano `NOT TESTED`. Le rate limit Auth documentate da Supabase sono
  configurabili e non provano i valori del progetto corrente.
- La mappa dipende anche dai tile Esri. Disponibilita', quote e fallback di tale
  dipendenza non sono configurati o verificabili nel repository.

## Finding Critical

Nessun finding Critical dimostrato.

## Finding High

### `SEC-AUD-001` — Credenziale Auth mobile intercettabile tramite schema URI custom

**Stato remediation 2026-09-09: IN-PROGRESS.** Eliminati dal web il bridge
`/auth/mobile-confirm` e la costruzione di `funghitracker://auth/...`; mobile
confirm e recovery usano ora i callback HTTPS `/auth/confirm` e
`/auth/recovery`. Expo dichiara Android intent filter `autoVerify` limitati ai
due path e l'associated domain iOS. Test locali parser/cold-warm handler e
config passano. Restano bloccanti la pubblicazione di `assetlinks.json` e AASA
con gli identificativi reali, il deploy web, l'AAB/IPA e il test con handler
concorrente. Nessun fingerprint o Team ID e' stato inventato.

**Evidenza.** `mobile/app.config.js:32` registra solo lo schema custom;
`mobile/src/account/authCallbacks.ts:2-3` definisce callback confirm/recovery su
quello schema; `web/src/account/mobileAuthBridge.ts:27-33` inoltra la credenziale
monouso nel deep link. Non risultano `android.intentFilters` con `autoVerify`,
Digital Asset Links o `ios.associatedDomains` nell'Expo config. Android dichiara
che gli App Links verificati impediscono ad altre app di intercettare i link:
[Android App Links](https://developer.android.com/training/app-links/about).

**Sfruttamento e impatto.** Un'app ostile installata sul dispositivo puo'
registrare lo stesso schema. Se riceve una callback recovery non ancora usata,
puo' convertirla in una sessione e prendere controllo dell'account. Per la
conferma, puo' consumare o sottrarre il link.

**Probabilita'.** Media: richiede installazione di un'app ostile e apertura del
link, ma Android non garantisce ownership degli schemi custom.

**Fix consigliato.** Usare callback HTTPS con Android App Links verificati e
iOS Universal Links, limitate ai soli path Auth. Non inoltrare bearer nello
schema custom; effettuare uno scambio server-side monouso oppure completare il
flusso sul dominio verificato.

**Verifica richiesta.** Ispezione dell'AAB; verifica `assetlinks.json` e
associated domains; test cold/warm start; installazione controllata di un'app
che tenta di registrare lo stesso schema e conferma che non riceva la callback.

**Mapping.** ASVS V3, MASVS-AUTH, MASVS-PLATFORM.

### `SEC-AUD-002` — Session swapping/login CSRF nel client web

**Stato remediation 2026-09-09: IN-PROGRESS.** Il client web imposta ora
`detectSessionInUrl: false`; il router considera callback soltanto i path
esatti `/auth/confirm` e `/auth/recovery`, senza fallback dalla root o dalla
mappa. Test mirati confermano che URL arbitrari non vengono instradati e che
confirm/recovery manuali restano funzionanti. Manca il test E2E runtime con due
account usa-e-getta richiesto per chiudere il finding.

**Evidenza.** `../web-funghi-index/src/account/client.ts:33-35` abilita persistenza e
`detectSessionInUrl: true` globalmente. La versione installata di
`@supabase/auth-js` considera callback implicita qualunque URL che contenga un
access token, valida il token, costruisce la sessione e la salva. Non vi e'
allow-list del path, `state` applicativo o binding a un tentativo Auth avviato
dal browser. I callback custom dell'app usano gia' `verifyOtp` manuale, quindi
questa auto-detection non e' necessaria per i flussi documentati.

**Sfruttamento e impatto.** Un attaccante puo' condividere un link al sito con
una propria sessione Supabase valida nel fragment. La vittima viene autenticata
nell'account dell'attaccante e puo' caricare inconsapevolmente GPX e dati di
posizione in un account controllato dall'attaccante.

**Probabilita'.** Media: richiede social engineering e una sessione che
l'attaccante e' disposto a cedere, ma non richiede XSS o bypass di RLS.

**Fix consigliato.** Impostare `detectSessionInUrl: false`; gestire soltanto i
callback attesi, sui path attesi. Se verranno aggiunti OAuth/magic link, usare
PKCE e `state` legato alla richiesta originaria.

**Verifica richiesta.** Test E2E con due account usa-e-getta: un fragment con
sessione dell'account A aperto dal browser B non deve modificare la sessione B;
callback confirm/recovery legittimi devono continuare a funzionare.

**Mapping.** ASVS V3, API2:2023 Broken Authentication.

### `SEC-AUD-003` — Sessione e geodati mobile inclusi nel backup Android

**Remediation 2026-09-11 (implemented, signed-build verification pending).** La
sessione usa SecureStore, Android imposta `allowBackup=false` e il plugin iOS
esclude documenti/application support dal backup. Test statici e unitari sono
verdi; restano ispezione dell'AAB/IPA e prova backup/restore su dispositivo.

**Evidenza.** `mobile/src/account/supabase.ts:2,19,48-52` conserva la sessione,
incluso il refresh token, in AsyncStorage. GPX, SQLite e draft di registrazione
sono salvati nello storage applicativo. L'Expo config non imposta
`android.allowBackup` ne' regole di esclusione; il manifest nativo generato
localmente mostra `allowBackup=true`. Expo documenta che il default Android e'
`true` e che AsyncStorage non e' storage sicuro per access token:
[Expo app config](https://docs.expo.dev/versions/latest/config/app/#allowbackup),
[Expo authentication storage](https://docs.expo.dev/guides/authentication/#storing-data).
Il caso corrisponde a
[OWASP MASWE-0006](https://mas.owasp.org/MASWE/MASVS-STORAGE/MASWE-0006/).

**Sfruttamento e impatto.** Un backup cloud/locale o una migrazione dispositivo
possono contenere refresh token e posizioni precise. Chi ottiene il backup puo'
accedere all'account finche' la sessione e' valida e ricostruire percorsi.

**Probabilita'.** Media: richiede accesso al backup/account dispositivo, ma il
backup e' abilitato per default e i dati sono ad alto impatto privacy.

**Fix consigliato.** Usare SecureStore/Keychain per il materiale di sessione;
disabilitare il backup o definire regole di esclusione esplicite per
AsyncStorage, database, draft, GPX e cache. Conservare nel backup solo dati
deliberatamente ripristinabili e non sensibili.

**Verifica richiesta.** AAB di release con `allowBackup`/data extraction rules
attese; backup/restore controllato su dispositivo; conferma che token, database,
draft e GPX non compaiano nell'archive o nel trasferimento.

**Mapping.** MASVS-STORAGE-1/2, MASWE-0006, ASVS V6.

## Finding Medium

### `SEC-AUD-004` — Credenziale confirm/recovery presente nella query HTTPS

**Stato remediation 2026-09-09: IN-PROGRESS.** Il callback web acquisisce la
credenziale in memoria e rimuove query e fragment tramite `replaceState` prima
del primo render interattivo; il template aggiornato usa il fragment
`#token_hash=...`, che non viene inviato nella richiesta HTTPS iniziale. Il
mobile accetta soltanto lo stesso origin HTTPS e i due path Auth, senza
conservare il link grezzo nello stato. La compatibilita' con vecchie query e'
transitoria e le ripulisce subito. Restano la modifica manuale dei template
Supabase, deploy e verifica che log Cloudflare/Auth e history browser non
contengano query sensibili.

**Evidenza.** `docs/auth-email-setup.md:100-106` costruisce i link con
`token_hash` nella query. `../web-funghi-index/src/account/AuthCallbackPage.tsx:20,32` lo legge
al render ma rimuove la query soltanto dopo il click dell'utente. Il bridge
mobile pulisce subito la URL nel client, ma la richiesta HTTPS iniziale ha gia'
attraversato browser e CDN. Le route Auth live hanno correttamente `no-store` e
`no-referrer`, che non eliminano il dato dalla request line del primo hop.

**Sfruttamento e impatto.** Chi accede tempestivamente a URL copiati, strumenti
di osservabilita' o log che includono la query puo' usare per primo una
credenziale recovery e ottenere una sessione. La monouso/scadenza limita la
finestra ma non l'impatto.

**Probabilita'.** Bassa-media: richiede accesso a un canale che osserva la URL e
uso prima del proprietario.

**Fix consigliato.** Preferire fragment client-side oppure callback server-side
che scambi immediatamente la credenziale e rediriga a una URL pulita. Escludere
sempre query e fragment dai log applicativi/CDN. Mantenere `no-store` e
`no-referrer`.

**Verifica richiesta.** Flussi confirm/recovery web e mobile con account
usa-e-getta; log CDN/app senza query; URL pulita prima del primo render
interattivo; riuso della credenziale negato.

**Mapping.** ASVS V3/V8, MASVS-AUTH.

### `SEC-AUD-005` — `finalize_my_gpx_track` accetta contenuti non validati

**Remediation 2026-09-09 (implemented, runtime negative test pending).** La
migration `202609090001` è applicata e aggiunge admission separata e worker
service-role streaming. Export e funzioni trusted richiedono
`validation_status=validated`; legacy e nuovi upload non sono trusted prima
del controllo server. Il worker ha validato i 9 archivi eleggibili senza
errori; manca una prova live controllata con contenuto avverso.

**Evidenza.** La reservation valida suffisso, valori dichiarati e formato
dell'hash (`backend/supabase/migrations/202608130001_gpx_display_name_and_rename.sql:47-130`). La finalize
controlla owner, dimensione Storage e MIME dichiarato
(`backend/supabase/migrations/202608060001_user_accounts_and_gpx_archive.sql:350-404`), ma non scarica il
file, non verifica magic gzip/XML, non ricalcola SHA-256 e non confronta punti,
bbox o dimensione decompressa. `backend/src/accounts/gpx_validation.py` ha un
validator streaming con cap, ma e' usato da test/CLI, non dall'ammissione.

**Sfruttamento e impatto.** Un utente con accesso completo puo' usare API/RPC
dirette per marcare `ready` byte arbitrari con MIME gzip e metadati inventati.
Le quote per utente limitano lo storage, ma export e futuri job trusted possono
trattare il record come GPX valido. Un gzip ad alta espansione puo' colpire i
client che lo aprono.

**Probabilita'.** Alta per l'integrita' del proprio record; impatto oggi medio
perche' RLS impedisce accesso cross-user e il modelling non deve ancora fidarsi
di questi dati.

**Fix consigliato.** Stato di quarantena; validazione server-side streaming
dell'oggetto; ricalcolo di hash/dimensioni/statistiche; transizione a `ready`
solo dopo successo. I consumer trusted devono richiedere uno stato
`validated`, non solo `ready`.

**Verifica richiesta.** Matrice con magic errato, gzip troncato, XML/DTD
malevolo, root non GPX, hash/statistiche false, espansione oltre limite,
finalize concorrente e delete durante validazione. Usare solo account e file
usa-e-getta.

**Mapping.** ASVS V5, API8:2023, API4:2023.

### `SEC-AUD-006` — Decompressione GPX web prima dei limiti

**Remediation 2026-09-11 (implemented, deploy/runtime verification pending).**
Il parser web applica cap prima della lettura, decompressione bounded e limiti
XML/punti; i test sintetici sono presenti nel commit web `aadfcab`. Restano il
deploy verificato e una prova browser sui file avversi previsti dal finding.

**Evidenza.** `../web-funghi-index/src/account/gpx.ts:80-86` legge l'intero file e chiama
`gunzip` prima di verificare limite compresso e non compresso.
`decodeCloudGpx`, righe 89-92, non riceve alcun limite. Il probe locale ha
evitato payload distruttivi ma ha confermato l'ordine delle operazioni.

**Sfruttamento e impatto.** Un file scelto dall'utente, o un oggetto caricato
tramite il bypass di `SEC-AUD-005`, puo' far allocare memoria molto superiore al
limite e bloccare/crashare la scheda. E' richiesta interazione e non e' stato
dimostrato un impatto server-side.

**Probabilita'.** Media.

**Fix consigliato.** Verificare `file.size` prima di `arrayBuffer`, usare
decompressione streaming/capped in Worker, imporre time/point/entity budget e
rifiutare esplicitamente DTD/DOCTYPE. Applicare gli stessi cap ai download
cloud.

**Verifica richiesta.** File sintetici compressi, ad alta espansione,
troncati, multi-member e XML con DTD; il processo deve terminare entro limiti
misurati senza crescita incontrollata.

**Mapping.** API4:2023, ASVS V5/V12.

### `SEC-AUD-007` — GPX ed export restano nella cache mobile

**Remediation 2026-09-11 (implemented, device verification pending).** Copie
GPX ed export usano una directory temporanea dedicata, cleanup in `finally` e
purge nei confini account previsti. Test unitari verdi; resta l'ispezione del
filesystem su dispositivo dopo successo, errore, logout e riavvio.

**Evidenza.** `mobile/src/account/AccountArchiveScreen.tsx:310-312,562-565`
crea copie GPX in `Paths.cache`; `mobile/src/account/useAccountRights.ts:25-30`
crea l'export ZIP nella stessa cache.
Non risultano delete in `finally`, logout o completamento share. In alcuni
flussi esistono sia il download gzip sia una seconda copia condivisibile.

**Sfruttamento e impatto.** I file contengono percorsi e dati account e restano
fino a eviction, clear data o uninstall; logout e richiesta di cancellazione
non garantiscono la rimozione locale.

**Probabilita'.** Alta come persistenza; l'accesso richiede dispositivo,
backup o ambiente compromesso.

**Fix consigliato.** Directory temporanea dedicata; rimozione in `finally` dopo
lettura/share, inclusi error/cancel; purge a startup, logout e conferma
cancellazione; esclusione dal backup.

**Verifica richiesta.** Ispezione filesystem dopo successo, errore, cancel,
logout, restart e cancellazione account.

**Mapping.** MASVS-STORAGE, MASVS-PRIVACY.

### `SEC-AUD-008` — Bypass diretto di `full_access` sui dataset correnti

**Decisione prodotto 2026-09-11 — rischio accettato per release 1.9.0.**
`tiles`, `index-data` e `index-history` restano tecnicamente pubblici nei
bucket correnti. Il gate D-7 rispetto all'indice corrente è una regola UI e di
prodotto, non una misura di autorizzazione. Non sono coinvolti dati personali.
Si accettano per questa release scraping, bypass del gate client ed egress
associato. La decisione va rivalutata prima di una crescita rilevante degli
utenti, dell'introduzione di forecast riservati oppure al verificarsi di costi,
egress o traffico anomali; in quei casi valutare bucket privato/gateway e quote.

**Evidenza.** Il contratto dichiara `tiles`, `index-data` e `index-history`
pubblici. Il 2026-09-09 richieste `HEAD` anonime ai tre pointer/manifests hanno
restituito `200`. Il client limita la UI, ma URL Storage diretti non passano dal
lifecycle o da `full_access`.

**Sfruttamento e impatto.** Chiunque puo' automatizzare download/scraping
dell'indice recente e aggirare l'entitlement. Non sono dati personali, ma si
perdono controllo di accesso, valore commerciale e controllo dell'egress.

**Probabilita'.** Alta: non richiede autenticazione. Il rischio e' gia'
dichiarato e differito nel rollout, ma resta reale.

**Fix consigliato.** Proteggere i dati recenti con bucket privato/gateway e
autorizzazione server-side; pubblicare soltanto la finestra guest differita.
Aggiungere rate/egress quota, cache policy e alert. In alternativa serve
accettazione formale del rischio per la specifica release.

**Verifica richiesta.** Anonimo e account restricted devono fallire sui giorni
recenti anche usando URL diretti; i dati guest differiti devono restare
pubblici; testare range/batch con richieste limitate.

**Mapping.** API1:2023, API5:2023, API4:2023.

### `SEC-AUD-009` — Quota globale cancellazione esterna esauribile da anonimo

**Remediation 2026-09-09 (implemented, runtime verification pending).** La lookup
account precede token, lock e insert. Un indirizzo sconosciuto riceve la stessa
risposta generica ma non crea righe e non consuma il budget globale.

**Evidenza.** `request_external_account_deletion` e' eseguibile da `anon`. La
migration assegna un limite globale orario 100 e un limite per identificatore;
anche richieste per account inesistenti inseriscono una riga e consumano il
budget globale. Non risultano nel repository CAPTCHA o rate limit per IP/device
prima della RPC.

**Sfruttamento e impatto.** Un attaccante invia un numero contenuto di input
sintatticamente validi e distinti, saturando il budget. Le successive richieste
esterne legittime ricevono comunque risposta non enumerativa ma non producono
l'email. Il percorso autenticato usa una quota diversa e resta disponibile.

**Probabilita'.** Media. Il test non e' stato eseguito per non consumare quota o
inviare email.

**Fix consigliato.** Edge Function/WAF con rate IP/device e challenge;
separare il budget delle richieste sconosciute da quello delle richieste che
possono generare email; alert sull'occupazione anomala della quota, mantenendo
risposta indistinguibile.

**Verifica richiesta.** Piccola sequenza documentata su identificativi
usa-e-getta; dimostrare che gli input sconosciuti non bloccano un'unica
richiesta legittima e che non causano enumerazione.

**Mapping.** API4:2023 Unrestricted Resource Consumption.

### `SEC-AUD-010` — MapLibre web vulnerabile a CVE-2026-85061

**Remediation 2026-09-11 (implemented, browser/deploy verification pending).**
Il web usa `maplibre-gl@6.4.1`, prima versione corretta, e il dependency gate
non rileva advisory web. Restano verifica sul deploy di attribution, popup e
CSP e il test regressivo browser richiesto.

**Evidenza.** Il lock web installa `maplibre-gl@5.24.0`; la advisory critica
GHSA-jrc7-96c5-q579/CVE-2026-85061 riguarda versioni `<=6.4.0` e corregge in
`6.4.1`: [GitHub Advisory](https://github.com/advisories/GHSA-jrc7-96c5-q579).
Il sink e' l'attribution HTML. Nel codice corrente le attribution sono stringhe
hard-coded (`../web-funghi-index/src/mapStyle.ts:14,21`) e i popup usano React
con `setDOMContent` (`../web-funghi-index/src/App.tsx:335`); non e' stata trovata una attribution
controllata dall'attaccante.

**Sfruttamento e impatto.** Se una futura/compromessa style source o custom
attribution introduce HTML non fidato, il bypass del sanitizer consente XSS e
accesso alla sessione web. La raggiungibilita' corrente non e' dimostrata: per
questo il finding di progetto e' Medium, non Critical.

**Probabilita'.** Bassa nello stato corrente, alta se vengono accettate style o
attribution di terze parti non fissate.

**Fix consigliato.** Aggiornare almeno alla prima versione corretta compatibile
e mantenere attribution statiche o sanitizzate esternamente.

**Verifica richiesta.** Build/test mappa, CSP, attribution e popup; test
regressivo con payload innocuo che verifichi la rimozione degli event handler.

**Mapping.** ASVS V5, CWE-79.

### `SEC-AUD-011` — Dependency gate incompleto e backend non riproducibile

**Remediation 2026-09-10 (code complete).** Backend definito da
`pyproject.toml` e `uv.lock`; un gate unico genera tre SBOM CycloneDX e fallisce
su advisory nuovi o eccezioni scadute. `requests`, `pytest` e `fflate` sono
stati aggiornati alle sole versioni correttive necessarie. Backend e web hanno 0
advisory note; le eccezioni mobile residue scadono il 2026-10-10.
Il gate finale del 2026-09-11 riporta backend 0, web 0 e mobile 34 advisory
conosciute, senza advisory inattese.

**Evidenza.** `npm audit --omit=dev` riporta nel grafo mobile 35 advisory
(1 Critical, 16 High, 17 Moderate, 1 Low). La Critical `shell-quote` arriva da
`react-native → react-devtools-core`; `@xmldom/xmldom` arriva da tooling
Expo/plist; l'advisory `fflate` riguarda ZIP64/`unzipSync`, mentre il percorso
GPX usa gzip/gunzip. Non e' stato dimostrato un exploit runtime di questi tre
rami, ma l'albero non ha una policy di eccezioni/reachability. Il web ha anche
una advisory High transitiva via tooling. Per Python non esiste nel repository
alcun `requirements`, `pyproject`, lock o environment manifest: la versione
eseguita in produzione non e' ricostruibile ne' auditabile.

**Sfruttamento e impatto.** Dipendenze vulnerabili o variabili tra ambienti
possono compromettere build, parsing o runtime; l'assenza di inventario rende
impossibile sapere se una CVE Python e' presente in produzione.

**Probabilita'.** Media come rischio supply-chain; sfruttabilita' runtime delle
singole advisory mobile non dimostrata.

**Fix consigliato.** SBOM e gate CI con reachability/allow-list a scadenza;
upgrade della catena Expo e dei package diretti; manifest Python pinned con
hash e separazione runtime/dev; scanner Python sul lock effettivamente
deployato.

**Verifica richiesta.** Build riproducibile pulita; audit sui lock finali;
motivazione e owner per ogni advisory residua; scansione del bundle/AAB per
confermare quali moduli vengono spediti.

**Mapping.** ASVS V1/V14, MASVS-CODE.

### `SEC-AUD-012` — Update OTA EAS non firmati end-to-end

**Remediation 2026-09-11 (implemented, signed-build verification pending).**
Per la release 1.9.0 EAS Update è disabilitato (`updates.enabled=false`), quindi
non vengono accettati bundle OTA non firmati. Resta da verificare questa
configurazione nell'AAB/IPA candidato effettivamente firmato.

**Evidenza.** `mobile/app.json:63-65` abilita EAS Update e `eas.json` usa un
canale production. Non risultano `updates.codeSigningCertificate` o
`codeSigningMetadata`. Expo documenta che, con code signing configurato, il
client verifica e rifiuta update privi di firma valida:
[EAS Update code signing](https://docs.expo.dev/eas-update/code-signing/).

**Sfruttamento e impatto.** Una compromissione dell'account/pipeline EAS o del
canale di pubblicazione puo' consegnare JavaScript capace di leggere sessioni e
geodati. TLS protegge il trasporto normale, ma non fornisce separazione da un
publisher compromesso.

**Probabilita'.** Bassa; impatto alto.

**Fix consigliato.** Abilitare firma end-to-end con chiave offline e rotazione,
oppure disabilitare gli update OTA per la release; MFA e least privilege EAS;
promozione staging→production dello stesso artifact.

**Verifica richiesta.** Una build nuova deve accettare un update firmato e
rifiutare update alterato/non firmato; controllare che la chiave privata non sia
nel repository o nell'archive EAS.

**Mapping.** MASVS-RESILIENCE, MASVS-CODE.

### `SEC-AUD-016` — Quota GPX moltiplicabile e export ad alto costo senza budget tenant

**Remediation 2026-09-09 (partial, database cutover complete).** Budget atomici DB
coprono byte per utente/tenant, pending, ingress tenant 24h, frequenza utente ed
input export tenant 24h. Restano CAPTCHA/rate edge signup e alert di piano.

**Evidenza.** La registrazione e' pubblica e richiede conferma email. Il limite
iniziale e' 50 tracce da 10 MiB compressi per account, cioe' fino a 500 MiB di
Storage per ogni identita' confermata
(`backend/supabase/migrations/202608060001_user_accounts_and_gpx_archive.sql:25`).
Le RPC applicano la quota al singolo
utente, ma nel repository non risultano un budget globale di byte, un limite di
upload per IP/device o un limite aggregato per tenant. I client non integrano un
token CAPTCHA; l'eventuale configurazione Dashboard non e' stata ispezionata.
L'export giornaliero scarica sequenzialmente tutti i GPX dell'utente e li copia,
senza ricomprimerli, in un nuovo ZIP privato; la pipeline manuale ammette fino a
20 export per esecuzione (`backend/src/accounts/rights.py:150,168-205`).

**Sfruttamento e impatto.** Un attaccante con piu' mailbox controllate puo'
moltiplicare la quota per account, caricare centinaia di MiB per identita' e
richiedere export periodici. Una campagna distribuita consuma Storage, egress e
tempo del worker pur rispettando ogni limite individuale; puo' aumentare costi,
raggiungere quote del piano e ritardare export o cancellazioni legittimi.

**Probabilita'.** Media. Conferma email e rate limit Auth del provider aumentano
il costo, ma non fermano account distribuiti; i valori Dashboard correnti sono
`NOT TESTED`.

**Fix consigliato.** Applicare atomicamente quota byte totale per account e
budget tenant per ingress, Storage ed export; introdurre rate limit edge per
IP/device/ASN e CAPTCHA/Turnstile; imporre a ogni run un budget di byte e tempo,
Spend Cap e alert sulle pendenze anomale. Il client non deve essere il punto di
enforcement.

**Verifica richiesta.** In staging, con soglie ridotte e pochi account
usa-e-getta, dimostrare che il budget aggregato rifiuta nuove prenotazioni prima
dell'upload, che il rollback non lascia oggetti e che il worker continua a
servire account legittimi. Nessun test di saturazione in produzione.

**Mapping.** API4:2023 Unrestricted Resource Consumption, ASVS V11/V13.

### `SEC-AUD-017` — Cleanup export scaduti senza limite puo' monopolizzare il worker

**Remediation 2026-09-09 (implemented, runtime backlog test pending).** Le cancellazioni
sono elaborate prima della manutenzione. Il cleanup ha cap per job, byte e tempo e il
claim SQL rispetta il budget residuo.

**Evidenza.** `run_account_rights` limita costruzione export e cancellazioni
(`backend/src/accounts/rights.py:408,452`),
ma tra le due fasi esegue un `while True` che reclama e cancella tutti gli
export scaduti disponibili (`backend/src/accounts/rights.py:421-435`). Non
esiste un massimo di job, byte o durata per
questa fase. Cleanup email e cancellazioni account sono eseguiti solo dopo che
il backlog e' stato svuotato o dopo il primo errore.

**Sfruttamento e impatto.** Un backlog consistente, naturale o alimentato dalla
creazione distribuita di export, puo' occupare l'intera finestra operativa con
chiamate Storage/RPC sequenziali. Le cancellazioni richieste dagli utenti e la
retention email possono essere ritardate, anche se le singole operazioni sono
idempotenti.

**Probabilita'.** Media-bassa oggi, ma cresce con utenti, dimensione degli
export e frequenza del worker. La condizione e' deterministica nel codice; non
e' stata provocata in produzione.

**Fix consigliato.** Aggiungere massimo job, massimo byte e deadline per run;
alternare equamente cleanup, export e cancellazioni; separare le code se
necessario; alert su eta' e dimensione del backlog.

**Verifica richiesta.** In test/staging preparare piu' export scaduti del cap e
una cancellazione pronta: la singola run deve fermare il cleanup al budget e
progredire comunque sulla cancellazione, senza doppie delete.

**Mapping.** API4:2023, ASVS V11/V13.

## Finding Low

### `SEC-AUD-013` — Oracle cross-user sullo stato contributor

**Remediation 2026-09-09 (implemented, two-account runtime test pending).** EXECUTE sulla
funzione UUID viene revocato ad `authenticated`; il client ha solo il wrapper
basato su `auth.uid()`, mentre service-role conserva l'helper.

**Evidenza.** `has_current_contributor_access(uuid)` e' `SECURITY DEFINER` e
accetta un UUID arbitrario; la migration concede `EXECUTE` ad `authenticated`.
La risposta rivela se l'account noto e' attivo e allineato alle versioni legali.

**Impatto.** Leakage booleano di stato lifecycle; non concede lettura GPX o
mutazioni. Serve conoscere un UUID di un altro utente.

**Probabilita'.** Bassa.

**Fix consigliato.** Per chiamate client accettare solo `auth.uid()`; consentire
lookup arbitrario esclusivamente a `service_role`, oppure spostare l'helper in
schema non esposto mantenendo un wrapper owner-only.

**Verifica richiesta.** Account A non deve ottenere lo stato di B; policy RLS e
job service-role devono continuare a funzionare.

**Mapping.** API1:2023, ASVS V4.

### `SEC-AUD-014` — Chiave client storica ancora recuperabile da Git

**Remediation 2026-09-10 (complete).** Uno script ispeziona history e HEAD
senza stampare valori; la chiave risulta assente dal codice corrente e il
proprietario ne ha confermato l'eliminazione in Google Cloud Console. Non è
stata eseguita alcuna riscrittura distruttiva della history.

**Evidenza.** Una chiave Google API-shaped fu aggiunta nel 2025 e rimossa dal
file corrente dal commit `9548a73` del 2026-07-23. Il valore non e' stato
stampato ne' testato. Non esiste evidenza nel repository della sua revoca o di
restriction Android/API/billing.

**Impatto.** Se ancora valida e non correttamente ristretta, puo' essere usata
per consumo quota/costi. Una chiave client mobile non e' un segreto forte, ma
deve essere limitata a package, certificato e API necessarie.

**Probabilita'.** Bassa/non determinata.

**Fix consigliato.** Verificare in console che sia revocata; se necessaria,
ruotarla e applicare restriction. Una riscrittura history e' secondaria alla
revoca e richiede un piano separato.

**Verifica richiesta.** Evidenza console senza valore della chiave: stato
revocato oppure restriction package/certificato/API e alert quota.

**Mapping.** ASVS V6/V14, MASVS-CODE.

### `SEC-AUD-015` — Header web incompleti su HSTS e variante URL cancellazione

**Evidenza.** Le pagine live non restituiscono `Strict-Transport-Security`.
`../web-funghi-index/public/_headers` applica `no-store`/`no-referrer` a
`/elimina-account/`, ma la
variante senza slash, usata dal router, riceve la policy base
`public, max-age=0, must-revalidate` e `strict-origin-when-cross-origin`.
Callback Auth, CSP, `nosniff`, `frame-ancestors 'none'` e `form-action 'self'`
sono invece presenti.

**Impatto.** HSTS mancante lascia il primo accesso piu' esposto al downgrade.
La cache della variante cancellazione riguarda oggi soltanto la shell statica e
il bearer e' nel fragment, quindi non e' stata dimostrata cache di dati
personali.

**Probabilita'.** Bassa.

**Fix consigliato.** Abilitare HSTS dopo verifica di tutti i sottodomini;
allineare il pattern header a entrambe le varianti della route.

**Verifica richiesta.** `HEAD` su root, callback e le due varianti della pagina
cancellazione; tutte le route sensibili devono avere la policy attesa.

**Mapping.** ASVS V9/V14.

### `SEC-AUD-018` — Retry e polling fissi possono amplificare un outage

**Remediation 2026-09-11 (implemented, runtime verification pending).** Web e
mobile applicano backoff esponenziale con jitter, `Retry-After`, tetto ai
tentativi e pausa offline/background; i test con errori simulati sono verdi.
Resta una prova controllata sul deploy/build, senza stressare la produzione.

**Evidenza.** Il mobile ritenta il manifest tile ogni 4 secondi finche' il
bootstrap fallisce e aggiunge un query parameter temporale a ogni richiesta
(`mobile/App.tsx:174,235,796-802`). Il
web e il mobile interrogano lo stato export ogni 15 secondi per job
`pending/building/retry`
(`../web-funghi-index/src/account/useAccountRights.ts:80-84`,
`mobile/src/account/useAccountRights.ts:73-77`). Non risultano backoff
esponenziale, jitter, limite di
tentativi o gestione `Retry-After`. Il polling mobile export e' almeno sospeso
quando l'app non e' attiva e i timer partono dopo il completamento, quindi non
sono state trovate richieste sovrapposte. Tre `HEAD` live sul manifest hanno
mostrato revalidazione edge; il comportamento delle query string dipende anche
dal piano Smart CDN, non verificato.

**Impatto.** Durante un guasto comune, ogni istanza mobile genera fino a 15
tentativi manifest al minuto e ogni utente con export pendente quattro poll al
minuto. Una base utenti ampia puo' creare un thundering herd e rallentare il
recupero del servizio; l'impatto attuale e' limitato dal basso numero di
richieste per client e dall'edge provider.

**Probabilita'.** Bassa oggi; aumenta durante outage o lancio pubblico.

**Fix consigliato.** Backoff esponenziale con jitter e tetto, rispetto di
`Retry-After`, pausa offline/background, circuit breaker e retry manuale dopo il
limite. Eliminare cache-busting per-request e usare versioni/ETag coerenti.

**Verifica richiesta.** Test con risposte simulate `429/503` e rete sospesa:
nessuna sovrapposizione, intervalli crescenti e randomizzati, stop al tetto e
ripresa controllata; soltanto poche richieste concordate in staging.

**Mapping.** API4:2023, ASVS V11/V13.

## Controlli senza finding sfruttabile confermato

- **RLS/IDOR.** Le tabelle account, GPX, marker ed export usano owner check su
  `auth.uid()`. Le funzioni di mutazione cercano righe owner-specifiche e i
  worker RPC sono revocati ad `anon/authenticated`.
- **Storage/signed URL.** `user-gpx` e `account-exports` sono privati; path e
  archive entry sono UUID server-side. Il client mobile chiede signed URL GPX
  da 60 secondi. Nessun token e' loggato dal codice applicativo osservato.
- **Lifecycle.** Trigger di mutazione, policy read/delete/upload e RPC di
  accesso applicano `has_current_contributor_access`. Lo stato restricted
  mantiene i soli diritti previsti dal contratto. Resta necessaria la prova
  runtime corrente.
- **Race.** Reservation per utente con advisory lock, upload `upsert:false`,
  finalize con row lock, job con lease/claim e retry idempotenti riducono race
  note. Nessuna race prod e' stata sollecitata.
- **Path traversal.** Il filename originale puo' contenere testo non ideale, ma
  Storage e ZIP non lo usano come path: oggetti ed entry export sono costruiti
  da UUID. Nessun traversal sfruttabile trovato.
- **Injection.** Le query applicative usano Supabase/PostgREST, parametri RPC e
  quoting esplicito dei path backend. Non sono state trovate concatenazioni SQL
  con input utente.
- **CSRF/CORS.** Le API private usano bearer in header, non cookie ambienti;
  `Access-Control-Allow-Origin: *` sugli oggetti pubblici e' coerente. Il
  problema di sessione indotta e' separatamente coperto da `SEC-AUD-002`.
- **XSS applicativo.** Nessun `dangerouslySetInnerHTML`/`setHTML` applicativo;
  popup con DOM React. La dipendenza MapLibre resta coperta da `SEC-AUD-010`.
- **Logging.** I log mobile correnti osservati sono messaggi generici e non
  interpolano coordinate, path, sessioni o error object. I log pipeline
  persistono classi/conteggi. Non e' stato verificato logcat release o logging
  provider.
- **TLS.** Gli endpoint applicativi configurati usano HTTPS; il client Supabase
  accetta solo host `https://...supabase.co`. Certificate pinning non e'
  obbligatorio per questo threat model, ma il binario finale va ispezionato.
- **Logout.** Il codice usa `signOut()` con scope Supabase globale di default e
  rimuove la sessione persistita. Supabase precisa che l'access token gia'
  emesso resta valido fino a scadenza:
  [Supabase sign out](https://supabase.com/docs/guides/auth/signout). La durata
  JWT di produzione non era verificabile.
- **Secret correnti.** Nei file tracciati non sono emersi private key, JWT,
  credenziali cloud o `service_role`; solo `.env.example`. `.env`, native dirs,
  signing material, dist, dataset e log sono ignorati. La chiave anon Supabase
  e' pubblica per design e non sostituisce RLS.

## Checklist pre-release

`DONE` significa che il controllo di audit e' stato completato con l'evidenza
indicata; non significa che tutti i finding correlati siano corretti.

| Area / controllo | Stato | Evidenza o blocker |
|---|---|---|
| Documenti richiesti e threat model | DONE | lettura completa e modello in questo report |
| Suite backend | DONE | 193 passed |
| Suite/typecheck mobile | DONE | 227 passed, 3 skipped; typecheck passed |
| Suite/build web | DONE | 128 passed; build passed |
| Signup email e conferma obbligatoria pubblica | DONE | audit Auth read-only del 2026-09-09 |
| Redirect allow-list, template, SMTP gestiti | NOT TESTED | manca access token Management |
| Policy password, leaked-password check, MFA, JWT TTL | NOT TESTED | configurazione Dashboard non disponibile |
| Enumerazione account via signup/reset | NOT TESTED | mancano account/mailbox usa-e-getta; nessuna email inviata |
| Rate limit Auth/reset/retry | NOT TESTED | nessun test quota/flood autorizzato |
| Deep link Auth mobile verificato | BLOCKED | codice App/Universal Links pronto; associazioni live e AAB/IPA non verificati (`SEC-AUD-001`) |
| Session injection web | BLOCKED | fix e test locali completati; test runtime a due account mancante (`SEC-AUD-002`) |
| Storage sicuro sessione e backup mobile | BLOCKED | `SEC-AUD-003` |
| Credenziali Auth fuori da URL/log | BLOCKED | fragment e cleanup pre-render implementati; template/deploy/log runtime non verificati (`SEC-AUD-004`) |
| Logout e scadenza access token prod | NOT TESTED | JWT TTL e test runtime mancanti |
| RLS/RPC/Storage statici owner-only | DONE | policy e funzioni revisionate; suite verde |
| Cross-user runtime produzione corrente | NOT TESTED | prove storiche nei runbook; nessuna credenziale in questa sessione |
| Signed URL owner, expiry e replay runtime | NOT TESTED | TTL 60 s verificato staticamente |
| Export/cancellazione IDOR runtime corrente | NOT TESTED | prove storiche, non ripetute |
| Enforcement lifecycle/riaccettazione statico | DONE | trigger, policy e RPC revisionati |
| Enforcement lifecycle/riaccettazione runtime | NOT TESTED | account usa-e-getta mancanti |
| Protezione tecnica `full_access` dati recenti | RISK ACCEPTED 1.9.0 | Dati non personali; gate D-7 solo UI, rivalutazione su crescita/forecast riservati/costi anomali (`SEC-AUD-008`) |
| GPX cap mobile nel percorso testato | DONE | ISIZE precheck e cap post-decompressione |
| GPX ammissione server-side | IMPLEMENTED, RUNTIME NEGATIVE TEST PENDING | Migration applicata e 9 archivi validati; manca upload avverso live (`SEC-AUD-005`) |
| GPX web anti-zip-bomb/XML budget | IMPLEMENTED, RUNTIME PENDING | Cap e parser bounded testati; deploy/browser avverso non verificati (`SEC-AUD-006`) |
| GPX path traversal Storage/export | DONE | path/entry UUID server-side |
| Race upload/finalize/delete produzione | NOT TESTED | controlli statici presenti; nessuna race live |
| Cache/export mobile rimossi | IMPLEMENTED, DEVICE TEST PENDING | Cleanup dedicato testato; filesystem reale non verificato (`SEC-AUD-007`) |
| Injection backend/API | DONE | nessun sink SQL/shell raggiungibile trovato |
| CSRF/CORS applicabile | DONE | bearer API; login CSRF trattato separatamente |
| Quota cancellazione esterna resistente ad abuso | IMPLEMENTED, RUNTIME PENDING | Input sconosciuti non consumano budget per contratto/test locale; prova live limitata mancante (`SEC-AUD-009`) |
| Quota CDN/Storage/tile e spending alert | NOT TESTED | configurazione provider non disponibile |
| Protezione volumetrica edge sito | DONE | risposta live Cloudflare e garanzia provider; nessuno stress test |
| Protezione volumetrica edge Supabase/Storage | DONE | edge/CDN dichiarati dal provider e header live; nessuno stress test |
| WAF, rate limit applicativi, CAPTCHA e alert DDoS | NOT TESTED | pannelli provider non disponibili |
| Budget tenant GPX/Storage/export | PARTIAL | Budget DB applicati; CAPTCHA/rate edge signup e alert provider restano aperti (`SEC-AUD-016`) |
| Fairness e limite cleanup export scaduti | IMPLEMENTED, RUNTIME BACKLOG TEST PENDING | Cap job/byte/tempo e priorità cancellazioni; backlog live non simulato (`SEC-AUD-017`) |
| Backoff/jitter client durante outage | IMPLEMENTED, RUNTIME PENDING | Test simulati web/mobile verdi; prova deploy/build mancante (`SEC-AUD-018`) |
| Load test controllato su staging | NOT TESTED | vietato sollecitare la produzione; staging non disponibile |
| CSP/XSS applicativo web | DONE | CSP live e nessun sink applicativo diretto |
| MapLibre corretto | IMPLEMENTED, BROWSER TEST PENDING | Web a 6.4.1; attribution/popup/CSP live non riverificati (`SEC-AUD-010`) |
| Cache/referrer route Auth | DONE | `no-store`, `no-referrer` live |
| HSTS e route cancellazione coerente | BLOCKED | `SEC-AUD-015` |
| Logging sorgente senza dati sensibili | DONE | scansione statica; nessun valore sensibile stampato |
| Logcat/network device release | NOT TESTED | AAB e device test mancanti |
| Background location e disclosure sorgente | DONE | permesso/disclosure presenti e test di integrazione verde |
| Dichiarazione Play e comportamento permesso background | NOT TESTED | richiede build/device/Play Console |
| Manifest, firma, permission e TLS AAB finale | NOT TESTED | nessun AAB/APK di release disponibile |
| Segreti working tree/tracked files | DONE | nessun segreto privilegiato confermato |
| Segreti in Git history | DONE | Chiave storica eliminata nel provider; valore assente da HEAD, history preservata (`SEC-AUD-014`) |
| `.gitignore` / `.easignore` | DONE | env, native, signing, dist, dataset e log esclusi |
| Source map/artifact distribuiti | NOT TESTED | nessun artifact finale; map locale ignorata |
| Dipendenza web MapLibre | IMPLEMENTED, BROWSER TEST PENDING | Versione corretta 6.4.1; verifica deploy/UI ancora aperta (`SEC-AUD-010`) |
| Dipendenze backend/mobile/web | DONE | Lock hash-bearing, gate e SBOM; eccezioni mobile puntuali da riesaminare entro 2026-10-10 (`SEC-AUD-011`) |
| Firma EAS Update | IMPLEMENTED, SIGNED BUILD PENDING | OTA disabilitato per 1.9.0; configurazione AAB/IPA non verificata (`SEC-AUD-012`) |

## Gate di rilascio consigliato

1. Completare le verifiche runtime/release di `SEC-AUD-001`, `SEC-AUD-002`,
   `SEC-AUD-003` e `SEC-AUD-004` senza chiuderle sulla sola evidenza locale.
2. Completare le prove ancora indicate per `SEC-AUD-005`, `SEC-AUD-006`,
   `SEC-AUD-007`, `SEC-AUD-009`, `SEC-AUD-010`, `SEC-AUD-012`,
   `SEC-AUD-013`, `SEC-AUD-017` e `SEC-AUD-018`; completare o accettare
   formalmente i controlli edge/provider residui di `SEC-AUD-016`.
3. Per `SEC-AUD-008`, applicare l'accettazione rischio della sola release 1.9.0
   e rivalutarla ai trigger registrati prima di estenderla a release successive.
4. Ottenere AAB production candidato e ripetere manifest/signing/source-map,
   backup/restore, deep link concorrente, logcat e network test.
5. Con due account usa-e-getta, ripetere matrice RLS/RPC/Storage/export/delete,
   restriction/riaccettazione, reset/logout e signed URL expiry. Usare poche
   richieste e una sola email per flusso.
6. Verificare WAF/rate limit/CAPTCHA, Smart CDN, alert e limiti di spesa nei
   pannelli provider; validare `SEC-AUD-018` con errori simulati e un load test
   controllato su staging, mai con flood della produzione.
7. Verificare le altre impostazioni Management/Dashboard mancanti e chiudere i
   quattro finding Low o documentarne l'accettazione.

Questo assessment si ferma alla fase documentale richiesta. Non sono stati
implementati fix.
