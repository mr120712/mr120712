// @solco/sdk — tipi dell'API di Solco.
//
// Rispecchiano i contratti zod condivisi dal backend (src/lib/contracts/*). Sono
// tipi di sola compilazione: l'SDK non convalida a runtime (nessuna dipendenza da
// zod), così resta leggero e usabile nel browser. Se il backend cambia forma,
// aggiornare questi tipi insieme al contratto.

// ---------- Audius ----------

export type AudiusPlaybackReason =
  | 'ready'
  | 'not_streamable'
  | 'gated'
  | 'access_denied'
  | 'access_unknown'
  | 'license_not_allowed'
  | 'rate_limited'
  | 'state_unknown';

export interface AudiusTrack {
  provider: 'audius';
  id: string;
  qualifiedId: string;
  title: string;
  artistName: string;
  artistHandle: string;
  artistId: string;
  artistQualifiedId: string;
  artistUrl: string;
  trackUrl: string;
  artworkUrl: string;
  durationSeconds: number | null;
  genre: string | null;
  mood: string | null;
  tags: string | null;
  releaseDate: string | null;
  license: string | null;
  licensorName: string | null;
  copyrightNotice: string | null;
  producerCopyrightNotice: string | null;
  attributionRemovalRequested: boolean;
  attributionComplete: boolean;
  playbackEligible: boolean;
  playbackReason: AudiusPlaybackReason;
}

export interface AudiusArtist {
  provider: 'audius';
  id: string;
  qualifiedId: string;
  name: string;
  handle: string;
  artworkUrl: string;
  profileUrl: string;
}

export interface AudiusPlaylist {
  provider: 'audius';
  id: string;
  qualifiedId: string;
  title: string;
  artistName: string;
  artistUrl: string;
  playlistUrl: string;
  artworkUrl: string;
  trackCount: number | null;
}

export interface AudiusAlbum {
  provider: 'audius';
  id: string;
  qualifiedId: string;
  title: string;
  artistName: string | null;
  artistUrl: string | null;
  albumUrl: string;
  artworkUrl: string | null;
  releaseDate: string | null;
  trackCount: number | null;
}

// ---------- YouTube ----------

export interface YouTubeVideo {
  provider: 'youtube';
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string | null;
  description: string | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
}

export type YouTubeVideoWithDuration = YouTubeVideo & { durationSeconds: number | null };

export interface YouTubeChartResponse {
  outcome: 'results' | 'no_results' | 'unavailable';
  regionCode: string;
  videos: YouTubeVideoWithDuration[];
}

/** Avviso sullo stato del budget di ricerca YouTube. */
export interface YouTubeSearchNotice {
  freshness: 'live' | 'saved';
  savedAt: string | null;
  limit: 'personal' | 'connection' | 'everyone' | 'busy' | null;
  resetsAt: string;
  [key: string]: unknown;
}

// ---------- Fonti e stato ricerca ----------

export type SearchSourceId = 'audius' | 'youtube';

export type SearchOutcome =
  | 'idle'
  | 'results'
  | 'no_results'
  | 'partial'
  | 'unavailable'
  | 'inactive';

export interface MusicSearchSource {
  id: SearchSourceId;
  label: string;
  active: boolean;
  searchOutcome: SearchOutcome;
  unavailableReason?: 'not_configured' | 'quota_exceeded' | 'api_error';
  blockers?: Array<'credential_missing'>;
  retryAfterSeconds?: number;
  summary: string;
  prerequisite: string;
}

export interface MusicSourceStatusList {
  sources: MusicSearchSource[];
}

// ---------- Home / Trending ----------

export type HomeSectionOutcome = 'results' | 'no_results' | 'unavailable';

export interface MusicHomeResponse {
  sourceStatus: MusicSearchSource;
  trending: { outcome: HomeSectionOutcome; tracks: AudiusTrack[] };
  releases: { outcome: HomeSectionOutcome; albums: AudiusAlbum[] };
  playlists: { outcome: HomeSectionOutcome; playlists: AudiusPlaylist[] };
  artists: { outcome: HomeSectionOutcome; artists: AudiusArtist[] };
}

export interface MusicTrendingResponse {
  outcome: 'results' | 'no_results' | 'partial' | 'unavailable' | 'inactive';
  tracks: AudiusTrack[];
  albums: AudiusAlbum[];
  sourceStatus: MusicSearchSource;
}

// ---------- Ricerca per fonte ----------

export interface MusicSearchResponse {
  source: SearchSourceId;
  outcome: 'results' | 'no_results' | 'partial' | 'unavailable' | 'inactive';
  tracks: AudiusTrack[];
  artists: AudiusArtist[];
  playlists: AudiusPlaylist[];
  albums: AudiusAlbum[];
  videos: YouTubeVideo[];
  sourceStatus: MusicSearchSource;
}

// ---------- Ricerca unificata ----------

export type UnifiedSourceStatus = 'results' | 'empty' | 'unavailable' | 'skipped';

export type UnifiedResult =
  | {
      kind: 'audius';
      key: string;
      score: number;
      track: AudiusTrack;
      youtubeAlternative: YouTubeVideo | null;
    }
  | { kind: 'youtube'; key: string; score: number; video: YouTubeVideo }
  | { kind: 'radio'; key: string; score: number; station: RadioStation }
  | { kind: 'podcast'; key: string; score: number; podcast: Podcast };

