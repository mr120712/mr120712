// @polsia:user-owned — licenze e indirizzi dei brani di audio.com (funzioni PURE, usate sia dal
// server sia dal client: nessuna rete, nessun server-only).
//
// Perché un brano suona o no nel player di Solco: Solco vende l'abbonamento Pro, quindi l'uso è
// COMMERCIALE. Un brano di audio.com si riproduce NEL PLAYER DI SOLCO solo se la sua licenza
// permette l'uso commerciale chiedendo al massimo l'attribuzione: CC0 1.0, CC BY 4.0, CC BY-SA 4.0,
// CC BY-ND 4.0 (riprodurlo non è un'opera derivata). Tutto il resto — «tutti i diritti riservati»
// (arr), nessuna licenza scelta (none), qualunque licenza NC (non commerciale) e i valori che non
// conosciamo — NON passa MAI dal player di Solco: si ascolta solo nel player ufficiale di audio.com
// incorporato (iframe https://audio.com/embed/v2/audio/{id}) o sul sito stesso. Per le licenze CC
// con attribuzione Solco mostra sempre autore, nome della licenza con il link al testo (deed) e il
// link al brano su audio.com (nella riga del risultato e nella riga della fonte del player).
//
// Le COVER (categoria `cover` di audio.com) restano sempre fuori dal player di Solco, qualunque sia
// la licenza: chi carica una cover può licenziare solo la propria registrazione, non la canzone di
// un altro autore, quindi una CC BY non basta per eseguirla in un servizio a pagamento. Si
// ascoltano nel player ufficiale di audio.com, come le licenze non ammesse.
//
// Indirizzi: solo https, senza credenziali né porte, su audio.com o un suo sottodominio. Per il
// SOLO audio (`play.url`) vale anche il CDN di Muse Group, la società di audio.com, da cui l'API
// lo dà davvero: `s3.ustatik.com` (host esatto), con un link S3 firmato che scade (X-Amz-Expires,
// visto: 6 giorni). Un link vicino alla scadenza non si usa: vedi isAudioComStreamFresh. Ogni altro
// valore dall'API viene scartato.

export const AUDIOCOM_LICENSES = [
  'none',
  'arr',
  'cc-0',
  'cc-by',
  'cc-by-sa',
  'cc-by-nc',
  'cc-by-nc-sa',
  'cc-by-nd',
  'cc-by-nc-nd',
] as const;
export type AudioComKnownLicense = (typeof AUDIOCOM_LICENSES)[number];
/** Licenza normalizzata: una delle note, oppure `unknown` (vuota o mai vista: mai riprodotta). */
export type AudioComLicense = AudioComKnownLicense | 'unknown';
export const AUDIOCOM_LICENSE_VALUES = [...AUDIOCOM_LICENSES, 'unknown'] as const;

/** Le SOLE licenze che Solco riproduce nel proprio player (uso commerciale consentito). */
export const AUDIOCOM_PLAYABLE_LICENSES: ReadonlySet<AudioComLicense> = new Set([
  'cc-0',
  'cc-by',
  'cc-by-sa',
  'cc-by-nd',
]);

type LicenseInfo = {
  /** Etichetta corta del distintivo (es. «CC BY»). */
  short: string;
  /** Nome completo (es. «CC BY 4.0»), anche nella riga della fonte del player. */
  name: string;
  /** Testo della licenza in italiano (deed di Creative Commons), null per le non-CC. */
  deedUrl: string | null;
};

const CC = 'https://creativecommons.org';

const LICENSE_INFO: Record<AudioComLicense, LicenseInfo> = {
  'cc-0': { short: 'CC0', name: 'CC0 1.0', deedUrl: `${CC}/publicdomain/zero/1.0/deed.it` },
  'cc-by': { short: 'CC BY', name: 'CC BY 4.0', deedUrl: `${CC}/licenses/by/4.0/deed.it` },
  'cc-by-sa': {
    short: 'CC BY-SA',
    name: 'CC BY-SA 4.0',
    deedUrl: `${CC}/licenses/by-sa/4.0/deed.it`,
  },
  'cc-by-nd': {
    short: 'CC BY-ND',
    name: 'CC BY-ND 4.0',
    deedUrl: `${CC}/licenses/by-nd/4.0/deed.it`,
  },
  'cc-by-nc': {
    short: 'CC BY-NC',
    name: 'CC BY-NC 4.0',
    deedUrl: `${CC}/licenses/by-nc/4.0/deed.it`,
  },
  'cc-by-nc-sa': {
    short: 'CC BY-NC-SA',
    name: 'CC BY-NC-SA 4.0',
    deedUrl: `${CC}/licenses/by-nc-sa/4.0/deed.it`,
  },
  'cc-by-nc-nd': {
    short: 'CC BY-NC-ND',
    name: 'CC BY-NC-ND 4.0',
    deedUrl: `${CC}/licenses/by-nc-nd/4.0/deed.it`,
  },
  arr: { short: 'Tutti i diritti riservati', name: 'Tutti i diritti riservati', deedUrl: null },
  none: { short: 'Nessuna licenza', name: 'Nessuna licenza indicata', deedUrl: null },
  unknown: { short: 'Licenza sconosciuta', name: 'Licenza sconosciuta', deedUrl: null },
};

