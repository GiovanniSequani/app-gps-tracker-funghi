# Account, accesso all'indice e privacy: piano di rollout

## Scopo e autorità

Questo documento è il backlog di coordinamento per il passaggio di
FunghiTracker al modello con servizio pubblico limitato e account contributore.
Deve essere letto prima di modificare account, GPX, accesso all'indice,
documenti legali, modelling o dichiarazioni degli store.

Le chat backend, mobile, web, modelling e coordinamento devono:

1. usare gli ID di questo documento nei propri handoff;
2. aggiornare stato, data ed evidenze solo per attività realmente completate;
3. non reinterpretare retroattivamente le vecchie accettazioni;
4. segnalare qui ogni contrasto tra codice, documenti legali e comportamento;
5. non segnare un task `DONE` se manca una verifica richiesta dal criterio di
   completamento.

Principio di proporzionalità: implementare e documentare il minimo necessario
per rispettare legge, sicurezza e requisiti degli store. Non aggiungere
procedure, dati, consensi o infrastrutture non richiesti dal rischio reale o
dal funzionamento del prodotto.

Ordine di autorità:

1. legge applicabile e testi approvati dal legale;
2. decisioni esplicite registrate in questo documento;
3. contratti tecnici in `docs/`;
4. implementazione corrente.

Se un testo legale approvato contrasta con questo piano, fermare il task,
registrare il conflitto e aggiornare prima il piano e i contratti tecnici.

## Legenda

- `DECIDED`: decisione di prodotto approvata.
- `OPEN`: decisione ancora da prendere.
- `OPEN-LEGAL`: serve conferma del legale prima della release.
- `TODO`: attività non iniziata.
- `IN-PROGRESS`: attività iniziata ma non completata.
- `BLOCKED`: attività bloccata con causa documentata.
- `DONE`: attività completata e verificata con evidenze.

## Decisioni approvate

### Prodotto e destinatari

- `DECIDED` Distribuzione iniziale: Italia.
- `DECIDED` Età minima: 18 anni.
- `DECIDED` Titolare del trattamento: Giovanni Sequani.
- `DECIDED` Contatto privacy e supporto: `funghitracker@gmail.com`.
- `DECIDED OPS-001` Lo stesso indirizzo `funghitracker@gmail.com` viene usato
  inizialmente come mittente delle email automatiche tramite Gmail SMTP, per
  mantenere un solo riferimento riconoscibile per gli utenti.
- `DECIDED` Gmail viene configurato come SMTP personalizzato con TLS, verifica
  in due passaggi e App Password conservata esclusivamente nei secret.
- `DECIDED` Quando volume o requisiti di affidabilità lo richiederanno, il
  mittente passerà a un dominio personalizzato e a un provider transazionale;
  il cambio sarà preceduto dall'aggiornamento di documenti e configurazione.
- `DECIDED` FunghiTracker è inizialmente un progetto personale gratuito, senza
  partita IVA, pubblicità, acquisti, abbonamenti, donazioni o attività
  professionale.
- `DECIDED` Un futuro passaggio a un indirizzo sul dominio FunghiTracker è un
  aggiornamento operativo di contatti, documenti, store e configurazione email;
  non richiede di cambiare l'architettura degli account.
- `DECIDED` Supabase è ospitato nella regione EU Central, Francoforte.
- `DECIDED` I testi legali saranno pubblicati sul sito Cloudflare Pages.
- `DECIDED` Il terreno statico resta pubblico anche senza account.
- `DECIDED` Nessun percorso o ritrovamento individuale viene pubblicato.
  L'unico output pubblico derivato dal modelling è l'indice finale.

### Servizio senza account

- `DECIDED` Accesso all'indice con ritardo di 7 giorni.
- `DECIDED` Nessun forecast.
- `DECIDED` Nessuna analisi diagnostica dell'indice.
- `DECIDED` Dati meteo disponibili.
- `DECIDED` Nessun archivio cloud o locale gestito dall'app.
- `DECIDED` Nessun import o caricamento sulla mappa di percorsi salvati.
- `DECIDED` È possibile registrare temporaneamente un percorso e, al termine,
  invocare la condivisione nativa del sistema operativo per salvarlo nei file
  del dispositivo o condividerlo.
- `DECIDED` Dopo la condivisione o l'abbandono esplicito del flusso, l'app non
  deve conservare il percorso in un archivio proprio.

### Servizio con account contributore

- `DECIDED` L'account abilita tutte le funzionalità: indice corrente, storico,
  analisi, futuro forecast, archivio cloud, import, editing e visualizzazione
  dei percorsi.
- `DECIDED` Prima della creazione dell'account l'utente riceve comunicazione
  evidente dell'uso di localizzazione, GPX e ritrovamenti per validare e
  migliorare l'algoritmo dell'indice.
- `DECIDED` La partecipazione contributiva è parte delle condizioni
  contrattuali dell'account secondo la scelta validata con il legale.
- `DECIDED` La base giuridica approvata per account e trattamento contributivo
  è l'esecuzione del contratto ai sensi dell'art. 6(1)(b) GDPR.
- `DECIDED` L'utente accetta i Termini e dichiara di aver letto la Privacy
  Policy. Non presentare l'informativa privacy come un contratto autonomo.
- `DECIDED` La permission del sistema operativo per la posizione resta distinta
  dall'accettazione contrattuale dell'account.

### Account esistenti e cessazione

- `DECIDED` Le vecchie accettazioni non autorizzano automaticamente il nuovo
  trattamento. Gli account esistenti devono accettare la nuova versione prima
  di tornare pienamente attivi.
- `DECIDED` In caso di rifiuto o mancata accettazione, l'account viene sospeso.
- `DECIDED` Un account sospeso è escluso immediatamente da nuove estrazioni,
  dataset, fine-tuning e validazioni.
- `DECIDED` Durante la sospensione sono consentiti soltanto: login limitato,
  lettura dei documenti, export dei dati, eliminazione dell'account e
  riattivazione tramite accettazione della versione corrente.
- `DECIDED` Durante la sospensione non sono consentiti: indice corrente,
  forecast, analisi, upload, modifica o creazione di nuovi dati cloud.
- `DECIDED` Un'email respinta o non consegnabile non causa da sola sospensione
  o cancellazione. Il backend registra l'esito e l'avviso autenticato resta la
  fonte principale per scadenze e riaccettazione.
- `DECIDED EMAIL-JOB-001` Un processo backend eseguito una volta al giorno
  controlla scadenze, transizioni di stato, promemoria, inattività, retry e
  cleanup delle email. Gli invii sono idempotenti e sequenziali, con una pausa
  configurabile di alcuni secondi e un limite giornaliero prudenziale per
  evitare picchi Gmail.
- `DECIDED` Le email automatiche non contengono percorsi, coordinate o
  ritrovamenti. Copie inviate ed esiti tecnici restano normalmente al massimo
  24 mesi e vengono rimossi con l'account entro i termini dichiarati.
- `DECIDED RET-001` Per una nuova versione materiale dei Termini, il termine di
  riaccettazione non parte dalla pubblicazione. Parte dalla prima comunicazione
  mostrata durante un accesso autenticato e registrata dal backend.
- `DECIDED` Il termine di riaccettazione è di 365 giorni. Alla scadenza, se
  l'utente non ha accettato, account e dati vengono cancellati.
- `DECIDED` Inviare promemoria di servizio all'avvio del termine, dopo 6 mesi,
  30 giorni prima e 7 giorni prima della scadenza, oltre alla conferma finale.
- `DECIDED` Un account che non accede per 24 mesi viene marcato inattivo,
  sospeso ed escluso dal modelling. Segue un preavviso di 12 mesi in sola
  lettura; dopo 36 mesi complessivi di inattività viene cancellato.
