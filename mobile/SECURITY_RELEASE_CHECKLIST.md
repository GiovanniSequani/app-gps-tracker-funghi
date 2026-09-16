# Checklist release mobile — security audit 2026-09

Questa checklist è obbligatoria per ogni release che include SEC-AUD-003, 007, 012 o 018. I controlli su artefatto e dispositivo non possono essere sostituiti dal solo Expo Doctor.

## Stato OTA della release 1.9.0

`expo.updates.enabled` è `false`: la release 1.9.0 non scarica aggiornamenti OTA. Le modifiche richiedono una nuova build distribuita tramite Google Play. La riattivazione di EAS Update non è pianificata.

## Prima della build

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npx expo-doctor`
- [ ] `npx expo config --type public` mostra `android.allowBackup: false`, `updates.enabled: false` e i plugin SecureStore/backup iOS.
- [ ] Nessun file `.pem`, token, GPX, database, draft o export è presente nel repository o nell’archivio EAS.
- [ ] Le variabili EAS contengono soltanto `EXPO_PUBLIC_SUPABASE_URL` e `EXPO_PUBLIC_SUPABASE_ANON_KEY` client-safe.

## Verifica AAB/APK Android reale

- [ ] Generare la build da questa directory: `eas build -p android --profile production` (AAB Play Store) oppure `eas build -p android --profile preview` (APK di prova).
- [ ] Ispezionare il manifest finale con `apkanalyzer manifest print app.aab` oppure `apkanalyzer manifest print app.apk`: `android:allowBackup="false"` deve essere presente sull’elemento `application`.
- [ ] Installare pulito su un dispositivo reale, effettuare login, chiudere forzatamente e riaprire: la sessione deve sopravvivere.
- [ ] Aggiornare sopra una release 1.8.x: la sessione AsyncStorage deve migrare una sola volta a SecureStore e login/deep link devono continuare a funzionare.
- [ ] Verificare che backup/ripristino Android non trasferisca sessione, database, GPX locali o draft su un altro dispositivo.
- [ ] Avviare, mettere in pausa, mandare in background, riprendere e salvare una registrazione; verificare anche il recovery dopo terminazione del processo.
- [ ] Con rete assente, tile ed export non devono martellare la rete; al ritorno online riprendono. Dopo il tetto dei tentativi deve essere disponibile `Riprova`.
- [ ] Scaricare/condividere GPX ed export, poi annullare la share e ripetere con errore: `cache/sensitive-temp` deve risultare vuota dopo ogni esito e dopo logout.
- [ ] Con una traccia usa-e-getta già `ready`, verificare sulla build release: conteggi/dettagli, mostra su mappa, apertura editor e download/condivisione. Il download deve usare il JWT corrente e non deve produrre signed URL; il Blob nativo deve essere leggibile senza errori `arrayBuffer`.
- [ ] Eliminare la stessa traccia usa-e-getta e verificare che spariscano sia l'oggetto Storage sia i metadata. In caso di risposta RPC ambigua il retry deve completare l'operazione senza ripetere la DELETE Storage.
- [ ] In `adb logcat` gli eventuali record `[FunghiTracker account operation]` devono contenere soltanto operazione/categoria/codici tecnici, mai token, email, UUID, path, coordinate o contenuti GPX.
- [ ] Con account A creare una route locale e una bozza di recovery, poi fare logout/accesso con account B e simulare anche sessione scaduta: B non deve vedere, caricare o recuperare route, waypoint, marker o metadata di A.
- [ ] Importare un `.gpx` e un `.gpx.gz` validi; poi scegliere file oltre i limiti configurati e un provider senza size attendibile: il rifiuto deve avvenire prima della copia/lettura completa e `cache/sensitive-temp` deve restare vuota.
- [ ] Apertura/chiusura di archivio, export e retry tile non deve rimontare MapLibre né cambiare centro, zoom, bearing o pitch.

## Verifica iOS reale / archivio

- [ ] Generare una build iOS con CNG/EAS e verificare nell’AppDelegate prodotto la chiamata `excludeSensitiveDataFromBackup()`.
- [ ] Su dispositivo reale verificare login persistente, deep link conferma/recovery, registrazione in foreground/background e recovery draft.
- [ ] Ispezionare il container dell’app: Documents e Application Support devono avere `NSURLIsExcludedFromBackupKey = 1`; Cache non deve contenere file in `sensitive-temp` dopo share/logout.
- [ ] Un ripristino su altro dispositivo non deve trasferire credenziali, database, GPX, draft o export.
- [ ] Verificare che nessun pannello o retry modifichi la camera o rimonti la mappa.

Se uno dei controlli rimane non verificato, la release non è pronta per la pubblicazione sugli store.
