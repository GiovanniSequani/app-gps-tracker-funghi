# Checklist release mobile — security audit 2026-09

Questa checklist è obbligatoria per ogni release che include SEC-AUD-003, 007, 012 o 018. I controlli su artefatto e dispositivo non possono essere sostituiti dal solo Expo Doctor.

## Stato OTA della release 1.9.0

`expo.updates.enabled` è `false`: la release 1.9.0 non scarica aggiornamenti OTA. Le modifiche richiedono una nuova build. Non riattivare EAS Update senza completare la procedura firmata qui sotto e produrre una nuova build con un nuovo runtime.

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
- [ ] Apertura/chiusura di archivio, export e retry tile non deve rimontare MapLibre né cambiare centro, zoom, bearing o pitch.

## Verifica iOS reale / archivio

- [ ] Generare una build iOS con CNG/EAS e verificare nell’AppDelegate prodotto la chiamata `excludeSensitiveDataFromBackup()`.
- [ ] Su dispositivo reale verificare login persistente, deep link conferma/recovery, registrazione in foreground/background e recovery draft.
- [ ] Ispezionare il container dell’app: Documents e Application Support devono avere `NSURLIsExcludedFromBackupKey = 1`; Cache non deve contenere file in `sensitive-temp` dopo share/logout.
- [ ] Un ripristino su altro dispositivo non deve trasferire credenziali, database, GPX, draft o export.
- [ ] Verificare che nessun pannello o retry modifichi la camera o rimonti la mappa.

## Riattivazione futura di EAS Update con firma

1. Generare offline una chiave RSA privata e un certificato X.509. Conservare la chiave privata fuori dal repository e dai backup/archivi EAS; committare soltanto il certificato pubblico.
2. Impostare in `app.json`:
   - `updates.enabled: true`;
   - `updates.codeSigningCertificate` verso il certificato pubblico;
   - `updates.codeSigningMetadata` con `keyid` stabile e `alg: rsa-v1_5-sha256`.
3. Incrementare `expo.version`, così `runtimeVersion.policy: appVersion` crea un runtime nuovo.
4. Produrre e installare una nuova build nativa: il certificato deve essere incorporato nel binario prima di pubblicare OTA.
5. Pubblicare sempre con la chiave esplicita fuori repo, per esempio:
   `eas update --branch main --platform android --private-key-path D:\percorso-esterno\funghitracker-update-private.pem --message "descrizione"`.
6. Su dispositivo verificare un update firmato valido. In un ambiente di test isolato verificare inoltre che manifest unsigned o alterato venga rifiutato.
7. Non usare mai il vecchio runtime non firmato per distribuire bundle dopo la riattivazione.

Se uno dei controlli rimane non verificato, la release non è pronta per la pubblicazione sugli store.
