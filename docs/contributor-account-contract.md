# Contratto tecnico account contributore

Questo documento definisce lo schema target minimo. Le migration e il comando
lifecycle sono preparati ma non applicati in produzione. La configurazione
`account_lifecycle_config.lifecycle_enabled` nasce a `false`: nessun gate o
invio diventa effettivo prima del cutover coordinato con web e mobile.

## Stati

`user_profiles.account_state` ammette soltanto:

- `active`: Termini correnti accettati e accesso completo;
- `restricted`: accesso limitato;
- `deletion_pending`: richiesta di eliminazione in lavorazione.

Per `restricted`, `restriction_reason` e obbligatoria e vale uno tra:
`terms_outdated`, `terms_refused`, `inactive`, `security`.

Un JWT valido non sostituisce il controllo dello stato. Qualunque stato assente
o non verificabile deve produrre accesso limitato.

## Versioni e tempi

Le versioni e i timestamp gia presenti per Termini e informativa privacy
restano la base del contratto. I nuovi campi registrano:

- presa visione dell'informativa privacy;
- provenienza dell'accettazione (`mobile`, `web` o migrazione);
- prima comunicazione autenticata di una nuova versione e relativa scadenza;
- ultima attivita autenticata significativa;
- eventuale richiesta di eliminazione.

La privacy viene presa in visione, non "accettata" come base giuridica. I
Termini includono il requisito 18+ e il contratto contributivo approvato.

La prima presentazione autenticata viene registrata esclusivamente da
`record_my_legal_notice_seen`. Solo questo evento avvia i 365 giorni; una email
inviata, una notifica locale o un semplice refresh non lo fanno. Accettazione e
rifiuto sono eventi append-only per versione. I promemoria sono previsti
all'avvio, dopo sei mesi, 30 giorni e 7 giorni prima della scadenza.

L'inattivita usa soltanto `last_meaningful_activity_at`, aggiornato dalla RPC
esplicita per login/sessione in foreground/azione account. A 24 mesi lo stato
diventa `restricted/inactive`; a 36 mesi diventa `deletion_pending`. Il job di
eliminazione fisica appartiene a `BE-ACCOUNT-005` e non e implementato qui.

## Account esistenti e compatibilita

Gli account preesistenti vengono inizializzati una sola volta come
`restricted/terms_outdated`. La migrazione non retrodata il termine di
riaccettazione: la scadenza sara calcolata dal task lifecycle dopo la prima
comunicazione mostrata durante una sessione autenticata.

I campi `raw_gpx_research_consent*` restano temporaneamente nel database per
compatibilita e audit, ma sono legacy: non autorizzano il trattamento previsto
dal nuovo contratto e non devono essere usati per decidere l'accesso.

Ogni utente continua a leggere soltanto il proprio profilo e non puo modificare
direttamente i campi lifecycle. Quando il gate e attivo, RLS, policy Storage e
trigger sulle tabelle impediscono a un account non `active` di leggere o
mutare archivio e marker, anche passando dalle RPC `SECURITY DEFINER`.

Gli account limitati conservano soltanto le RPC per leggere lo stato, registrare
la presentazione, accettare/rifiutare e registrare un vero nuovo accesso.
L'export e la cancellazione completa restano rispettivamente `BE-ACCOUNT-004`
e `BE-ACCOUNT-005`; fino ad allora il normale accesso al GPX e bloccato.

I job trusted devono usare esclusivamente
`trusted_current_contributor_gpx_tracks()` e
`trusted_current_contributor_gpx_markers()`: entrambe falliscono chiuse prima
del cutover ed escludono stato non attivo o versioni obsolete. I vecchi campi
`raw_gpx_research_consent*` non partecipano alla selezione.

## Migrazione

La definizione preparatoria e in:

```text
backend/supabase/migrations/202608290001_contributor_account_contract.sql
```

L'enforcement, le RPC lifecycle, l'outbox e i job trusted sono in:

```text
backend/supabase/migrations/202608310001_account_lifecycle_and_email_outbox.sql
```

Export, verifica esterna, cancellazione riprendibile e retention Gmail sono in:

```text
backend/supabase/migrations/202609010001_account_rights_export_deletion.sql
```

Il blocco usa `account_rights_enabled=false` separatamente dal lifecycle. Gli
account `restricted` possono esportare e chiedere la cancellazione senza
riottenere accesso all'archivio ordinario. La conferma di cancellazione richiede
un token monouso inviato all'email Auth; un semplice JWT o la conoscenza
dell'indirizzo non bastano. Storage, dati applicativi e Auth vengono eliminati
in quest'ordine soltanto dopo la pulizia delle email automatizzate.

Non applicare ora nessuna delle tre in produzione. Ordine futuro obbligatorio:
`202608290001`, poi `202608310001`, poi `202609010001`. Le seconde e terze
migration sono tecnicamente inerti fino all'abilitazione dei rispettivi flag,
ma la prima marca correttamente i legacy come
`restricted/terms_outdated`; il cutover deve quindi essere coordinato.
