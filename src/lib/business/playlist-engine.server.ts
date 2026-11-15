// @polsia:user-owned — motore di «Crea playlist» lato server: raccoglie le proposte (catalogo
// Audius riproducibile, Open Music License; suggerimenti dell'AI salvati come "song"), firma i
// metadati Audius proposti e salva la bozza come playlist in UNA sola scrittura (create annidato,
// transazione implicita compatibile con il pooler). Mai YouTube in fase di creazione: i "song" si
// cercano solo quando si ascoltano (/api/music/resolve-song). Mai i brani in evidenza né i
// caricamenti: le uniche sorgenti sono Audius e "song".
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  type AiEngineInput,
  cleanSongText,
  clipText,
  defaultPlaylistName,
  interleave,
  normalizeArtistName,
  pickVaried,
} from '@/lib/business/playlist-engine';
import { suggestSongsWithAi } from '@/lib/business/playlist-engine-ai.server';
import { songIdentity } from '@/lib/business/track-list-import';
import {
  availableCollectionName,
  songItemData,
  songSourceId,
} from '@/lib/business/track-list-import.server';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import {
  type DraftTrack,
  DraftTrackSchema,
  type EngineAiStatus,
  type EngineOrigin,
  PLAYLIST_ENGINE_RESERVE_MAX,
  type SuggestRequest,
  type SuggestResponse,
} from '@/lib/contracts/playlist-engine';
import { prisma } from '@/lib/db';
import { isAudiusOpenMusicLicense } from '@/lib/music/audius';
import { getAudiusMoodTracks, searchAudius } from '@/lib/music/audius-source.server';
import { MAX_ITEMS_PER_COLLECTION, MAX_PLAYLISTS_PER_USER } from '@/lib/music/collections.server';
import { AUDIUS_GENRES, AUDIUS_MOODS, findMood } from '@/lib/music/moods';

// ---- Firma dei brani Audius proposti --------------------------------------------------------
// Al salvataggio il server non rilegge Audius brano per brano (le richieste Audius sono in fila
// per tutta l'app: 30 letture di fila finirebbero in "rate_limited"). I metadati proposti tornano
// dal client con una firma HMAC del server: se qualcosa è cambiato, o la firma è scaduta o di un
// altro account, il brano viene scartato. Nessuna tabella: la firma è autocontenuta.

const TOKEN_CONTEXT = 'playlist-engine:v1';
/** Una bozza resta salvabile per una settimana (resta nel sessionStorage della scheda). */
export const AUDIUS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenSecret(): string | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret?.trim() ? secret : null;
}

type AudiusDraftFields = Omit<Extract<DraftTrack, { source: 'audius' }>, 'token'>;

function tokenMaterial(userId: string, track: AudiusDraftFields, issuedAt: number) {
  return JSON.stringify([
    TOKEN_CONTEXT,
    userId,
    track.sourceId,
    track.title,
    track.creatorName,
    track.artworkUrl,
    track.sourceUrl,
    track.artistUrl,
    track.durationSeconds,
    issuedAt,
  ]);
}

function hmac(secret: string, material: string) {
  return createHmac('sha256', secret).update(material).digest('base64url');
}

/** `<emissione base36>.<firma>` sui metadati del brano e sull'account; null senza segreto. */
export function signAudiusTrack(userId: string, track: AudiusDraftFields, now = Date.now()) {
  const secret = tokenSecret();
  if (!secret) return null;
  return `${now.toString(36)}.${hmac(secret, tokenMaterial(userId, track, now))}`;
}

