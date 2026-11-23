// @polsia:user-owned — caricatore della IFrame Player API di YouTube, senza UI né CSS: il player
// globale lo importa da qui, così il CSS del player della coda YouTube non entra in ogni pagina.

export type YouTubePlayerInstance = {
  loadVideoById: (videoId: string) => void;
  cueVideoById?: (videoId: string) => void;
  playVideo?: () => void;
  pauseVideo: () => void;
  destroy: () => void;
  // Playlist API, present once the official player is ready: YouTube prepares the next video.
  loadPlaylist?: (playlist: string[], index?: number, startSeconds?: number) => void;
  cuePlaylist?: (playlist: string[], index?: number, startSeconds?: number) => void;
  nextVideo?: () => void;
  previousVideo?: () => void;
  playVideoAt?: (index: number) => void;
  getPlaylistIndex?: () => number;
  getVideoData?: () => { video_id?: string } | null | undefined;
};

export type YouTubePlayerEvent = { data: number };

export type YouTubeNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width: string;
      height: string;
      host: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: () => void;
        onStateChange: (event: YouTubePlayerEvent) => void;
        onError: (event: YouTubePlayerEvent) => void;
      };
    },
  ) => YouTubePlayerInstance;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api';

let apiPromise: Promise<YouTubeNamespace> | null = null;

/**
 * Oltre questo tempo l'API YouTube si considera non caricata. Lo script ufficiale ne inietta un
 * secondo (www-widgetapi.js): se quello fallisce o resta appeso, onYouTubeIframeAPIReady non arriva
 * mai e nessun onerror scatta; senza un limite ogni video resterebbe in caricamento fino al reload.
 */
export const YOUTUBE_API_TIMEOUT_MS = 15_000;

/** Carica una sola volta lo script ufficiale della IFrame Player API. */
export function loadYouTubeIframeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  const attempt = new Promise<YouTubeNamespace>((resolve, reject) => {
    const script = document.createElement('script');
    let timer: number | null = null;
    // Un tentativo fallito non resta in cache: il prossimo tocco riprova da capo.
    const fail = (message: string) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (apiPromise === attempt) apiPromise = null;
      reject(new Error(message));
    };
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      if (window.YT?.Player) {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        resolve(window.YT);
      } else {
        fail('YouTube IFrame API non disponibile.');
      }
    };
    script.src = YOUTUBE_IFRAME_API_URL;
    script.async = true;
    script.onerror = () => fail('Script YouTube IFrame API non caricato.');
    timer = window.setTimeout(() => {
      // Il caricatore ufficiale non reinietta il suo secondo script finché vede YT.loading: per
      // riprovare davvero si toglie lo stato a metà e lo script di questo tentativo.
      if (window.YT && !window.YT.Player) {
        try {
          delete window.YT;
        } catch {
          window.YT = undefined;
        }
      }
      script.remove();
      fail('YouTube IFrame API non risponde.');
    }, YOUTUBE_API_TIMEOUT_MS);
    document.head.appendChild(script);
  });
  apiPromise = attempt;
  return attempt;
}
