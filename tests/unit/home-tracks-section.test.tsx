// @polsia:user-owned
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: 'idle',
    playTrack: vi.fn(),
    togglePlayback: vi.fn(),
  }),
}));

import { HomeTracksSection } from '@/components/custom/music/home-tracks-section';

function item(id: string, title: string) {
  return {
    id,
    title,
    artist: null,
    streamUrl: `/api/music/home-tracks/stream?p=${id}`,
    durationSeconds: 0,
  };
}

const roots: Array<ReturnType<typeof createRoot>> = [];
let container: HTMLDivElement;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<HomeTracksSection />));
  return container;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function searchCalls() {
  return mocks.apiFetch.mock.calls.filter(([u]) => String(u).startsWith('/api/music/home-tracks'));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  container?.remove();
  vi.useRealTimers();
});

describe('HomeTracksSection auto-refresh', () => {
  it('carica dalla cache e mostra i brani in evidenza', async () => {
    mocks.apiFetch.mockResolvedValue({ items: [item('a.mp3', 'Primo'), item('b.mp3', 'Secondo')] });
    render();
    await flush();
    expect(searchCalls()[0]?.[0]).toBe('/api/music/home-tracks');
    const text = container.textContent ?? '';
    expect(text).toContain('Primo');
    expect(text).toContain('Secondo');
    expect(text).toContain('IN EVIDENZA');
  });

  it('al ritorno sulla scheda ricarica una sola volta con cache-bust (focus + visibilitychange)', async () => {
    mocks.apiFetch.mockResolvedValue({ items: [item('a.mp3', 'Primo')] });
    render();
    await flush();
    const before = searchCalls().length;

    // Oltre il throttle, poi scheda di nuovo visibile: focus e visibilitychange insieme devono
    // produrre UN SOLO aggiornamento (dedupe tramite il throttle segnato all'inizio del load).
    await act(async () => {
      vi.advanceTimersByTime(16_000);
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    const calls = searchCalls();
    expect(calls.length).toBe(before + 1);
    expect(String(calls.at(-1)?.[0])).toMatch(/^\/api\/music\/home-tracks\?t=\d+/);
  });

  it('non ricarica due volte dentro la finestra di throttle', async () => {
    mocks.apiFetch.mockResolvedValue({ items: [item('a.mp3', 'Primo')] });
    render();
    await flush();
    const before = searchCalls().length;
    await act(async () => {
      vi.advanceTimersByTime(3000); // < throttle
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(searchCalls().length).toBe(before);
  });
});