const KNOWN = new Set<string>(AUDIOCOM_LICENSES);

/** Il valore `license` dell'API (qualsiasi) → licenza nota o `unknown`. */
export function normalizeAudioComLicense(raw: unknown): AudioComLicense {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase();
  return KNOWN.has(value) ? (value as AudioComKnownLicense) : 'unknown';
}

/** True SOLO per CC0 / CC BY / CC BY-SA / CC BY-ND. */
export function isAudioComPlayableLicense(license: string): boolean {
  return AUDIOCOM_PLAYABLE_LICENSES.has(license as AudioComLicense);
}

export function audioComLicenseShortLabel(license: AudioComLicense): string {
  return LICENSE_INFO[license].short;
}

export function audioComLicenseName(license: AudioComLicense): string {
  return LICENSE_INFO[license].name;
}

export function audioComLicenseDeedUrl(license: AudioComLicense): string | null {
  return LICENSE_INFO[license].deedUrl;
}

export const AUDIOCOM_ORIGIN = 'https://audio.com';

/** audio.com o un suo sottodominio (mai "evilaudio.com" né "audio.com.evil.it"). */
export function isAudioComHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'audio.com' || host.endsWith('.audio.com');
}

function parseHttps(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url;
}

/** URL https di audio.com (audio, copertina, pagina), oppure null. */
export function audioComHttpsUrl(raw: unknown): string | null {
  const url = parseHttps(raw);
  return url && isAudioComHost(url.hostname) ? url.toString() : null;
}

/**
 * Host del CDN di Muse Group (la società di audio.com) da cui l'API dà lo stream (`play.url`):
 * ammessi SOLO per l'audio, mai per copertine o pagine. Host esatti, niente sottodomini.
 */
export const AUDIOCOM_STREAM_CDN_HOSTS: ReadonlySet<string> = new Set(['s3.ustatik.com']);

/**
 * Stream dell'audio (`play.url`): solo https su audio.com (o un sottodominio) o sul CDN di Muse
 * Group (AUDIOCOM_STREAM_CDN_HOSTS). Il link firmato resta com'è (parametri compresi).
 */
export function audioComStreamUrl(raw: unknown): string | null {
  const url = parseHttps(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  return isAudioComHost(host) || AUDIOCOM_STREAM_CDN_HOSTS.has(host) ? url.toString() : null;
}

/**
 * Margine minimo prima della scadenza perché il SERVER mandi uno stream ai client: copre le cache
 * (ricerca ~10 min, CDN fino a ~15 min, sezioni della Home fino a 1 ora) e un lungo ascolto.
 */
export const AUDIOCOM_STREAM_SERVE_MARGIN_MS = 6 * 60 * 60_000;
/** Margine minimo perché il CLIENT avvii uno stream (pagina rimasta aperta, coda salvata). */
export const AUDIOCOM_STREAM_PLAY_MARGIN_MS = 30 * 60_000;

/**
 * Scadenza (ms dall'epoch) di uno stream con link S3 firmato (X-Amz-Date + X-Amz-Expires), oppure
 * null se il link non è firmato o la scadenza non si legge (allora vale come senza scadenza).
 */
export function audioComStreamExpiresAt(raw: unknown): number | null {
  const url = parseHttps(raw);
  if (!url) return null;
  const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    url.searchParams.get('X-Amz-Date') ?? '',
  );
  const seconds = url.searchParams.get('X-Amz-Expires') ?? '';
  if (!date || !/^\d{1,7}$/.test(seconds)) return null;
  const part = (index: number) => Number(date[index] ?? 0);
  const signedAt = Date.UTC(part(1), part(2) - 1, part(3), part(4), part(5), part(6));
  return Number.isFinite(signedAt) ? signedAt + Number(seconds) * 1000 : null;
}

/** true se lo stream vale ancora per più di `marginMs` (uno stream senza scadenza vale sempre). */
export function isAudioComStreamFresh(
  raw: unknown,
  marginMs: number = AUDIOCOM_STREAM_PLAY_MARGIN_MS,
  now: number = Date.now(),
): boolean {
  const expiresAt = audioComStreamExpiresAt(raw);
  return expiresAt === null || expiresAt - now > marginMs;
}
/**
 * Copertina (`image`, può essere vuota): solo https su audio.com o sottodominio, così il browser
 * dell'ascoltatore non viene mai mandato verso host scelti da altri.
 */
export const audioComImageUrl = audioComHttpsUrl;

