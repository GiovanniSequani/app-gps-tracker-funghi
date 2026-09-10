# Indice documentazione

Leggere `../AGENTS.md` prima di lavorare nel repository.

## Coordinamento

- `account-access-privacy-rollout.md`: backlog autorevole per account
  contributore, accesso pubblico/riservato all'indice, documenti legali,
  cancellazione, export, lifecycle temporaneo dei dataset modelling e rollout.
  Aggiornare stati e diario durante l'esecuzione dei task.
- `legal/README.md`: indice delle bozze legali pubbliche e dei documenti
  interni di conformità. I file sono bozze non efficaci fino ad approvazione
  legale e allineamento del codice.

## Contratti e regole

- `index-access-contract.md`: finestre `D-28..D` e `D-28..D-7` per account
  attivi e accesso limitato.
- `contributor-account-contract.md`: schema target minimo e stati dell'account
  contributore.
- `auth-email-setup.md`: configurazione, audit e collaudo di Gmail SMTP,
  conferma email, recovery e callback web/mobile.
- `account-lifecycle-runbook.md`: rollout e recovery degli stati account e del
  dispatcher lifecycle.
- `account-lifecycle-frontend-handoff.md`: contratto lifecycle per i client.
- `account-rights-runbook.md`: export, cancellazione riprendibile e retention
  delle email di servizio.
- `account-rights-frontend-handoff.md`: RPC e flussi export/cancellazione per
  web e mobile.
- `account-cutover-preflight.md`: esito pre-cutover, blocker e sequenza
  operativa staging/produzione per le tre migration account.
- `sec-001-web-handoff.md`: requisiti minimi di logging privacy per il
  repository web separato.
- `security-audit-backend-handoff.md`: compatibilita client dopo admission GPX,
  quote aggregate e rimozione dell'oracle lifecycle cross-user.
- `dependency-security-runbook.md`: lock Python, dependency gate, SBOM,
  eccezioni advisory e verifica sicura della chiave Google storica.
- `user-accounts-gpx-contract.md`: contratto tecnico corrente di account e GPX.
- `public-data-contract.md`: contratti dei dataset pubblici.
- `weather-time-series.md`: serie temporali meteo.
- `map-camera-rules.md`: invarianti della camera della mappa.
- `modelling-context.md`: contesto tecnico e vincoli di lifecycle per la chat
  modelling; effort, target e split restano scelte metodologiche.
- `modelling-notes.md`: decisioni, risultati e problemi metodologici del
  modelling.

Il piano di rollout descrive il target futuro. I contratti tecnici descrivono
il comportamento corrente finché i relativi task non sono completati. Non
confondere i due stati durante l'implementazione.
