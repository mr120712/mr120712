// @polsia:user-owned — copia offline dei "brani in evidenza" DICHIARATI in diritti.json (lato
// server): attribuzione della copia (titolare, licenza e link alla licenza per le Creative
// Commons) e lettura dei byte audio dallo store con il token del server.
//
// - L'audio si legge SOLO per il pathname che l'indice dei brani dichiarati ha risolto dall'id
//   opaco (resolveFeaturedOfflineDownload in featured-search.server): mai un percorso o un URL dal
//   client, mai un URL pubblico rivelato (il browser riceve solo i byte).
// - Tetto MAX_DOWNLOAD_BYTES (50 MiB) come Audius e podcast: oltre (dall'elenco, dall'header o
//   leggendo) → too_large. Il corpo si legge INTERO prima di rispondere: la rotta conta il download
//   (rimborsando la prenotazione in caso contrario) solo a byte confermati.
// - Il tipo deve poter essere audio (audio/*, oppure un tipo generico per un file con estensione
//   audio, unico caso ammesso perché isHomeAudioBlob ha già controllato l'estensione).
import 'server-only';
import { get } from '@vercel/blob';
import type { OfflineAttribution } from '@/lib/contracts/offline';
import type { RightsEntry } from '@/lib/music/featured-rights.server';
import { encodeBlobPathname, isHomeAudioBlob } from '@/lib/music/home-tracks.server';
import {
  type BoundedAudio,
  MAX_DOWNLOAD_BYTES,
  readBoundedBody,
} from '@/lib/music/offline-download.server';

/** Tempo massimo per leggere il file dallo store (50 MiB su una rete lenta). */
const READ_TIMEOUT_MS = 30_000;

/** Fonte leggibile delle copie dei brani in evidenza (in «La tua musica» e nel player). */
export const FEATURED_OFFLINE_SOURCE_NAME = 'Solco · In evidenza';

/** Nome e testo (deed in italiano, versione 4.0) delle licenze Creative Commons ammesse. */
const CC_LICENCES: Record<
  'cc0' | 'cc-by' | 'cc-by-sa' | 'cc-by-nd',
  { name: string; deed: string; path: RegExp }
> = {
  cc0: {
    name: 'CC0 1.0 Universale (pubblico dominio)',
    deed: 'https://creativecommons.org/publicdomain/zero/1.0/deed.it',
    path: /^\/publicdomain\/zero\/\d\.\d\/?(?:deed\.[a-z-]+)?$/i,
  },
  'cc-by': {
    name: 'Creative Commons Attribuzione (CC BY)',
    deed: 'https://creativecommons.org/licenses/by/4.0/deed.it',
    path: /^\/licenses\/by\/\d\.\d(?:\/[a-z-]+)?\/?(?:deed\.[a-z-]+)?$/i,
  },
  'cc-by-sa': {
    name: 'Creative Commons Attribuzione - Condividi allo stesso modo (CC BY-SA)',
    deed: 'https://creativecommons.org/licenses/by-sa/4.0/deed.it',
    path: /^\/licenses\/by-sa\/\d\.\d(?:\/[a-z-]+)?\/?(?:deed\.[a-z-]+)?$/i,
  },
  'cc-by-nd': {
    name: 'Creative Commons Attribuzione - Non opere derivate (CC BY-ND)',
    deed: 'https://creativecommons.org/licenses/by-nd/4.0/deed.it',
    path: /^\/licenses\/by-nd\/\d\.\d(?:\/[a-z-]+)?\/?(?:deed\.[a-z-]+)?$/i,
  },
};

/**
 * Il link alla licenza: "prova" se è un indirizzo https di creativecommons.org della STESSA
 * licenza (es. https://creativecommons.org/licenses/by/3.0/, la versione dichiarata
 * dall'amministratore), altrimenti il testo della versione 4.0.
 */
function ccLicenceUrl(licenza: keyof typeof CC_LICENCES, prova: string | undefined): string {
  const licence = CC_LICENCES[licenza];
  if (prova) {
    try {
      const url = new URL(prova.trim());
      if (
        url.protocol === 'https:' &&
        (url.hostname === 'creativecommons.org' || url.hostname === 'www.creativecommons.org') &&
        !url.username &&
        !url.password &&
        url.toString().length <= 2048 &&
        licence.path.test(url.pathname)
      ) {
        return `https://creativecommons.org${url.pathname}`;
      }
    } catch {
      // Non è un indirizzo: si usa il testo della licenza 4.0.
    }
  }
  return licence.deed;
}

