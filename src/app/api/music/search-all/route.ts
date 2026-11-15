// @polsia:user-owned — GET /api/music/search-all: ricerca unificata. Una query interroga in
// parallelo Audius (sempre), YouTube (SOLO all'invio esplicito, youtubeConsent=accepted, per non
// bruciare la quota mentre si digita), radio e podcast, ognuna con il suo tempo massimo e il suo
// stato, così una fonte lenta o in errore non blocca le altre. Riusa le funzioni di ricerca già
// esistenti (incluso il budget YouTube con l'avviso quando la quota è finita): qui nulla cambia i
// loro limiti. Restituisce un elenco unico ordinato e deduplicato più le sezioni per fonte.
// Con `featured=1` (client che sanno mostrarli) aggiunge i brani in evidenza di Solco con i diritti
// dichiarati in diritti.json (featured-search.server): fonte propria con tempo massimo e stato.
// Con `audiocom=1` (client che sanno mostrarli, solo per ricerche complete) aggiunge i brani musicali
// di audio.com (audiocom.server: account collegato dall'admin, cache e limite globale): fonte
// propria con tempo massimo e stato (`disconnected` se nessun account è collegato). I risultati di
// audio.com non dipendono da chi cerca, quindi la risposta resta condivisibile in cache; l'unica
// eccezione è chi ha finito la propria quota di ricerche su audio.com (o non ha un'identità
// affidabile): per lui audio.com è `unavailable` e la risposta è privata, mai in cache condivisa.
import 'server-only';
import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { auth } from '@/lib/auth';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import type { AudioComSourceStatus, AudioComTrack } from '@/lib/contracts/audiocom';
import { type HomeTrack, HomeTrackResultSchema } from '@/lib/contracts/home-tracks';
import {
  type Podcast,
  PodcastSchema,
  type RadioStation,
  RadioStationSchema,
} from '@/lib/contracts/library';
import {
  type AudiusAlbumSearchResult,
  AudiusAlbumSearchSchema,
  type AudiusArtistSearchResult,
  AudiusArtistSearchSchema,
  type AudiusPlaylistSearchResult,
  AudiusPlaylistSearchSchema,
  type AudiusTrackSearchResult,
  AudiusTrackSearchSchema,
  type YouTubeVideoSearchResult,
  YouTubeVideoSearchResultSchema,
} from '@/lib/contracts/music';
import {
  UNIFIED_AUDIOCOM_LIMIT,
  UNIFIED_AUDIOCOM_PARAM,
  UNIFIED_AUDIUS_LIST_LIMIT,
  UNIFIED_AUDIUS_TRACK_LIMIT,
  UNIFIED_FEATURED_LIMIT,
  UNIFIED_FEATURED_PARAM,
  UNIFIED_PODCAST_LIMIT,
  UNIFIED_RADIO_LIMIT,
  UnifiedSearchResponseSchema,
  type UnifiedSourceStatus,
} from '@/lib/contracts/unified-search';
import type { YouTubeSearchNotice } from '@/lib/contracts/youtube-search';
import { searchAudioCom } from '@/lib/music/audiocom.server';
import { audioComStreamDiagnostics } from '@/lib/music/audiocom-stream-diagnostics';
import { searchFeaturedTracks } from '@/lib/music/featured-search.server';
import { searchMusic } from '@/lib/music/music-api.server';
import { searchPodcasts } from '@/lib/music/podcasts.server';
import { listStations } from '@/lib/music/radio-browser.server';
import { rankUnifiedResults } from '@/lib/music/unified-search';

export const dynamic = 'force-dynamic';
/** Oltre il tempo massimo della fonte più lenta (Audius 12 s) più il controllo del limite. */
export const maxDuration = 20;

/** Tempo massimo per fonte: oltre, la sezione è "unavailable" e le altre proseguono. */
const SOURCE_TIMEOUT_MS = {
  audius: 12_000,
  youtube: 10_000,
  radio: 9_000,
  podcasts: 6_500,
  // L'indice è in cache: questo tempo conta solo quando va ricostruito (elenco Blob + diritti.json).
  // Oltre, la ricostruzione prosegue e serve le ricerche successive.
  featured: 6_000,
  // Rinnovo del token (raro) + limite globale + ricerca (4,5 s al massimo): oltre, "unavailable".
  audiocom: 7_000,
} as const;
/** Stazioni chieste per avere scelta dopo lo scarto dei doppioni; mostrate fino a UNIFIED_RADIO_LIMIT. */
const RADIO_FETCH_LIMIT = 12;

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };

