// @polsia:user-owned — motore di «Potrebbe piacerti» (brani consigliati personali). Tutto sul server
// e solo con i dati dell'utente che chiede: ascolti Audius/Jamendo degli ultimi 60 giorni, Preferiti
// e playlist (le playlist importate da Spotify servono solo a non riproporre ciò che hai già), diario
// (album votati 4 o 5) e «Non mi interessa». Le voci YouTube non entrano mai nel gusto, nella cache
// o all'AI: di quelle ancora valide (28 giorni) si leggono solo titolo e artista per calcolare in
// memoria la chiave "song" e non riproporre un suggerimento AI già ascoltato.
// Candidati, solo brani che Solco può riprodurre (Audius Open Music License, playbackEligible):
// altri brani degli artisti che ascolti, brani popolari dei loro generi («Popolare nel genere di
// …»), i preferiti della community (solo conteggi aggregati, almeno 3 ascoltatori, ricalcolati
// dalla pulizia giornaliera, nessun dato di una persona) e le tendenze Audius. Per gli account Premium, una volta al giorno, l'AI propone brani "song" (artista
// + titolo) cercati su YouTube solo quando tocca a loro nel player. Mai brani caricati o «In
// evidenza», mai ricerche YouTube qui. I candidati restano in RecommendationCache (una riga per
// utente, rifatta ogni 6 ore, cancellata dopo 2 giorni e con l'account); i «Non mi interessa» in
// RecommendationHidden (al massimo 300 per utente).
import 'server-only';
import type { Prisma } from '@prisma/client';
import { after } from 'next/server';
import { z } from 'zod';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { consumeRateLimit, releaseRateLimit } from '@/lib/business/rate-limit.server';
import { songSourceId } from '@/lib/business/track-list-import.server';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import {
  RECOMMENDATION_HIDDEN_LIMIT,
  RECOMMENDATION_PAGE_SIZE,
  type RecommendationMode,
  type RecommendationReason,
  type RecommendationsResponse,
  RecommendationsResponseSchema,
  RecommendedAudiusTrackSchema,
  RecommendedSongSchema,
} from '@/lib/contracts/recommendations';
import { prisma } from '@/lib/db';
import { normalizeAudiusTracks } from '@/lib/music/audius';
import { createAudiusApiClient } from '@/lib/music/audius-api.server';
import {
  getAudiusActivation,
  getAudiusMoodTracks,
  getAudiusTrending,
  searchAudius,
} from '@/lib/music/audius-source.server';
import { AUDIUS_GENRES, type AudiusGenre } from '@/lib/music/moods';
import {
  buildTasteProfile,
  capCandidates,
  type DiarySeed,
  dailySeed,
  eligibleEntries,
  type HistorySeed,
  isColdStart,
  type LibrarySeed,
  mergeCandidates,
  mostCommon,
  normalizeArtistKey,
  type PoolEntry,
  PoolEntrySchema,
  type PoolSource,
  RECOMMENDATION_WINDOW_DAYS,
  rankingContext,
  reasonFor,
  romeDay,
  selectPage,
  type TasteArtist,
  type TasteProfile,
  toAudiusGenre,
  toAudiusMood,
} from '@/lib/music/recommendations';
import {
  aiRecommendationsConfigured,
  suggestRecommendedSongs,
} from '@/lib/music/recommendations-ai.server';
import { purgeStaleRecommendations } from '@/lib/music/recommendations-cache.server';
import { YOUTUBE_HISTORY_MAX_AGE_MS } from '@/lib/music/youtube-history.server';

