// @polsia:user-owned — lettura delle credenziali degli store per gli acquisti in-app.
//
// Nessun segreto vive nel codice: tutto arriva dalle variabili d'ambiente iniettate al deploy
// (come STRIPE_SECRET_KEY). Se una piattaforma non è configurata, l'acquisto in-app per quella
// piattaforma resta semplicemente non disponibile (readiness), senza rompere nulla.
import 'server-only';

type Env = Record<string, string | undefined>;

export type AppleIapConfig = {
  /** Bundle id dell'app iOS (claim `bid` del token, e controllo su bundleId delle transazioni). */
  bundleId: string;
  /** Issuer id della chiave App Store Connect / In-App Purchase (UUID). */
  issuerId: string;
  /** Key id della chiave .p8. */
  keyId: string;
  /** Contenuto della chiave privata .p8 (PKCS#8). */
  privateKey: string;
  /**
   * Ancora di fiducia: uno o più certificati "Apple Root CA" in PEM (concatenabili), scaricati da
   * https://www.apple.com/certificateauthority/ (Apple Root CA - G3). La catena x5c delle risposte
   * firmate da Apple deve terminare ESATTAMENTE su una di queste radici. Senza, la verifica JWS non
   * può fidarsi di nulla, quindi gli acquisti Apple restano non disponibili.
   */
  rootCas: string;
};

export type GooglePlayConfig = {
  /** Package name dell'app Android. */
  packageName: string;
  /** Email del service account con accesso all'API Google Play Developer. */
  clientEmail: string;
  /** Chiave privata del service account (PEM RSA). */
  privateKey: string;
};

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

/** Le chiavi scritte come "\n" nelle env var vanno riportate a capo reali. */
export function normalizePem(raw: string): string {
  return raw.trim().replace(/\\n/g, '\n');
}

/** Config Apple, o null se mancano le credenziali. */
export function appleIapConfig(env: Env = process.env): AppleIapConfig | null {
  const bundleId = clean(env.APPLE_IAP_BUNDLE_ID);
  const issuerId = clean(env.APPLE_IAP_ISSUER_ID);
  const keyId = clean(env.APPLE_IAP_KEY_ID);
  const privateKey = clean(env.APPLE_IAP_PRIVATE_KEY);
  const rootCas = normalizePem(clean(env.APPLE_IAP_ROOT_CA));
  if (!bundleId || !issuerId || !keyId || !privateKey || !rootCas.includes('BEGIN CERTIFICATE')) {
    return null;
  }
  return { bundleId, issuerId, keyId, privateKey, rootCas };
}

/**
 * Config Google. Accetta sia il JSON intero del service account (`GOOGLE_PLAY_SA_JSON`) sia i due
 * campi separati (`GOOGLE_PLAY_SA_CLIENT_EMAIL` + `GOOGLE_PLAY_SA_PRIVATE_KEY`). null se incompleta.
 */
export function googlePlayConfig(env: Env = process.env): GooglePlayConfig | null {
  const packageName = clean(env.GOOGLE_PLAY_PACKAGE_NAME);
  if (!packageName) return null;

  const json = clean(env.GOOGLE_PLAY_SA_JSON);
  if (json) {
    try {
      const parsed = JSON.parse(json) as { client_email?: unknown; private_key?: unknown };
      const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
      const privateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';
      if (clientEmail && privateKey) {
        return { packageName, clientEmail, privateKey: normalizePem(privateKey) };
      }
    } catch {
      // JSON malformato: prova i campi separati prima di arrenderti.
    }
  }

  const clientEmail = clean(env.GOOGLE_PLAY_SA_CLIENT_EMAIL);
  const privateKey = clean(env.GOOGLE_PLAY_SA_PRIVATE_KEY);
  if (!clientEmail || !privateKey) return null;
  return { packageName, clientEmail, privateKey: normalizePem(privateKey) };
}

/**
 * Accettare acquisti in ambiente Sandbox (Apple) / di test (Google)? Di norma NO in produzione:
 * si abilita solo per i tester con IAP_ALLOW_SANDBOX=1.
 */
export function iapAllowSandbox(env: Env = process.env): boolean {
  return clean(env.IAP_ALLOW_SANDBOX) === '1';
}

/** Segreto condiviso nella URL di push delle notifiche Google RTDN (verificato a tempo costante). */
export function googleRtdnSecret(env: Env = process.env): string {
  return clean(env.GOOGLE_PLAY_RTDN_SECRET);
}

export type IapReadiness = {
  apple: boolean;
  google: boolean;
  /** true se almeno una piattaforma è acquistabile. */
  available: boolean;
};

export function iapReadiness(env: Env = process.env): IapReadiness {
  const apple = appleIapConfig(env) !== null;
  const google = googlePlayConfig(env) !== null;
  return { apple, google, available: apple || google };
}
