// @polsia:user-owned — logica server dei "brani in evidenza" della Home. Elenca i file audio che
// l'amministratore ha caricato DIRETTAMENTE nello store Vercel Blob (dal pannello Vercel) e li
// espone come brani riproducibili in Home. Sono distinti dagli upload degli utenti (/pubblica):
// si escludono gli oggetti sotto il prefisso `public-uploads/`.
//
// Organizzazione, tutta dal pannello Blob (nessuna pagina in più da gestire):
// - SEZIONI: ogni cartella è una sezione della Home col nome della cartella (es. "Novità/…",
//   "Rock italiano/…"); i file nella radice stanno in "In evidenza".
// - ARTISTA E TITOLO: dal nome del file "Artista - Titolo.mp3" (altrimenti solo il titolo).
// - COPERTINA: un'immagine con lo stesso nome del brano ("Artista - Titolo.jpg"), oppure la
//   copertina della cartella ("cover.jpg", "copertina.png", "folder.jpg"…), oppure quella già
//   incorporata nel file MP3/FLAC (letta dal server, vedi /api/music/home-tracks/cover).
import 'server-only';
import { list } from '@vercel/blob';
import {
  HOME_TRACK_COVER_PREFIX,
  HOME_TRACK_STREAM_PREFIX,
  HOME_TRACKS_DEFAULT_SECTION,
  type HomeTrack,
  HomeTrackSchema,
  type HomeTrackSection,
  HomeTrackSectionSchema,
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
/** Immagini usabili come copertina (niente SVG: potrebbe contenere script). */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};
/** Formati audio da cui il server sa leggere la copertina incorporata. */
const EMBEDDED_ARTWORK_EXTENSIONS = new Set(['mp3', 'flac']);
/** Nomi della copertina di una cartella (senza estensione, maiuscole indifferenti). */
const FOLDER_COVER_NAMES = ['cover', 'copertina', 'folder', 'front', 'artwork', 'album'];
/** Massimo numero di brani nella lista piatta `items` (compatibilità). */
const MAX_HOME_TRACKS = 24;
/** Massimo numero di brani per sezione e di sezioni mostrate in Home. */
const MAX_TRACKS_PER_SECTION = 24;
const MAX_SECTIONS = 12;
/** Tempo massimo per elencare lo store (tutte le pagine): oltre, si mostra quanto raccolto. */
const LIST_DEADLINE_MS = 8000;

/** La sezione è attiva solo se Vercel Blob è configurato (token presente). */
export function isHomeTracksConfigured(): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN);
}