/** true se la firma è del server, per questo account e questi metadati, e non è scaduta. */
export function verifyAudiusTrack(
  userId: string,
  track: Extract<DraftTrack, { source: 'audius' }>,
  now = Date.now(),
): boolean {
  const secret = tokenSecret();
  if (!secret) return false;
  const [issued, signature, extra] = track.token.split('.');
  if (!issued || !signature || extra !== undefined) return false;
  const issuedAt = Number.parseInt(issued, 36);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60_000) return false;
  if (now - issuedAt > AUDIUS_TOKEN_TTL_MS) return false;
  const { token: _token, ...fields } = track;
  const expected = Buffer.from(hmac(secret, tokenMaterial(userId, fields, issuedAt)));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---- Conversioni ----------------------------------------------------------------------------

/** Un brano "song" della bozza: identificativo stabile come l'importazione di un elenco. */
export function songToDraft(song: { title: string; artist: string | null }): DraftTrack {
  return {
    source: 'song',
    sourceId: songSourceId(song.title, song.artist),
    title: song.title,
    creatorName: song.artist,
    artworkUrl: null,
    sourceUrl: null,
    artistUrl: null,
    durationSeconds: null,
  };
}

/**
 * Un brano Audius della bozza, solo se Solco può trasmetterlo (Open Music License, riproducibile,
 * attribuzione completa) e firmabile; null altrimenti.
 */
export function audiusToDraft(
  track: AudiusTrackSearchResult,
  userId: string,
  now = Date.now(),
): DraftTrack | null {
  if (!track.playbackEligible || !isAudiusOpenMusicLicense(track.license)) return null;
  const duration =
    typeof track.durationSeconds === 'number' && Number.isFinite(track.durationSeconds)
      ? Math.max(0, Math.round(track.durationSeconds))
      : null;
  const fields: AudiusDraftFields = {
    source: 'audius',
    sourceId: track.id,
    // 200 unità UTF-16 come il contratto (DraftTrackSchema), mai mezza emoji.
    title: clipText(track.title, 200),
    creatorName: clipText(track.artistName, 200),
    artworkUrl: track.artworkUrl,
    sourceUrl: track.trackUrl,
    artistUrl: track.artistUrl,
    durationSeconds: duration,
  };
  const token = signAudiusTrack(userId, fields, now);
  if (!token) return null;
  const parsed = DraftTrackSchema.safeParse({ ...fields, token });
  return parsed.success ? parsed.data : null;
}

// ---- Catalogo Audius ------------------------------------------------------------------------

/** Il massimo che Audius accetta in una richiesta: molti brani popolari non sono OML. */
const AUDIUS_FETCH_LIMIT = 100;
/** Brani dello stesso artista di partenza, prima di quelli del suo genere. */
const SEED_ARTIST_TRACKS = 3;

type CatalogResult = {
  status: 'results' | 'unavailable' | 'inactive';
  tracks: AudiusTrackSearchResult[];
  /** Genere ricavato dalla ricerca quando l'artista scritto non è su Audius (va detto all'utente). */
  guessedGenre?: string;
};

function playable(tracks: readonly AudiusTrackSearchResult[]) {
  return tracks.filter(
    (track) => track.playbackEligible && isAudiusOpenMusicLicense(track.license),
  );
}

async function moodCatalog(filters: { moods: readonly string[]; genres: readonly string[] }) {
  const result = await getAudiusMoodTracks({ ...filters, limit: AUDIUS_FETCH_LIMIT }).catch(() => ({
    tracks: [],
    outcome: 'unavailable' as const,
  }));
  if (result.outcome === 'inactive') return { status: 'inactive', tracks: [] } as CatalogResult;
  if (result.outcome === 'unavailable')
    return { status: 'unavailable', tracks: [] } as CatalogResult;
  return { status: 'results', tracks: playable(result.tracks) } as CatalogResult;
}

/**
 * I brani riproducibili di un artista cercato per nome (stesso nome, a meno di maiuscole e
 * accenti); `hits` sono tutti i risultati riproducibili della stessa ricerca, di qualunque artista.
 */
