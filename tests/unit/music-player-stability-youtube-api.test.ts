// @polsia:user-owned — regressione: l'API IFrame di YouTube che non risponde (il secondo script
// del caricatore ufficiale fallisce o resta appeso) non lascia ogni video in caricamento fino al
// reload: il tentativo scade, non resta in cache e il tocco successivo riprova da capo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const API_SRC = 'https://www.youtube.com/iframe_api';
type YouTubeWindow = { YT?: unknown; onYouTubeIframeAPIReady?: () => void };
const youtubeWindow = window as unknown as YouTubeWindow;

function scripts() {
  return document.head.querySelectorAll(`script[src="${API_SRC}"]`);
}

async function freshLoader() {
  vi.resetModules();
  return import('@/lib/music/youtube-iframe-api');
}

beforeEach(() => {
  youtubeWindow.YT = undefined;
  youtubeWindow.onYouTubeIframeAPIReady = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  for (const script of scripts()) script.remove();
  youtubeWindow.YT = undefined;
  youtubeWindow.onYouTubeIframeAPIReady = undefined;
});

describe('caricamento della IFrame Player API di YouTube', () => {
  it('un caricamento appeso scade e il tentativo successivo riprova da capo', async () => {
    vi.useFakeTimers();
    const { loadYouTubeIframeApi, YOUTUBE_API_TIMEOUT_MS } = await freshLoader();
    const first = loadYouTubeIframeApi();
    const outcome = first.then(
      () => 'caricata',
      (error: Error) => error.message,
    );
    expect(scripts()).toHaveLength(1);
    // The official loader set YT.loading, but its widget script never arrives.
    youtubeWindow.YT = { loading: 1 };
    expect(loadYouTubeIframeApi()).toBe(first);

    await vi.advanceTimersByTimeAsync(YOUTUBE_API_TIMEOUT_MS);
    await expect(outcome).resolves.toBe('YouTube IFrame API non risponde.');
    // Half-loaded state and stale script gone: the official loader would skip a retry otherwise.
    expect(youtubeWindow.YT).toBeUndefined();
    expect(scripts()).toHaveLength(0);

    const second = loadYouTubeIframeApi();
    expect(second).not.toBe(first);
    expect(scripts()).toHaveLength(1);
    const api = { Player: function Player() {} };
    youtubeWindow.YT = api;
    youtubeWindow.onYouTubeIframeAPIReady?.();
    await expect(second).resolves.toBe(api);
  });

  it('una risposta senza YT.Player non resta in cache', async () => {
    const { loadYouTubeIframeApi } = await freshLoader();
    const first = loadYouTubeIframeApi();
    youtubeWindow.onYouTubeIframeAPIReady?.();
    await expect(first).rejects.toThrow('YouTube IFrame API non disponibile.');
    expect(loadYouTubeIframeApi()).not.toBe(first);
  });

  it('caricata in tempo, il timer non la annulla più', async () => {
    vi.useFakeTimers();
    const { loadYouTubeIframeApi, YOUTUBE_API_TIMEOUT_MS } = await freshLoader();
    const pending = loadYouTubeIframeApi();
    const api = { Player: function Player() {} };
    youtubeWindow.YT = api;
    youtubeWindow.onYouTubeIframeAPIReady?.();
    await expect(pending).resolves.toBe(api);
    await vi.advanceTimersByTimeAsync(YOUTUBE_API_TIMEOUT_MS * 2);
    expect(youtubeWindow.YT).toBe(api);
    await expect(loadYouTubeIframeApi()).resolves.toBe(api);
  });
});