- `DECIDED` Durante il preavviso per inattività inviare email all'avvio, dopo
  6 mesi, 30 giorni prima e 7 giorni prima della cancellazione.
- `DECIDED` Un accesso autenticato significativo interrompe la cancellazione
  per inattività e presenta eventuali Termini correnti. Refresh token, job in
  background e chiamate automatiche non contano come attività dell'utente.
- `DECIDED` Per gli account esistenti non si retrodatano le scadenze: prima di
  una cancellazione devono ricevere almeno 12 mesi di preavviso secondo i testi
  e le modalità approvate dal legale.

### Cancellazione, export e retention

- `DECIDED` L'utente può eliminare account e dati direttamente da app e web.
- `DECIDED` Una richiesta esplicita di eliminazione avvia la cancellazione,
  non una semplice sospensione.
- `DECIDED` I dati operativi vengono eliminati appena il job lo consente; gli
  eventuali residui tecnici dichiarati devono scomparire entro 30 giorni.
- `DECIDED` GPX e marker di un account attivo restano finché l'utente non
  elimina la traccia o l'account.
- `DECIDED BACKUP-001` FunghiTracker non crea backup applicativi separati dei
  GPX. I backup Supabase Pro coprono Postgres ma non gli oggetti Storage; il
  rischio residuo di perdita è accettato e l'utente viene invitato a esportare
  i percorsi che desidera conservare.
- `DECIDED` Staging, mapping di provenienza e dataset pseudonimizzati di
  modelling vengono eliminati entro 10 giorni dalla loro creazione.
- `DECIDED` Anche il dataset finale usato per il fine-tuning è temporaneo: viene
  eliminato al termine delle verifiche della run e comunque entro 10 giorni.
- `DECIDED` Restano in modo permanente soltanto modello, configurazione,
  versione del codice, metriche aggregate e un registro minimale senza
  coordinate fini o identificativi: data, hash, numerosità, regole di
  eleggibilità e modello prodotto.
- `DECIDED` L'utente può ottenere un export dei propri dati.

### Procedura dati per il fine-tuning

- `DECIDED MODEL-PIPE-001` La sorgente è il bucket privato `user-gpx`, letto
  soltanto da job trusted e senza modificare gli oggetti originali.
- `DECIDED` Ogni run fissa un cutoff e seleziona soltanto account `active` che
  hanno accettato i documenti correnti e tracce `ready` ancora eleggibili.
- `DECIDED` Validazione, trim, marker, deduplicazione e associazione alla griglia
  avvengono in uno staging trusted con identificativi tecnici temporanei di
  utente, traccia e sessione.
- `DECIDED` Gli identificativi temporanei possono essere usati per controlli di
  qualità e per assegnare i gruppi di training/validation/test, ma non entrano
  nel dataset finale e vengono eliminati con staging e mapping entro 10 giorni.
- `DECIDED` Il dataset finale contiene soltanto giorno, specie, variabili meteo,
  variabili terreno, statistiche di effort del percorso, target dei
  ritrovamenti ed eventuale assegnazione train/validation/test. Non contiene
  account, pseudonimi, tracce, sessioni, coordinate, identificativi di cella,
  nomi o path Storage.
- `DECIDED` Il dataset finale viene eliminato dopo fine-tuning, validazione e
  debug della run, comunque entro 10 giorni. Ogni run futura lo ricostruisce
  dagli account eleggibili in quel momento.
- `DECIDED` GPX e marker originali seguono il lifecycle dell'archivio utente e
  non vengono eliminati dalla pipeline di modelling.
- `DECIDED` Formula dell'effort, tipo di target, criterio di split, modello e
  metriche restano decisioni metodologiche della chat modelling.

## Matrice funzionale target

| Funzione | Senza account | Account attivo | Account sospeso |
|---|---|---|---|
| Mappa e indice | ultimo giorno disponibile non successivo a `D-7` | corrente | solo versione pubblica `D-7` |
| Valore puntuale | ritardato | corrente | ritardato |
| Storico indice | termina a `D-7` | aggiornato | termina a `D-7` |
| Analisi indice | no | sì | no |
| Forecast | no | sì, quando disponibile | no |
| Meteo | sì | sì | sì |
| Terreno | sì | sì | sì |
| Registrazione mobile | temporanea + share sheet | salvataggio cloud | temporanea + share sheet |
| Archivio cloud | no | sì | sola esportazione |
| Archivio locale gestito dall'app | no | no, salvo cache tecnica | no |
| Import/edit/view GPX | no | sì | no, salvo export |
| Uso in nuovi job modelling | no | sì, se `active` e documenti correnti | no |

`D` è la data dell'indice corrente pubblicato correttamente. Per il pubblico si
usa l'ultima data effettivamente disponibile minore o uguale a `D-7 giorni`,
senza inventare o interpolare date mancanti.

## Gate di release

La nuova versione non può essere pubblicata finché non sono veri tutti i punti:

- testi legali approvati e pubblicati con URL stabili;
- retention e scadenze account riportate nei testi approvati dal legale;
- accettazioni versionate e account state applicati dal backend;
- indice ritardato verificato senza account;
- UI e discovery guest non mostrano dati successivi a `D-7`;
- l'esposizione tecnica residua dei dati recenti pubblici è documentata come
  limite accettato della prima release e non viene descritta come protezione;
- export e cancellazione account verificati end-to-end;
- account esistenti gestiti senza uso retroattivo dei dati;
- log di produzione privi di coordinate, GPX, token e path identificativi;
- nessun job modelling usa dati reali finché non è conforme a eleggibilità e
  retention; l'assenza temporanea del job non blocca la release;
- Google Data Safety e Apple App Privacy coerenti col comportamento reale.

## Workstream A - Documenti legali e compliance

### `LEGAL-001` Inventario definitivo del trattamento - `IN-PROGRESS`

Owner: coordinamento + backend + modelling + legale.

Definire per ogni dato: sorgente, finalità, base giuridica approvata, accessi,
fornitore, regione, retention, cancellazione, export e uso nel modelling.
Includere email, username, token, GPX, trkpt, marker, trim, metadata, log tecnici,
IP, meteo/terreno associati e artefatti derivati.

Criterio `DONE`: tabella approvata dal legale e senza campi `OPEN` rilevanti.

### `LEGAL-002` Termini di utilizzo - `IN-PROGRESS`

Descrivere servizio pubblico, account contributore, uso dei dati per il
miglioramento, sospensione, riattivazione, eliminazione, condotte vietate,
proprietà intellettuale, divieto di scraping e limitazioni di responsabilità.
Chiarire che l'indice non garantisce ritrovamenti, commestibilità, sicurezza,
accessibilità o legalità della raccolta.

Criterio `DONE`: versione numerata approvata dal legale.

### `LEGAL-003` Privacy Policy - `IN-PROGRESS`

Includere titolare, categorie dati, finalità, basi giuridiche, destinatari,
fornitori, trasferimenti, regione Supabase, retention, diritti, reclamo al
Garante, sicurezza, account sospesi, cancellazione, export e modelling.
Non definire pseudonimi o GPX come anonimi.

Criterio `DONE`: versione numerata approvata dal legale e coerente con
`LEGAL-001`.

### `LEGAL-004` Informative brevi e testi UI - `TODO`

Preparare testi approvati per registrazione, localizzazione foreground e
background, aggiornamento documenti, sospensione, export e cancellazione.
Separare chiaramente accettazione dei Termini, presa visione della Privacy e
permission del sistema operativo.

Criterio `DONE`: catalogo testi con versione e destinazione UI.

### `LEGAL-005` Diritti e cancellazione - `IN-PROGRESS`

Definire procedura per accesso, portabilità, rettifica, limitazione,
cancellazione e reclamo. Stabilire verifica identità, tempi operativi,
escalation e risposta via email. Preparare pagina pubblica richiesta da Google.

