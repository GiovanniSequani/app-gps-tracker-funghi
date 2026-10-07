# Forecast porcini: operazioni e contratto v1

Task `BE-FORECAST-001`. Implementazione locale; **prima pubblicazione remota
ancora subordinata al check del proprietario**. Nessuna modifica mobile/web.

## Decisioni e sorgenti

- ICON-2I fino all'ultimo giorno locale interamente coperto, poi ICON-EU.
  Orizzonte configurabile `--horizon 0..4` (default +4, cinque date incluso +0).
  Si riduce al numero di giorni coperti dalla corsa EU effettivamente disponibile.
- ICON-2I: ultima corsa disponibile non futura, massimo 36 ore di eta'; se
  necessario anche la precedente per completare le ore iniziali di +0.
  EU: corsa 00 UTC con lead 120 disponibile, stessa soglia di freschezza.
- File reali: ICON-2I regolare 0.02 lat x 0.025 lon; ICON-EU 0.0625 x 0.0625.
  La griglia indice 500x700 / 0.003 gradi **non e' la risoluzione meteo**.
  Assegnazione della cella sorgente piu' vicina, senza interpolazione spaziale,
  correzione altimetrica o dettaglio meteorologico artificiale.
- T_2M Kelvin -> Celsius; EU RELHUM_2M percentuale (tolleranza di packing
  0.01%, poi clipping 0..100). ICON-2I RH da T_2M/TD_2M con Magnus su acqua.
  VMAX_10M m/s -> km/h. TOT_PREC kg/m2 = mm; differenze fra accumuli della
  **stessa corsa**. Reset negativi oltre 0.05 mm bloccano la build.
- EU e' orario fino a 78h, poi triorario fino a 120h. T/RH interpolati solo
  nel tempo; pioggia distribuita uniformemente nell'intervallo, conservando
  l'accumulo. Estremi di T/RH da campioni, non estremi continui esatti.
- **Decisione accettata**: per EU il massimo giornaliero di raffica e' il
  massimo dei campioni effettivamente disponibili. Le ore non coperte
  restano NaN, non vengono replicate. `gust_covered_hours`, `gust_partial` e
  `partial_gust_max` segnalano copertura inferiore a 23/24/25 ore. Possibile
  sottostima dello stress e sovrastima dello score; non e' una probabilita'.
- Europe/Rome: giorni civili costruiti da due mezzanotti locali indipendenti,
  quindi 23/24/25 intervalli al cambio d'ora. Per pioggia/raffiche il timestamp
  e' la **fine** dell'intervallo. Il vecchio aggregatore ufficiale non viene
  riscritto: il suo campionamento giornaliero per etichetta oraria resta quello
  esistente e puo' differire di un'ora ai bordi dalla convenzione forecast.
- Il passaggio fra modelli e' a inizio giorno locale. `model_overlap` misura
  differenze a uguali valid_time su griglia campionata ogni sei celle, non
  una validazione contro osservazioni. Nessun aggiustamento empirico nascosto.

Fonti e attribuzioni frontend obbligatorie:

