// @polsia:user-owned — feed per mood della Home: brani Audius (solo OML riproducibili), radio dal vivo,
// podcast e playlist Solco collegate. Ogni fonte ha il suo tempo massimo e il suo stato, così una
// fonte lenta o in errore non blocca le altre. Nessuna ricerca YouTube (quota scarsa).
import 'server-only';
import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import {
  type Podcast,
  PodcastSchema,
  type RadioStation,
  RadioStationSchema,
} from '@/lib/contracts/library';
import {
  MOOD_GENRE_LIMIT,
  MOOD_PODCAST_LIMIT,
  MOOD_STATION_LIMIT,
  MOOD_TRACK_LIMIT,
  MoodFeedResponseSchema,
  type MoodGenreLink,
  MoodGenreLinkSchema,
  type MoodSectionStatus,
  type MoodTrack,
  MoodTrackSchema,
} from '@/lib/contracts/moods';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import { getAudiusMoodTracks } from '@/lib/music/audius-source.server';
import { findGenre } from '@/lib/music/genre-catalog';
import { findMood, type MoodEntry } from '@/lib/music/moods';
import { searchPodcasts } from '@/lib/music/podcasts.server';
import { listStations } from '@/lib/music/radio-browser.server';

export const dynamic = 'force-dynamic';
/**
 * Explicit function limit, above the slowest source deadline (12 s) plus the rate-limit check:
 * without it a Vercel function outside Fluid Compute stops at its 10 s default.
 */
export const maxDuration = 20;

/**
 * Tempo massimo per fonte: oltre, la sezione risponde "unavailable" e le altre proseguono.
 * Each client gives a single host 8 s (Audius) or 6 s (Radio Browser mirror) before trying the
 * next: these deadlines leave room for one fallback host instead of cutting it off.
 */
const SOURCE_TIMEOUT_MS = { audius: 12_000, radio: 9_000, podcasts: 6_500 } as const;
/**
 * Il massimo che Audius accetta, sempre in una sola richiesta: tra i brani più popolari di un mood
 * la maggior parte è "All rights reserved" e viene scartata, quindi ne servono molti per arrivare a 20.
 */
const AUDIUS_FETCH_LIMIT = 100;
/**
 * Prima 3 brani per artista, così un solo catalogo non riempie i primi brani del mood; se così
 * restano posti liberi, li riempiono gli altri brani riproducibili (vedi moodTracks).
 */
const MOOD_TRACKS_PER_ARTIST = 3;
/**
 * Stazioni chieste per tag: più delle 8 mostrate, perché i doppioni (stessa radio in più bitrate,
 * codec o canali dello stesso sito) vengono scartati.
 */
const MOOD_STATIONS_PER_TAG = 12;

type Section<T> = { status: MoodSectionStatus; items: T[] };

function unavailable<T>(): Section<T> {
  return { status: 'unavailable', items: [] };
}

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

