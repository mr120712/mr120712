// @polsia:user-owned — dati pubblici dell'app iOS di Solco (ios/Solco.xcodeproj) e percorsi
// dell'installazione dal sito. Su iPhone un'app fuori dall'App Store si installa solo con un link
// `itms-services://` verso un manifest che indica l'IPA: Solco pubblica entrambi dietro un cancello
// (account + token firmato a scadenza, perché l'installatore di iOS non manda i cookie del browser).
// L'IPA deve essere firmato con un certificato dell'Apple Developer Program del proprietario e con un
// profilo Ad Hoc (dispositivi registrati) o Enterprise: un IPA senza firma o firmato per l'App Store
// non si installa in questo modo.
import { ANDROID_APP_HOST, ANDROID_APP_PACKAGE } from '@/lib/android-app';

/** Identificativo del bundle: lo stesso del pacchetto Android. */
export const IOS_APP_BUNDLE_ID = ANDROID_APP_PACKAGE;
/**
 * Versione dell'IPA distribuito (CFBundleShortVersionString) in public/solco.ipa. Segue l'IPA, non
 * l'APK: si aggiorna quando si pubblica un nuovo IPA (workflow «Flutter (iOS)», modalità
 * ipa-unsigned). Il test ios-public-ipa la confronta con l'Info.plist dell'IPA.
 */
export const IOS_APP_VERSION = '0.7.5';
export const IOS_APP_TITLE = 'Solco';
export const IOS_APP_HOST = ANDROID_APP_HOST;

/** Stato e link di installazione per l'utente autenticato (pagina /app). */
export const IOS_INSTALL_ENDPOINT = '/api/ios/install';
/** Manifest plist per itms-services (token nel parametro `t`). */
export const IOS_MANIFEST_PATH = '/api/ios/manifest';
/** Il file IPA (token nel parametro `t`). */
export const IOS_IPA_PATH = '/api/ios/ipa';
/** Pagina e API admin per caricare, attivare e rimuovere l'IPA. */
export const IOS_ADMIN_PAGE = '/admin/app-ios';
export const IOS_ADMIN_ENDPOINT = '/api/admin/ios-app';
export const IOS_ADMIN_BLOB_ENDPOINT = '/api/admin/ios-app/blob';

/** Validità del token di installazione: copre il tempo tra il tocco su «Installa» e il download. */
export const IOS_INSTALL_TOKEN_TTL_MS = 15 * 60_000;

/** Prefisso dei file dell'app iOS nello store Vercel Blob (privato: si leggono solo dal server). */
export const IOS_IPA_BLOB_PREFIX = 'ios-app/';
/** Il piccolo JSON con l'IPA attivo (versione, percorso, metodo di firma). */
export const IOS_IPA_META_PATHNAME = 'ios-app/current.json';
/** Dimensione massima dell'IPA caricato dall'amministratore. */
export const IOS_IPA_MAX_BYTES = 200 * 1024 * 1024;
/** Tipi MIME che il browser può dichiarare per un .ipa (è uno zip). */
export const IOS_IPA_MIME_TYPES = [
  'application/octet-stream',
  'application/x-itunes-ipa',
  'application/zip',
  'application/x-zip-compressed',
] as const;

/** Come è firmato l'IPA, letto dal profilo di provisioning incorporato. */
export type IosIpaMethod = 'ad-hoc' | 'development' | 'enterprise' | 'app-store' | 'unknown';
export const IOS_IPA_METHODS = [
  'ad-hoc',
  'development',
  'enterprise',
  'app-store',
  'unknown',
] as const satisfies readonly IosIpaMethod[];

/** I metodi che iOS accetta per l'installazione da un link itms-services. */
export const IOS_IPA_INSTALLABLE_METHODS: readonly IosIpaMethod[] = [
  'ad-hoc',
  'development',
  'enterprise',
];

/** Percorso nello store per un nuovo IPA (Vercel Blob aggiunge un suffisso casuale al nome). */
export function iosIpaPathname(version: string): string {
  const safe = version.replace(/[^0-9A-Za-z.-]/g, '');
  return `${IOS_IPA_BLOB_PREFIX}Solco-${safe || 'app'}.ipa`;
}

/** Vero per i percorsi che il token di caricamento può autorizzare. */
export function isIosIpaPathname(pathname: string): boolean {
  return (
    pathname.startsWith(IOS_IPA_BLOB_PREFIX) &&
    /^[A-Za-z0-9._/-]+\.ipa$/.test(pathname) &&
    !pathname.includes('..') &&
    !pathname.includes('//')
  );
}

/**
 * Il contenuto di /.well-known/apple-app-site-association per un team Apple: l'app condivide le
 * credenziali salvate con il sito (webcredentials); i link universali (applinks) restano senza regole
 * finché l'app non gestirà i percorsi del sito.
 */
export function appleAppSiteAssociation(teamId: string, bundleId: string = IOS_APP_BUNDLE_ID) {
  const appId = `${teamId}.${bundleId}`;
  return {
    applinks: { details: [] as { appIDs: string[]; components: unknown[] }[] },
    webcredentials: { apps: [appId] },
  };
}

/** Il link che Safari su iPhone apre con «Vuoi installare Solco?». */
export function itmsServicesUrl(manifestUrl: string): string {
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
}

/**
 * L'IPA pubblico del sito (public/solco.ipa): l'ultimo build non firmato del workflow «iOS (IPA)».
 * Non si installa da solo (iOS esegue solo app firmate): lo firmano AltStore o SideStore con l'Apple
 * ID di chi installa, oppure Xcode. Si aggiorna copiando l'artefatto `Solco-unsigned.ipa` qui.
 */
export const IOS_IPA_PUBLIC_PATH = '/solco.ipa';

/** Nome del file scaricato dal pulsante «Scarica l'IPA». */
export const IOS_IPA_DOWNLOAD_NAME = `Solco-${IOS_APP_VERSION}.ipa`;

/** Apre AltStore sull'iPhone con l'IPA da firmare e installare (schema altstore://install). */
export function altStoreInstallUrl(ipaUrl: string): string {
  return `altstore://install?url=${encodeURIComponent(ipaUrl)}`;
}

/** Lo stesso per SideStore (schema sidestore://install). */
export function sideStoreInstallUrl(ipaUrl: string): string {
  return `sidestore://install?url=${encodeURIComponent(ipaUrl)}`;
}