type AudiusSection = {
  status: UnifiedSourceStatus;
  tracks: AudiusTrackSearchResult[];
  artists: AudiusArtistSearchResult[];
  playlists: AudiusPlaylistSearchResult[];
  albums: AudiusAlbumSearchResult[];
};
type YouTubeSection = {
  status: UnifiedSourceStatus;
  videos: YouTubeVideoSearchResult[];
  notice?: YouTubeSearchNotice;
};
type RadioSection = { status: UnifiedSourceStatus; stations: RadioStation[] };
type PodcastSection = { status: UnifiedSourceStatus; podcasts: Podcast[] };
type FeaturedSection = { status: UnifiedSourceStatus; tracks: HomeTrack[] };
type AudioComSection = {
  status: AudioComSourceStatus;
  tracks: AudioComTrack[];
  /** Fermato dalla quota personale di chi cerca: esito solo suo, risposta privata. */
  requesterLimited?: boolean;
};

/** Corsa fra il lavoro e il tempo massimo: alla scadenza (o in errore) torna il valore di riserva. */
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

function sectionStatus(outcome: string, count: number): UnifiedSourceStatus {
  if (outcome === 'unavailable' || outcome === 'inactive') return 'unavailable';
  return count > 0 ? 'results' : 'empty';
}

async function audiusSection(query: string): Promise<AudiusSection> {
  const result = await searchMusic('audius', query);
  const tracks = validItems(AudiusTrackSearchSchema, result.tracks).slice(
    0,
    UNIFIED_AUDIUS_LIST_LIMIT,
  );
  const artists = validItems(AudiusArtistSearchSchema, result.artists).slice(
    0,
    UNIFIED_AUDIUS_LIST_LIMIT,
  );
  const playlists = validItems(AudiusPlaylistSearchSchema, result.playlists).slice(
    0,
    UNIFIED_AUDIUS_LIST_LIMIT,
  );
  const albums = validItems(AudiusAlbumSearchSchema, result.albums).slice(
    0,
    UNIFIED_AUDIUS_LIST_LIMIT,
  );
  const count = tracks.length + artists.length + playlists.length + albums.length;
  return { status: sectionStatus(result.outcome, count), tracks, artists, playlists, albums };
}

const AUDIUS_UNAVAILABLE: AudiusSection = {
  status: 'unavailable',
  tracks: [],
  artists: [],
  playlists: [],
  albums: [],
};

async function youtubeSection(query: string, identity: string | null): Promise<YouTubeSection> {
  const result = await searchMusic('youtube', query, { youtubeIdentity: identity });
  const videos = validItems(YouTubeVideoSearchResultSchema, result.videos);
  // searchMusic youtube aggiunge l'avviso (in tempo reale o salvato, con il limite che blocca una
  // ricerca nuova): va preservato in cima alla risposta.
  const notice = 'youtube' in result ? result.youtube : undefined;
  return { status: sectionStatus(result.outcome, videos.length), videos, notice };
}

const YOUTUBE_SKIPPED: YouTubeSection = { status: 'skipped', videos: [] };
const YOUTUBE_UNAVAILABLE: YouTubeSection = { status: 'unavailable', videos: [] };

async function radioSection(query: string): Promise<RadioSection> {
  const result = await listStations({ q: query, limit: RADIO_FETCH_LIMIT });
  const stations = validItems(RadioStationSchema, result.stations).slice(0, UNIFIED_RADIO_LIMIT);
  return { status: sectionStatus(result.outcome, stations.length), stations };
}

const RADIO_UNAVAILABLE: RadioSection = { status: 'unavailable', stations: [] };

