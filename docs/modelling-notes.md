# FunghiTracker modelling notes

Memoria tecnica sintetica del filone modelling/fine-tuning. Aggiornare questo
documento quando emergono decisioni, risultati, metriche o problemi rilevanti;
non usarlo come log della conversazione.

## Stato

- Fase: progettazione metodologica iniziale; nessun dataset di ricerca ancora
  costruito e nessuna modifica allo scoring produttivo.
- Obiettivo: verificare se dati osservazionali consentiti possono migliorare
  l'indice per porcini e finferli senza alterare prematuramente i contratti
  pubblici o il comportamento operativo.
- Tag problemi: `[OPEN]`, `[RESOLVED YYYY-MM-DD]`, `[BLOCKED]`.

## Decisioni e motivazioni

- Un normale `trkpt` descrive attività e selezione umana dello spazio, ma un
  waypoint creato dall'app con tipo `Porcino` o `Finferlo` è un ritrovamento
  positivo auto-segnalato, con specie, coordinate e timestamp. Rimane evidenza
  osservazionale soggetta a errori, non una misura certificata di abbondanza.
- Il primo artefatto sarà un audit offline e consent-aware, non un training run.
  Si useranno solo tracce `ready` di utenti con consenso corrente, validate con
  le regole backend e con oggetti non validi messi in quarantena.
- L'unità analitica candidata è `specie x sessione x cella x giorno`, con
  conteggio/presenza di waypoint e un'esposizione basata su tempo o distanza
  percorsa. I `trkpt` definiscono lo sforzo di ricerca; i `wpt` gli eventi
  positivi. Questo evita che frequenze GPS diverse dominino il dataset.
- I dati verranno suddivisi prima della modellazione per utente, spazio e tempo.
  L'assegnazione utente-fold deve avvenire nel job trusted; l'export non deve
  contenere user ID, username, filename o Storage path.
- L'attuale scoring `0.2.0` è il baseline obbligatorio. Il confronto deve
  distinguere `base_score` dal contributo upward-only di recovery/carry-over.
- Nessun risultato entra in produzione senza: target validato, valutazione
  out-of-sample bloccata, miglioramento pratico e statistico, replay in shadow,
  versione esplicita e rollback.
- La proposta di lavoro parte da audit anche manuale delle tracce, ricostruzione
  di un corridoio visitato ad alta risoluzione, stima conservativa dell'effort e
  aggregazione per cella indice. La griglia indice reale è `0.003°`, non
  `0.03°`.
- Non si assegnerà a priori una densità fisica ai valori 0-100. La relazione
  specie-specifica fra score e tasso di ritrovamento sarà stimata dai dati,
  inizialmente con una funzione monotona e regolarizzata.

## Assunzioni metodologiche da verificare

- I waypoint specie-specifici sono inseriti quando l'utente trova un fungo;
  resta da verificare se tutte le tracce cloud provengano da questo flusso e se
  ogni ritrovamento venga sempre marcato.
- Timestamp, frequenza di campionamento, accuratezza GPS, pause e completezza
  possono essere eterogenei o mancanti.
- Gli utenti possono scegliere l'area in base alla mappa FunghiTracker: ciò
  crea preferential sampling e un feedback loop con lo score corrente.
- Un tratto percorso senza waypoint è una non-rilevazione condizionata allo
  sforzo registrato, non automaticamente un'assenza biologica: detection e
  propensione dell'utente a premere il pulsante vanno modellate o validate.
- La risoluzione di circa 230-330 m e l'incertezza GPS possono richiedere
  aggregazione multiscala o assegnazione probabilistica alle celle vicine.
- Una griglia locale da 2 m è una discretizzazione computazionale, non una
  precisione osservazionale: il raggio del corridoio deve riflettere errore GPS,
  visibilità e comportamento di ricerca, con analisi di sensibilità.
- Il tempo trascorso vicino a una cella non misura solo attenzione: una sosta
  può essere causata dal ritrovamento stesso, creando causalità inversa.

## Piano metodologico e gate

1. **Governance e snapshot riproducibile.** Definire policy per consenso
   revocato, retention, cancellazione dei derivati, audit trail, accesso trusted,
   versioni di sorgenti/configurazioni e separazione tra staging identificabile
   ed export analitico minimizzato.
