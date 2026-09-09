# Preflight cutover account

**Data:** 1 settembre 2026
**Esito:** `BLOCKED` per produzione fino al completamento dei prerequisiti; il
cutover avverrà direttamente sul progetto Supabase attuale, con rollout
controllato e account di prova usa-e-getta.

## Ambito e prove eseguite

Il controllo e' stato solo locale/read-only: nessuna migration e' stata
applicata, nessun flag e' stato attivato, nessun account o email reale e' stato
usato. Non e' configurato un progetto Supabase di staging separato.

- ordine verificato: `202608290001` -> `202608310001` ->
  `202609010001`;
- tutte e tre le migration usano oggetti riapplicabili (`if not exists`,
  `create or replace` o `drop ... if exists`) per il percorso previsto;
- il preflight ha corretto `202608290001`: anche il valore predefinito di
  `restricted_at` e' ora `now()`. Cosi' una registrazione legacy nel breve
  intervallo fra prima e seconda migration soddisfa il vincolo coerente per lo
  stato `restricted`;
- test backend mirati lifecycle/rights: **26 passati**; test mobile: **174
  passati, 3 skipped**; build web generata localmente. Il runner web e' stato
  avviato e ha caricato i test, ma la cattura del terminale non ha restituito il
  riepilogo finale: ripetere la suite web in CI o localmente con esito completo come condizione di
  cutover;
- l'ambiente backend locale contiene configurazione Supabase ma nessuna
  configurazione nominata di staging e nessuna delle tre variabili del
  dispatcher dei diritti. Non e' stato contattato il progetto di produzione.

## Compatibilita' verificata staticamente

| Area | Esito | Evidenza |
| --- | --- | --- |
| Stati `active`, `restricted`, `deletion_pending` | Pronta | `get_my_account_access`, RLS, trigger su tracce/marker e policy Storage usano il gate server. |
| Fail-closed dopo attivazione | Pronta | `full_access` e' necessario per archivio; RPC/risposta non valida o stato non verificabile bloccano il client. Il fallback legacy vale soltanto finche' API o flag sono disabilitati. |
| Riaccettazione | Pronta | web/mobile inviano versioni server e `p_source` corretto; `notice_seen` e' l'unico avvio della deadline. |
| Export | Pronta localmente | job privato, RLS sul path esatto, TTL e download JWT; pannelli client presenti. |
| Cancellazione | Pronta localmente | richiesta autenticata/esterna, token hashato e monouso, pagina web pubblica e stato `deletion_pending`. |
| Email lifecycle | Pronta localmente | outbox deduplicata, lock/lease/retry; segreto SMTP e scheduler mancano intenzionalmente. |
| Archivio GPX | Pronta localmente | lettura, mutate RPC e Storage richiedono account attivo e documenti correnti quando lifecycle e' attivo. |

I job trusted selezionano solo profili attivi/versioni correnti e restano vuoti
prima dell'abilitazione. I dati non devono essere usati per modelling prima del
cutover completo.

## Blocker prima della produzione

1. Pubblicare e rendere efficaci URL e versioni definitive di Termini e
   Privacy. Non impostare versioni fittizie.
2. Preparare account di prova usa-e-getta direttamente nel progetto di
   produzione. Non usare per la cancellazione i tre account personali esistenti.
3. Eseguire le prove runtime con gli account di prova, incluso REST/Storage
   cross-user, account legacy, account ristretto e hard-delete Auth.
4. Definire e conservare solo nei secret del worker: App Password Gmail
   dedicata, subject Auth esatti, URL pubblico `/elimina-account`, URL account
   e scheduler sempre attivo. Non usare l'App Password SMTP di Supabase Auth.
5. Ripetere la suite web completa con esito finale e fare E2E web/mobile reali,
   inclusa pagina pubblica di cancellazione.
6. Risolvere i gate di release ancora `IN-PROGRESS` nel rollout, in particolare
   documenti efficaci, prove runtime di `SEC-001/002`, `QA-001`, cleanup
   `pending_upload`, retention Gmail e scheduler.

## Runbook di cutover

### 0. Freeze e backup operativo

1. Congelare le build web/mobile che implementano gli handoff lifecycle e
   rights; annotare commit/artifact e URL legali esatti.
2. Verificare che `Confirm email` e SMTP Auth restino funzionanti; non cambiare
   Site URL o callback durante il cutover.
3. Disabilitare scheduler futuri: prima delle migration non deve girare ne'
   `run_account_lifecycle --send`, ne' `run_account_rights --run`, ne' il
   cleanup automatico delle prenotazioni GPX.
