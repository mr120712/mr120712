# Solco per Android

L'app è una Trusted Web Activity: all'avvio apre `https://solcomusic.app/` nel browser Android, a schermo intero quando il dominio riconosce la firma dell'APK. Le pagine e le API restano quelle del sito Solco, quindi account, catalogo, diario, assistenza e piani continuano a usare i servizi già configurati. I collegamenti interni restano nel flusso Solco; quelli esterni passano al browser o all'app Android associata. Il tasto Indietro segue la cronologia del browser.

Il file `../public/.well-known/assetlinks.json` collega il dominio al package Android e al certificato usato per firmare l'APK. Il file `../public/solco-android-icon.svg` fornisce l'icona Solco per il launcher e la schermata iniziale.

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

Servono JDK 17, Android SDK Platform 36 e Android Build Tools 36.1.0. Impostare `JAVA_HOME` e `ANDROID_HOME`, poi eseguire:

```sh
bash android/build.sh apk
```

Lo script compila e firma `solco.apk` nella radice del repository. Per generare un Android App Bundle da verificare localmente:

```sh
bash android/build.sh aab
```

Il bundle viene copiato in `solco.aab` e validato con `bundletool`. Senza chiave, resta non firmato e non è pronto per l'invio a Play. Per firmare l'AAB, il proprietario deve fornire la propria chiave privata di upload e conservarla solo nei file locali ignorati da Git in `android/.keys/`: `solco-release-key.jks` e `keystore-password.txt`. Se la password della chiave è diversa da quella del keystore, salvarla in `key-password.txt`; in assenza di questo file il build riusa la password del keystore. Non generare una chiave sostitutiva e non sostituire quella di upload dopo l'iscrizione a Play App Signing.

Il package è `app.solcomusic.solco`, il target SDK iniziale è 36 e la versione locale predefinita è `1.0.0` / `versionCode 1`. Per generare un AAB, il proprietario deve verificare in Console l'ultimo codice usato e passare entrambi i valori, ad esempio `SOLCO_ANDROID_LAST_VERSION_CODE=7 SOLCO_ANDROID_VERSION_CODE=8 bash android/build.sh aab`. Il nuovo codice deve essere maggiore del precedente; se Console conferma che non esiste alcuna release precedente, usare `SOLCO_ANDROID_LAST_VERSION_CODE=0`. Lo script non consulta Console. Ricontrollare la policy Play sul target API al momento della release.

La chiave di upload non è il certificato con cui Google Play App Signing firma gli APK distribuiti. Il fingerprint del certificato Play va confermato dal proprietario in Play Console e pubblicato separatamente in `public/.well-known/assetlinks.json`; non copiare lì automaticamente il fingerprint dell'APK o della chiave di upload. Il target (`36`), la versione (`1.0.0`, code `1`) e il package restano definiti in `app/build.gradle`.

Nessun comando di questo progetto carica artefatti o pubblica una release su Google Play.