async function artistCatalog(
  artist: string,
): Promise<CatalogResult & { hits: AudiusTrackSearchResult[] }> {
  const wanted = normalizeArtistName(artist);
  if (wanted.length < 2) return { status: 'results', tracks: [], hits: [] };
  const result = await searchAudius(artist).catch(() => ({
    tracks: [],
    artists: [],
    outcome: 'unavailable' as const,
  }));
  if (result.outcome === 'inactive') return { status: 'inactive', tracks: [], hits: [] };
  if (result.outcome === 'unavailable') return { status: 'unavailable', tracks: [], hits: [] };
  const hits = playable(result.tracks);
  return {
    status: 'results',
    tracks: hits.filter((track) => normalizeArtistName(track.artistName) === wanted),
    hits,
  };
}

function knownMood(value: string | null | undefined) {
  return (AUDIUS_MOODS as readonly string[]).includes(value ?? '') ? (value as string) : null;
}
function knownGenre(value: string | null | undefined) {
  return (AUDIUS_GENRES as readonly string[]).includes(value ?? '') ? (value as string) : null;
}

/** I brani Audius per un'atmosfera (mood della Home e/o genere), dal più popolare, vari. */
async function audiusForMood(mood: string | null, genre: string | null): Promise<CatalogResult> {
  const entry = findMood(mood);
  const moods = entry?.audius.moods ?? [];
  const genres = genre ? [genre] : (entry?.audius.genres ?? []);
  const first = await moodCatalog({ moods, genres });
  // Mood e genere insieme possono essere rari: allora anche il solo genere.
  if (first.status === 'results' && first.tracks.length < 20 && entry && genre) {
    const wider = await moodCatalog({ moods: [], genres: [genre] });
    return { status: 'results', tracks: [...first.tracks, ...wider.tracks] };
  }
  return first;
}

/**
 * I brani Audius per un brano o artista di partenza: lo stesso artista, poi il suo genere.
 * `guessGenre` (solo senza AI): se l'artista scritto non ha brani Audius e non è stato scelto un
 * brano dai risultati, si parte dal genere del primo risultato riproducibile della stessa ricerca,
 * invece di lasciare la proposta vuota. La pagina lo dice all'ascoltatore (`guessedGenre`).
 */
async function audiusForSeed(seed: SuggestSeed, guessGenre: boolean): Promise<CatalogResult> {
  const genre = knownGenre(seed.audius?.genre);
  const mood = knownMood(seed.audius?.mood);
  const [byArtist, byGenre] = await Promise.all([
    artistCatalog(seed.artist),
    genre
      ? moodCatalog({ moods: mood ? [mood] : [], genres: [genre] })
      : Promise.resolve<CatalogResult>({ status: 'results', tracks: [] }),
  ]);
  if (byArtist.status === 'inactive') return byArtist;
  if (guessGenre && !genre && byArtist.tracks.length === 0) {
    const guessedGenre = byArtist.hits
      .map((track) => knownGenre(track.genre))
      .find((value): value is string => value !== null);
    if (guessedGenre) {
      const guessed = await moodCatalog({ moods: [], genres: [guessedGenre] });
      if (guessed.status === 'results' && guessed.tracks.length > 0) {
        return { status: 'results', tracks: guessed.tracks, guessedGenre };
      }
    }
  }
  const startId = seed.audius?.trackId ?? null;
  const start = byArtist.tracks.find((track) => track.id === startId);
  const sameArtist = byArtist.tracks.filter((track) => track.id !== startId);
  const tracks = [
    ...(start ? [start] : []),
    ...sameArtist.slice(0, SEED_ARTIST_TRACKS),
    ...byGenre.tracks,
    ...sameArtist.slice(SEED_ARTIST_TRACKS),
  ];
  const status =
    byArtist.status === 'unavailable' && byGenre.status !== 'results' ? 'unavailable' : 'results';
  return { status, tracks };
}

type SuggestSeed = Extract<SuggestRequest, { mode: 'seed' }>['seed'];

// ---- Proposte ---------------------------------------------------------------------------------