2. **Audit di fattibilita.** Su un campione protetto misurare validita XML/gzip,
   campi GPX presenti, duplicati, durate, distanze, frequenze, gap, velocita
   implausibili, copertura spaziale/temporale, concentrazione per utente e
   sovrapposizione con griglia/meteo. Output solo aggregati non identificativi.
3. **Definizione dell'estimand/target.** Target primario candidato: intensità o
   probabilità di ritrovamento auto-segnalato per specie, condizionata allo
   sforzo di ricerca osservato. Stabilire se ogni waypoint rappresenti un
   singolo esemplare, un gruppo o un luogo di ritrovamento prima di interpretare
   i conteggi come abbondanza.
4. **Preprocessing versionato.** Validare, normalizzare timezone e coordinate,
   rimuovere duplicati, filtrare salti impossibili, segmentare sessioni,
   resamplare per tempo/distanza e aggregare a cella-giorno. Conservare flag di
   qualita e analisi di sensibilita sui filtri; non fare map matching stradale
   come default per tracce forestali.
   Prima fase: report tabellare e mappe per audit manuale di durate, distanze,
   velocita, gap, duplicati, waypoint e casi anomali. Smoothing facoltativo e
   sempre confrontato con la traccia originale; mai spostare i waypoint con lo
   smoothing del percorso.
5. **Dataset e controlli.** Estrarre separatamente `trkpt` e `wpt`, associare
   ciascun waypoint alla sessione/cella e costruire celle percorse con
   esposizione e conteggio per specie. Fare join point-in-time con meteo,
   terreno, componenti e score realmente disponibili alla data della sessione.
   Pesare/cappare utenti e sessioni. Usare come controlli le porzioni percorse
   della stessa sessione o di sessioni matched, non pseudo-assenze globali.
   Il corridoio visitato va costruito localmente come buffer/kernel attorno ai
   segmenti validi, senza collegare gap temporali lunghi. Una griglia sparsa da
   2 m può approssimarlo; in alternativa sono preferibili intersezioni
   geometriche dirette con le celle indice. Visite separate nello stesso giorno
   sommano l'effort; date diverse restano osservazioni distinte perché hanno
   condizioni meteo e score diversi.
6. **Baseline e challenger.** Confrontare: score corrente; modello binomiale o
   di conteggio con offset di esposizione; regressione logistica condizionale o
   GAM regolarizzato; modello bayesiano gerarchico con processi distinti di
   presenza/intensità e detection; boosting come challenger non primario.
   Separare porcini e finferli salvo evidenza per partial pooling condiviso.
   Formulazione iniziale consigliata per specie e cella-sessione:
   `N ~ NegBin(mu, phi)`, `log(mu) = log(E_eff) + f(score) + effetti casuali`,
   dove `E_eff` è area/tempo effettivamente cercato e `f` è monotona. Questo
   evita di costruire densità osservate instabili e confrontarle con una tabella
   score-densità inventata.
7. **Validazione.** Usare test futuro nel tempo, blocchi spaziali e utenti mai
   visti; vietato lo split casuale per punti. Riportare incertezza tramite
   bootstrap a blocchi o posteriori e analisi per stagione, area, copertura e
   qualita della traccia.
8. **Integrazione progressiva.** Preferire, in ordine: analisi diagnostica;
   ricalibrazione monotona; correzione residuale limitata con score corrente
   come offset/prior; modifica di soglie/pesi; sostituzione del modello solo con
   evidenza nettamente superiore. Ogni candidato va eseguito in shadow su
   replay storico prima di una proposta produttiva.

## Metriche candidate

- Audit: percentuale tracce/sessioni utilizzabili, copertura cella-giorno,
  utenti effettivi, concentrazione, missingness, duplicati e tasso di scarto.
- Target di ritrovamento con effort: log predictive density o deviance,
  log-loss/Brier per evento, calibrazione di eventi osservati vs attesi,
  ranking intra-sessione, top-decile lift e recall degli eventi nelle celle
  meglio classificate; ROC-AUC solo come secondaria.
- Target binario credibile: Brier score, calibration intercept/slope, PR-AUC,
  log-loss e metriche operative a soglie dichiarate.
- Accettazione: miglioramento sul baseline con intervallo di incertezza,
  rilevanza pratica prefissata e assenza di regressioni materiali nei principali
  blocchi spazio-temporali. Le soglie numeriche saranno preregistrate dopo
  l'audit, non inventate prima di conoscere numerosita e prevalenza.