async function podcastSection(query: string): Promise<PodcastSection> {
  const result = await searchPodcasts(query);
  const podcasts = validItems(PodcastSchema, result.podcasts).slice(0, UNIFIED_PODCAST_LIMIT);
  return { status: sectionStatus(result.outcome, podcasts.length), podcasts };
}

const PODCAST_UNAVAILABLE: PodcastSection = { status: 'unavailable', podcasts: [] };

/** Brani in evidenza: solo quelli con i diritti dichiarati (il filtro è in featured-search). */
async function featuredSection(query: string): Promise<FeaturedSection> {
  const result = await searchFeaturedTracks(query, UNIFIED_FEATURED_LIMIT);
  const tracks = validItems(HomeTrackResultSchema, result.tracks).slice(0, UNIFIED_FEATURED_LIMIT);
  return { status: sectionStatus(result.outcome, tracks.length), tracks };
}

const FEATURED_UNAVAILABLE: FeaturedSection = { status: 'unavailable', tracks: [] };

/**
 * Brani musicali di audio.com (licenza e attribuzione nel brano; lo stream solo se riproducibile).
 * `identity` serve alla quota personale delle ricerche che arrivano davvero ad audio.com.
 */
async function audiocomSection(query: string, identity: string | null): Promise<AudioComSection> {
  const result = await searchAudioCom(query, { identity });
  return {
    status: result.status,
    tracks: result.tracks.slice(0, UNIFIED_AUDIOCOM_LIMIT),
    requesterLimited: result.requesterLimited === true,
  };
}

const AUDIOCOM_UNAVAILABLE: AudioComSection = { status: 'unavailable', tracks: [] };

/**
 * Stato di audio.com per le regole di cache: `disconnected` conta come `unavailable` (cache breve,
 * così i risultati compaiono presto dopo il collegamento), `skipped` non conta.
 */
function audiocomCacheStatus(status: AudioComSourceStatus): UnifiedSourceStatus | null {
  if (status === 'skipped') return null;
  return status === 'disconnected' ? 'unavailable' : status;
}

/**
 * Cache HTTP:
 * - con YouTube (dati per identità: quota personale/di connessione e avviso) mai in cache, così non
 *   si serve ad altri un "unavailable" YouTube né l'avviso di un altro ascoltatore;
 * - senza YouTube (Audius + radio + podcast, dati pubblici uguali per tutti) breve cache condivisa
 *   secondo le regole delle route di catalogo; niente cache se non c'è nulla da mostrare;
 * - con brani in evidenza nella risposta al massimo 1 minuto in cache condivisa (niente cache nel
 *   browser né stale-while-revalidate): un diritto revocato in diritti.json sparisce dalla ricerca
 *   quando l'indice segue la nuova versione del catalogo (di solito ~30-90 secondi, al più ~5
 *   minuti) più questo minuto.
 */