Criterio `DONE`: procedura verificata dal legale e implementabile senza
promesse impossibili.

### `LEGAL-006` Documenti interni - `IN-PROGRESS`

Preparare registro trattamenti, valutazione interna dei rischi, retention
schedule, elenco responsabili/sub-responsabili, matrice accessi, incident
response e data breach. Una DPIA formale non è richiesta allo stato attuale e
va rivalutata solo se ricorrono in futuro i requisiti dell'articolo 35 GDPR.

Criterio `DONE`: documenti versionati e responsabile della revisione definito.

### `LEGAL-007` Dichiarazioni store - `TODO`

Compilare checklist Google Play Data Safety e Apple App Privacy soltanto dopo
l'implementazione. Includere URL privacy e URL cancellazione account.

Criterio `DONE`: dichiarazioni confrontate campo per campo con app e fornitori.

## Workstream B - Backend account e ciclo di vita

### `BE-EMAIL-001` Configurazione Gmail SMTP - `DONE`

Configurare Supabase Auth con `smtp.gmail.com`, porta 587 e TLS usando
`funghitracker@gmail.com`. Abilitare 2FA, creare un'App Password dedicata e
conservarla soltanto nei secret Supabase/backend. Verificare conferma account,
recupero password, cambio email, rate limit ed errori senza scrivere credenziali
o destinatari nei log. La conferma email era stata disabilitata dopo un flusso
non funzionante: prima di riattivarla verificare con evidenze configurazione
Supabase, Site URL, redirect consentiti e callback costruite da web e mobile.
In produzione nessun link deve terminare su `localhost`; lo sviluppo locale
deve continuare a funzionare soltanto tramite redirect esplicitamente ammessi.

Criterio `DONE`: invii reali di test completati per registrazione, conferma e
recupero password; callback di produzione web e mobile verificate end-to-end;
causa del precedente malfunzionamento documentata; segreto assente da repository
e client; procedura di revoca/rotazione documentata.

### `BE-EMAIL-002` Dispatcher giornaliero delle comunicazioni - `IN-PROGRESS`

Creare un unico comando backend eseguibile ogni giorno che controlli gli eventi
account dovuti, applichi le transizioni previste, alimenti una outbox idempotente
e invii i messaggi in sequenza.
Pausa tra invii, limite giornaliero, lock di esecuzione, retry e backoff devono
essere configurabili. Un riavvio non deve duplicare email né perdere scadenze;
l'avviso autenticato resta la fonte principale delle deadline.

Criterio `DONE`: test con esecuzioni ripetute, concorrenza, errore SMTP, quota
raggiunta e ripresa il giorno successivo; scheduling di produzione verificato
su un ambiente sempre disponibile.

Stato: comando, outbox, lock, deduplica, retry/backoff e test controllati sono
preparati. Mancano applicazione staging/produzione, invio controllato con la
credenziale dedicata e verifica dello scheduler always-on; quindi non è `DONE`.

Nota operativa BE-EMAIL-002 del 6 settembre 2026: il primo invio singolo
autorizzato non ha reclamato ne' inviato l'email. La preparazione SQL e' fallita
con SQLSTATE `55000` per un conflitto tra record PL/pgSQL e alias SQL entrambi
chiamati `profile`. La correzione idempotente e'
`202609060002_fix_lifecycle_prepare_record_name.sql`; dopo la sua applicazione
servono preview, retry limitato a una email e conferma della ricezione prima di
chiudere il task.

La follow-up e' stata applicata in produzione. Preview prima dell'invio:
`enabled=True`, nessuna transizione, `emails=1`; dispatcher controllato:
`claimed=True sent=1 failed=0 stop=daily_limit`; preview finale: `emails=0`.
Rights e' rimasto disattivato.

### `BE-EMAIL-003` Retention delle comunicazioni Gmail - `DONE`

Gestire le copie che Gmail conserva tra i messaggi inviati e i metadata locali
dell'outbox. Eliminare normalmente i messaggi di servizio oltre 24 mesi e, in
caso di cancellazione account, rimuovere quelli riconducibili all'utente appena
possibile e comunque entro 30 giorni. Conservare soltanto l'audit minimo ancora
necessario e mai contenuti geolocalizzati.

Criterio `DONE`: cleanup testato su messaggi e account di prova, inclusi retry
e cancellazione parziale, senza eliminare richieste di assistenza non correlate.

Stato: cleanup IMAP per `Message-ID` lifecycle e subject Auth esatti, retention
outbox a 24 mesi, retry/lease e blocco fail-closed verificati. Il cutover del 6
settembre ha usato una email reale di un account usa-e-getta e ha verificato la
cancellazione mirata e i retry; corrette anche quotatura mailbox Gmail e valori
SEARCH. L'esecuzione resta manuale finche' non verra' scelto uno scheduler.

### `BE-EMAIL-004` Notifica export pronto - `DONE`

Quando un export passa atomicamente a `ready`, accodare una sola email
idempotente per job. Il messaggio deve indicare la scadenza e collegare l'area
account HTTPS del sito, dove l'utente autenticato scarica lo ZIP dal bucket
privato con il proprio JWT. Non allegare lo ZIP e non inserire URL Storage
pubblici, signed URL, path, token o coordinate nell'email. Un errore SMTP non
deve invalidare l'export: la notifica resta in retry indipendente.

Criterio `DONE`: migration/outbox, template, retry/deduplica e invio reale con
account usa-e-getta verificati; link autenticato e scadenza testati end-to-end.

Completato l'8 settembre 2026: applicata `202609070001`; account usa-e-getta
ha verificato richiesta, ZIP privato scaricato con JWT proprietario, una sola
riga `export_ready` con payload minimale, SMTP accettato per il template
esatto in coda e cleanup finale di
Storage, database e Auth senza residui. La latenza resta giornaliera finché non
verrà implementato `OPS-004`.

### `BE-ACCOUNT-001` Nuovo schema legale versionato - `DONE`

Non riutilizzare semanticamente `raw_gpx_research_consent`. Introdurre campi e
stati coerenti con il contratto approvato: versioni correnti, timestamp e
provenienza dell'accettazione. Lo stato minimo e `active`, `restricted` o
`deletion_pending`; il motivo di `restricted` distingue `terms_outdated`,
`terms_refused`, `inactive` e `security`. Conservare la storia necessaria senza
esporla ad altri utenti.

Criterio `DONE`: contratto e migration idempotente preparati, RLS esistente
preservata, audit service-role e test statici. Applicazione remota, test REST e
transizioni runtime appartengono al task lifecycle successivo.

### `BE-ACCOUNT-002` Enforcement dello stato account - `IN-PROGRESS`

Applicare `active/suspended` nelle RPC, nelle letture riservate, negli upload e
nei job trusted. Un JWT valido non deve bastare se i documenti sono obsoleti.
Consentire agli account sospesi solo le operazioni limitate definite sopra.

Criterio `DONE`: test diretti REST/RPC dimostrano che client modificati non
possono aggirare il gate.

Stato: gate RLS/Storage, trigger per RPC `SECURITY DEFINER` e selettori trusted
sono nella migration disabilitata. Mancano applicazione e prove REST con JWT in
produzione controllata, oltre all'integrazione runtime definitiva.

Aggiornamento 4 settembre 2026: il trigger lifecycle risulta attivo in
produzione ma con `lifecycle_enabled=false`, come provato dall'errore Auth
`legacy signup contract is incomplete`. La migration di recovery
`202609040001_fix_disabled_lifecycle_signup_contract.sql` rende compatibile il
periodo di transizione; non abilita il gate e non completa il cutover.
Il collaudo web ha poi identificato un terzo payload transitorio, senza il campo
legacy di consenso GPX: viene coperto dalla follow-up idempotente
`202609050001_fix_legacy_web_signup_contract.sql`, registrando quel consenso
come assente.

