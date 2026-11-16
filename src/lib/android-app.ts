// @polsia:user-owned — dati pubblici dell'app Android (Trusted Web Activity) distribuita da /app:
// versione, package, dominio verificato e impronta SHA-256 del certificato che firma l'APK, la stessa
// pubblicata dal sito in public/.well-known/assetlinks.json (Digital Asset Links). È l'accordo che fa
// aprire Solco a schermo intero, senza la barra del browser. Il test
// tests/unit/android-apk-certificates.test.ts confronta questi valori con l'APK in public/solco.apk
// e con il progetto android/, così la pagina /app e il file pubblicato non possono divergere dal binario.

/**
 * Package Android dell'app (applicationId in android/app/build.gradle, assetlinks.json). Dal 16 novembre
 * 2026 è online.solcomusic.solco: Play Console ha rifiutato app.solcomusic.solco perché già in uso.
 */
export const ANDROID_APP_PACKAGE = 'online.solcomusic.solco';

/**
 * Package degli APK 1.1.0 e 1.2.0 distribuiti da /app prima del cambio. Per Android è un'altra app: resta in
 * assetlinks.json perché chi li ha installati continui ad aprirli a schermo intero, ma non si aggiornano.
 */
export const ANDROID_LEGACY_PACKAGE = 'app.solcomusic.solco';

/** Dominio che l'app apre e verifica (host della TWA e sito degli asset statements). */
export const ANDROID_APP_HOST = 'www.solcomusic.online';

/** Versione e codice dell'APK in public/solco.apk. */
export const ANDROID_APP_VERSION = '1.3.0';
export const ANDROID_APP_VERSION_CODE = 4;

/** Requisito minimo (minSdk 24). */
export const ANDROID_APP_MIN_VERSION = 'Android 7.0 o successivo';

/**
 * Impronta SHA-256 del certificato che firma l'APK dall'11 novembre 2026 (versioni 1.1.0 e successive).
 * La chiave privata sta in android/.keys/, fuori da Git: senza quella chiave un nuovo APK non aggiorna
 * le installazioni esistenti.
 */
export const ANDROID_APP_CERT_SHA256 =
  '02:28:46:FD:CF:D1:34:80:21:74:52:B9:01:A9:27:A2:10:74:94:8D:05:A7:23:1A:30:EF:AF:73:E3:66:F2:52';

/**
 * Impronta del certificato degli APK precedenti all'11 novembre 2026. Resta in assetlinks.json perché
 * chi li ha ancora installati continui ad aprirli a schermo intero; quegli APK non si aggiornano da soli
 * (chiave diversa) e vanno disinstallati prima di installare la versione corrente.
 */
export const ANDROID_LEGACY_CERT_SHA256 =
  '74:EA:96:7E:6D:43:57:F8:42:CB:03:AD:9C:65:6E:1C:38:68:6E:06:E4:0D:9D:61:AB:7E:34:DB:2E:37:C4:15';

/** Forma di un'impronta SHA-256 come la pubblica Digital Asset Links: 32 coppie esadecimali maiuscole. */
export const SHA256_FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