/** Tiene solo le voci conformi al contratto: una voce anomala non fa fallire la sezione. */
function validItems<T>(schema: ZodType<T>, rows: readonly unknown[]): T[] {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

function toMoodTrack(track: AudiusTrackSearchResult) {
  return {
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
    playbackEligible: track.playbackEligible,
    playbackReason: track.playbackReason,
  };
}

async function moodTracks(mood: MoodEntry): Promise<Section<MoodTrack>> {
  const result = await getAudiusMoodTracks({
    moods: mood.audius.moods,
    genres: mood.audius.genres,
    limit: AUDIUS_FETCH_LIMIT,
  });
  if (result.outcome === 'inactive' || result.outcome === 'unavailable') return unavailable();
  // Only tracks Solco may stream (Audius Open Music License): the normaliser marks the others
  // license_not_allowed, and they are left out as in the other Audius sections.
  // Variety first: at most 3 tracks per artist, in popularity order. One catalogue can hold a third
  // of the results (College Music in Relax), so the playable tracks over the cap then fill the
  // places still free, in the same order: the first rows stay varied and the mood reaches 20
  // whenever Audius has that many playable tracks (measured live: Relax 48, Notte 38, Focus 61).
  const perArtist = new Map<string, number>();
  const varied: AudiusTrackSearchResult[] = [];
  const overCap: AudiusTrackSearchResult[] = [];
  for (const track of result.tracks) {
    if (!track.playbackEligible) continue;
    const artist = track.artistId || track.artistName;
    const count = perArtist.get(artist) ?? 0;
    if (count < MOOD_TRACKS_PER_ARTIST) {
      perArtist.set(artist, count + 1);
      varied.push(track);
    } else {
      overCap.push(track);
    }
  }
  return {
    status: 'results',
    items: validItems(MoodTrackSchema, [...varied, ...overCap].map(toMoodTrack)).slice(
      0,
      MOOD_TRACK_LIMIT,
    ),
  };
}

/**
 * Sito della stazione senza "www.", query e barra finale: i canali dello stesso sito con pagine
 * diverse (somafm.com/groovesalad, somafm.com/secretagent) restano distinti, quelli che rimandano
 * alla stessa pagina (love.radio, epic-piano.com) sono una sola radio.
 */
function stationHomepageKey(homepage: string | null) {
  if (!homepage) return null;
  try {
    const url = new URL(homepage);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Nome della stazione senza parti tra parentesi, bitrate, codec e punteggiatura:
 * "SomaFM Groove Salad (128k MP3)" e "(128k AAC)", "Classic Vinyl HD" e "Classic Vinyl HD Opus".
 */
function stationNameKey(name: string) {
  const key = name
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b\d+\s*k(?:bps)?\b/g, ' ')
    .replace(/\b(?:mp3|aac|opus|ogg|flac|hls|hd)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return key || name.trim().toLowerCase();
}

/**
 * Alterna le stazioni dei tag (le più votate di ciascuno prima), senza doppioni: stesso id, stesso
 * nome normalizzato (la stessa radio in un altro bitrate o codec) o stessa pagina del sito.
 */
function interleaveStations(lists: readonly RadioStation[][]) {
  const seen = new Set<string>();
  const stations: RadioStation[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest && stations.length < MOOD_STATION_LIMIT; index += 1) {
    for (const list of lists) {
      const station = list[index];
      if (!station || stations.length >= MOOD_STATION_LIMIT) continue;
      const homepage = stationHomepageKey(station.homepage);
      const keys = [`id:${station.id}`, `name:${stationNameKey(station.name)}`];
      if (homepage) keys.push(`homepage:${homepage}`);
      if (keys.some((key) => seen.has(key))) continue;
      for (const key of keys) seen.add(key);
      stations.push(station);
    }
  }
  return stations;
}

async function moodStations(mood: MoodEntry): Promise<Section<RadioStation>> {
  const results = await Promise.all(
    mood.radioTags.map((tag) => listStations({ tag, limit: MOOD_STATIONS_PER_TAG })),
  );
  if (results.every((result) => result.outcome === 'unavailable')) return unavailable();
  const lists = results.map((result) => validItems(RadioStationSchema, result.stations));
  return { status: 'results', items: interleaveStations(lists) };
}

async function moodPodcasts(mood: MoodEntry): Promise<Section<Podcast>> {
  const result = await searchPodcasts(mood.podcastTerm);
  if (result.outcome === 'unavailable') return unavailable();
  return {
    status: 'results',
    items: validItems(PodcastSchema, result.podcasts).slice(0, MOOD_PODCAST_LIMIT),
  };
}

/** Playlist del catalogo generi Solco: link interni, nessuna chiamata esterna. */
function moodGenres(mood: MoodEntry): Section<MoodGenreLink> {
  const links = mood.genreSlugs.flatMap((slug) => {
    const genre = findGenre(slug);
    return genre ? [{ slug: genre.slug, name: genre.name, href: `/generi/${genre.slug}` }] : [];
  });
  return {
    status: 'results',
    items: validItems(MoodGenreLinkSchema, links).slice(0, MOOD_GENRE_LIMIT),
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ mood: string }> }) {
  const mood = findMood((await params).mood);
  if (!mood) {
    return NextResponse.json(
      { error: 'mood_not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  // Proxy anonimo verso cataloghi esterni: limite per IP d'ingresso, prima di ogni fonte
  // (senza un IP affidabile, come in sviluppo locale, non limita).
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;

  const [tracks, stations, podcasts] = await Promise.all([
    withDeadline(() => moodTracks(mood), SOURCE_TIMEOUT_MS.audius, unavailable<MoodTrack>()),
    withDeadline(() => moodStations(mood), SOURCE_TIMEOUT_MS.radio, unavailable<RadioStation>()),
    withDeadline(() => moodPodcasts(mood), SOURCE_TIMEOUT_MS.podcasts, unavailable<Podcast>()),
  ]);
  const body = MoodFeedResponseSchema.parse({
    mood: { id: mood.id, label: mood.label, description: mood.description },
    tracks,
    stations,
    podcasts,
    genres: moodGenres(mood),
  });

  return NextResponse.json(body, {
    headers: { 'Cache-Control': moodCacheControl([body.tracks, body.stations, body.podcasts]) },
  });
}

/**
 * Same feed for everyone, so the CDN absorbs repeats (the static genre links do not count):
 * - every external source answered and at least one has something to show: 10 minutes on the
 *   CDN and 5 in the browser, like the sibling catalogue routes (switching chips back and forth
 *   does not refetch);
 * - one source down but another with something to show: one minute, without stale reuse, so a
 *   short Audius outage is not served to a whole region for twenty minutes;
 * - nothing to show: not cached.
 */
function moodCacheControl(sections: readonly Section<unknown>[]) {
  const hasResults = sections.some(
    (section) => section.status === 'results' && section.items.length > 0,
  );
  if (!hasResults) return 'no-store';
  if (sections.some((section) => section.status === 'unavailable')) {
    return 'public, max-age=0, s-maxage=60';
  }
  return 'public, max-age=300, s-maxage=600, stale-while-revalidate=600';
}
