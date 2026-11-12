// @solco/sdk — scoperta e ricerca musica.

import type { HttpClient } from '../http.js';
import type {
  MoodFeedResponse,
  MusicHomeResponse,
  MusicSearchResponse,
  MusicSourceStatusList,
  MusicTrendingResponse,
  SearchSourceId,
  UnifiedSearchResponse,
  YouTubeChartResponse,
} from '../types.js';

export interface SearchInput {
  /** Testo da cercare (max 80 caratteri lato server). */
  q: string;
  /** Fonte da interrogare. Default: "audius". */
  source?: SearchSourceId;
  /**
   * Consenso esplicito a interrogare YouTube. Obbligatorio quando `source` è
   * "youtube": senza, il backend risponde 400. Ignorato per Audius.
   */
  youtubeConsent?: boolean;
}

export interface SearchAllInput {
  /** Testo da cercare. */
  q: string;
  /**
   * Se `true`, interroga anche YouTube (consenso esplicito). Default `false`:
   * mentre si digita si interroga solo Audius/radio/podcast, YouTube all'invio.
   */
  youtube?: boolean;
}

export class MusicResource {
  constructor(private readonly http: HttpClient) {}

  /** Catalogo della Home (tendenze, uscite, playlist, artisti su Audius). */
  async home(): Promise<MusicHomeResponse> {
    return this.http.requestJson<MusicHomeResponse>('/api/music/home');
  }

  /** Tendenze Audius (brani + album). */
  async trending(): Promise<MusicTrendingResponse> {
    return this.http.requestJson<MusicTrendingResponse>('/api/music/trending');
  }

  /** Ricerca su una singola fonte. */
  async search(input: SearchInput): Promise<MusicSearchResponse> {
    const source = input.source ?? 'audius';
    return this.http.requestJson<MusicSearchResponse>('/api/music/search', {
      query: {
        source,
        q: input.q,
        ...(source === 'youtube' && input.youtubeConsent ? { youtubeConsent: 'accepted' } : {}),
      },
    });
  }

  /** Ricerca unificata: Audius + radio + podcast (+ YouTube se `youtube: true`), elenco unico. */
  async searchAll(input: SearchAllInput): Promise<UnifiedSearchResponse> {
    return this.http.requestJson<UnifiedSearchResponse>('/api/music/search-all', {
      query: {
        q: input.q,
        ...(input.youtube ? { youtubeConsent: 'accepted' } : {}),
      },
    });
  }

  /** Feed per mood della Home (brani, stazioni, podcast, generi). */
  async mood(mood: string): Promise<MoodFeedResponse> {
    return this.http.requestJson<MoodFeedResponse>(`/api/music/moods/${encodeURIComponent(mood)}`);
  }

  /** Classifiche video di YouTube per regione (default "IT"). */
  async youtubeCharts(options: { region?: string } = {}): Promise<YouTubeChartResponse> {
    return this.http.requestJson<YouTubeChartResponse>('/api/music/youtube/charts', {
      query: { region: options.region },
    });
  }

  /** Stato delle fonti di ricerca (Audius, YouTube). */
  async sources(): Promise<MusicSourceStatusList> {
    return this.http.requestJson<MusicSourceStatusList>('/api/music/source-status');
  }
}