4. Verificare che le build web/mobile siano già disponibili e compatibili; il
   runbook prosegue direttamente sul progetto di produzione.

### 1. Produzione: migration e controlli dopo ogni passo

Nel SQL Editor del progetto Supabase attuale, eseguire integralmente e in questo
ordine i tre file. Non concatenarli e non modificarli nel browser.

1. `202608290001_contributor_account_contract.sql`
   - controllare `user_account_contract_setup_audit()` con service role;
   - verificare che gli utenti esistenti siano `restricted/terms_outdated`,
     senza deadline; una nuova signup legacy deve riuscire.
2. `202608310001_account_lifecycle_and_email_outbox.sql`
   - controllare `account_lifecycle_setup_audit()`; `lifecycle_enabled` deve
     essere `false`, trigger e policy devono risultare presenti;
   - con lifecycle ancora off, verificare login e archivio legacy;
   - eseguire `cleanup_pending_gpx_uploads --dry-run`: deve produrre soltanto
     conteggi aggregati; non eseguire ancora `--run` finche' non sono verificati
     i due account usa-e-getta;
   - non impostare ancora versioni legali efficaci né abilitare il lifecycle.
3. `202609010001_account_rights_export_deletion.sql`
   - controllare `account_rights_setup_audit()`; flag `false`, bucket
     `user-data-exports` privato;
   - verificare che il bucket `user-gpx` e altri bucket non siano cambiati.

Dopo ogni migration: fermarsi se audit, policy, numero profili o signup non
sono quelli attesi. Non procedere al file successivo.

### 2. Produzione: test con account usa-e-getta

Con account A e B diversi, ripetere:

- A attivo: signup con versioni esatte, archivio GPX, marker, export ZIP e
  download prima della scadenza;
- B ristretto: nessuna lettura/mutazione GPX o Storage, ma export e richiesta
  cancellazione disponibili;
- cross-user: A non legge/scarica/elimina metadata o oggetti di B, neppure con
  REST/Storage diretto;
- riaccettazione: mostrare davvero il documento, poi `notice_seen`, accettare
  e rifiutare; verificare eventi e `full_access`;
- cancellazione: richiesta esterna non enumerativa, token in frammento,
  conferma monouso, `deletion_pending`, failure injection Storage poi Auth,
  retry fino a nessun oggetto/riga/Auth user;
- email: un solo messaggio usa-e-getta, Message-ID, pause/limite/outbox retry;
  provare anche subject Auth allow-list e IMAP senza cancellare posta estranea.
- upload incompleto: A crea una prenotazione e carica un oggetto di prova senza
  finalizzare; con TTL temporaneamente ridotto solo per A/test controllato,
  verificare `--dry-run`, poi `--run`, assenza di oggetto e metadata. Ripetere
  con errore Storage e verificare che una traccia `ready` non sia mai toccata.

### 3. Produzione: attivazione graduale

1. Applicare le stesse migration con i medesimi controlli post-step, mentre
   entrambi i flag restano `false`.
2. Deploy web/mobile gia' verificati. Testare una sessione esistente: stato e
   archivio devono essere governati dal server senza spostare/rimontare la
   mappa.
3. Configurare nei soli secret del worker le variabili dispatcher e uno
   scheduler giornaliero che esegua prima cleanup pending GPX, poi lifecycle e
   rights. Eseguire solo:

```powershell
python -m backend.scripts.accounts.cleanup_pending_gpx_uploads --dry-run
python -m backend.scripts.accounts.run_account_lifecycle --dry-run
python -m backend.scripts.accounts.run_account_rights --dry-run
```

4. In una finestra monitorata, impostare versioni legali reali e
   `lifecycle_enabled=true`. Non attivare subito `account_rights_enabled`.
   Verificare con un account di controllo che legacy sia ristretto senza
   deadline fino alla vera visualizzazione del documento.
5. Abilitare `account_rights_enabled=true` solo dopo export/cancellazione
   test completi. Eseguire prima `--dry-run`; il primo `--send`/`--run`
   richiede autorizzazione esplicita e limite minimo.

### 4. Rollback e condizioni di stop

- Per bloccare nuove restrizioni/email: disabilitare scheduler e impostare
  `lifecycle_enabled=false`. Gli stati ed eventi restano per diagnosi.
- Per bloccare nuovi export/cancellazioni: disabilitare scheduler rights e
  impostare `account_rights_enabled=false`. Non annulla un job gia' avviato.