export type AiGate =
  | { ok: true }
  | {
      ok: false;
      status: Exclude<EngineAiStatus, 'used' | 'not_requested'>;
      message: string;
      response: Response;
    };

export type SuggestOutcome =
  | { ok: true; body: SuggestResponse }
  | { ok: false; response: Response };

const privateHeaders = { 'Cache-Control': 'private, no-store' };

const AI_ERROR_STATUS = { not_configured: 503, refused: 422, busy: 503, failed: 502 } as const;
export const AI_ERROR_MESSAGE = {
  not_configured:
    'Le proposte con l’AI non sono disponibili in questo momento. «Scegli l’atmosfera» funziona sempre.',
  refused: 'Non posso aiutarti con questa richiesta. Descrivi la musica che vuoi ascoltare.',
  busy: 'L’AI è molto richiesta in questo momento. Riprova tra poco.',
  failed: 'L’AI non è riuscita a preparare la playlist. Riprova.',
} as const;
const AI_ERROR_ENGINE_STATUS = {
  not_configured: 'unavailable',
  refused: 'refused',
  busy: 'busy',
  failed: 'failed',
} as const satisfies Record<keyof typeof AI_ERROR_STATUS, EngineAiStatus>;

const CATALOG_DOWN = 'Il catalogo Audius non risponde in questo momento: riprova tra poco.';
const CATALOG_OFF = 'Il catalogo Audius non è attivo su questo server.';

/** Scorte per «Sostituisci» e «Aggiungi altri»: un terzo della richiesta, fra 2 e 10. */
function spareFor(count: number) {
  return count < 10 ? 2 : Math.min(10, Math.ceil(count / 3));
}

function originOf(request: SuggestRequest): EngineOrigin {
  if (request.mode === 'describe') return { mode: 'describe', prompt: request.prompt };
  if (request.mode === 'seed') return { mode: 'seed', seed: request.seed, useAi: request.useAi };
  return { mode: 'mood', mood: request.mood, genre: request.genre, useAi: request.useAi };
}

function aiInputOf(request: SuggestRequest): AiEngineInput {
  if (request.mode === 'describe') return { kind: 'describe', prompt: request.prompt };
  if (request.mode === 'seed') {
    return { kind: 'seed', artist: request.seed.artist, title: request.seed.title || null };
  }
  return { kind: 'mood', mood: request.mood, genre: request.genre };
}

/**
 * Le proposte per una richiesta. Le parti senza AI funzionano per tutti; l'AI si usa solo quando
 * serve (descrizione) o è chiesta (`useAi`) e `aiGate` la permette (Premium, chiave, limiti).
 * Per la descrizione l'AI è indispensabile: un suo errore diventa la risposta HTTP. Altrove l'errore
 * dell'AI è spiegato in `ai` e le proposte Audius arrivano comunque.
 */
