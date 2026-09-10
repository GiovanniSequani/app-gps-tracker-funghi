# Account lifecycle mobile

## Protezioni locali e rete

- Le sessioni Supabase sono persistite con `expo-secure-store` usando una classe di accesso non migrabile su un altro dispositivo. Al primo avvio della 1.9.0 l'eventuale sessione legacy viene migrata e rimossa da AsyncStorage.
- Android disabilita integralmente backup e restore dell'app. Su iOS il plugin CNG esclude Documents e Application Support, che contengono database, GPX locali e draft di recovery.
- GPX ed export destinati alla condivisione vivono esclusivamente in `cache/sensitive-temp` e vengono rimossi dopo successo, annullamento o errore, oltre che all'avvio, al logout e alla perdita autoritativa dell'accesso.
- Il bootstrap tile e il polling export si sospendono offline/in background, rispettano `Retry-After`, usano backoff esponenziale con jitter e un tetto di tentativi. Dopo il tetto l'utente può riprovare manualmente.
- Gli EAS Update sono disabilitati nella release 1.9.0. La procedura necessaria per riattivarli con firma e i controlli obbligatori su artefatto/dispositivo sono in `SECURITY_RELEASE_CHECKLIST.md`.

Questa implementazione copre lato app `MOB-001`, `MOB-003`, `MOB-004` e `MOB-005`. Non applica migration e non modifica gli switch server.

## Fonte dello stato

L’app legge `get_account_lifecycle_public_config` e, quando il rollout è attivo, `get_my_account_access`. L’accesso alle funzioni riservate è consentito soltanto quando la risposta server validata contiene `full_access=true`.

- errori di rete, risposte incomplete e stati sconosciuti sono fail-closed;
- RPC mancante, lifecycle disabilitato, errore di rete o risposta non valida restano fail-closed;
- al ritorno in foreground lo stato viene rivalidato con `foreground_session`;
- il login esplicito usa `interactive_login`; deep link e refresh del token non vengono registrati come attività significativa;
- una perdita di accesso confermata invalida i caricamenti dell’archivio e rimuove dalla mappa le tracce private, senza comandi camera; un refresh ancora in corso conserva l’ultimo stato autorevole.

## Documenti e accettazione

La build riconosce Termini `1.0` e Privacy `1.0`. Se il server richiede versioni diverse, registrazione e riaccettazione restano bloccate. I documenti completi sono aperti dalle pagine pubbliche `/termini/` e `/privacy/` e le chiamate mobile usano sempre `p_source='mobile'`.

Le RPC usate sono:

- `record_my_legal_notice_seen` dopo che la schermata limitata è stata mostrata;
- `accept_current_contributor_terms`;
- `refuse_current_contributor_terms`;
- `record_my_meaningful_activity`.

## Diritti, export e cancellazione

L’area account mostra i diritti per account `active` e `restricted`:

- `request_my_data_export` crea o restituisce il job corrente;
- il client legge solo il job più recente consentito da RLS e fa polling ogni 15 secondi soltanto per `pending`, `building` e `retry` mentre l’app è in foreground;
- un job `ready` viene scaricato con il JWT dal bucket privato `user-data-exports`, salvato temporaneamente nella cache dell’app e consegnato al foglio di condivisione del sistema; non vengono creati URL pubblici o persistenti;
- `request_my_account_deletion_verification` mostra sempre l’invito non enumerativo a controllare l’email; la conferma monouso resta nel callback HTTPS pubblico, così il token non viene né acquisito né persistito dall’app;
- dopo la conferma esterna, il refresh foreground rileva `deletion_pending` e rimuove subito tracce/export privati dalla UI senza muovere o rimontare la mappa.

Se API o switch non sono disponibili, l’interfaccia lo dichiara e non simula export o cancellazioni.

In registrazione vengono inviati username, accettazione Termini, presa visione Privacy, versioni correnti e `terms_acceptance_source='mobile'`. Non viene più proposto un consenso ricerca separato: la natura contributiva dell’account è descritta nei Termini correnti.

## Accesso pubblico e account

- guest, account sospeso e stato non verificabile vedono l’ultima data indice disponibile tra `D-27` e `D-7`;
- il valore puntuale usa la stessa finestra e i giorni mancanti non vengono interpolati;
- l’analisi indice, l’archivio, import, editing e visualizzazione di percorsi salvati richiedono `full_access=true`;
- senza account la registrazione resta temporanea: al termine viene aperto lo share sheet con un GPX e il file temporaneo viene eliminato;
- con una sessione già persistita ma rete non disponibile, l’identità locale consente soltanto di conservare nuove registrazioni sul dispositivo: non concede accesso alle API private né sostituisce `full_access=true`;
- quando la verifica server torna disponibile, i percorsi locali sono proposti tra quelli non sincronizzati e possono essere caricati con il normale flusso cloud; uno stato `restricted` o `deletion_pending` confermato non abilita questa modalità offline;
- l’avviso iniziale riprende gerarchia e testi della webapp mobile, con accesso/registrazione oppure prosecuzione con l’indice pubblico.

## Limiti intenzionali

La conferma monouso della cancellazione resta nella pagina HTTPS pubblica prevista dal contratto; l’app non acquisisce o conserva quel token. Gli stati `deletion_pending` e `security` non offrono riattivazione automatica.

## Verifica locale

Da `mobile/`:

```powershell
npm.cmd run typecheck
npm.cmd test
npx.cmd expo-doctor
```

La verifica manuale su Android e iOS deve includere: sessione persistente, sessione scaduta, ritorno foreground, cambio remoto `active/restricted/deletion_pending`, accettazione/rifiuto, mismatch versioni e conferma che centro, zoom, bearing e pitch della mappa restino invariati.