const DAY_MS = 24 * 60 * 60 * 1000;
/** I candidati di un utente si rifanno al massimo ogni 6 ore (e a ogni nuovo giorno). */
export const RECOMMENDATION_POOL_TTL_MS = 6 * 60 * 60 * 1000;
/** Meno di una pagina di candidati (gusti di nicchia o una fonte giù): si riprova dopo 30 minuti. */
const SMALL_POOL_TTL_MS = 30 * 60 * 1000;
/** I suggerimenti dell'AI valgono al massimo 48 ore. */
const AI_ITEMS_MAX_AGE_MS = 2 * DAY_MS;
/** Tempo massimo per fonte: una fonte lenta non blocca le altre. */
const SOURCE_TIMEOUT_MS = 8_000;
/** Ricerche Audius per artista (2 richieste ciascuna, in cache per 10 minuti). */
const ARTIST_SEARCHES = 2;
/** Generi interrogati (stessi parametri per tutti: la cache in memoria li riusa). */
const GENRE_POOLS = 2;
/** Il massimo che Audius accetta: molti brani popolari non sono OML e vengono scartati. */
const GENRE_FETCH_LIMIT = 100;
/** Candidati tenuti per fonte e in tutto. */
const PER_SOURCE_LIMIT = 40;
const POOL_LIMIT = 120;
/** Brani della community riverificati su Audius (licenza e disponibilità), una volta l'ora. */
const COMMUNITY_VERIFY_LIMIT = 8;
/** Classifica della community più vecchia di così (pulizia giornaliera ferma): non si usa. */
const COMMUNITY_MAX_AGE_MS = 3 * DAY_MS;
const COMMUNITY_TTL_MS = 60 * 60 * 1000;
const COMMUNITY_RETRY_MS = 5 * 60 * 1000;
const HISTORY_READ_LIMIT = 200;
/**
 * La route ha 60 s (maxDuration) e la chiamata AI gira nella stessa funzione: deve finire entro 50 s
 * dall'inizio della richiesta, lasciando il tempo di salvare il risultato o restituire i limiti.
 */
const AI_REQUEST_BUDGET_MS = 50_000;
/** Con meno di così a disposizione la chiamata AI non parte (e non consuma il limite del giorno). */
const AI_MIN_TIME_MS = 15_000;
const LIBRARY_READ_LIMIT = 1000;
const DIARY_READ_LIMIT = 100;

const StoredPoolSchema = z.object({
  version: z.literal(1),
  /** Giorno (ora italiana) in cui i candidati sono stati raccolti. */
  day: z.string(),
  entries: z.array(PoolEntrySchema).max(POOL_LIMIT),
  genres: z.array(z.object({ genre: z.enum(AUDIUS_GENRES), weight: z.number() })),
  moods: z.array(z.string().max(40)),
  ai: z
    .object({
      day: z.string(),
      generatedAt: z.string().datetime(),
      entries: z.array(PoolEntrySchema),
    })
    .nullable(),
});
type StoredPool = z.infer<typeof StoredPoolSchema>;

type Options = { page: number; personal: boolean };

// ---------- Utilità ----------