- Non eliminare outbox o job per "ripulire" il rollback.
- Fermare subito il rollout se: una policy cross-user permette dati altrui,
  una signup fallisce, audit incoerente, email inviata al destinatario errato,
  token/log contiene segreti, stato non verificabile da accesso completo,
  Storage non vuoto prima della fase database, o cancellazione Auth senza
  completamento delle fasi precedenti.

## Checklist frontend al cutover

- **Web:** URL legali pubblici, callback Auth invariati, pagina
  `/elimina-account` con frammento rimosso, export/download privato, schermata
  restricted/deletion_pending e nessun bypass tramite archivio.
- **Mobile:** aggiornamento della build con lifecycle/rights, foreground reale
  soltanto come attivita' significativa, export condiviso in modo sicuro,
  apertura del link pubblico di cancellazione e purga stato GPX senza cambiare
  camera mappa.

Il completamento richiede evidenze runtime sul progetto di produzione con soli
account di prova; questo file non le sostituisce.

## Evidenza rights del 6 settembre 2026

Applicate in produzione le follow-up idempotenti
`202609060003_fix_account_deletion_callback_grant.sql` e
`202609060004_enable_account_rights.sql`. Audit post-cutover:
`account_rights_enabled=true`, lifecycle invariato e attivo, versioni legali
1.0/1.0, bucket export privato e nessun job preesistente.

Il collaudo con due soli account usa-e-getta ha verificato export completo e
privato, ZIP/GPX/marker, scadenza, isolamento cross-user, richiesta esterna,
email reale, callback anonima monouso, retry dopo failure Storage, retry dopo
failure Auth e cancellazione finale di Storage/database/Auth. Il cleanup finale
ha lasciato zero export e richieste esterne di test. Nessun account reale e'
stato cancellato o modificato. Il lifecycle non e' stato cambiato.

Il test ha inoltre corretto la quotatura delle mailbox e dei valori SEARCH
Gmail IMAP; una query IMAP reale non distruttiva e i test di regressione sono
passati. Resta operativa l'esecuzione giornaliera manuale dei tre comandi finche'
non verra' scelto uno scheduler.

## Evidenza lifecycle-only del 6 settembre 2026

Nota dispatcher del 6 settembre: il primo invio controllato autorizzato si e'
fermato prima del claim SMTP. `prepare_account_lifecycle_daily` ha restituito
SQLSTATE `55000` per il conflitto tra il record PL/pgSQL `profile` non ancora
assegnato e un alias SQL omonimo. La follow-up idempotente
`202609060002_fix_lifecycle_prepare_record_name.sql` e' stata applicata; il
preview e' tornato corretto e l'invio controllato con limite 1 ha chiuso con
`claimed=True sent=1 failed=0`. Il preview finale riporta zero email
dispatchable. `account_rights_enabled=false` e' rimasto invariato.

- route pubbliche `/termini/`, `/privacy/`, `/account-e-dati/` e `/mappa/`:
  HTTP 200;
- bundle Cloudflare: Termini 1.0, Privacy 1.0, route mappa e contratto lifecycle
  presenti;
- Auth pubblico: provider email attivo, signup attivo, conferma obbligatoria;
- GPX audit: 5 profili, 6 tracce, 10 marker; cleanup pending eleggibili 0;
- lifecycle: disabilitato, versioni `null`, 5 profili restricted, 0 eventi,
  outbox vuota e gate completi;
- rights: disabilitato, 0 export, 0 cancellazioni, 0 richieste esterne, bucket
  export privato.

Il cutover limitato al lifecycle con
`202609060001_enable_account_lifecycle_v1.sql` è stato applicato. Gli audit
post-esecuzione confermano configurazione pubblica 1.0/1.0, lifecycle attivo,
rights disattivo, cinque profili restricted, zero eventi e outbox vuota. Resta
da verificare la riaccettazione web autenticata e che la deadline nasca solo
dalla prima visualizzazione effettiva della comunicazione.

Il collaudo autenticato successivo ha verificato due rami controllati: un
account ha accettato ed è diventato `active` con versioni 1.0/1.0; un secondo
ha rifiutato ed è rimasto `restricted/terms_refused`. Per entrambi la prima
visualizzazione ha impostato una deadline esattamente 365 giorni dopo, non
retrodatata. Audit: 4 eventi legali, una email iniziale annullata dopo
l'accettazione e una email ancora pending; nessun invio è stato eseguito.
L'indice pubblico è rimasto disponibile, come previsto dal contratto.