Aggiornamento 5 settembre 2026: la migration rights risulta installata ma
`account_rights_enabled=false`, quindi export e richieste autenticate restano
correttamente non disponibili. La richiesta esterna ha inoltre evidenziato la
risoluzione non qualificata di `pgcrypto` dentro funzioni con `search_path=''`;
la correzione idempotente e in
`202609050002_fix_account_rights_pgcrypto_resolution.sql`. L'attivazione e il
dispatcher email restano parte del cutover controllato, non di questa fix.

### `BE-ACCOUNT-003` Migrazione account esistenti - `IN-PROGRESS`

Marcare gli account esistenti come bisognosi di nuova accettazione. Non usare
GPX o marker precedenti finché la nuova versione non è accettata. Definire
notifica email e schermata al login. Non retrodatare scadenze e garantire almeno
12 mesi di preavviso prima di una cancellazione automatica.

Criterio `DONE`: test su account legacy con dati e sessione già esistente.

Stato: backfill idempotente e assenza di deadline retrodatata sono coperti da
test statici. Nessun account reale è stato migrato; prova runtime legacy ancora
necessaria al cutover.

Preflight lifecycle-only 6 settembre 2026: testi web definitivi 1.0/1.0 e
bundle lifecycle verificati live; audit produzione con 5 profili restricted,
zero eventi/outbox e nessuna deadline avviata. Lo switch atomico
`202609060001_enable_account_lifecycle_v1.sql` è stato applicato: audit remoto
conferma lifecycle attivo 1.0/1.0 e `account_rights_enabled=false`, cinque
profili restricted, zero eventi/outbox e gate completi. Resta il collaudo web
autenticato di notice, deadline e accettazione prima di chiudere il task.

Collaudo web completato: accettazione -> `active` 1.0/1.0; rifiuto ->
`restricted/terms_refused`; deadline in entrambi i casi ancorata alla prima
visualizzazione reale +365 giorni. L'email dell'account poi attivo è stata
annullata e una email controllata resta pending, senza invio. L'indice pubblico
è rimasto disponibile. Il lifecycle-only cutover è quindi operativo; rights e
dispatcher restano separatamente non attivati/non eseguiti.

### `BE-ACCOUNT-004` Export dati - `DONE`

Produrre un archivio autenticato con profilo, accettazioni, metadata, GPX,
trim, marker e altri dati personali applicabili. Proteggere il job con
riautenticazione, scadenza del download, rate limit e cleanup.

Criterio `DONE`: export verificato su account vuoto, completo e sospeso.

Stato: test locali coprono account vuoto, completo e sospeso. In produzione un
account completo usa-e-getta ha verificato ZIP, GPX raw, marker, download owner,
diniego cross-user, scadenza e cleanup; bucket privato e rate limit invariati.

### `BE-ACCOUNT-005` Eliminazione completa - `DONE`

Eliminare in ordine sicuro Storage, righe dipendenti, profilo e Auth. Gestire
errori parziali con job idempotente e stato riprendibile. Eliminare anche
pending upload e artefatti derivati ancora personali. Conservare soltanto il
minimo audit non identificativo approvato.

Criterio `DONE`: nessun oggetto o riga riconducibile all'utente dopo il job;
testare retry e failure injection.

Stato: state machine Gmail -> Storage -> database -> hard-delete Auth verificata
in produzione solo su account usa-e-getta, incluse failure injection Storage e
Auth, ripresa dallo stadio corretto e assenza finale di oggetti, righe e Auth.

### `BE-ACCOUNT-006` Canale esterno per i diritti - `DONE`

Fornire endpoint o workflow web per richiedere cancellazione anche senza app.
Verificare identità senza chiedere GPX o coordinate via email.

Criterio `DONE`: richiesta reale di test tracciata fino alla chiusura.

Stato: RPC pubblica non enumerativa, rate limit, email e token monouso hashato
verificati con account usa-e-getta; callback anonima riuscita una volta e replay
rifiutato. La route pubblica era gia' live e verificata nel preflight.

### `BE-ACCOUNT-007` Riaccettazione e promemoria - `IN-PROGRESS`

Quando cambiano materialmente i Termini, escludere gli account legacy dal
modelling e applicare l'accesso limitato. Registrare lato server la prima
presentazione autenticata della comunicazione, calcolare la deadline a 365
giorni e inviare i promemoria previsti. Accettazione e rifiuto devono essere
registrati per versione; nessun evento locale o semplice invio email avvia da
solo il termine.

Criterio `DONE`: test con mancato accesso, prima visualizzazione, accettazione,
rifiuto, promemoria, riattivazione e cancellazione alla scadenza.

Stato: RPC, audit eventi, deadline da prima visualizzazione autenticata,
promemoria e passaggio a `deletion_pending` sono preparati. Test SQL runtime e
cutover client restano incompleti; la cancellazione fisica è `BE-ACCOUNT-005`.

### `BE-ACCOUNT-008` Lifecycle degli account inattivi - `IN-PROGRESS`

Calcolare l'inattività da attività autenticata significativa registrata lato
server. Dopo 24 mesi sospendere, escludere dal modelling e avviare 12 mesi di
preavviso; dopo 36 mesi cancellare. Refresh token e richieste automatiche non
aggiornano la data. Un vero accesso interrompe il job e mostra i Termini
correnti. Gestire email respinte e account legacy secondo il testo legale.

Criterio `DONE`: test temporali con clock controllato, retry idempotenti,
promemoria e accesso effettuato immediatamente prima della cancellazione.

Stato: attività significativa esplicita, soglie 24/36 mesi, riattivazione e
promemoria sono preparati. Mancano test PostgreSQL con clock controllato,
bounce reali e scheduler di produzione.

## Workstream C - Separazione indice pubblico e riservato

### `BE-ACCESS-001` Contratto dati dei due livelli - `DONE`

Definire quali bucket, manifest e versioni servono indice `D-7` pubblico e
indice corrente per account attivi. Coprire tile, score puntuale, storico,
diagnostica e forecast. Meteo e terreno restano pubblici. Per la prima release
la separazione funzionale non implica ancora protezione tecnica dei dati
recenti pubblicati.

Criterio `DONE`: contratto documentato prima di modificare i client. Lo storico
pubblicato e `D-27..D`; account attivo usa l'intera finestra, mentre guest,
account sospeso o stato non verificabile usano soltanto `D-27..D-7`. Non si
pubblicano giorni aggiuntivi per estendere la finestra limitata.

### `BE-ACCESS-002` Pubblicazione ritardata - `TODO`

Pubblicare l'ultima data disponibile `<= D-7`, gestendo giorni mancanti,
retention, run idempotenti e rollback. Non duplicare dati senza misurarne il
costo. Il client guest deve usare esclusivamente il contratto ritardato, pur
con il limite tecnico dichiarato dei dati recenti ancora pubblici.

Criterio `DONE`: il manifest destinato ai guest non contiene riferimenti a date
più recenti, e il limite dell'accesso diretto residuo è documentato.

### `BE-ACCESS-003` Protezione indice corrente - `TODO, differito`

Rendere inaccessibili con anon key o URL permanenti tile e dati correnti.
Progettare accesso compatibile con MapLibre, cache, token scaduti e logout.
Valutare signed URL, endpoint autenticato o altra soluzione senza esporre
service-role nei client.

Non è bloccante per la prima release: fino al completamento, il gate `D-7` è
funzionale nell'app e nel sito ma non costituisce controllo di sicurezza contro
accesso diretto agli oggetti pubblici.

Criterio `DONE`: test anonimo e account sospeso ricevono rifiuto anche usando
direttamente URL/API; account attivo continua a caricare la mappa.

