# Solco per Android

L'app è una Trusted Web Activity: all'avvio apre `https://www.solcomusic.online/` nel browser Android, a schermo intero quando il dominio riconosce la firma dell'APK. Le pagine e le API restano quelle del sito Solco, quindi account, catalogo, diario, assistenza e piani continuano a usare i servizi già configurati. I collegamenti interni restano nel flusso Solco; quelli esterni passano al browser o all'app Android associata. Il tasto Indietro segue la cronologia del browser.

Il file `../public/.well-known/assetlinks.json` collega il dominio al package Android e ai certificati che firmano l'APK (Digital Asset Links); gli stessi certificati sono dichiarati in `twa-manifest.json` (`fingerprints`) e in `../src/lib/android-app.ts`, che la pagina `/app` mostra agli utenti. Il test `../tests/unit/android-apk-certificates.test.ts` confronta questi tre punti con il certificato letto dentro `../public/solco.apk`: se uno diverge, il test fallisce. Il file `../public/solco-android-icon.svg` fornisce l'icona Solco per il launcher e la schermata iniziale.

## Certificati

| Impronta SHA-256 | Uso |
| --- | --- |
| `02:28:46:FD:CF:D1:34:80:21:74:52:B9:01:A9:27:A2:10:74:94:8D:05:A7:23:1A:30:EF:AF:73:E3:66:F2:52` | APK distribuiti da `/app` dall'11 novembre 2026 (1.1.0 e successivi). Chiave in `android/.keys/solco-release-key.jks` (alias `solco`), fuori da Git. |
| `74:EA:96:7E:6D:43:57:F8:42:CB:03:AD:9C:65:6E:1C:38:68:6E:06:E4:0D:9D:61:AB:7E:34:DB:2E:37:C4:15` | APK precedenti all'11 novembre 2026. Resta pubblicata perché chi li ha ancora installati li apra a schermo intero; quegli APK non si aggiornano (chiave diversa). |

