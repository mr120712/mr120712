// @solco/sdk — costruttori di URL per lo streaming.
//
// Tutte le fonti riproducibili passano da un proxy same-origin di Solco (GET),
// così la CSP e il mixed-content restano a posto. Questi metodi costruiscono
// solo l'URL: nel browser basta usarlo come `src` di un <audio> (i cookie di
// sessione partono da soli); lato server si può passarlo a `client.request` o a
// un fetch con il barattolo di cookie.
//
// YouTube è l'eccezione: non viene proxato lo stream (lo vieterebbero i termini).
// Si riproduce con il player ufficiale in un iframe/embed a partire dal videoId.

export class Streams {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return this.baseUrl + path;
  }

  /** Stream di un brano Audius. */
  audius(trackId: string): string {
    return this.url(`/api/music/audius/tracks/${encodeURIComponent(trackId)}/stream`);
  }

  /** Stream di un brano Jamendo (Premium). */
  jamendo(trackId: string): string {
    return this.url(`/api/music/jamendo/${encodeURIComponent(trackId)}/stream`);
  }

  /** Stream live di una stazione radio. */
  radio(stationId: string): string {
    return this.url(`/api/music/radio/${encodeURIComponent(stationId)}/stream`);
  }

  /** Stream di un episodio podcast. */
  podcastEpisode(podcastId: string, episodeKey: string): string {
    return this.url(
      `/api/music/podcasts/${encodeURIComponent(podcastId)}/episodes/${encodeURIComponent(
        episodeKey,
      )}/stream`,
    );
  }

  /** Stream di un brano dentro un album Audius. */
  albumTrack(albumId: string, trackId: string): string {
    return this.url(
      `/api/music/albums/${encodeURIComponent(albumId)}/tracks/${encodeURIComponent(trackId)}/stream`,
    );
  }

  /** URL di visione su YouTube (lo stream NON è proxato: usare il player ufficiale). */
  youtubeWatch(videoId: string): string {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }

  /** URL di embed del player ufficiale YouTube, per un iframe. */
  youtubeEmbed(videoId: string): string {
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`;
  }
}