export async function suggestPlaylist(
  request: SuggestRequest,
  context: { userId: string; aiGate: () => Promise<AiGate>; now?: Date },
): Promise<SuggestOutcome> {
  const now = context.now ?? new Date();
  const origin = originOf(request);
  const fallbackName = defaultPlaylistName(origin);
  const excludedKeys = new Set(request.exclude.map((track) => `${track.source}:${track.sourceId}`));
  const excludedSongs = new Set(
    request.exclude
      .filter((track) => track.title.trim())
      .map((track) => songIdentity(track.title, track.artist)),
  );
  const wantsAi = request.mode === 'describe' || request.useAi;

  const aiTask = async () => {
    if (!wantsAi) return { status: 'not_requested' as const, message: null };
    const gate = await context.aiGate();
    if (!gate.ok) return { status: gate.status, message: gate.message, response: gate.response };
    const result = await suggestSongsWithAi(aiInputOf(request), {
      count: request.count,
      spare: spareFor(request.count),
      exclude: request.exclude,
      fallbackName,
      now,
    });
    if (!result.ok) {
      return {
        status: AI_ERROR_ENGINE_STATUS[result.error],
        message: AI_ERROR_MESSAGE[result.error],
        error: result.error,
      };
    }
    return { status: 'used' as const, message: null, result };
  };
  const catalogTask = async (): Promise<CatalogResult | null> => {
    if (request.mode === 'describe') return null;
    if (request.mode === 'seed') return audiusForSeed(request.seed, !wantsAi);
    return audiusForMood(request.mood, request.genre);
  };
  const [ai, catalog] = await Promise.all([aiTask(), catalogTask()]);

  if (request.mode === 'describe') {
    if ('response' in ai && ai.response) return { ok: false, response: ai.response };
    if ('error' in ai && ai.error) {
      return {
        ok: false,
        response: Response.json(
          { error: ai.error, message: AI_ERROR_MESSAGE[ai.error] },
          { status: AI_ERROR_STATUS[ai.error], headers: privateHeaders },
        ),
      };
    }
  }

  const aiResult = 'result' in ai ? ai.result : null;
  const songs = (aiResult?.songs ?? [])
    .map(songToDraft)
    .filter((track) => !excludedKeys.has(`${track.source}:${track.sourceId}`));
  const nowMs = now.getTime();
  const audius = pickVaried(
    (catalog?.tracks ?? []).filter(
      (track) =>
        !excludedKeys.has(`audius:${track.id}`) &&
        !excludedSongs.has(songIdentity(track.title, track.artistName)),
    ),
    (track) => track.artistId || track.artistName,
  )
    .map((track) => audiusToDraft(track, context.userId, nowMs))
    .filter((track): track is DraftTrack => track !== null);

  // Mood: prima il catalogo (si ascolta subito); partenza: prima i simili dell'AI.
  const combined = request.mode === 'mood' ? interleave(audius, songs) : interleave(songs, audius);
  const seen = new Set<string>();
  const unique = combined.filter((track) => {
    const key = `${track.source}:${track.sourceId}`;
    const identity = songIdentity(track.title, track.creatorName);
    if (seen.has(key) || seen.has(identity)) return false;
    seen.add(key);
    seen.add(identity);
    return true;
  });

  let notice: string | null = null;
  if (unique.length === 0) {
    if (catalog?.status === 'unavailable') notice = CATALOG_DOWN;
    else if (catalog?.status === 'inactive') notice = CATALOG_OFF;
    else if (request.mode === 'describe')
      notice =
        'Non ho trovato brani per questa descrizione. Prova a indicare un genere, un’atmosfera o qualche artista.';
    else if (request.mode === 'seed')
      notice = aiResult
        ? 'Non ho trovato brani simili a questo punto di partenza. Prova con un altro artista.'
        : 'Senza l’AI posso proporre solo brani Audius, e per questo punto di partenza non ne ho trovati. Prova «Scegli l’atmosfera».';
    else notice = 'Non ho trovato brani per questa atmosfera. Prova un altro genere.';
  } else if (catalog?.status === 'unavailable' && request.mode !== 'describe') {
    notice = 'Il catalogo Audius non ha risposto: ci sono solo i suggerimenti dell’AI.';
  } else if (catalog?.guessedGenre && request.mode === 'seed') {
    notice = `Su Audius non ho trovato brani di «${request.seed.artist}»: ti propongo brani ${catalog.guessedGenre}, il genere dei risultati della ricerca. Con «Cerca su Audius» puoi scegliere tu un brano da cui partire.`;
  }

  return {
    ok: true,
    body: {
      name: aiResult?.name ?? fallbackName,
      description: aiResult?.description ?? null,
      tracks: unique.slice(0, request.count),
      reserve: unique.slice(request.count, request.count + PLAYLIST_ENGINE_RESERVE_MAX),
      ai: { status: ai.status, message: ai.message },
      notice,
    },
  };
}

// ---- Salvataggio ------------------------------------------------------------------------------

export type SaveDraftInput = {
  name: string;
  description: string | null;
  tracks: DraftTrack[];
};