export interface UnifiedSearchResponse {
  query: string;
  youtubeRequested: boolean;
  results: UnifiedResult[];
  sources: {
    audius: {
      status: UnifiedSourceStatus;
      tracks: AudiusTrack[];
      artists: AudiusArtist[];
      playlists: AudiusPlaylist[];
      albums: AudiusAlbum[];
    };
    youtube: { status: UnifiedSourceStatus; videos: YouTubeVideo[] };
    radio: { status: UnifiedSourceStatus; stations: RadioStation[] };
    podcasts: { status: UnifiedSourceStatus; podcasts: Podcast[] };
  };
  youtube?: YouTubeSearchNotice;
}

// ---------- Mood ----------

export type MoodSectionStatus = 'results' | 'unavailable';

export interface MoodTrack {
  id: string;
  qualifiedId: string;
  title: string;
  artistName: string;
  artistUrl: string;
  trackUrl: string;
  artworkUrl: string;
  durationSeconds: number | null;
  license: string | null;
  licensorName: string | null;
  copyrightNotice: string | null;
  attributionRemovalRequested: boolean;
  playbackEligible: boolean;
  playbackReason: AudiusPlaybackReason;
}

export interface MoodGenreLink {
  slug: string;
  name: string;
  href: string;
}

export interface MoodFeedResponse {
  mood: { id: string; label: string; description: string };
  tracks: { status: MoodSectionStatus; items: MoodTrack[] };
  stations: { status: MoodSectionStatus; items: RadioStation[] };
  podcasts: { status: MoodSectionStatus; items: Podcast[] };
  genres: { status: MoodSectionStatus; items: MoodGenreLink[] };
}

// ---------- Radio ----------

export interface RadioStation {
  id: string;
  name: string;
  artworkUrl: string | null;
  country: string | null;
  countryCode: string | null;
  tags: string[];
  codec: string | null;
  bitrate: number | null;
  homepage: string | null;
  votes: number;
}

export interface RadioListResponse {
  outcome: 'results' | 'no_results' | 'unavailable';
  stations: RadioStation[];
}

export interface RadioListQuery {
  q?: string;
  tag?: string;
  /** Codice paese ISO a due lettere (es. "IT"). */
  country?: string;
  /** 1–60, default 30. */
  limit?: number;
}

// ---------- Podcast ----------

export interface Podcast {
  id: string;
  title: string;
  author: string | null;
  artworkUrl: string | null;
  genre: string | null;
}

export interface PodcastEpisode {
  key: string;
  title: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  description: string | null;
  artworkUrl: string | null;
}

export interface PodcastListResponse {
  outcome: 'results' | 'no_results' | 'unavailable';
  podcasts: Podcast[];
}

export interface PodcastDetailResponse {
  outcome: 'results' | 'no_results' | 'unavailable';
  podcast: Podcast | null;
  episodes: PodcastEpisode[];
}

// ---------- Stato pubblico (monitoraggio) ----------

export type MonitorOverallStatus = 'ok' | 'degraded' | 'down';

export type MonitorCheckId =
  | 'database'
  | 'signup_write'
  | 'auth_config'
  | 'google_signin'
  | 'youtube_quota'
  | 'youtube_search'
  | 'audius'
  | 'radio'
  | 'podcasts'
  | 'jamendo'
  | 'email'
  | 'anthropic'
  | 'stripe'
  | 'cron_cleanup';

export interface PublicMonitorStatus {
  status: MonitorOverallStatus | 'unknown';
  checkedAt: string | null;
  stale: boolean;
  failing: MonitorCheckId[];
  warnings: MonitorCheckId[];
  /** Controlli che hanno davvero girato e sono passati. Un id assente da ok/failing/warnings
   *  non è stato eseguito in questo giro e non va mostrato come "verde". */
  ok: MonitorCheckId[];
}

// ---------- Ascolti ----------

export interface PlayResult {
  allowed: boolean;
  used?: number;
  limit?: number;
}

// ---------- Autenticazione (better-auth) ----------

export interface SolcoUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface SolcoSession {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
    [key: string]: unknown;
  };
  user: SolcoUser;
}

export interface SignInEmailInput {
  email: string;
  password: string;
  rememberMe?: boolean;
  callbackURL?: string;
}

export interface SignUpEmailInput {
  email: string;
  password: string;
  name: string;
  image?: string;
  callbackURL?: string;
}

// ---------- Download offline ("scarica il permesso") ----------

export interface OfflineAttribution {
  sourceName: string | null;
  sourceUrl: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
  creditLine: string | null;
}

export interface OfflineDownloadMeta {
  source: 'audius-download' | 'podcast-download';
  downloadKey: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSeconds: number | null;
  mimeType: string;
  attribution: OfflineAttribution;
}

export interface OfflineDownload {
  /** Byte audio del brano scaricato. */
  bytes: Uint8Array;
  /** Metadati per salvare il brano nella libreria locale. */
  meta: OfflineDownloadMeta;
  /** Content-Type dichiarato dalla risposta. */
  contentType: string;
}
