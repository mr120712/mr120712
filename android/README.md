# Solco per Android

L'app è una Trusted Web Activity: all'avvio apre `https://solcomusic.app/` nel browser Android, a schermo intero quando il dominio riconosce la firma dell'APK. Le pagine e le API restano quelle del sito Solco, quindi account, catalogo, diario, assistenza e piani continuano a usare i servizi già configurati. I collegamenti interni restano nel flusso Solco; quelli esterni passano al browser o all'app Android associata. Il tasto Indietro segue la cronologia del browser.

Il file `../public/.well-known/assetlinks.json` collega il dominio al package Android e al certificato usato per firmare l'APK. Il file `../public/solco-android-icon.svg` fornisce l'icona Solco per il launcher e la schermata iniziale.

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