### `BE-ACCESS-004` Cleanup esposizioni precedenti - `TODO, dipende da BE-ACCESS-003`

Dopo il cutover, rimuovere o rendere inaccessibili versioni correnti rimaste in
bucket pubblici, cache o manifest storici. Eseguire prima un inventario
read-only e mantenere rollback controllato.

Criterio `DONE`: audit remoto dei prefissi e probe anonimi verificati.

## Workstream D - Mobile

### `MOB-001` Modalità senza account - `TODO`

Mostrare indice ritardato, meteo e registrazione temporanea. Rimuovere o
disabilitare archivio, import, editing, percorsi salvati, analisi e forecast.
Usare lo share sheet nativo per esportare il GPX e pulire i file temporanei.

Criterio `DONE`: test Android/iOS per share completato, annullato e fallito;
nessun percorso compare in un archivio interno.

### `MOB-002` Migrazione tracce locali legacy - `DROPPED`

Nessuna migrazione è necessaria: l'app non è ancora distribuita ad altri utenti
e non esistono tracce locali da preservare. Non implementare flussi legacy per
questo scenario.

### `MOB-003` Registrazione e accettazione - `TODO`

Implementare testi e checkbox approvati, link esterni/in-app e versione server.
Non usare copie hardcoded divergenti come fonte della versione corrente.

Criterio `DONE`: impossibile creare l'account senza i passaggi obbligatori;
accessibilità e link verificati.

### `MOB-004` Account obsoleto o sospeso - `TODO`

Intercettare stato e versioni senza loop di login. Mostrare schermata limitata
con documenti, riattivazione, export ed eliminazione. Non rimontare o muovere la
mappa violando `docs/map-camera-rules.md`.

Criterio `DONE`: test E2E su sessione già aperta durante il cambio versione.

### `MOB-005` Profilo, export ed eliminazione - `TODO`

Fornire azioni chiare, riautenticazione, conferme, stato del job e risultato.
Distinguere `Sospendi/rifiuta le nuove condizioni` da `Elimina account e dati`.

Criterio `DONE`: test E2E incluso riavvio dell'app durante un job.

## Workstream E - Web

### `WEB-001` Pagine legali Cloudflare Pages - `TODO`

Pubblicare `/privacy`, `/termini`, `/account-e-dati` e `/elimina-account` con
URL stabili, responsive, stampabili e accessibili senza login. Conservare le
versioni precedenti quando richiesto dal legale.

Criterio `DONE`: URL di produzione verificati e adatti agli store.

### `WEB-002` Modalità pubblica e account - `TODO`

Applicare la stessa matrice del mobile: indice ritardato per anonimi/sospesi e
funzioni complete per account attivi. Il routing React applica l'esperienza
guest ma non va descritto come protezione tecnica finché `BE-ACCESS-003` resta
differito.

Criterio `DONE`: test E2E desktop/mobile e probe diretti alle API.

### `WEB-003` Registrazione e accettazione - `TODO`

Allineare testi, link, versioni e comportamento al mobile. Gestire account
legacy e sospesi senza duplicare la logica autorizzativa del backend.

Criterio `DONE`: parità funzionale e test sulle versioni obsolete.

### `WEB-004` Export, diritti ed eliminazione - `TODO`

Implementare area autenticata e percorso pubblico esterno richiesto dagli
store. Rendere evidente cosa viene eliminato e in quali tempi.

Criterio `DONE`: flusso completo verificato dopo logout e da browser mobile.

Handoff aggiuntivo per `BE-EMAIL-004`: dopo la richiesta mostrare che l'export
verra' preparato in background e che arrivera' un'email quando sara' pronto.
Non promettere invio immediato prima del deploy del worker cloud. Il link email
apre l'area account; se la sessione non esiste, richiedere login e poi mostrare
lo stato corrente. Abilitare il download soltanto per `status=ready` e
`expires_at` futuro; per export scaduto mostrare una nuova richiesta, senza
tentare Storage e senza affidarsi a parametri sensibili nell'URL.

## Workstream F - Modelling e governance dati

### `MODEL-001` Elegibilità point-in-time - `TODO`

Ogni estrazione deve verificare account `active`, versione contrattuale
corrente e data di efficacia, fissando un cutoff della run. I dati anteriori
alla nuova accettazione non entrano automaticamente nel dataset.

Criterio `DONE`: test con account attivo, sospeso, eliminato e riattivato.

### `MODEL-002` Provenienza e pseudonimizzazione - `TODO`

Usare identificativi tecnici purpose-specific soltanto nello staging trusted,
separare mapping e dataset e registrare tracce/sessioni incluse senza esporre
identità ai modeller. La tecnica concreta può essere HMAC o un equivalente
verificabile scelto in implementazione.

Criterio `DONE`: un amministratore autorizzato può propagare una cancellazione,
ma il dataset non permette di ricavare email, username o Storage path.

### `MODEL-003` Retention e cleanup - `TODO`

Eliminare dopo la run e comunque entro 10 giorni staging, mapping, dataset
pseudonimizzati e dataset finale. Il dataset finale segue lo schema minimale
definito in `MODEL-PIPE-001`; non è un archivio permanente. Conservare soltanto
modello, configurazione, metriche aggregate e registro minimale. Le run future
ricostruiscono i dati dagli account allora eleggibili; sospesi ed eliminati non
entrano in nuove estrazioni.

Criterio `DONE`: test temporale del cleanup e audit degli artefatti dimostrano
che nessun dataset della run resta oltre 10 giorni.

### `MODEL-004` Aggiornamento documentazione modelling - `TODO`

Aggiornare `docs/modelling-context.md` e `docs/modelling-notes.md` dopo
l'approvazione legale e durante l'implementazione, rimuovendo il vecchio
paradigma di consenso facoltativo e descrivendo il contratto contributivo senza
cambiare retroattivamente i dati.

Criterio `DONE`: nessun documento interno contiene regole incompatibili.

## Workstream G - Sicurezza, osservabilità e qualità

### `SEC-001` Pulizia logging - `DONE` (backend/mobile)

Rimuovere coordinate, GPX, marker, JWT, token, email e path identificativi dai
log mobile, web, backend e modelling. Definire logging strutturato minimale.

Criterio `DONE`: scansione statica e test runtime su flussi principali.

Stato: i comandi backend account producono solo conteggi e classi d'errore;
le eccezioni della pipeline sono ridotte alla sola classe, senza traceback
persistito. I log reali della pipeline account del 2026-09-09 sono stati
scansionati senza email, token, coordinate, GPX, marker, JWT o path Storage.
Il mobile non registra piu' path/waypoint o oggetti errore grezzi; test Python
e typecheck mobile superati. Il repository web e' separato: applicare il breve
handoff SEC-001 prima della sua prossima release.

### `SEC-002` RLS, least privilege e segreti - `IN-PROGRESS`

Rivedere RLS, policy Storage, service-role, MFA amministrativa, chiavi HMAC,
rotazione segreti e futura VM cloud. Separare ambiente operativo e modelling.

Criterio `DONE`: audit con due utenti, anon key e credenziali backend.

Stato: migration e test statici coprono owner `auth.uid()`, bucket privati,
funzioni service-role e blocco degli stati non abilitati. Restano audit REST e
Storage con due account usa-e-getta dopo migration, MFA/rotazione operativa e
conservazione dei segreti solo nel worker.

### `SEC-003` Anti-abuso - `IN-PROGRESS, bloccante per release`

Definire rate limit, limiti download/tile, monitoraggio anomalo e mitigazioni
contro scraping. Non considerare controlli client come protezione.

Criterio `DONE`: minacce e limiti misurabili documentati.

