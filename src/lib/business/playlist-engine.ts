// @polsia:user-owned — regole pure di «Crea playlist» (nessuna rete, nessun database): pulizia
// dei suggerimenti dell'AI, varietà dei brani Audius, testo della richiesta a Claude (il testo
// dell'ascoltatore resta un dato, mai un'istruzione), operazioni della bozza (Togli, Su/Giù,
// Sostituisci, Aggiungi altri) e bozza nel sessionStorage. Usate dal server e dalla pagina.
import { cleanTrackField, songIdentity } from '@/lib/business/track-list-import';
import {
  type DraftTrack,
  type EngineOrigin,
  type ExcludedTrack,
  PLAYLIST_ENGINE_ADD_STEP,
  PLAYLIST_ENGINE_EXCLUDE_MAX,
  PLAYLIST_ENGINE_MAX_TRACKS,
  PLAYLIST_ENGINE_NAME_MAX,
  PLAYLIST_ENGINE_RESERVE_MAX,
  type StoredDraft,
  StoredDraftSchema,
} from '@/lib/contracts/playlist-engine';
import { findMood } from '@/lib/music/moods';
import {
  clipToUtf16Length,
  normalizePlaylistDescription,
  PLAYLIST_DESCRIPTION_MAX_LENGTH,
} from '@/lib/music/playlist-share';

/** Un titolo o un artista più lungo di così non è un brano vero (testo incollato, spam). */
export const SONG_FIELD_MAX = 150;
/** Il massimo di brani accettati da una risposta dell'AI, qualunque cosa abbia scritto. */
export const AI_SONGS_MAX = 40;

/** Valori segnaposto che non identificano un brano né un artista. */
const PLACEHOLDERS = new Set([
  'unknown',
  'unknown artist',
  'sconosciuto',
  'artista sconosciuto',
  'brano sconosciuto',
  'n/a',
  'na',
  'null',
  'undefined',
  'tbd',
  'varie',
  'various',
  'various artists',
  'artisti vari',
  'untitled',
  'senza titolo',
]);

/**
 * Un titolo o un artista suggerito, ripulito come nell'importazione di un elenco; null quando è
 * vuoto, troppo lungo, un link, senza lettere né cifre o un segnaposto ("Unknown", "N/A").
 */