/** Nome utente o slug di audio.com: una parte di percorso senza barre né caratteri di controllo. */
function pathPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const part = value.trim();
  if (!part || part.length > 200 || part === '.' || part === '..') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rifiuta proprio i caratteri di controllo.
  if (/[/\\?#%\s\u0000-\u001f\u007f]/.test(part)) return null;
  return part;
}

/** Pagina del brano: https://audio.com/{username}/audio/{slug} (o null se mancano i pezzi). */
export function audioComPageUrl(username: unknown, slug: unknown): string | null {
  const user = pathPart(username);
  const audio = pathPart(slug);
  if (!user || !audio) return null;
  return `${AUDIOCOM_ORIGIN}/${encodeURIComponent(user)}/audio/${encodeURIComponent(audio)}`;
}

/** True per un URL di pagina brano costruito da audioComPageUrl (controllo del contratto). */
export function isAudioComPageUrl(value: string): boolean {
  const url = parseHttps(value);
  if (!url || url.hostname !== 'audio.com' || url.search || url.hash) return false;
  return /^\/[^/]+\/audio\/[^/]+$/.test(url.pathname);
}

/** Id numerico di un audio di audio.com. */
export const AUDIOCOM_ID_PATTERN = /^[0-9]{1,24}$/;

/**
 * Player UFFICIALE di audio.com (lo stesso iframe che restituisce GET /v1/embed/create, senza lo
 * script embed.js: lo script-src rigoroso di Solco lo bloccherebbe e non serve). Tema scuro.
 */
export function audioComEmbedUrl(id: string): string | null {
  if (!AUDIOCOM_ID_PATTERN.test(id)) return null;
  return `${AUDIOCOM_ORIGIN}/embed/v2/audio/${id}?theme=dark`;
}

/** Categoria `cover`: la canzone è di un altro autore, la licenza CC copre solo la registrazione. */
export const AUDIOCOM_COVER_CATEGORY = 'cover';

/**
 * Lo stream può arrivare al player di Solco: licenza ammessa E categoria che non sia una cover
 * (la licenza di chi carica una cover non copre la canzone originale).
 */
export function isAudioComStreamAllowed(track: { license: string; category: string }): boolean {
  return isAudioComPlayableLicense(track.license) && track.category !== AUDIOCOM_COVER_CATEGORY;
}

/**
 * Riproducibile nel player di Solco: licenza ammessa, non una cover E stream https valido (audio.com
 * o il suo CDN) che non stia per scadere (pagina rimasta aperta a lungo: allora il player ufficiale).
 */
export function isAudioComPlayable(
  track: {
    license: string;
    category: string;
    streamUrl: string | null;
  },
  now: number = Date.now(),
): boolean {
  return (
    isAudioComStreamAllowed(track) &&
    audioComStreamUrl(track.streamUrl) !== null &&
    isAudioComStreamFresh(track.streamUrl, AUDIOCOM_STREAM_PLAY_MARGIN_MS, now)
  );
}

/**
 * Prefisso degli id dei brani di audio.com nel player e nel registro degli ascolti Free
 * (`audiocom:<id>`, con <id> come AUDIOCOM_ID_PATTERN). Il prefisso proprio (non `upload:`) serve
 * al player per chiedere il permesso di /api/music/plays: account obbligatorio e conteggio nei 40
 * ascolti Free, come Audius e podcast (vedi play-quota.ts).
 */
export const AUDIOCOM_QUALIFIED_PREFIX = 'audiocom:';

/**
 * Id usato fino a quando audio.com non contava nel limite Free: `upload:audiocom~<id>`, con le
 * regole dei file pubblici (nessun accesso richiesto, nessun conteggio). Può essere ancora salvato
 * nella coda del player (localStorage) di chi ha ascoltato un brano di audio.com prima del cambio.
 */
const LEGACY_AUDIOCOM_PREFIX = 'upload:audiocom~';

/** Id del brano nel player: `audiocom:<id>` (stream diretto come i file pubblici, vedi audiocom-tracks). */
export function audioComQualifiedId(id: string): string {
  return `${AUDIOCOM_QUALIFIED_PREFIX}${id}`;
}

/** L'id numerico di audio.com di un id del player `audiocom:<id>`, oppure null. */
export function audioComIdFromQualifiedId(qualifiedId: string): string | null {
  if (!qualifiedId.startsWith(AUDIOCOM_QUALIFIED_PREFIX)) return null;
  const id = qualifiedId.slice(AUDIOCOM_QUALIFIED_PREFIX.length);
  return AUDIOCOM_ID_PATTERN.test(id) ? id : null;
}

/**
 * Un id storico `upload:audiocom~<id>` diventa `audiocom:<id>`; ogni altro id resta com'è.
 *
 * Scelta più sicura per i brani già salvati: continuano a suonare (stesso stream https di
 * audio.com), ma con le regole di oggi, cioè accesso obbligatorio e conteggio nel limite Free.
 * Lasciarli sulla via `upload:` li avrebbe fatti suonare per sempre senza account e senza
 * contare, aggirando il limite con una coda salvata prima del cambio. Il player lo applica a ogni
 * brano che entra in coda (anche dalla coda ripristinata dopo un ricaricamento) e prima di chiedere
 * il permesso; il server accetta solo la forma nuova (isValidPlayId).
 */
export function currentAudioComQualifiedId(qualifiedId: string): string {
  if (!qualifiedId.startsWith(LEGACY_AUDIOCOM_PREFIX)) return qualifiedId;
  const id = qualifiedId.slice(LEGACY_AUDIOCOM_PREFIX.length);
  return AUDIOCOM_ID_PATTERN.test(id) ? audioComQualifiedId(id) : qualifiedId;
}