function withDeadline<T>(task: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  const work = Promise.resolve()
    .then(task)
    .catch(() => fallback);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Tiene viva una promessa dopo la risposta (after(), waitUntil su Vercel). Mai throw. */
function keepAlive(task: Promise<unknown>) {
  const settled = task.then(
    () => undefined,
    () => undefined,
  );
  try {
    after(settled);
  } catch {
    // Fuori da una richiesta (test, avvio): la promessa prosegue da sola.
  }
}

/** Handle Audius dal link ufficiale di un brano: https://audius.co/<handle>/<brano>. */
function audiusHandle(sourceUrl: string | null) {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    if (url.hostname !== 'audius.co') return null;
    const handle = decodeURIComponent(url.pathname.split('/')[1] ?? '');
    return handle ? handle.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isSpotifyUrl(value: string | null) {
  if (!value) return false;
  try {
    return /(^|\.)spotify\.com$/.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function sameArtist(
  track: Pick<AudiusTrackSearchResult, 'artistName' | 'artistHandle'>,
  artist: TasteArtist,
) {
  if (artist.handle && track.artistHandle.toLowerCase() === artist.handle) return true;
  return normalizeArtistKey(track.artistName) === artist.key;
}

// ---------- Dati dell'utente ----------

type Seeds = {
  history: HistorySeed[];
  library: LibrarySeed[];
  diary: DiarySeed[];
  /** "song" degli stessi brani già ascoltati (per non riproporli come suggerimenti AI). */
  playedSongs: string[];
};

async function readSeeds(userId: string, now: Date): Promise<Seeds> {
  const since = new Date(now.getTime() - RECOMMENDATION_WINDOW_DAYS * DAY_MS);
  const [history, items, diary, youtubePlays] = await Promise.all([
    // Solo Audius e Jamendo: le voci YouTube (dati dell'API con scadenza) non vengono lette.
    prisma.userPlaybackHistory.findMany({
      where: {
        userId,
        lastPlayedAt: { gte: since },
        OR: [
          { qualifiedId: { startsWith: 'audius:' } },
          { qualifiedId: { startsWith: 'jamendo:' } },
        ],
      },
      select: {
        qualifiedId: true,
        title: true,
        artistName: true,
        sourceUrl: true,
        playCount: true,
        lastPlayedAt: true,
      },
      orderBy: { lastPlayedAt: 'desc' },
      take: HISTORY_READ_LIMIT,
    }),
    // Solo brani Audius e "song": i video YouTube salvati non vengono letti.
    prisma.userMusicCollectionItem.findMany({
      where: { source: { in: ['audius', 'song'] }, collection: { userId } },
      select: {
        source: true,
        sourceId: true,
        creatorName: true,
        sourceUrl: true,
        collection: { select: { kind: true, spotifySource: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: LIBRARY_READ_LIMIT,
    }),
    prisma.listeningEntry.findMany({
      where: { userId, rating: { gte: 4 } },
      select: { artistName: true, genre: true, rating: true },
      orderBy: { listenedOn: 'desc' },
      take: DIARY_READ_LIMIT,
    }),
    // Un suggerimento "song" ascoltato diventa nel player un video YouTube con il titolo e l'artista
    // del suggerimento. Solo titolo e artista delle voci YouTube ancora valide (28 giorni), solo per
    // la chiave "song" calcolata qui sotto in memoria: mai nel gusto, nella cache o all'AI.
    prisma.userPlaybackHistory.findMany({
      where: {
        userId,
        qualifiedId: { startsWith: 'youtube:' },
        lastPlayedAt: { gte: new Date(now.getTime() - YOUTUBE_HISTORY_MAX_AGE_MS) },
      },
      select: { title: true, artistName: true },
      orderBy: { lastPlayedAt: 'desc' },
      take: HISTORY_READ_LIMIT,
    }),
  ]);

  return {
    history: history.map((row) => ({
      qualifiedId: row.qualifiedId,
      artistName: row.artistName,
      playCount: row.playCount,
      lastPlayedAt: row.lastPlayedAt,
      handle: row.qualifiedId.startsWith('audius:') ? audiusHandle(row.sourceUrl) : null,
    })),
    library: items.map((item) => {
      // Spotify: i dati ricevuti da Spotify non entrano nel gusto (né vanno all'AI); il brano
      // conta solo per non riproporlo.
      const fromSpotify =
        item.source === 'song' &&
        (item.collection.spotifySource !== null || isSpotifyUrl(item.sourceUrl));
      return {
        qualifiedId: `${item.source}:${item.sourceId}`,
        artistName: fromSpotify ? null : item.creatorName,
        weight: fromSpotify ? 0 : item.collection.kind === 'favorites' ? 3 : 1.5,
      };
    }),
    diary: diary.map((entry) => ({
      artistName: entry.artistName,
      genre: entry.genre,
      rating: entry.rating,
    })),
    playedSongs: [...history, ...youtubePlays].map(
      (row) => `song:${songSourceId(row.title, row.artistName)}`,
    ),
  };
}

async function readHidden(userId: string) {
  const rows = await prisma.recommendationHidden.findMany({
    where: { userId },
    select: { itemKey: true },
    orderBy: { createdAt: 'desc' },
    take: RECOMMENDATION_HIDDEN_LIMIT,
  });
  return new Set(rows.map((row) => row.itemKey));
}

// ---------- Candidati ----------

function audiusEntry(
  track: AudiusTrackSearchResult,
  source: PoolSource,
  reason: RecommendationReason,
  rank: number,
): PoolEntry | null {
  // Solo brani che Solco può riprodurre (licenza OML verificata dal normalizzatore).
  if (!track.playbackEligible || track.playbackReason !== 'ready') return null;
  const item = RecommendedAudiusTrackSchema.safeParse({
    kind: 'audius',
    id: track.id,
    qualifiedId: track.qualifiedId,
    title: track.title,
    artistName: track.artistName,
    artistUrl: track.artistUrl,
    trackUrl: track.trackUrl,
    artworkUrl: track.artworkUrl,
    durationSeconds: track.durationSeconds,
    license: track.license,
    licensorName: track.licensorName,
    copyrightNotice: track.copyrightNotice,
    attributionRemovalRequested: track.attributionRemovalRequested,
    playbackEligible: true,
    playbackReason: 'ready',
    genre: track.genre ? track.genre.slice(0, 80) : null,
    reason,
  });
  if (!item.success) return null;
  return {
    item: item.data,
    source,
    rank,
    genre: toAudiusGenre(track.genre),
    mood: toAudiusMood(track.mood),
    alsoIn: [],
  };
}

/**
 * Brani di una fonte → candidati. Un brano di un artista che ascolti diventa sempre «Perché hai
 * ascoltato …» (mai «Popolare nel genere di …» per lo stesso artista).
 */
function audiusEntries(
  tracks: readonly AudiusTrackSearchResult[],
  artists: readonly TasteArtist[],
  fallback: { source: PoolSource; reason: RecommendationReason },
): PoolEntry[] {
  const entries: PoolEntry[] = [];
  for (const track of tracks) {
    if (entries.length >= PER_SOURCE_LIMIT) break;
    const known = artists.find((artist) => sameArtist(track, artist));
    const entry = known
      ? audiusEntry(track, 'artist', reasonFor('artist', { artist: known.name }), entries.length)
      : audiusEntry(track, fallback.source, fallback.reason, entries.length);
    if (entry) entries.push(entry);
  }
  return entries;
}

type CommunityState = { at: number; ttl: number; tracks: AudiusTrackSearchResult[] };
let communityState: CommunityState | null = null;
let communityLoad: Promise<AudiusTrackSearchResult[]> | null = null;

export function resetRecommendationCommunityCacheForTests() {
  communityState = null;
  communityLoad = null;
}

/**
 * Brani Audius più ascoltati su Solco: SOLO un conteggio aggregato per brano (persone distinte,
 * almeno 3, ultimi 30 giorni), mai chi li ha ascoltati. La classifica è ricalcolata una volta al
 * giorno dalla pulizia (refreshRecommendationCommunity): qui si legge solo quella tabella piccola,
 * mai tutta la cronologia. Riverificati su Audius (licenza OML e disponibilità) e tenuti in memoria
 * per un'ora: sono uguali per tutti.
 */
async function loadCommunity(now: number): Promise<AudiusTrackSearchResult[]> {
  const activation = getAudiusActivation();
  if (!activation.active) return [];
  const rows = await prisma.recommendationCommunity.findMany({
    where: { computedAt: { gte: new Date(now - COMMUNITY_MAX_AGE_MS) } },
    orderBy: [{ listeners: 'desc' }, { qualifiedId: 'asc' }],
    take: COMMUNITY_VERIFY_LIMIT,
    select: { qualifiedId: true },
  });
  const ids = rows.flatMap((row) => {
    const id = /^audius:([A-Za-z0-9_-]{1,128})$/.exec(row.qualifiedId)?.[1];
    return id ? [id] : [];
  });
  if (ids.length === 0) return [];
  const client = createAudiusApiClient({ apiKey: activation.apiKey });
  const verified = await Promise.all(
    ids.map(async (id) => {
      try {
        const track = normalizeAudiusTracks(await client.getTrack(id), true).find(
          (item) => item.id === id,
        );
        return track?.playbackEligible ? track : null;
      } catch {
        return null;
      }
    }),
  );
  return verified.filter((track): track is AudiusTrackSearchResult => track !== null);
}

export function communityFavorites(now = Date.now()): Promise<AudiusTrackSearchResult[]> {
  if (communityState && now - communityState.at < communityState.ttl) {
    return Promise.resolve(communityState.tracks);
  }
  communityLoad ??= loadCommunity(now)
    .then((tracks) => {
      communityState = { at: Date.now(), ttl: COMMUNITY_TTL_MS, tracks };
      return tracks;
    })
    .catch(() => {
      communityState = { at: Date.now(), ttl: COMMUNITY_RETRY_MS, tracks: [] };
      return [];
    })
    .finally(() => {
      communityLoad = null;
    });
  return communityLoad;
}

const NO_TRACKS = { tracks: [] as AudiusTrackSearchResult[] };

/** Fonti uguali per tutti: preferiti della community e tendenze Audius. */
async function generalEntries(artists: readonly TasteArtist[]) {
  const [community, trending] = await Promise.all([
    withDeadline(() => communityFavorites(), SOURCE_TIMEOUT_MS, [] as AudiusTrackSearchResult[]),
    withDeadline(() => getAudiusTrending(), SOURCE_TIMEOUT_MS, NO_TRACKS),
  ]);
  return [
    audiusEntries(community, artists, { source: 'community', reason: reasonFor('community') }),
    audiusEntries(trending.tracks, artists, { source: 'trending', reason: reasonFor('trending') }),
  ];
}

/**
 * Candidati personali: altri brani degli artisti più ascoltati (ricerca Audius, solo corrispondenze
 * esatte), poi i brani popolari dei loro generi e di quelli del diario, più community e tendenze.
 * I brani già ascoltati, già nella Libreria o nascosti escono PRIMA del taglio a 120 (non occupano
 * posti) e community e tendenze hanno posti riservati (capCandidates).
 */
async function collectPersonalPool(
  profile: TasteProfile,
  hidden: ReadonlySet<string>,
  day: string,
): Promise<StoredPool> {
  const searched = profile.artists.slice(0, ARTIST_SEARCHES);
  const [searches, general] = await Promise.all([
    Promise.all(
      searched.map((artist) =>
        withDeadline(() => searchAudius(artist.name), SOURCE_TIMEOUT_MS, NO_TRACKS),
      ),
    ),
    generalEntries(profile.artists),
  ]);

  const artistLists: PoolEntry[][] = [];
  const genreInfo = new Map<AudiusGenre, { weight: number; artist: string | null }>();
  const moods: string[] = [];
  searched.forEach((artist, index) => {
    const matches = (searches[index]?.tracks ?? []).filter((track) => sameArtist(track, artist));
    artistLists.push(
      audiusEntries(matches, profile.artists, {
        source: 'artist',
        reason: reasonFor('artist', { artist: artist.name }),
      }),
    );
    const genre = mostCommon(matches.map((track) => toAudiusGenre(track.genre)));
    const mood = mostCommon(matches.map((track) => toAudiusMood(track.mood)));
    if (mood) moods.push(mood);
    if (genre) {
      const current = genreInfo.get(genre);
      if (current) current.weight += artist.weight;
      else genreInfo.set(genre, { weight: artist.weight, artist: artist.name });
    }
  });
  for (const { genre, weight } of profile.diaryGenres) {
    const current = genreInfo.get(genre);
    if (current) current.weight += weight;
    else genreInfo.set(genre, { weight, artist: null });
  }
  const genres = [...genreInfo.entries()]
    .sort((left, right) => right[1].weight - left[1].weight || left[0].localeCompare(right[0]))
    .slice(0, GENRE_POOLS);

  const genreResults = await Promise.all(
    genres.map(([genre]) =>
      withDeadline(
        () => getAudiusMoodTracks({ moods: [], genres: [genre], limit: GENRE_FETCH_LIMIT }),
        SOURCE_TIMEOUT_MS,
        NO_TRACKS,
      ),
    ),
  );
  const genreLists = genres.map(([genre, info], index) =>
    audiusEntries(
      genreResults[index]?.tracks ?? [],
      profile.artists,
      info.artist
        ? { source: 'similar', reason: reasonFor('similar', { artist: info.artist }) }
        : { source: 'genre', reason: reasonFor('genre', { genre }) },
    ),
  );

  const unseen = (list: PoolEntry[]) =>
    list.filter(
      (entry) =>
        !profile.excluded.has(entry.item.qualifiedId) && !hidden.has(entry.item.qualifiedId),
    );
  return {
    version: 1,
    day,
    entries: capCandidates(
      mergeCandidates([...artistLists, ...genreLists, ...general].map(unseen)),
      POOL_LIMIT,
    ),
    genres: genres.map(([genre, info]) => ({ genre, weight: info.weight })),
    moods: [...new Set(moods)],
    ai: null,
  };
}

// ---------- Cache per utente ----------

async function readCache(userId: string): Promise<{ pool: StoredPool; generatedAt: Date } | null> {
  try {
    const row = await prisma.recommendationCache.findUnique({ where: { userId } });
    if (!row) return null;
    const parsed = StoredPoolSchema.safeParse(row.payload);
    return parsed.success ? { pool: parsed.data, generatedAt: row.generatedAt } : null;
  } catch {
    return null;
  }
}

async function writeCache(userId: string, pool: StoredPool, now: Date) {
  const payload = pool as unknown as Prisma.InputJsonValue;
  await prisma.recommendationCache
    .upsert({
      where: { userId },
      create: { userId, payload, generatedAt: now },
      update: { payload, generatedAt: now },
    })
    .catch(() => undefined);
  // Mantiene la promessa dell'informativa: niente più vecchio di 2 giorni resta salvato.
  await purgeStaleRecommendations(now);
}

function recentAi(pool: StoredPool | undefined, now: Date) {
  const ai = pool?.ai;
  if (!ai) return null;
  return now.getTime() - Date.parse(ai.generatedAt) < AI_ITEMS_MAX_AGE_MS ? ai : null;
}

// ---------- AI (solo Premium, una volta al giorno) ----------

function aiEntries(songs: Awaited<ReturnType<typeof suggestRecommendedSongs>>): PoolEntry[] {
  if (!songs.ok) return [];
  return songs.songs.flatMap((song, rank) => {
    const item = RecommendedSongSchema.safeParse({
      kind: 'song',
      qualifiedId: song.qualifiedId,
      title: song.title,
      artistName: song.artistName,
      reason: reasonFor('ai', song.seedArtist ? { artist: song.seedArtist } : {}),
    });
    return item.success
      ? [{ item: item.data, source: 'ai' as const, rank, genre: null, mood: null, alsoIn: [] }]
      : [];
  });
}

/** Tempo che resta alla chiamata AI perché finisca dentro il limite della funzione. */
function aiTimeLeft(startedAt: number) {
  return AI_REQUEST_BUDGET_MS - (Date.now() - startedAt);
}

/**
 * Se l'utente è Premium e la chiave funziona, avvia in background UNA richiesta AI (limite di 1 al
 * giorno per utente e tetto giornaliero per l'app); il risultato entra nella cache e compare dalla
 * richiesta successiva. Una richiesta non partita o fallita per un problema passeggero non conta.
 * La chiamata ha solo il tempo che resta alla richiesta (`startedAt`, vedi AI_REQUEST_BUDGET_MS):
 * con meno di 15 s non parte, così la funzione non viene fermata a metà con il limite consumato.
 */
async function scheduleAi(
  userId: string,
  profile: TasteProfile,
  pool: StoredPool,
  now: Date,
  startedAt: number,
) {
  if (pool.ai?.day === pool.day) return;
  if (!aiRecommendationsConfigured(now.getTime())) return;
  if (aiTimeLeft(startedAt) < AI_MIN_TIME_MS) return;
  if (!(await hasPremiumAccess(userId))) return;
  const identity = `user:${userId}`;
  const own = await consumeRateLimit('music.recommendations.ai', identity);
  if (!own.allowed) return;
  const global = await consumeRateLimit('music.recommendations.ai.global', 'global');
  if (!global.allowed) {
    await releaseRateLimit('music.recommendations.ai', identity);
    return;
  }
  const timeoutMs = aiTimeLeft(startedAt);
  if (timeoutMs < AI_MIN_TIME_MS) {
    await releaseRateLimit('music.recommendations.ai', identity);
    await releaseRateLimit('music.recommendations.ai.global', 'global');
    return;
  }
  const task = (async () => {
    const outcome = await suggestRecommendedSongs(
      {
        artists: profile.artists.map((artist) => artist.name),
        genres: pool.genres.map((entry) => entry.genre),
      },
      now,
      { timeoutMs },
    );
    if (!outcome.ok) {
      if (outcome.error === 'busy' || outcome.error === 'not_configured') {
        await releaseRateLimit('music.recommendations.ai', identity);
        await releaseRateLimit('music.recommendations.ai.global', 'global');
      }
      return;
    }
    // Rilegge la cache: nel frattempo può essere stata rifatta. Se non c'è più (cronologia
    // cancellata, account eliminato, scaduta) non la ricrea con i dati di prima.
    const latest = (await readCache(userId))?.pool;
    if (!latest) return;
    await writeCache(
      userId,
      {
        ...latest,
        ai: { day: pool.day, generatedAt: new Date().toISOString(), entries: aiEntries(outcome) },
      },
      new Date(),
    );
  })();
  keepAlive(task);
}

// ---------- Risposta ----------

function respond(
  mode: RecommendationMode,
  entries: PoolEntry[],
  context: Parameters<typeof selectPage>[1],
  page: number,
): RecommendationsResponse {
  const selected = selectPage(entries, context, page, RECOMMENDATION_PAGE_SIZE);
  return RecommendationsResponseSchema.parse({ mode, ...selected });
}

/**
 * I consigli dell'utente (pagina `page`). Con `personal` spento non legge nulla dei suoi ascolti:
 * solo «Popolari su Solco» (community + tendenze), senza i brani che ha segnato «Non mi interessa».
 */
export async function getRecommendations(
  userId: string,
  options: Options,
  now = new Date(),
): Promise<RecommendationsResponse> {
  // Orologio vero (non `now`, che i test fissano): misura il tempo già speso dalla richiesta.
  const startedAt = Date.now();
  const day = romeDay(now);
  const seed = dailySeed(userId, day);
  const hidden = await readHidden(userId);

  if (!options.personal) {
    const pool = mergeCandidates(await generalEntries([]));
    const entries = eligibleEntries(pool, { excluded: new Set(), hidden });
    return respond('popular', entries, rankingContext(null, [], [], seed), options.page);
  }

  const seeds = await readSeeds(userId, now);
  const profile = buildTasteProfile({ ...seeds, now, extraExcluded: seeds.playedSongs });

  if (isColdStart(profile)) {
    const pool = mergeCandidates(await generalEntries([]));
    const entries = eligibleEntries(pool, { excluded: profile.excluded, hidden });
    return respond('starter', entries, rankingContext(null, [], [], seed), options.page);
  }

  const cached = await readCache(userId);
  let pool = cached?.pool;
  const ttl =
    (pool?.entries.length ?? 0) >= RECOMMENDATION_PAGE_SIZE
      ? RECOMMENDATION_POOL_TTL_MS
      : SMALL_POOL_TTL_MS;
  const fresh = pool?.day === day && now.getTime() - (cached?.generatedAt.getTime() ?? 0) < ttl;
  if (!pool || !fresh) {
    const collected = await collectPersonalPool(profile, hidden, day);
    pool = { ...collected, ai: recentAi(cached?.pool, now) };
    // Nessun candidato (Audius non raggiungibile): niente cache, si riprova alla prossima.
    if (collected.entries.length > 0) {
      await writeCache(userId, pool, now);
      await scheduleAi(userId, profile, pool, now, startedAt).catch(() => undefined);
    }
  }

  const ai = recentAi(pool, now);
  const entries = eligibleEntries(mergeCandidates([pool.entries, ai?.entries ?? []]), {
    excluded: profile.excluded,
    hidden,
  });
  return respond(
    'personal',
    entries,
    rankingContext(profile, pool.genres, pool.moods, seed),
    options.page,
  );
}

// ---------- «Non mi interessa» ----------

/** Nasconde un brano dai consigli. Oltre i 300 per utente, i più vecchi vengono dimenticati. */
export async function hideRecommendation(userId: string, itemKey: string) {
  await prisma.recommendationHidden.upsert({
    where: { userId_itemKey: { userId, itemKey } },
    create: { userId, itemKey },
    update: {},
  });
  const overflow = await prisma.recommendationHidden.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    skip: RECOMMENDATION_HIDDEN_LIMIT,
    take: 100,
    select: { id: true },
  });
  if (overflow.length > 0) {
    await prisma.recommendationHidden.deleteMany({
      where: { userId, id: { in: overflow.map((row) => row.id) } },
    });
  }
}

/** Annulla un «Non mi interessa». */
export async function unhideRecommendation(userId: string, itemKey: string) {
  await prisma.recommendationHidden.deleteMany({ where: { userId, itemKey } });
}
