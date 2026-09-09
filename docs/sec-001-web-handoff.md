# SEC-001 - Handoff web logging

Prima della prossima release web, verificare e correggere i log client affinche'
non emettano mai email, username, JWT, token, coordinate, GPX, marker, path
Storage, URL firmati o oggetti `Error`/risposte HTTP grezze.

Usare solo eventi minimali, ad esempio `event=export_request_failed` e una
classe/codice tecnico non sensibile. Non inviare tali valori a console,
analytics o crash reporting. Verificare sia flussi riusciti sia errori di
archivio GPX, export, cancellazione e callback pubblica.