`assetlinks.json` dichiara due package: `online.solcomusic.solco` (l'APK attuale, dalla 1.3.0) e `app.solcomusic.solco` (gli APK 1.1.0 e 1.2.0). Il 16 novembre 2026 Play Console ha rifiutato `app.solcomusic.solco` perché già in uso da un'altra app, quindi il package è cambiato; per Android sono due app diverse e chi ha la vecchia la disinstalla dopo aver installato la nuova. Il namespace del codice Java resta `app.solcomusic.solco`: cambia solo `applicationId`.

Android aggiorna un'app solo se il nuovo APK è firmato con la stessa chiave: senza `android/.keys/` (chiave e `keystore-password.txt`) un nuovo APK non si installa sopra le versioni esistenti e gli utenti devono disinstallare. Conservare una copia di quella cartella fuori dal repository e non committarla mai. Se l'app verrà pubblicata su Google Play, il certificato di Play App Signing (e quello della chiave di upload) andranno aggiunti a `assetlinks.json` e a `twa-manifest.json`: le impronte si leggono in Play Console, sezione Integrità dell'app, e vanno confermate dal proprietario.

## Ascolto in background

In una Trusted Web Activity la pagina gira nel Chrome dell'utente (o in un altro browser che supporta le TWA): la notifica multimediale, i controlli sulla schermata di blocco e il servizio in primo piano che tiene viva la riproduzione appartengono al browser, non all'APK. Per questo l'APK non dichiara `POST_NOTIFICATIONS` né `FOREGROUND_SERVICE_MEDIA_PLAYBACK`: da Android 13 le notifiche legate a una sessione multimediale sono esenti dal permesso di notifica ([developer.android.com](https://developer.android.com/develop/ui/views/notifications/notification-permission#exemptions)). `enableNotifications: false` in `twa-manifest.json` disattiva solo la delega delle notifiche push (`DelegationService`) e non tocca i controlli multimediali: non va cambiato.

Tutto il comportamento in background viene dal player web (`src/components/custom/music/music-player.tsx`, Media Session API): titolo e copertina nella notifica, tasti precedente/successivo per la musica, ±15/30 secondi per i podcast, nessun cursore per le radio in diretta, passaggio al brano successivo senza pause di rete. I video YouTube non suonano mai in background: si fermano quando Solco non è in primo piano e un video in coda aspetta il ritorno su Solco.

`fallbackType: customtabs`: sui dispositivi il cui browser predefinito non supporta le TWA, l'app si apre in una Custom Tab di quel browser e l'ascolto in background dipende da quel browser. Non passare al fallback WebView, che non ha la notifica multimediale del browser.

### Verifica su dispositivo

Da ripetere su iPhone (Safari e app aggiunta alla schermata Home) e su Android (scheda Chrome e app TWA) prima di una release che tocca il player:

- Bloccare lo schermo durante un brano Audius: almeno 3 passaggi automatici al brano successivo senza sbloccare.
- Coda mista con un video YouTube: a schermo bloccato il video non parte; riprende solo tornando su Solco.
- Tasti della schermata di blocco: musica con precedente/successivo, podcast con -15/+30 secondi, radio senza cursore.
- Telefonata in arrivo e cuffie scollegate: l'audio si ferma e il tasto del player mostra "Riproduci".
- Ripresa dalla schermata di blocco dopo 10 minuti di pausa.
- Account Free: dopo 3 brani passati in automatico il contatore aumenta esattamente di 3.
- Premi: dopo 15 minuti di ascolto con lo schermo bloccato risultano circa 15 minuti.

## Compilazione locale

Servono un JDK 17 o 21, Android SDK Platform 36 e Android Build Tools 36.1.0. Impostare `ANDROID_HOME` (e `JAVA_HOME`, se il `java` sul PATH non è quello voluto), poi eseguire:

```sh
bash android/build.sh apk
```

Lo script compila, firma con la chiave in `android/.keys/` e scrive `public/solco.apk`, il file che il sito distribuisce da `/app`; poi verifica la firma con `apksigner`, confronta package, versione e codice con `app/build.gradle` e si ferma se il certificato dell'APK non è pubblicato in `public/.well-known/assetlinks.json`. Per una nuova versione aggiornare insieme `versionName` e il codice predefinito in `app/build.gradle`, `appVersionName`/`appVersionCode` in `twa-manifest.json` e `ANDROID_APP_VERSION`/`ANDROID_APP_VERSION_CODE` in `src/lib/android-app.ts` (il test li confronta). Per generare un Android App Bundle da verificare localmente:

```sh
bash android/build.sh aab
```

Il bundle viene copiato in `solco.aab` e validato con `bundletool`. Senza chiave, resta non firmato e non è pronto per l'invio a Play. Per firmare l'AAB, il proprietario deve fornire la propria chiave privata di upload e conservarla solo nei file locali ignorati da Git in `android/.keys/`: `solco-release-key.jks` e `keystore-password.txt`. Se la password della chiave è diversa da quella del keystore, salvarla in `key-password.txt`; in assenza di questo file il build riusa la password del keystore. Non generare una chiave sostitutiva e non sostituire quella di upload dopo l'iscrizione a Play App Signing.

Il package è `online.solcomusic.solco`, il target SDK è 36 e la versione distribuita è `1.3.0` / `versionCode 4` (il codice predefinito di `app/build.gradle`). Per generare un AAB, il proprietario deve verificare in Console l'ultimo codice usato e passare entrambi i valori, ad esempio `SOLCO_ANDROID_LAST_VERSION_CODE=7 SOLCO_ANDROID_VERSION_CODE=8 bash android/build.sh aab`. Il nuovo codice deve essere maggiore del precedente; per il package nuovo non esiste alcuna release su Play, quindi il primo bundle si genera con `SOLCO_ANDROID_LAST_VERSION_CODE=0 SOLCO_ANDROID_VERSION_CODE=4` (il 16 novembre 2026 è stato generato e validato così con bundletool 1.18.1, indicato in `SOLCO_BUNDLETOOL_JAR`). Lo script non consulta Console. Ricontrollare la policy Play sul target API al momento della release.

La chiave locale che firma l'APK distribuito da `/app` non è il certificato con cui Google Play App Signing firmerebbe gli APK scaricati da Play. Quel fingerprint va confermato dal proprietario in Play Console e aggiunto a `public/.well-known/assetlinks.json` e a `twa-manifest.json` accanto agli attuali, senza togliere quelli esistenti. Il target (`36`), la versione e il package restano definiti in `app/build.gradle`.

Nessun comando di questo progetto carica artefatti o pubblica una release su Google Play.
