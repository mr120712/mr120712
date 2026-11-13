// @polsia:user-owned — logica server dei "brani in evidenza" della Home. Elenca i file audio che
// l'amministratore ha caricato DIRETTAMENTE nello store Vercel Blob (dal pannello Vercel) e li
// espone come brani riproducibili in Home. Sono distinti dagli upload degli utenti (/pubblica):
// si escludono gli oggetti sotto il prefisso `public-uploads/`.
import 'server-only';
import { list } from '@vercel/blob';
import {
  HOME_TRACK_STREAM_PREFIX,
  type HomeTrack,
  HomeTrackSchema,
} from '@/lib/contracts/home-tracks';
import { env } from '@/lib/env';

/** Prefisso usato dagli upload degli utenti: va ESCLUSO dai brani in evidenza della Home. */
const USER_UPLOAD_PREFIX = 'public-uploads/';
/** Estensioni audio riconosciute (list() non riporta il content-type: si va per estensione). */
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'm4b',
  'aac',
  'ogg',
  'oga',
  'opus',
  'wav',
  'flac',
  'webm',
  'weba',
]);
/** Massimo numero di brani in evidenza mostrati in Home. */
const MAX_HOME_TRACKS = 24;

/** La sezione è attiva solo se Vercel Blob è configurato (token presente). */
export function isHomeTracksConfigured(): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN);
}

function fileExtension(pathname: string): string {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True per un oggetto audio da mostrare in Home (non un upload utente). */
export function isHomeAudioBlob(pathname: string): boolean {
  return !pathname.startsWith(USER_UPLOAD_PREFIX) && AUDIO_EXTENSIONS.has(fileExtension(pathname));
}

/** Percorso same-origin del proxy che serve un brano in evidenza (per i file PRIVATI su Blob). */
export function homeTrackStreamPath(pathname: string): string {
  return `${HOME_TRACK_STREAM_PREFIX}?p=${encodeURIComponent(pathname)}`;
}

/** Un oggetto su un host *.public.blob… è pubblico: riproducibile direttamente dal CDN. */
function isPublicBlobUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.public.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

/** Titolo leggibile dal nome del file: toglie cartella ed estensione, separatori → spazi. */
function titleFromPathname(pathname: string): string {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  let name = base.replace(/\.[^.]+$/, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // pathname non codificato: lascia com'è.
  }
  name = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!name) return 'Brano';
  // Se è tutto minuscolo (uno slug), rendi maiuscola l'iniziale; altrimenti rispetta il nome scelto.
  return name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/**
 * Elenca i brani in evidenza: tutti i file audio nello store Blob che NON sono upload degli utenti,
 * dal più recente. Non fa mai throw: qualsiasi problema (storage assente, API lenta) → lista vuota,
 * così la Home non si rompe mai.
 */
export async function listHomeTracks(): Promise<HomeTrack[]> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return [];

  const abortSignal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(8000)
      : undefined;

  // list() torna UNA pagina per volta (max 1000, ordinata per pathname). Gli upload degli utenti
  // vivono nello stesso store: senza paginare, oltre i 1000 oggetti un brano in evidenza potrebbe
  // sparire e l'ordine "più recenti prima" sarebbe sbagliato. Si pagina con il cursore raccogliendo
  // SOLO i blob audio in evidenza (array piccolo anche con molti upload); un tetto di pagine + il
  // timeout evitano scansioni illimitate. Se qualcosa si raccoglie prima di un errore, si mostra.
  const MAX_PAGES = 20;
  const homeBlobs: Awaited<ReturnType<typeof list>>['blobs'] = [];
  try {
    let cursor: string | undefined;
    let page = 0;
    do {
      const result = await list({ token, limit: 1000, cursor, abortSignal });
      for (const blob of result.blobs) {
        if (isHomeAudioBlob(blob.pathname)) homeBlobs.push(blob);
      }
      cursor = result.hasMore ? result.cursor : undefined;
      page += 1;
    } while (cursor && page < MAX_PAGES);
  } catch {
    if (homeBlobs.length === 0) return [];
  }

  return homeBlobs
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
    .slice(0, MAX_HOME_TRACKS)
    .map((blob) =>
      // Valida contro il contratto: un oggetto malformato (es. URL inatteso) viene scartato, non
      // rompe l'intera sezione. File pubblico → stream diretto dal CDN; file privato → proxy
      // same-origin che lo legge lato server (il browser non può leggere un blob privato).
      HomeTrackSchema.safeParse({
        id: blob.pathname,
        title: titleFromPathname(blob.pathname),
        artist: null,
        streamUrl: isPublicBlobUrl(blob.url) ? blob.url : homeTrackStreamPath(blob.pathname),
        durationSeconds: 0,
      }),
    )
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
}