Stato audit 2026-09-11: la mitigazione volumetrica edge di Cloudflare Pages e
Supabase e' presente come controllo provider. Per la release 1.9.0 il rischio
scraping/egress dei dataset indice pubblici è formalmente accettato; quota
anonima, cleanup bounded e retry client sono implementati ma attendono le
prove runtime indicate nell'audit. Restano parziali budget multi-account,
WAF/CAPTCHA, Smart CDN, Spend Cap, alert e test di capacita' controllati.
Riferimenti: `SEC-AUD-008`, `SEC-AUD-009`, `SEC-AUD-016`, `SEC-AUD-017`,
`SEC-AUD-018`.

### `QA-001` Matrice test cross-component - `IN-PROGRESS`

Coprire account nuovo, legacy, attivo, sospeso, riattivato ed eliminato;
assenza account; versioni legali obsolete; export; errori di cancellazione;
accesso diretto ai dati; share GPX; offline e token scaduto.

Criterio `DONE`: risultati backend, web e mobile raccolti in un unico report.

Stato backend: test locali per accesso attivo/ristretto, eliminato fail-closed,
cross-user statico, retry diritti/outbox e cleanup upload incompleto. Manca la
matrice runtime con account usa-e-getta e l'evidenza finale web/mobile.

## Migrazione e rollback

- Nessun dato locale o cloud viene eliminato durante la migrazione senza un
  flusso esplicito e verificato.
- Il passaggio ai bucket/accessi riservati deve avere un piano di rollback che
  non ripubblichi involontariamente l'indice corrente.
- Le nuove versioni legali entrano in vigore solo quando backend, web e mobile
  sono in grado di applicarle coerentemente.
- Le build precedenti devono essere considerate e aggiornate per applicare la
  modalità guest. Finché `BE-ACCESS-003` è differito, dati recenti già pubblici
  possono comunque essere raggiunti direttamente: è un limite dichiarato, non
  una garanzia di accesso riservato.
- Ogni migration Supabase deve avere verifica post-migration e istruzioni
  operative; copiarla negli appunti non equivale a eseguirla.

## Roadmap proposta

1. Usare le bozze `LEGAL-001` - `LEGAL-006` come contratto di progetto; la
   stesura iniziale è completa, mentre approvazione finale e stato `DONE`
   restano al gate di release dopo l'allineamento del codice.
2. Definire `BE-ACCESS-001` e il nuovo contratto account `BE-ACCOUNT-001`. `DONE`.
3. Configurare l'email e implementare il lifecycle backend: `BE-EMAIL-001` -
   `BE-EMAIL-003` e `BE-ACCOUNT-002` - `BE-ACCOUNT-008`.
4. Implementare il livello guest `D-7`: `BE-ACCESS-002`; differire
   esplicitamente `BE-ACCESS-003` e `BE-ACCESS-004`.
5. Pubblicare pagine legali `WEB-001` e congelare URL/versioni.
6. Implementare web `WEB-002` - `WEB-004`.
7. Implementare mobile `MOB-001`, `MOB-003` - `MOB-005`; `MOB-002` è escluso.
8. Implementare governance modelling `MODEL-001` - `MODEL-004`.
9. Completare sicurezza e test `SEC-001`, `SEC-002`, `QA-001`.
10. Compilare dichiarazioni store `LEGAL-007` e fare audit pre-release.
11. Eseguire rollout graduale, verificare i flussi guest e monitorare errori.

### `OPS-004` Worker account sempre disponibile in cloud - `TODO`

Durante la migrazione backend su cloud, eseguire il worker rights in un ambiente
sempre disponibile con secret backend, mai nel client. Frequenza obiettivo
1-5 minuti per trasformare gli export `pending/retry` in `ready`, inviare la
notifica `BE-EMAIL-004`, pulire gli export scaduti e proseguire cancellazioni
riprendibili. Mantenere lifecycle e retention sui rispettivi intervalli
giornalieri. Usare una sola istanza o lock/claim esistenti, health check,
timeout, log senza dati personali e alert su failure ripetute. Il passaggio al
cloud non cambia RPC, bucket, RLS o contratto frontend.

Criterio `DONE`: richiesta export completata senza PC dell'operatore acceso,
latenza osservata entro l'intervallo previsto, retry dopo riavvio e nessuna
doppia email o doppio job.

### `OPS-005` Pipeline account locale giornaliera - `DONE`

Finche' il backend resta locale, `run_daily_account_pipeline.bat` orchestra una
singola esecuzione manuale con log dedicato: cleanup `pending_upload`, lifecycle
con massimo 100 email e pausa 5 secondi, quindi rights con massimo 20 export e
100 cancellazioni. Lo stop e' immediato tra step; `--dry-run` esegue soltanto i
tre preview. La migration idempotente `202609060005` allinea a 100 il cap email
del database senza modificare gli switch. Il limite andra' rivalutato con la
crescita degli utenti e le quote Gmail.

## Diario di avanzamento

Aggiornare con righe concise; non trasformare questa sezione in una chat log.