## Alternative considerate

- **Point process / modello di conteggio con effort:** ora alternativa primaria,
  perché i waypoint forniscono eventi positivi e la traccia fornisce esposizione;
  richiede comunque una componente di detection e controllo del sampling bias.
- **Soste o bassa velocita come successo:** possibile weak label, ma molto
  confusa da riposo, foto, terreno e segnale GPS; richiede validazione manuale.
- **Calibrazione bayesiana delle soglie/pesi correnti:** interpretabile e
  compatibile col dominio, ma l'identificabilità dipende da effort e detection;
  resta complessa per massimo sui lag e recovery ricorsivo.
- **GAM/regressione condizionale:** baseline preferita per trasparenza e
  diagnostica; flessibilita inferiore ma rischio di overfit piu controllabile.
- **Gradient boosting:** utile come upper-bound/challenger, non come prima scelta
  produttiva per calibrazione, extrapolazione e spiegabilita.
- **Sola presenza dei `trkpt`:** scartata come target; descrive il percorso e
  serve a stimare effort e controlli, mentre il target positivo è nei `wpt`.
- **Densità empirica `funghi / area visitata corretta`:** utile come diagnostica
  descrittiva, ma non come unico target/loss: rapporti con area piccola sono
  instabili, gli zeri hanno informazione diversa secondo l'effort e l'incertezza
  del denominatore va propagata. Il modello di conteggio con offset incorpora
  gli stessi elementi in modo più coerente.
- **Fattore di attenzione deterministico:** da non fissare subito. Confrontare
  funzioni conservative limitate, per esempio pesi tra 0.5 e 1.0, kernel
  saturante sul tempo e modelli con tempo/distanza separati. Evitare che le
  soste immediatamente successive a un waypoint aumentino artificialmente la
  detection prevista.

## Esperimenti e risultati

- Verifica statica del 2026-08-12: l'app aggiunge waypoint durante una
  registrazione, usa la posizione più recente, assegna tipo `Porcino` o
  `Finferlo`, nome progressivo e timestamp, e li esporta in GPX come `<wpt>` con
  `<name>` e `<type>`. Il database locale conserva gli stessi campi.
- Nessun esperimento statistico o audit sui GPX cloud eseguito al 2026-08-12.
- Nessuna metrica disponibile e nessuna evidenza attuale di miglioramento dello
  scoring produttivo.

## Problemi aperti

- [RESOLVED 2026-08-12] I GPX generati dall'app contengono waypoint di
  ritrovamento con specie `Porcino`/`Finferlo`, coordinate e timestamp; i
  `trkpt` della sessione forniscono una misura candidata di effort.
- [OPEN] Verificare se l'archivio cloud accetti anche GPX esterni/importati e
  definire criteri per distinguere con certezza quelli generati dall'app.
- [OPEN] Chiarire se un waypoint rappresenti un singolo fungo, un gruppo o un
  luogo e quanto sia completa la marcatura dei ritrovamenti.
- [OPEN] Determinare se esistano dati sulla visualizzazione dello score o altri
  segnali capaci di misurare il feedback loop nella scelta delle aree.
- [OPEN] Definire policy su revoca del consenso dopo estrazione/training e
  cancellazione o ricostruzione di dataset, modelli e statistiche derivate.
- [OPEN] Verificare numerosita, stagionalita, copertura geografica, qualita e
  concentrazione per utente dei GPX reali.
- [OPEN] Formalizzare se il target primario sia probabilità di almeno un
  ritrovamento o intensità/conteggio, sempre condizionato all'effort.
- [OPEN] Preregistrare split, metriche e soglie minime di miglioramento dopo
  l'audit di fattibilita.
- [OPEN] Decidere se raccogliere in futuro conferme di sessione senza
  ritrovamenti e informazioni su completezza della marcatura/detection.
- [OPEN] Stimare empiricamente errore GPS e raggio di ricerca; confrontare
  corridoi/kernel indicativamente da 4, 8, 12 e 20 m e risoluzioni interne senza
  confondere granularità computazionale con precisione reale.
- [OPEN] Definire il fattore di attenzione evitando causalità inversa dovuta a
  soste per raccolta, foto o inserimento del waypoint.
- [OPEN] Scegliere se il conteggio waypoint rappresenta abbastanza bene il
  numero di funghi; in caso contrario usare come target primario almeno un
  ritrovamento per cella-sessione.
