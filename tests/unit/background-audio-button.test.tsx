// @polsia:user-owned — "Ascolta in background" sblocca l'audio dentro il tocco (iOS), prima delle
// ricerche di rete che fanno perdere il gesto.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  playTrack: vi.fn(),
  primeAudio: vi.fn(),
  order: [] as string[],
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({ playTrack: mocks.playTrack, primeAudio: mocks.primeAudio }),
  trackStreamPath: () => null,
}));

const video = { videoId: 'abcdefghijk', title: 'Artista Uno - Notte Chiara', channelTitle: 'X' };
const roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.order.length = 0;
  mocks.primeAudio.mockReset().mockImplementation(() => mocks.order.push('prime'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url);
      if (path.includes('/api/music/search')) mocks.order.push('search');
      const body = path.includes('source-status')
        ? { sources: [{ id: 'audius', active: true }] }
        : { outcome: 'not_configured', tracks: [] };
      return new Response(JSON.stringify(body));
    }),
  );
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('Ascolta in background: sblocco audio nel gesto', () => {
  it('chiama primeAudio in modo sincrono nel click, prima di qualsiasi ricerca', async () => {
    vi.resetModules();
    const { BackgroundListenButton } = await import(
      '@/components/custom/music/background-listen-button'
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<BackgroundListenButton video={video} />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = container.querySelector('button');
    if (!button) throw new Error('pulsante mancante');

    await act(async () => {
      button.click();
      // Still inside the tap: nothing awaited yet.
      expect(mocks.primeAudio).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.order[0]).toBe('prime');
    expect(mocks.order).toContain('search');
  });
});