| Data | ID | Stato | Evidenza / decisione |
|---|---|---|---|
| 2026-08-28 | PLAN-001 | DONE | Creato piano coordinato per accesso, account, privacy e modelling. |
| 2026-08-28 | CONTACT-001 | DONE | Creato contatto di progetto `funghitracker@gmail.com`. |
| 2026-08-28 | RET-001 | DECIDED | Termini: 365 giorni dalla prima comunicazione autenticata; inattività: sospensione a 24 mesi e cancellazione a 36 mesi. |
| 2026-08-28 | MODEL-RET-001 | DECIDED | Tutti i dataset della run vengono eliminati entro 10 giorni; restano modello e metadati aggregati. |
| 2026-08-29 | PRODUCT-001 | DECIDED | Meteo e terreno restano pubblici anche senza account. |
| 2026-08-29 | ACCESS-RISK-001 | DECIDED | Gate guest `D-7` funzionale; protezione tecnica degli oggetti recenti differita e non promessa. |
| 2026-08-29 | MODEL-PIPE-001 | DECIDED | Fissati sorgente privata, staging trusted temporaneo, dataset minimale e cleanup entro 10 giorni. |
| 2026-08-29 | SUSPEND-001 | DECIDED | Account sospeso: solo documenti, riaccettazione, export ed eliminazione; esclusione immediata dal modelling. |
| 2026-08-29 | MOB-002 | DROPPED | Nessun utente distribuito e nessuna traccia locale legacy da migrare. |
| 2026-08-29 | LEGAL-DRAFT-001 | IN-PROGRESS | Create bozze Privacy, Termini, Account e dati, registro trattamenti, valutazione rischi e note. |
| 2026-08-29 | LEGAL-BASE-001 | DECIDED | Il legale ha approvato l'art. 6(1)(b) GDPR per il contratto contributore. |
| 2026-08-29 | LEGAL-CLARIFY-001 | DECIDED | Nessuna retention privacy per log pipeline privi di dati utente; 18+ dichiarato accettando i Termini; DPO e DPIA non obbligatori allo stato attuale. |
| 2026-08-29 | BACKUP-001 | DECIDED | Nessun backup applicativo GPX; rischio residuo accettato e comunicato, con export disponibile all'utente. |
| 2026-08-29 | BE-ACCESS-001 | DONE | Contratto corretto a 28 giorni: storico `D-27..D`; livello limitato `D-27..D-7`, senza giorni aggiuntivi; meteo e terreno pubblici. |
| 2026-08-29 | BE-ACCOUNT-001 | DONE | Definiti tre stati account, motivi di restrizione e migration preparatoria; nessuna applicazione remota o enforcement in questo task. |
| 2026-08-30 | LEGAL-REVIEW-001 | IN-PROGRESS | Termini e Privacy Policy approvati dall'avvocato; completato il controllo tecnico finale. Restano configurazione email, allineamento del codice e congelamento delle versioni efficaci. |
| 2026-08-31 | OPS-001 | DONE | Scelto Gmail SMTP con unico indirizzo `funghitracker@gmail.com`; dominio/provider dedicato rinviato alla crescita del servizio. |
| 2026-08-31 | EMAIL-JOB-001 | DECIDED | Processo giornaliero unico, outbox idempotente, invio sequenziale con pausa configurabile, retry e limite prudenziale. |
| 2026-08-31 | EMAIL-RET-001 | DECIDED | Copie ed esiti delle email di servizio massimo 24 mesi; cleanup con eliminazione account entro 30 giorni. |
| 2026-08-31 | BE-EMAIL-001 | DONE | Audit pubblico e Management API superati: Gmail `smtp.gmail.com:587`, identita mittente, Site URL, allow-list, conferma obbligatoria e template conformi. Registrazione/conferma e recovery testati con invii reali da web e mobile; token Management temporaneo rimosso dal backend. |
| 2026-08-31 | EMAIL-CONFIRM-001 | DONE | Causa localhost identificata nei redirect impliciti; callback esplicite e gestione token implementate nei client. Conferma email e cambio password verificati end-to-end su web e mobile. |
| 2026-08-31 | BE-ACCOUNT-002/003/007/008 | IN-PROGRESS | Preparate migration lifecycle disabilitata, gate RPC/RLS/Storage, legacy senza deadline retrodatata, eventi legali, attività significativa e transizioni 365 giorni/24-36 mesi. Test locali controllati superati; nessuna applicazione remota. |
| 2026-08-31 | BE-EMAIL-002 | IN-PROGRESS | Preparati comando giornaliero, outbox idempotente, lock globale, limite, invio sequenziale e retry/backoff. Mancano credenziale dispatcher, invio controllato in produzione e scheduler always-on. |
| 2026-09-01 | BE-ACCOUNT-004/005/006 | IN-PROGRESS | Preparati export ZIP privato temporaneo, richiesta esterna non enumerativa con token monouso e cancellazione riprendibile Gmail/Storage/database/Auth. Test locali e failure injection superati; nessuna applicazione remota. |
| 2026-09-01 | BE-EMAIL-003 | IN-PROGRESS | Preparata retention IMAP/outbox con verifica esatta di Message-ID, subject e destinatario, lease/retry e test locali. Mancano App Password dispatcher, subject Auth definitivi, prova Gmail controllata e scheduler. |
| 2026-09-01 | PREFLIGHT-ACCOUNT-001 | IN-PROGRESS | Audit locale migration/backend/web/mobile: compatibilita' statica e test locali positivi; corretto default `restricted_at` nella migration preparatoria. Il cutover avverra' direttamente in produzione con account usa-e-getta; prove runtime, dispatcher/scheduler e documenti efficaci sono ancora mancanti. Vedi `account-cutover-preflight.md`. |
| 2026-09-01 | SEC-001/002, OPS-003, QA-001 backend | IN-PROGRESS | Aggiunti log account con soli conteggi/classi d'errore, cleanup server-side e lease delle prenotazioni `pending_upload`, test locali stati/cross-user/retry e runbook. Migration non applicata; mancanti prove runtime Supabase/Gmail con account usa-e-getta. |
| 2026-09-06 | BE-EMAIL-002 | IN-PROGRESS | Risolto SQLSTATE 55000 con `202609060002_fix_lifecycle_prepare_record_name.sql`. Preview, invio controllato singolo (`sent=1`) e preview finale (`emails=0`) verificati in produzione; resta lo scheduler always-on e il normale monitoraggio. |
| 2026-09-06 | BE-EMAIL-002 | IN-PROGRESS | Aggiornati subject e corpi delle email per evento: riaccettazione documenti, reminder, inattivita' e scadenza; deadline renderizzata come `YYYY-MM-DD`, rimossa la frase generica sui dati. Nessuna migration Supabase richiesta; serve deploy del backend prima del prossimo invio. |
| 2026-09-06 | BE-EMAIL-002 | IN-PROGRESS | Aggiunto collaudo template isolato da Supabase con 11 artefatti fittizi, destinatario fisso e subject `[TEST]`; Gmail ha accettato 11/11 invii senza errori SMTP. Suite backend: 161 passed. |
| 2026-09-06 | BE-ACCOUNT-004/005/006, BE-EMAIL-003 | DONE | Attivato `account_rights_enabled=true` preservando lifecycle 1.0/1.0. Due account usa-e-getta hanno verificato ZIP privato, scadenza, cross-user denial, email/callback monouso, retry Storage/Auth e cancellazione finale senza residui. Corrette query IMAP Gmail per mailbox e valori con spazi. |

| 2026-09-06 | OPS-004, BE-EMAIL-004, WEB-004 | TODO | Pianificato worker rights cloud ogni 1-5 minuti e notifica idempotente quando lo ZIP e' pronto. L'email apre l'area account autenticata, senza allegati o URL Storage pubblici; il web dovra' comunicare attesa email e gestire login, stato e scadenza. |
| 2026-09-06 | OPS-005 | DONE | Aggiunta pipeline account locale manuale con ordine cleanup/lifecycle/rights, stop-on-error, dry-run esplicito, log unico gitignored e limiti 100 email, 20 export, 100 cancellazioni. Preparata migration `202609060005` per il cap email DB. |
| 2026-09-07 | OPS-001 | IN-PROGRESS | Verificato su messaggio Gmail in Spam: SPF, DKIM e DMARC tutti PASS. Corretto backend lifecycle con display name, Reply-To, Date e Message-ID `gmail.com`, mantenendo cleanup dei Message-ID legacy. Resta da adottare, prima di una crescita significativa, dominio verificato e provider transazionale con SPF/DKIM/DMARC propri. |
| 2026-09-08 | BE-EMAIL-004 | DONE | Migration `202609070001` applicata. Collaudo usa-e-getta: ZIP privato, download owner, enqueue singolo/minimizzato, SMTP accettato e cleanup Storage/database/Auth senza residui. |
| 2026-09-09 | SEC-001 | DONE (backend/mobile) | Rimossi log mobile di path, waypoint, coordinate e oggetti errore grezzi; le eccezioni pipeline persistono solo come classe. Test mirato anti-interpolazione dati sensibili, suite backend, typecheck e 213 test mobile superati; scansione di otto log reali account senza pattern sensibili. Il web resta un repository separato con handoff obbligatorio prima della prossima release. |
| 2026-09-09 | SEC-AUD-001/002/004 | IN-PROGRESS | Eliminato il bridge Auth verso custom scheme; web con auto-detection URL disabilitata e callback HTTPS acquisite/pulite prima del render; mobile configurato per App/Universal Links e parser origin/path strict. Suite mobile 213 passed, typecheck e build/test web positivi. Il proprietario dichiara completati allow-list e template Supabase; manca verifica indipendente. Restano associazioni dominio, AAB/IPA e collaudi usa-e-getta. |
| 2026-09-10 | SEC-AUD-011 | DONE | Backend bloccato con `pyproject.toml` e `uv.lock` hash-bearing; gate unico e SBOM CycloneDX per backend/mobile/web. Aggiornati solo `requests`, `pytest` e `fflate`; backend e web senza advisory note, eccezioni mobile puntuali con scadenza 2026-10-10. |
| 2026-09-10 | SEC-AUD-014 | DONE | Audit non divulgativo: chiave assente da `HEAD`, presente in 2 commit e 1 percorso storico; il proprietario ne ha confermato l'eliminazione in Google Cloud Console. Nessun valore esposto e nessuna riscrittura Git eseguita. |
| 2026-09-11 | SEC-AUD-008 | RISK ACCEPTED 1.9.0 | Dataset indice recenti tecnicamente pubblici; gate D-7 solo UI/prodotto. Nessun dato personale. Accettati scraping/egress per 1.9.0; riesame obbligatorio prima di crescita rilevante, forecast riservati o costi/traffico anomali. |
| 2026-09-11 | SECURITY-AUDIT-DOC | UPDATED | Allineati finding implementati senza chiudere prove mancanti: App/Universal Links, runtime a due account, deploy browser, device backup/filesystem e AAB/IPA firmati restano aperti. |
| 2026-09-11 | SEC-AUD-013 | DONE | Migration `202609110001` applicata: le policy RLS usano il wrapper owner-only senza ripristinare `EXECUTE` sull'helper UUID. Due JWT usa-e-getta: owner active accede a profilo/traccia/marker/file, altro account negato, restricted/deletion_pending bloccati; lifecycle/export invariati e cleanup completo. |