export type SaveDraftOutcome =
  | { ok: true; collectionId: string; name: string; saved: number; skipped: number }
  | { ok: false; error: 'limit_reached' | 'no_valid_tracks' };

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

/**
 * Crea la playlist con tutti i brani della bozza, nell'ordine dato, in UNA scrittura (create
 * annidato: o tutto o niente). I "song" sono gli stessi dell'importazione di un elenco (cercati su
 * YouTube solo all'ascolto, nessun link Spotify); i brani Audius entrano solo con una firma valida.
 * Doppioni e firme non valide sono scartati e contati. Il limite di playlist vale per tutti i
 * piani (Free e Pro hanno gli stessi limiti di raccolte).
 */
export async function savePlaylistDraft(
  userId: string,
  input: SaveDraftInput,
  now = new Date(),
): Promise<SaveDraftOutcome> {
  const seen = new Set<string>();
  const items: Array<{
    key: string;
    build: (createdAt: Date) => Prisma.UserMusicCollectionItemCreateWithoutCollectionInput;
  }> = [];
  let skipped = 0;
  for (const track of input.tracks) {
    if (track.source === 'song') {
      const title = cleanSongText(track.title);
      const artist = cleanSongText(track.creatorName);
      if (!title) {
        skipped += 1;
        continue;
      }
      const sourceId = songSourceId(title, artist);
      const identity = songIdentity(title, artist);
      if (seen.has(`song:${sourceId}`) || seen.has(identity)) {
        skipped += 1;
        continue;
      }
      seen.add(`song:${sourceId}`);
      seen.add(identity);
      items.push({
        key: `song:${sourceId}`,
        build: (createdAt) =>
          songItemData({ title, artist, durationSeconds: null, sourceUrl: null }, createdAt),
      });
      continue;
    }
    const identity = songIdentity(track.title, track.creatorName);
    if (seen.has(`audius:${track.sourceId}`) || seen.has(identity)) {
      skipped += 1;
      continue;
    }
    if (!verifyAudiusTrack(userId, track, now.getTime())) {
      skipped += 1;
      continue;
    }
    seen.add(`audius:${track.sourceId}`);
    seen.add(identity);
    items.push({
      key: `audius:${track.sourceId}`,
      build: (createdAt) => ({
        source: 'audius',
        sourceId: track.sourceId,
        title: track.title,
        creatorName: track.creatorName,
        artworkUrl: track.artworkUrl,
        sourceUrl: track.sourceUrl,
        artistUrl: track.artistUrl,
        durationSeconds: track.durationSeconds,
        createdAt,
        expiresAt: null,
      }),
    });
  }
  const kept = items.slice(0, MAX_ITEMS_PER_COLLECTION);
  skipped += items.length - kept.length;
  if (kept.length === 0) return { ok: false, error: 'no_valid_tracks' };

  // La Libreria intera viene caricata a ogni visita: il numero di playlist resta limitato.
  const playlists = await prisma.userMusicCollection.count({ where: { userId, kind: 'playlist' } });
  if (playlists >= MAX_PLAYLISTS_PER_USER) return { ok: false, error: 'limit_reached' };

  for (let attempt = 0; ; attempt += 1) {
    const name = await availableCollectionName(userId, input.name);
    const base = now.getTime();
    try {
      const collection = await prisma.userMusicCollection.create({
        data: {
          userId,
          name,
          kind: 'playlist',
          description: input.description,
          items: {
            // Gli elementi si leggono dal più recente: orari decrescenti mantengono l'ordine.
            create: kept.map((item, index) => item.build(new Date(base - index))),
          },
        },
        select: { id: true },
      });
      return { ok: true, collectionId: collection.id, name, saved: kept.length, skipped };
    } catch (error) {
      // Un'altra scheda ha preso lo stesso nome nel frattempo: si passa al successivo libero.
      if (attempt < 2 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}