function unifiedCacheControl(
  youtubeRequested: boolean,
  statuses: readonly UnifiedSourceStatus[],
  featuredFound: boolean,
): string {
  if (youtubeRequested) return privateHeaders['Cache-Control'];
  if (!statuses.includes('results')) return 'no-store';
  if (featuredFound || statuses.includes('unavailable')) return 'public, max-age=0, s-maxage=60';
  return 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() ?? '';
  if (!query || query.length > 80) {
    return NextResponse.json(
      { errors: { q: 'Inserisci una ricerca da 1 a 80 caratteri.' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  // YouTube costa quota (search.list = 100 unità): si interroga SOLO all'invio esplicito, mai mentre
  // si digita. Il flag di consenso è lo stesso della ricerca per fonte.
  const youtubeRequested = url.searchParams.get('youtubeConsent') === 'accepted';
  // Le voci `featured` sono un tipo nuovo: solo i client che lo dichiarano le ricevono, così chi
  // non le conosce (app o pagine meno recenti) continua a leggere la risposta di sempre.
  const featuredRequested = url.searchParams.get(UNIFIED_FEATURED_PARAM) === '1';
  // Stessa regola per audio.com: tipo nuovo, solo per chi lo chiede.
  const audiocomRequested = url.searchParams.get(UNIFIED_AUDIOCOM_PARAM) === '1';

  // L'identità (utente autenticato o IP d'ingresso) serve alla quota YouTube per persona e al
  // limite. Come le route di catalogo, senza un'identità affidabile (sviluppo locale) non si limita.
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const identity = getRateLimitIdentity(session?.user.id ?? null, request.headers);
  if (identity) {
    const limited = await enforceRateLimit('music.search', identity);
    if (limited) {
      limited.headers.set('Cache-Control', 'private, no-store');
      return limited;
    }
  }

  const [audius, youtube, radio, podcasts, featured, audiocom] = await Promise.all([
    withDeadline(() => audiusSection(query), SOURCE_TIMEOUT_MS.audius, AUDIUS_UNAVAILABLE),
    youtubeRequested
      ? withDeadline(
          () => youtubeSection(query, identity),
          SOURCE_TIMEOUT_MS.youtube,
          YOUTUBE_UNAVAILABLE,
        )
      : Promise.resolve(YOUTUBE_SKIPPED),
    withDeadline(() => radioSection(query), SOURCE_TIMEOUT_MS.radio, RADIO_UNAVAILABLE),
    withDeadline(() => podcastSection(query), SOURCE_TIMEOUT_MS.podcasts, PODCAST_UNAVAILABLE),
    featuredRequested
      ? withDeadline(() => featuredSection(query), SOURCE_TIMEOUT_MS.featured, FEATURED_UNAVAILABLE)
      : Promise.resolve(null),
    audiocomRequested
      ? withDeadline(
          () => audiocomSection(query, identity),
          SOURCE_TIMEOUT_MS.audiocom,
          AUDIOCOM_UNAVAILABLE,
        )
      : Promise.resolve(null),
  ]);

  const results = rankUnifiedResults({
    query,
    featuredTracks: featured?.tracks ?? [],
    audiusTracks: audius.tracks.slice(0, UNIFIED_AUDIUS_TRACK_LIMIT),
    audiocomTracks: audiocom?.tracks ?? [],
    youtubeVideos: youtube.videos,
    stations: radio.stations,
    podcasts: podcasts.podcasts,
  });

  const body = UnifiedSearchResponseSchema.parse({
    query,
    youtubeRequested,
    results,
    sources: {
      audius: {
        status: audius.status,
        tracks: audius.tracks,
        artists: audius.artists,
        playlists: audius.playlists,
        albums: audius.albums,
      },
      youtube: { status: youtube.status, videos: youtube.videos },
      radio: { status: radio.status, stations: radio.stations },
      podcasts: { status: podcasts.status, podcasts: podcasts.podcasts },
      ...(featured ? { featured: { status: featured.status, tracks: featured.tracks } } : {}),
      ...(audiocom ? { audiocom: { status: audiocom.status, tracks: audiocom.tracks } } : {}),
    },
    ...(youtube.notice ? { youtube: youtube.notice } : {}),
  });

  // Nelle regole di cache contano solo le fonti pubbliche (i brani in evidenza e quelli di
  // audio.com sono uguali per tutti, come la Home); YouTube (per identità) forza no-store. Un
  // audio.com fermato dalla quota personale di chi cerca vale solo per lui: risposta privata, così
  // la CDN non serve quel "unavailable" agli altri.
  // DIAGNOSTICA TEMPORANEA: motivo e host degli stream di audio.com scartati (audiocom-stream-diagnostics.ts).
  const audiocomDiagnostics = audiocomRequested ? audioComStreamDiagnostics() : '';
  const diagnosticHeaders: Record<string, string> = audiocomDiagnostics
    ? { 'x-solco-audiocom-stream': audiocomDiagnostics }
    : {};
  if (audiocom?.requesterLimited) {
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, no-store', ...diagnosticHeaders },
    });
  }
  const audiocomStatus = audiocom ? audiocomCacheStatus(audiocom.status) : null;
  const cacheControl = unifiedCacheControl(
    youtubeRequested,
    [
      audius.status,
      radio.status,
      podcasts.status,
      ...(featured ? [featured.status] : []),
      ...(audiocomStatus ? [audiocomStatus] : []),
    ],
    featured?.status === 'results',
  );
  return NextResponse.json(body, {
    headers: { 'Cache-Control': cacheControl, ...diagnosticHeaders },
  });
}