## Security audit pre-release 2026-09

Stato audit: **BLOCKED**. Report autorevole:
`security-audit-2026-09.md`. Fase 1 completata senza modifiche al codice: 0
Critical dimostrati, 3 High, 11 Medium e 4 Low. Prima della pubblicazione servono
fix e verifica dei tre High, piu' chiusura o accettazione esplicita dei Medium;
test runtime a due account e AAB finale restano `NOT TESTED`.

| ID | Stato | Task emerso |
|---|---|---|
| SEC-AUD-001 | IN-PROGRESS | Rimossi bridge e callback Auth custom; configurati App Links/Universal Links HTTPS. Restano file di associazione live, AAB/IPA e collaudo concorrente cold/warm. |
| SEC-AUD-002 | IN-PROGRESS | `detectSessionInUrl=false` e callback limitate ai path Auth, con test locali. Resta il test runtime di session swapping a due account. |
| SEC-AUD-003 | IMPLEMENTED, SIGNED BUILD PENDING | SecureStore e backup exclusion implementati/testati; restano AAB/IPA e backup/restore su dispositivo. |
| SEC-AUD-004 | IN-PROGRESS | Callback acquisita in memoria e URL pulita prima del render; allow-list e template a fragment dichiarati configurati dal proprietario. Restano verifica Management/runtime, log e flussi reali. |
| SEC-AUD-005 | IMPLEMENTED, RUNTIME NEGATIVE TEST PENDING | Migration applicata, admission worker attivo e 9 archivi validati; export/modelling accettano solo `validated`. Manca upload avverso live. |
| SEC-AUD-006 | IMPLEMENTED, RUNTIME PENDING | Web con cap pre-read, decompressione e parser bounded; manca prova sul deploy con file avversi. |
| SEC-AUD-007 | IMPLEMENTED, DEVICE TEST PENDING | Cleanup file GPX/export implementato e testato; manca ispezione filesystem reale. |
| SEC-AUD-008 | RISK ACCEPTED 1.9.0 | Indice recente pubblico; gate D-7 solo UI/prodotto. Riesame su crescita rilevante, forecast riservati o costi/traffico anomali. |
| SEC-AUD-009 | IMPLEMENTED, RUNTIME PENDING | Email sconosciute: risposta invariata, nessuna riga e nessun consumo quota globale; manca prova live limitata. |
| SEC-AUD-010 | IMPLEMENTED, BROWSER TEST PENDING | Web a MapLibre 6.4.1; restano attribution/popup/CSP sul deploy. |
| SEC-AUD-011 | DONE | Lock Python con hash, gate/SBOM backend-mobile-web; fix mirati e eccezioni mobile con scadenza 2026-10-10. |
| SEC-AUD-012 | IMPLEMENTED, SIGNED BUILD PENDING | OTA disabilitato per 1.9.0; verifica AAB/IPA ancora mancante. |
| SEC-AUD-013 | DONE | Helper UUID revocato ai client; policy sul wrapper owner-only, service-role preservata e prova GPX cross-user live superata. |
| SEC-AUD-014 | DONE | Chiave assente da HEAD ed eliminata in Google Cloud Console; history preservata senza esporre il valore. |
| SEC-AUD-015 | TODO | Abilitare HSTS e allineare gli header sensibili a entrambe le varianti URL della cancellazione. |
| SEC-AUD-016 | PARTIAL | Budget DB user/tenant applicati su byte, pending, ingress 24h ed export; CAPTCHA/rate edge signup e alert provider restano separati. |
| SEC-AUD-017 | IMPLEMENTED, RUNTIME BACKLOG TEST PENDING | Cancellazioni prioritarie; cleanup export limitato per job, byte e tempo; manca prova live con backlog oltre soglia. |
| SEC-AUD-018 | IMPLEMENTED, RUNTIME PENDING | Backoff/jitter/`Retry-After` e cap testati su web/mobile; manca prova controllata su deploy/build. |

### Task differiti per App Links e Universal Links

I task seguenti riprendono i punti 3-7 del runbook Auth. Non creare file con
placeholder: attendere gli identificativi definitivi degli account sviluppatore.

| ID | Stato | Task / criterio di completamento |
|---|---|---|
| SEC-AUTH-LINK-003 | BLOCKED | Dopo l'apertura dell'account Google Play, recuperare il fingerprint SHA-256 Play App Signing; aggiungere anche quello EAS solo se diverso e necessario per APK preview. Creare `public/.well-known/assetlinks.json` nel repository web con package `com.giovannisequani.funghitracker`, senza chiavi private. |
| SEC-AUTH-LINK-004 | BLOCKED | Dopo l'apertura dell'account Apple Developer, recuperare l'Apple Team ID e creare `public/.well-known/apple-app-site-association`, senza estensione, limitato a `/auth/confirm` e `/auth/recovery`. |
| SEC-AUTH-LINK-005 | BLOCKED | Dopo 003/004, committare e distribuire i due file su Cloudflare Pages; verificare risposta diretta `200`, `Content-Type: application/json`, assenza di redirect e assenza di fallback HTML. |
| SEC-AUTH-LINK-006 | BLOCKED | Dopo 005, generare nuove build firmate EAS Android/iOS; verificare manifest/entitlement finali e lo stato App Links Android con `pm verify-app-links` e `pm get-app-links`. Un update OTA non soddisfa il criterio. |
| SEC-AUTH-LINK-007 | BLOCKED | Dopo 006, usare soltanto account usa-e-getta per conferma e recovery web/mobile, cold/warm start, cambio password, handler custom-scheme concorrente, session swapping, URL pulita e assenza di query sensibili nei log provider. Chiudere `SEC-AUD-001/002/004` solo dopo evidenza positiva. |

| 2026-09-09 | SEC-AUD-005/009/013/016/017 | IMPLEMENTED/PARTIAL, RUNTIME TESTS PENDING | Migration `202609090001` applicata; worker admission ha validato 9 archivi. Trusted gate, budget DB e cleanup bounded sono attivi; restano prove negative/cross-user/backlog live e controlli edge/provider di `SEC-AUD-016`. |

## Questioni aperte

- `OPEN LEGAL-REVIEW-001`: Termini e Privacy Policy sono stati approvati
  dall'avvocato. Prima dell'efficacia vanno inseriti il provider email scelto,
  allineato il comportamento reale e confermate le versioni definitive; la
  pagina operativa Account e dati e i documenti interni non sostituiscono i due
  testi legali approvati.
- `OPEN OPS-003`: implementato nella migration lifecycle non ancora applicata;
  resta la prova controllata e l'attivazione dello scheduler dopo il cutover.

## Decisioni differite

- `DEFERRED OPS-002`: protezione tecnica dell'indice corrente e accesso
  autenticato alle tile MapLibre (`BE-ACCESS-003`, `BE-ACCESS-004`). La prima
  release applica il ritardo nell'interfaccia ma accetta l'esposizione diretta
  residua degli oggetti pubblici.