export function cleanSongText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > SONG_FIELD_MAX * 2) return null;
  const cleaned = cleanTrackField(value)
    .replace(/^["'“”«»‘’]+|["'“”«»‘’]+$/g, '')
    .trim();
  if (!cleaned || cleaned.length > SONG_FIELD_MAX) return null;
  if (/https?:\/\/|www\.|\.(?:com|it|net|org)\//i.test(cleaned)) return null;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
  if (PLACEHOLDERS.has(cleaned.toLocaleLowerCase('it-IT'))) return null;
  return cleaned;
}

export type SuggestedSong = { title: string; artist: string };

/**
 * Taglia a `max` unità UTF-16, le stesse che contano zod `.max()` e il maxLength dei campi (una
 * emoji ne vale 2), solo fra caratteri interi: mai mezza emoji. Contare i code point farebbe
 * passare qui un nome che poi il contratto rifiuta (risposta 503 dopo una chiamata AI pagata).
 */
export function clipText(value: string, max: number) {
  return value.length <= max ? value : clipToUtf16Length(value, max).trimEnd();
}

/** Il nome proposto per la playlist: una riga, senza virgolette, al massimo 50 unità UTF-16. */
export function cleanPlaylistName(value: unknown, fallback: string): string {
  const cleaned =
    typeof value === 'string'
      ? cleanTrackField(value)
          .replace(/^["'“”«»‘’]+|["'“”«»‘’]+$/g, '')
          .trim()
      : '';
  const name = clipText(cleaned, PLAYLIST_ENGINE_NAME_MAX);
  return /[\p{L}\p{N}]/u.test(name) ? name : clipText(fallback, PLAYLIST_ENGINE_NAME_MAX);
}

/** La descrizione proposta: ripulita come quella scritta a mano, al massimo 300 unità UTF-16. */
export function cleanPlaylistDescription(value: unknown): string | null {
  const cleaned = normalizePlaylistDescription(typeof value === 'string' ? value : null);
  if (!cleaned) return null;
  return clipText(cleaned.replace(/\s+/g, ' '), PLAYLIST_DESCRIPTION_MAX_LENGTH);
}

export type AiPlaylistRaw = {
  name: unknown;
  description: unknown;
  songs: unknown;
};

/**
 * Tiene solo i brani utilizzabili di una risposta dell'AI: campi puliti, niente doppioni
 * (stessa identità dell'importazione: maiuscole, accenti e punteggiatura non contano), niente
 * brani già in bozza (`exclude`, identità songIdentity) e al massimo `max` brani.
 */
export function sanitizeAiPlaylist(
  raw: AiPlaylistRaw,
  options: { max: number; exclude?: ReadonlySet<string>; fallbackName: string },
): { name: string; description: string | null; songs: SuggestedSong[]; dropped: number } {
  const songs: SuggestedSong[] = [];
  const seen = new Set(options.exclude ?? []);
  let dropped = 0;
  const list = Array.isArray(raw.songs) ? raw.songs.slice(0, AI_SONGS_MAX * 2) : [];
  const max = Math.max(0, Math.min(options.max, AI_SONGS_MAX));
  for (const entry of list) {
    const record = typeof entry === 'object' && entry !== null ? entry : {};
    const title = cleanSongText((record as { title?: unknown }).title);
    const artist = cleanSongText((record as { artist?: unknown }).artist);
    if (!title || !artist) {
      dropped += 1;
      continue;
    }
    const identity = songIdentity(title, artist);
    if (seen.has(identity)) {
      dropped += 1;
      continue;
    }
    seen.add(identity);
    if (songs.length >= max) continue;
    songs.push({ title, artist });
  }
  return {
    name: cleanPlaylistName(raw.name, options.fallbackName),
    description: cleanPlaylistDescription(raw.description),
    songs,
    dropped,
  };
}

/** Nome di un artista senza maiuscole, accenti e punteggiatura, per confrontarlo. */
export function normalizeArtistName(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Varietà prima di tutto: al massimo `perArtist` brani per artista nell'ordine dato, poi gli altri
 * nello stesso ordine (come il feed dei mood della Home).
 */
export function pickVaried<T>(items: readonly T[], artistOf: (item: T) => string, perArtist = 2) {
  const counts = new Map<string, number>();
  const varied: T[] = [];
  const overflow: T[] = [];
  for (const item of items) {
    const artist = artistOf(item);
    const current = counts.get(artist) ?? 0;
    if (current < perArtist) {
      counts.set(artist, current + 1);
      varied.push(item);
    } else {
      overflow.push(item);
    }
  }
  return [...varied, ...overflow];
}

/** Alterna due elenchi (uno, l'altro, …), poi il resto del più lungo. */
export function interleave<T>(first: readonly T[], second: readonly T[]): T[] {
  const out: T[] = [];
  const longest = Math.max(first.length, second.length);
  for (let index = 0; index < longest; index += 1) {
    const a = first[index];
    const b = second[index];
    if (a !== undefined) out.push(a);
    if (b !== undefined) out.push(b);
  }
  return out;
}

/** "Artista - Titolo" → artista e titolo; un testo senza trattino è solo l'artista. */
export function parseSeedText(text: string): { artist: string; title: string | null } {
  const value = cleanTrackField(text);
  const match = /^(.+?)\s+[-–—]\s+(.+)$/.exec(value);
  if (match?.[1] && match[2]) return { artist: match[1].trim(), title: match[2].trim() };
  return { artist: value, title: null };
}

/**
 * Il testo dell'ascoltatore dentro i tag della richiesta: le parentesi angolari diventano
 * tipografiche, così nessun testo può chiudere il tag e fingersi un'istruzione.
 */
export function escapeForPrompt(value: string) {
  return cleanTrackField(value).replace(/</g, '‹').replace(/>/g, '›');
}

export type AiEngineInput =
  | { kind: 'describe'; prompt: string }
  | { kind: 'seed'; artist: string; title: string | null }
  | { kind: 'mood'; mood: string | null; genre: string | null };

/** Il messaggio per Claude: richiesta, quantità e brani da non ripetere, tutti come dati. */
export function buildEngineUserMessage(
  input: AiEngineInput,
  count: number,
  exclude: readonly Pick<ExcludedTrack, 'title' | 'artist'>[] = [],
) {
  const lines: string[] = [];
  if (input.kind === 'describe') {
    lines.push('Descrizione dell’ascoltatore:', '<descrizione>', escapeForPrompt(input.prompt));
    lines.push('</descrizione>');
  } else if (input.kind === 'seed') {
    lines.push('Brano o artista di partenza:', '<partenza>');
    lines.push(`Artista: ${escapeForPrompt(input.artist)}`);
    if (input.title) lines.push(`Brano: ${escapeForPrompt(input.title)}`);
    lines.push('</partenza>');
  } else {
    const mood = findMood(input.mood);
    lines.push('Atmosfera scelta:', '<atmosfera>');
    if (mood) lines.push(`${mood.label}: ${mood.description}`);
    if (input.genre) lines.push(`Genere: ${escapeForPrompt(input.genre)}`);
    lines.push('</atmosfera>');
  }
  const avoid = exclude
    .slice(0, PLAYLIST_ENGINE_EXCLUDE_MAX)
    .map((track) => {
      const title = escapeForPrompt(track.title);
      const artist = track.artist ? escapeForPrompt(track.artist) : '';
      return title ? `- ${artist ? `${artist} - ` : ''}${title}` : '';
    })
    .filter(Boolean);
  if (avoid.length > 0) {
    lines.push('Brani già nella playlist (non riproporli):', '<da_evitare>', ...avoid);
    lines.push('</da_evitare>');
  }
  lines.push(`Numero di brani da proporre: ${count}`);
  return lines.join('\n');
}

/** Nome della bozza quando l'AI non ne propone uno. */
export function defaultPlaylistName(origin: EngineOrigin): string {
  if (origin.mode === 'describe') return 'La mia playlist';
  if (origin.mode === 'seed') {
    const base = origin.seed.title ? origin.seed.title : origin.seed.artist;
    return clipText(`Simili a ${cleanTrackField(base)}`, PLAYLIST_ENGINE_NAME_MAX);
  }
  const mood = findMood(origin.mood);
  if (mood && origin.genre)
    return clipText(`${mood.label} · ${origin.genre}`, PLAYLIST_ENGINE_NAME_MAX);
  if (mood) return `Atmosfera ${mood.label}`;
  return clipText(`Playlist ${origin.genre ?? ''}`.trim(), PLAYLIST_ENGINE_NAME_MAX);
}

// ---- Bozza ---------------------------------------------------------------------------------

/** Chiave stabile di un brano della bozza (stessa chiave unica di una raccolta). */
export function draftTrackKey(track: Pick<DraftTrack, 'source' | 'sourceId'>) {
  return `${track.source}:${track.sourceId}`;
}

export type DraftLists = { tracks: DraftTrack[]; reserve: DraftTrack[] };

/** Toglie il brano in posizione `index`. */
export function removeTrack<T>(tracks: readonly T[], index: number): T[] {
  if (index < 0 || index >= tracks.length) return [...tracks];
  return [...tracks.slice(0, index), ...tracks.slice(index + 1)];
}

/** Sposta un brano di `delta` posizioni (Su = -1, Giù = +1), senza uscire dall'elenco. */
export function moveTrack<T>(tracks: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= tracks.length || target < 0 || target >= tracks.length) {
    return [...tracks];
  }
  const copy = [...tracks];
  const [moved] = copy.splice(index, 1);
  if (moved !== undefined) copy.splice(target, 0, moved);
  return copy;
}

/** Il primo brano di scorta che non è già in bozza (le scorte possono contenere doppioni). */
function nextReserve(lists: DraftLists, taken: Set<string>) {
  const index = lists.reserve.findIndex((track) => !taken.has(draftTrackKey(track)));
  return index;
}

/**
 * «Sostituisci»: il brano in posizione `index` lascia il posto al primo brano di scorta non già
 * in bozza. `replaced` è false quando le scorte sono finite (la pagina ne chiede altri).
 */
export function replaceTrack(lists: DraftLists, index: number): DraftLists & { replaced: boolean } {
  if (index < 0 || index >= lists.tracks.length) return { ...lists, replaced: false };
  const taken = new Set(lists.tracks.map(draftTrackKey));
  const pick = nextReserve(lists, taken);
  const replacement = lists.reserve[pick];
  if (pick < 0 || !replacement) return { ...lists, replaced: false };
  const tracks = [...lists.tracks];
  tracks[index] = replacement;
  return { tracks, reserve: removeTrack(lists.reserve, pick), replaced: true };
}

/**
 * «Aggiungi altri simili»: sposta in fondo alla bozza fino a `count` brani di scorta (mai oltre il
 * massimo di una bozza). `added` dice quanti ne sono arrivati davvero.
 */
export function addFromReserve(
  lists: DraftLists,
  count = PLAYLIST_ENGINE_ADD_STEP,
): DraftLists & { added: number } {
  const room = Math.max(0, PLAYLIST_ENGINE_MAX_TRACKS - lists.tracks.length);
  const wanted = Math.min(count, room);
  const taken = new Set(lists.tracks.map(draftTrackKey));
  const added: DraftTrack[] = [];
  const reserve: DraftTrack[] = [];
  for (const track of lists.reserve) {
    const key = draftTrackKey(track);
    if (added.length < wanted && !taken.has(key)) {
      taken.add(key);
      added.push(track);
    } else if (!taken.has(key)) {
      reserve.push(track);
    }
  }
  return { tracks: [...lists.tracks, ...added], reserve, added: added.length };
}

/** Aggiunge alle scorte i brani appena arrivati che non sono già in bozza né nelle scorte. */
export function mergeIntoReserve(lists: DraftLists, incoming: readonly DraftTrack[]): DraftLists {
  const taken = new Set([...lists.tracks, ...lists.reserve].map(draftTrackKey));
  const fresh = incoming.filter((track) => {
    const key = draftTrackKey(track);
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
  return {
    tracks: lists.tracks,
    reserve: [...lists.reserve, ...fresh].slice(0, PLAYLIST_ENGINE_RESERVE_MAX),
  };
}

/** I brani da non riproporre in una nuova richiesta: bozza e scorte, fino al massimo ammesso. */
export function excludedTracks(lists: DraftLists): ExcludedTrack[] {
  return [...lists.tracks, ...lists.reserve].slice(0, PLAYLIST_ENGINE_EXCLUDE_MAX).map((track) => ({
    source: track.source,
    sourceId: track.sourceId,
    title: track.title,
    artist: track.creatorName,
  }));
}

/** Quanti brani si ascoltano subito (Audius) e quanti si cercano su YouTube all'ascolto. */
export function draftSummary(tracks: readonly Pick<DraftTrack, 'source'>[]) {
  const audius = tracks.filter((track) => track.source === 'audius').length;
  return { total: tracks.length, audius, songs: tracks.length - audius };
}

// ---- sessionStorage --------------------------------------------------------------------------

export const DRAFT_STORAGE_KEY = 'solco.crea-playlist.bozza.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Finestra privata, dati del sito bloccati, anteprime: la bozza resta solo in memoria.
    return null;
  }
}

/** La bozza salvata, o null (nessuna, illeggibile o storage non disponibile). */
export function readStoredDraft(storage: StorageLike | null = sessionStore()): StoredDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = StoredDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Salva la bozza; false se lo storage non è disponibile o pieno (la pagina continua a funzionare). */
export function writeStoredDraft(
  draft: StoredDraft,
  storage: StorageLike | null = sessionStore(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredDraft(storage: StorageLike | null = sessionStore()) {
  if (!storage) return;
  try {
    storage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Niente da fare: al prossimo salvataggio la bozza viene sovrascritta.
  }
}