- [ItaliaMeteo, ICON-2I](https://dati.agenziaitaliameteo.it/dataset/previsioni-meteorologiche-modello-icon-2i):
  "Fonte: Agenzia nazionale per la meteorologia e climatologia ItaliaMeteo",
  collaborazione Arpae, CC BY; indicare elaborazione FunghiTracker.
- [DWD, documentazione ICON](https://isabel.dwd.de/DWD/forschung/nwv/fepub/icon_database_main.pdf)
  e [Open Data](https://opendata.dwd.de/weather/nwp/icon-eu/grib/):
  "Fonte: Deutscher Wetterdienst (DWD); elaborazione FunghiTracker".
- ECMWF esaminato ma **non utilizzato** nella v1: griglia Open Data 0.25 gradi
  e copertura delle raffiche parziale anche nei file verificati fino a lead 90.

## Fallback, scoring e isolamento

Priorita' giornaliera condivisa anche dallo scoring **ufficiale**, come richiesto:
HRS validato > ICON-RUC > ultima previsione locale verificata per quella data >
NaN. Fallback solo se la data non e' disponibile nelle serie HRS/RUC: non si
mescolano automaticamente celle di giorni ufficiali parzialmente nodata.
Le serie annuali RUC/HRS non vengono mai riempite con previsioni.

Una previsione locale e' utilizzabile come fallback solo dopo il completamento
del manifest, con checksum del NetCDF giornaliero verificato, unita' corrette e
griglia compatibile. Versioni incomplete/corrotte non diventano trusted. Si usa
la piu' recente, senza sostituire un giorno HRS/RUC presente. Se HRS/RUC arriva
successivamente, prevale nelle nuove composizioni; nessuna rigenerazione o
ripubblicazione retroattiva automatica degli indici gia' esistenti.

`weather_source`: 0=missing, 1=ICON-RUC, 2=HRS, **3=archived-forecast**.
L'attributo JSON `forecast_fallback` conserva date, emissione, versione, corse
dei modelli e copertura parziale delle raffiche. Passa dalle finestre alle
feature e all'indice ufficiale, e viene esposto nei metadata meteo e manifest
index-data quando presente. Nessun cambiamento al layout dei chunk ufficiali.
La daily ufficiale conserva i suoi gate di pubblicazione: questo fallback
non autorizza automaticamente a saltare quei gate o pubblicare date mancanti.

La previsione calcola in ordine cronologico, con finestra di 19 giorni e
recovery di sei giorni: indici ufficiali passati + indici gia' calcolati nella
corsa corrente. Eventuali giorni fra ultimo indice ufficiale e +0 vengono
ricostruiti solo localmente per la recovery. Oltre sette giorni senza indice
ufficiale si richiede aggiornamento degli input. Nessun finferlo previsionale.

Gap mantenuti NaN: la formula ufficiale usa `skipna=True`, percio' somme tutte
NaN possono dare zero, medie ignorano i giorni mancanti e confronti RH con NaN
non contano come giorni secchi. Questo **non significa meteo osservato secco**:
si pubblicano date mancanti, provenienza e flag `historical_gaps_skipna_bias`.
La formula non viene cambiata; meno di otto giorni utilizzabili o score
interamente non finiti fermano la build. Il fallback e' limitato alle versioni
ancora locali: dopo la retention un vecchio gap puo' tornare NaN in un ricalcolo.

## Comandi dalla root

```powershell
# Solo locale, default +0..+4 e zoom 3..11
.\run_daily_forecast_pipeline.bat
python -m backend.scripts.run_daily_forecast_pipeline --horizon 4 --max-zoom 11

# SOLO dopo approvazione della prima pubblicazione e migration applicata
python -m backend.scripts.run_daily_forecast_pipeline --publish-existing backend/outputs/forecast/VERSION
# Successive corse complete con pubblicazione
.\run_daily_forecast_pipeline.bat --publish
# Retention senza generare indici (anche fuori stagione)
.\run_daily_forecast_pipeline.bat --cleanup-only --publish
```

Migration idempotente da applicare **dopo il check**, integralmente nel SQL Editor:
`backend/supabase/migrations/202610070001_forecast_publication.sql`.
Non applicata durante il collaudo locale. Configurazione backend/.env esistente:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (o alias backend gia' supportato).
Nessun nuovo segreto; nessuna service-role nei frontend.

Download e cache: `backend/data/forecast/cache/`; output:
`backend/outputs/forecast/<YYYYMMDDTHHMMSSZ>/`; log: `backend/logs/forecast/`.
Tutto gitignored. Un file GRIB alla volta, crop della sorgente, scoring per
strisce di 50 righe, GDAL con un processo. Cap download 900 MB/esecuzione;
cap locale di ingresso 2 GB e almeno 1.5 GB liberi. Cache per corsa; raw eliminati
dopo decodifica. Errori interrompono senza cambiare il puntatore pubblico.

## Contratto frontend

1. Gate prodotto: mostrare solo se stato account **active/full_access**.
   Bucket pubblici: non e' protezione RLS, gli URL diretti restano accessibili.
2. `supabase.rpc('current_forecast')` con anon key restituisce JSON o `null`.
   Non esiste `current.json` Storage: il puntatore RPC e' atomico lato database
   ed evita la corsa fra due uploader. Non memorizzarlo con cache lunga.
3. Risposta minima:

```json
{"schema_version":1,"version":"20261007T152310Z",
 "issued_at":"2026-10-07T15:23:10+00:00",
 "valid_until":"2026-10-11T22:00:00+00:00",
 "manifest_bucket":"forecast-data",
 "manifest_path":"20261007T152310Z/manifest.json",
 "manifest_sha256":"<sha256>"}
```

4. GET pubblico `forecast-data/<version>/manifest.json`: date locali ordinate,
   specie, griglia, origine, modelli/run, qualita', inventario tile/chunk e SHA256.
   Manifest e oggetti sono immutabili, cache lunga; cambia sempre il prefisso.
5. Lookup come index-data: entro bbox, `row=floor((lat-origin_lat)/.003+.5)`,
   `col=floor((lon-origin_lon)/.003+.5)`, clamp 0..499 e 0..699 ai bordi.
   Riga crescente da sud, colonna crescente da ovest. Chunk `row//50,col//50`.
6. GET `forecast-data/<version>/chunks/rRR_cCC.bin.zlib` (140 chunk).
   Decomprimere **zlib**, poi float32 little-endian C-order `[row,col,date]`.
   Offset byte: `((row%50)*chunk_cols + col%50)*date_count*4 + date_index*4`.
   Valori esatti dello score porcini, scala 1, nodata IEEE NaN. Nessuna diagnostica.
7. Tile XYZ PNG: `forecast-tiles/<version>/<date>/porcini/{z}/{x}/{y}.png`.
   Zoom disponibili nel manifest; default 3..11, overzoom client senza muovere
   camera o ricreare la mappa. Non campionare colori per leggere score.
8. Non mostrare oltre `valid_until`, neppure da cache: e' la mezzanotte locale
   successiva all'ultima data valida, espressa in UTC. L'RPC restituisce null
   alla scadenza anche se il worker e' spento. La rimozione fisica richiede il job.

## Pubblicazione e recovery operativa

Registro service-role `forecast_versions`, puntatore `forecast_pointer`, unica
RPC pubblica read-only `current_forecast`. Upload completo di tile/chunk,
readback di **ogni oggetto**, manifest verificato, poi `activate_forecast` sotto
row lock. Una emissione vecchia o modelli piu' vecchi non possono sostituire
la corrente. Retry stessa versione idempotente; checksum diverso rifiutato.
Upload parziale: precedente corrente intatta, versione staging rintracciabile.

Cleanup solo inventari registrati, nessun listing Storage e nessun accesso ai
bucket ufficiali. Elimina versioni con `valid_until` scaduta da almeno sette
giorni; include staging incompleti. Directory incomplete locali dopo sette
giorni dall'emissione, cache dopo sette giorni. Cleanup alla prossima esecuzione:
se il PC resta spento non esiste uno scheduler remoto che rimuova i file.
Cap preventivo DB: 64 MiB/versione, 256 MiB riservati complessivi per forecast;
non e' una misura della quota totale Supabase. Nessun cleanup di account/GPX.

Prima pubblicazione: applicare migration, pubblicare una versione ancora valida,
verificare RPC anonima, manifest, chunk e tile; testare monotonicita'/expiry su
dati forecast controllati. Queste prove Supabase sono ancora **NOT RUN**.

## Evidenze locali 2026-10-07

- Suite backend: 229 passed al primo collaudo completo; test forecast coprono
  DST 23/25h, accumuli/reset, raffiche parziali, blending RUC, nearest-neighbour,
  scoring bitwise, recovery, fallback ufficiale streaming, priorita' HRS,
  checksum, fallimento upload/idempotenza e cleanup isolato.
- Corsa `20261007T152310Z`: ufficiale di partenza 2026-10-06, validita' 7..11
  ottobre; 500x700, zero score nodata, tutti 0..100. Raffiche 24/24 ore nei
  primi tre giorni, 13/24 e 8/24 negli ultimi due.
- +0: 7 ore RUC, 7 ICON-2I 00 UTC, 10 ICON-2I 12 UTC. +1/+2 ICON-2I,
  +3/+4 ICON-EU 00 UTC. Nessun gap storico nella finestra reale di questa corsa.
- 140 chunk: 3,927,747 byte; 1,250 tile zoom 3..11: 13,552,663 byte;
  payload 17,480,410 byte (~16.67 MiB), directory ~47 MB. Verificati tutti
  i 140 chunk bit per bit contro i NetCDF e le firme PNG di tutte le tile.
- Durata 209.1 s, con 337.1 MB scaricati e le altre due sorgenti gia' in cache.
  Totale sorgenti della configurazione: 818.8 MB a cache fredda (due corse
  ICON-2I + EU). Non e' stato misurato il tempo di una corsa tutta a cache fredda.
  Peak working set Python osservato durante la corsa: ~836 MB, esclusi figli GDAL.
- Ripetizione finale `20261007T152901Z`: 185.1 s, zero byte meteo scaricati,
  stessi score e payload, manifest con flag qualita' aggiornati.
- Sovrapposizione modelli 24h: differenza assoluta media T 2.10 C,
  RH 12.83 punti percentuali, pioggia 0.019 mm/h, raffica disponibile 8.23 km/h.
  Sono differenze fra modelli/run, **non errori rispetto alla realta'**.
- Sensibilita' NaN sullo score base (senza recovery), 7,000 celle in una fascia
  che include il massimo: togliendo il giorno 7 ottobre, delta medio -0.116
  punti, massimo assoluto 11.145, 2.16% delle celle oltre 1 punto. Esperimento
  controllato, non stima rappresentativa dell'intero dominio. Un'altra fascia
  con gap il 2 ottobre non mostrava differenze: l'effetto dipende dai candidati.

Non pubblicato, non collaudato da frontend. Prima emissione remota in attesa
del check richiesto dal proprietario; non segnare il rollout end-to-end DONE.