/**
 * L'attribuzione salvata con la copia (mostrata in «La tua musica»): titolare; per le Creative
 * Commons anche il nome della licenza e il link al suo testo. Nessun percorso dello store e nessun
 * link all'audio. Il titolare è già validato dal parser (1-120 caratteri).
 */
export function featuredOfflineAttribution(
  entry: Pick<RightsEntry, 'licenza' | 'titolare' | 'prova'>,
): OfflineAttribution {
  const holder = entry.titolare.trim();
  if (entry.licenza === 'propria' || entry.licenza === 'licenza') {
    return {
      sourceName: FEATURED_OFFLINE_SOURCE_NAME,
      sourceUrl: null,
      licenseName: null,
      licenseUrl: null,
      creditLine: `© ${holder}`,
    };
  }
  const licence = CC_LICENCES[entry.licenza];
  return {
    sourceName: FEATURED_OFFLINE_SOURCE_NAME,
    sourceUrl: null,
    licenseName: licence.name,
    licenseUrl: ccLicenceUrl(entry.licenza, entry.prova),
    creditLine: entry.licenza === 'cc0' ? `Opera di ${holder}` : `© ${holder}`,
  };
}

const EXTENSION_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  webm: 'audio/webm',
  weba: 'audio/webm',
};

/** Tipi generici ammessi SOLO per un file con estensione audio (lo store non sempre lo sa). */
const GENERIC_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/ogg',
  'video/webm',
  'video/mp4',
  'video/ogg',
]);

function extensionOf(pathname: string): string {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function baseType(contentType: string | null | undefined): string {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** Il tipo audio da dichiarare al client: audio/* concreto, altrimenti dall'estensione. */
export function featuredDownloadMime(contentType: string | null, pathname: string): string {
  const base = baseType(contentType);
  if (base.startsWith('audio/') && base !== 'audio/octet-stream') return base;
  return EXTENSION_MIME[extensionOf(pathname)] ?? 'audio/mpeg';
}

/** True se il tipo dichiarato dallo store può essere l'audio di un file con estensione audio. */
export function isFeaturedAudioType(contentType: string | null, pathname: string): boolean {
  if (!isHomeAudioBlob(pathname)) return false;
  const base = baseType(contentType);
  return base.startsWith('audio/') || GENERIC_TYPES.has(base);
}

function abortAfter(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * Legge l'INTERO file audio dallo store con il token (pubblico o privato come nell'elenco), entro
 * `maxBytes`. too_large se l'elenco, l'header o la lettura superano il tetto; not_audio se il tipo
 * non può essere audio; unavailable per file assente, rete o tempo scaduto. Mai throw.
 */
export async function readFeaturedAudio(
  token: string,
  audio: { pathname: string; public: boolean; size: number | null },
  maxBytes = MAX_DOWNLOAD_BYTES,
): Promise<BoundedAudio> {
  if (!isHomeAudioBlob(audio.pathname)) return { ok: false, reason: 'unavailable' };
  if (audio.size !== null && audio.size > maxBytes) return { ok: false, reason: 'too_large' };
  let result: Awaited<ReturnType<typeof get>>;
  try {
    result = await get(encodeBlobPathname(audio.pathname), {
      access: audio.public ? 'public' : 'private',
      token,
      useCache: false,
      abortSignal: abortAfter(READ_TIMEOUT_MS),
    });
  } catch {
    // File assente (404 dello storage), rete o tempo scaduto: nessun byte, nessun conteggio.
    return { ok: false, reason: 'unavailable' };
  }
  // Assente, 304 (nessun corpo) o senza stream: niente da salvare.
  if (!result || result.statusCode !== 200 || !result.stream) {
    return { ok: false, reason: 'unavailable' };
  }
  const contentType = result.blob.contentType || result.headers.get('content-type');
  if (!isFeaturedAudioType(contentType, audio.pathname)) {
    await result.stream.cancel().catch(() => undefined);
    return { ok: false, reason: 'not_audio' };
  }
  const declared = Number(result.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await result.stream.cancel().catch(() => undefined);
    return { ok: false, reason: 'too_large' };
  }
  const body = await readBoundedBody(new Response(result.stream), maxBytes);
  if (body === 'too_large') return { ok: false, reason: 'too_large' };
  if (body === 'error') return { ok: false, reason: 'unavailable' };
  return { ok: true, bytes: body, contentType };
}