function fileExtension(pathname: string): string {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Un pathname che i proxy possono passare allo storage senza sorprese: niente "." / ".." come
 * cartelle (risalirebbero, es. "x/../public-uploads/…"), niente barre rovesciate, cartelle vuote,
 * caratteri di controllo. "?" e "#" sono ammessi solo perché i proxy codificano ogni cartella
 * (vedi encodeBlobPathname): non diventano mai query o frammento dell'URL dello storage.
 */
export function isSafeBlobPathname(pathname: string): boolean {
  if (!pathname || pathname.length > 1024 || pathname.startsWith('/')) return false;
  if (pathname.includes('\\')) return false;
  for (let index = 0; index < pathname.length; index += 1) {
    const code = pathname.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return pathname
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Il pathname con ogni cartella codificata, da usare nell'URL dello storage (get()). */
export function encodeBlobPathname(pathname: string): string {
  return pathname.split('/').map(encodeURIComponent).join('/');
}

/** True per un oggetto audio da mostrare in Home (non un upload utente). */
export function isHomeAudioBlob(pathname: string): boolean {
  return (
    isSafeBlobPathname(pathname) &&
    !pathname.startsWith(USER_UPLOAD_PREFIX) &&
    AUDIO_EXTENSIONS.has(fileExtension(pathname))
  );
}

/** True per un'immagine dello store usabile come copertina dei brani in evidenza. */
export function isHomeImageBlob(pathname: string): boolean {
  return (
    isSafeBlobPathname(pathname) &&
    !pathname.startsWith(USER_UPLOAD_PREFIX) &&
    Object.hasOwn(IMAGE_CONTENT_TYPES, fileExtension(pathname))
  );
}

/** Content-Type di una copertina dall'estensione (mai quello dichiarato dallo storage). */
export function homeImageContentType(pathname: string): string | null {
  const extension = fileExtension(pathname);
  return Object.hasOwn(IMAGE_CONTENT_TYPES, extension)
    ? (IMAGE_CONTENT_TYPES[extension] ?? null)
    : null;
}

/** True per un brano in evidenza di cui il server sa leggere la copertina incorporata. */
export function supportsEmbeddedArtwork(pathname: string): boolean {
  return isHomeAudioBlob(pathname) && EMBEDDED_ARTWORK_EXTENSIONS.has(fileExtension(pathname));
}

/** Percorso same-origin della copertina (immagine privata o copertina incorporata nel brano). */
export function homeTrackCoverPath(pathname: string, isPublic = false): string {
  return `${HOME_TRACK_COVER_PREFIX}?p=${encodeURIComponent(pathname)}${isPublic ? '&pub=1' : ''}`;
}

/** Cartella di un oggetto ('' per la radice). */
function directoryOf(pathname: string): string {
  const slash = pathname.lastIndexOf('/');
  return slash > 0 ? pathname.slice(0, slash) : '';
}

/** Percorso senza estensione: chiave per abbinare brano e immagine con lo stesso nome. */
function stemKey(pathname: string): string {
  const slash = pathname.lastIndexOf('/');
  const dot = pathname.lastIndexOf('.');
  return (dot > slash + 1 ? pathname.slice(0, dot) : pathname).toLowerCase();
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

/** Tronca a `max` unità UTF-16 (il limite del contratto) senza spezzare un carattere. */
function truncateUnits(value: string, max: number): string {
  let out = '';
  for (const char of value) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

/**
 * Nome leggibile: "_" → spazi; i trattini diventano spazi solo in uno slug tutto minuscolo
 * ("ciao-mondo" → "Ciao mondo"), mai in nomi scritti a mano ("AC-DC", "Jay-Z"). Uno slug prende
 * l'iniziale maiuscola.
 */
function readableName(raw: string): string {
  let name = raw.replace(/_+/g, ' ');
  const slug = name === name.toLowerCase();
  if (slug) name = name.replace(/-+/g, ' ');
  name = truncateUnits(name.replace(/\s+/g, ' ').trim(), 200).trim();
  if (!name) return '';
  return slug ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Non codificato: com'è.
    return value;
  }
}

/**
 * Titolo e artista dal nome del file: "Artista - Titolo.mp3" (anche "Artista_-_Titolo.mp3") dà
 * entrambi; altrimenti solo il titolo. Toglie cartella ed estensione.
 */
export function trackNameFromPathname(pathname: string): { title: string; artist: string | null } {
  const name = decoded(pathname.slice(pathname.lastIndexOf('/') + 1)).replace(/\.[^.]+$/, '');
  // Numero di traccia davanti ("01 - Intro", "3. Titolo"): non è l'artista.
  const base = name.replace(/^\d{1,3}\s*[-._)]\s*(?=\S)/, '') || name;
  const parts = base.split(/\s+[-–—]\s+|_+-_+/);
  if (parts.length >= 2) {
    const artist = readableName(parts[0] ?? '');
    const title = readableName(parts.slice(1).join(' - '));
    if (artist && title) return { title, artist };
  }
  return { title: readableName(base) || 'Brano', artist: null };
}

/**
 * Titolo della sezione di una cartella: il nome dell'ultima cartella, leggibile. Con `full` tutto
 * il percorso ("Pop › Anni 80"), per distinguere cartelle con lo stesso nome.
 */
export function sectionTitleFromDirectory(directory: string, full = false): string {
  if (!directory) return HOME_TRACKS_DEFAULT_SECTION;
  const segments = full ? directory.split('/') : [directory.slice(directory.lastIndexOf('/') + 1)];
  const title = segments
    .map((segment) => readableName(decoded(segment)))
    .filter(Boolean)
    .join(' › ');
  return truncateUnits(title, 200).trim() || HOME_TRACKS_DEFAULT_SECTION;
}

type ListedBlob = Awaited<ReturnType<typeof list>>['blobs'][number];

/** Raccoglie brani e immagini dello store (paginando), esclusi gli upload degli utenti. */
async function collectHomeBlobs(
  token: string,
): Promise<{ audio: ListedBlob[]; images: ListedBlob[] }> {
  // list() torna UNA pagina per volta (max 1000, ordinata per pathname). Gli upload degli utenti
  // vivono nello stesso store: senza paginare, oltre i 1000 oggetti un brano in evidenza potrebbe
  // sparire e l'ordine "più recenti prima" sarebbe sbagliato. Si pagina con il cursore raccogliendo
  // SOLO brani e immagini in evidenza (array piccoli anche con molti upload); un tetto di pagine e
  // una scadenza complessiva evitano scansioni illimitate. Se qualcosa si raccoglie prima di un
  // errore o della scadenza, si mostra.
  // La scadenza vale per tutto l'elenco: l'SDK ritenta da solo le richieste fallite (anche per
  // minuti con lo storage irraggiungibile), quindi non basta il timeout della singola richiesta.
  const MAX_PAGES = 20;
  const deadline = Date.now() + LIST_DEADLINE_MS;
  const audio: ListedBlob[] = [];
  const images: ListedBlob[] = [];
  try {
    let cursor: string | undefined;
    let page = 0;
    do {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        list({ token, limit: 1000, cursor, abortSignal: abortAfter(remaining) }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!result) break;
      for (const blob of result.blobs) {
        if (isHomeAudioBlob(blob.pathname)) audio.push(blob);
        else if (isHomeImageBlob(blob.pathname)) images.push(blob);
      }
      cursor = result.hasMore ? result.cursor : undefined;
      page += 1;
    } while (cursor && page < MAX_PAGES);
  } catch {
    // Degrada: si usa quanto raccolto finora (anche niente).
  }
  return { audio, images };
}

function abortAfter(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

function newestFirst(a: ListedBlob, b: ListedBlob): number {
  return b.uploadedAt.getTime() - a.uploadedAt.getTime();
}

/** Copertina di ogni brano: stesso nome, poi copertina della cartella, poi quella incorporata. */
function artworkResolver(images: ListedBlob[]) {
  const byStem = new Map<string, ListedBlob>();
  const byFolder = new Map<string, { rank: number; blob: ListedBlob }>();
  // Dal più recente: a parità di nome vince l'immagine caricata per ultima.
  for (const image of [...images].sort(newestFirst)) {
    const stem = stemKey(image.pathname);
    if (!byStem.has(stem)) byStem.set(stem, image);
    const name = stem.slice(stem.lastIndexOf('/') + 1);
    const rank = FOLDER_COVER_NAMES.indexOf(name);
    if (rank < 0) continue;
    const folder = directoryOf(image.pathname).toLowerCase();
    const current = byFolder.get(folder);
    if (!current || rank < current.rank) byFolder.set(folder, { rank, blob: image });
  }
  return (audio: ListedBlob): string | null => {
    const image =
      byStem.get(stemKey(audio.pathname)) ??
      byFolder.get(directoryOf(audio.pathname).toLowerCase())?.blob;
    // Sempre dal proxy, anche per le immagini pubbliche: lì la copertina viene ridotta (512 px)
    // e messa in cache, invece di scaricare l'originale (anche di molti MB) per una miniatura.
    if (image) return homeTrackCoverPath(image.pathname, isPublicBlobUrl(image.url));
    return supportsEmbeddedArtwork(audio.pathname)
      ? homeTrackCoverPath(audio.pathname, isPublicBlobUrl(audio.url))
      : null;
  };
}

function toHomeTrack(blob: ListedBlob, artworkUrl: string | null): HomeTrack | null {
  const { title, artist } = trackNameFromPathname(blob.pathname);
  // Valida contro il contratto: un oggetto malformato (es. URL inatteso) viene scartato, non
  // rompe l'intera sezione. File pubblico → stream diretto dal CDN; file privato → proxy
  // same-origin che lo legge lato server (il browser non può leggere un blob privato).
  const parsed = HomeTrackSchema.safeParse({
    id: blob.pathname,
    title,
    artist,
    streamUrl: isPublicBlobUrl(blob.url) ? blob.url : homeTrackStreamPath(blob.pathname),
    durationSeconds: 0,
    artworkUrl,
  });
  return parsed.success ? parsed.data : null;
}

export type HomeTracksListing = { items: HomeTrack[]; sections: HomeTrackSection[] };

/**
 * Brani in evidenza divisi in sezioni (una per cartella, la radice per prima), ciascuna dal brano
 * più recente; le cartelle seguono l'ordine del loro ultimo caricamento. Non fa mai throw:
 * qualsiasi problema (storage assente, API lenta) → elenco vuoto, così la Home non si rompe mai.
 */
export async function listHomeTrackSections(): Promise<HomeTracksListing> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { items: [], sections: [] };

  const { audio, images } = await collectHomeBlobs(token);
  if (audio.length === 0) return { items: [], sections: [] };
  const artworkFor = artworkResolver(images);

  const groups = new Map<string, { directory: string; newest: number; blobs: ListedBlob[] }>();
  for (const blob of [...audio].sort(newestFirst)) {
    const directory = directoryOf(blob.pathname);
    const key = directory.toLowerCase();
    const group = groups.get(key);
    if (group) group.blobs.push(blob);
    else groups.set(key, { directory, newest: blob.uploadedAt.getTime(), blobs: [blob] });
  }

  const ordered = [...groups.entries()]
    .sort(([keyA, a], [keyB, b]) => {
      // La radice ("In evidenza") sempre prima; poi le cartelle aggiornate più di recente.
      if (keyA === '') return -1;
      if (keyB === '') return 1;
      return b.newest - a.newest;
    })
    .slice(0, MAX_SECTIONS);

  // Due cartelle con lo stesso nome (es. "Pop/Novità" e "Rock/Novità"), o una chiamata come la
  // sezione principale: si mostra il percorso completo, così i titoli non si ripetono.
  const shortTitles = ordered.map(([, group]) => sectionTitleFromDirectory(group.directory));
  const sections: HomeTrackSection[] = [];
  for (const [index, [, group]] of ordered.entries()) {
    const items = group.blobs
      .slice(0, MAX_TRACKS_PER_SECTION)
      .map((blob) => toHomeTrack(blob, artworkFor(blob)))
      .filter((item): item is HomeTrack => item !== null);
    if (items.length === 0) continue;
    const short = shortTitles[index] ?? HOME_TRACKS_DEFAULT_SECTION;
    const clashes =
      group.directory !== '' &&
      (short === HOME_TRACKS_DEFAULT_SECTION ||
        shortTitles.filter((title) => title === short).length > 1);
    const parsed = HomeTrackSectionSchema.safeParse({
      id: group.directory,
      title: clashes ? sectionTitleFromDirectory(group.directory, true) : short,
      items,
    });
    if (parsed.success) sections.push(parsed.data);
  }

  const shown = new Map(
    sections.flatMap((section) => section.items.map((item) => [item.id, item])),
  );
  const items = [...audio]
    .sort(newestFirst)
    .flatMap((blob) => {
      const item = shown.get(blob.pathname);
      return item ? [item] : [];
    })
    .slice(0, MAX_HOME_TRACKS);
  return { items, sections };
}

/** Solo l'elenco piatto dei brani in evidenza, dal più recente (vedi listHomeTrackSections). */
export async function listHomeTracks(): Promise<HomeTrack[]> {
  return (await listHomeTrackSections()).items;
}
