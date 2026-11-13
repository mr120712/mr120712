// @polsia:user-owned
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  currentTrack: null as { qualifiedId: string } | null,
  status: 'idle' as string,
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/image', () => ({
  default: (props: { alt: string }) => <span data-testid="thumb">{props.alt}</span>,
}));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: mocks.currentTrack,
    status: mocks.status,
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
}));

import { LiveMusicSearch } from '@/components/custom/music/live-music-search';

function track(id: string, title: string, eligible = true) {
  return {
    provider: 'audius',
    id,
    qualifiedId: `audius:${id}`,
    title,
    artistName: `Artista ${title}`,
    artistUrl: `https://audius.co/artista-${id}`,
    trackUrl: `https://audius.co/artista-${id}/brano`,
    artworkUrl: `https://audius.co/art-${id}.jpg`,
    durationSeconds: 180,
    playbackEligible: eligible,
  };
}

const roots: Array<ReturnType<typeof createRoot>> = [];
let container: HTMLDivElement;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<LiveMusicSearch />));
  return container;
}

function type(value: string) {
  const input = container.querySelector('input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush() {
  // Fa scattare il debounce e lascia risolvere la promise di apiFetch.
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.currentTrack = null;
  mocks.status = 'idle';
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  container?.remove();
  vi.useRealTimers();
});

describe('LiveMusicSearch', () => {
  it('mentre scrivi mostra i migliori brani riproducibili', async () => {
    mocks.apiFetch.mockResolvedValue({
      tracks: [track('a', 'Primo'), track('b', 'Secondo'), track('c', 'NonPlay', false)],
    });
    render();
    type('cia');
    await flush();

    const searchCall = mocks.apiFetch.mock.calls.find(([url]) =>
      String(url).startsWith('/api/music/search'),
    );
    expect(searchCall?.[0]).toBe('/api/music/search?source=audius&q=cia');
    const text = container.textContent ?? '';
    expect(text).toContain('Primo');
    expect(text).toContain('Secondo');
    // Il brano non riproducibile non entra tra i suggerimenti.
    expect(text).not.toContain('NonPlay');
    // C'è la scorciatoia alla ricerca completa.
    expect(text).toContain('Vedi tutti i risultati');
  });

  it('non cerca con meno di 2 caratteri', async () => {
    mocks.apiFetch.mockResolvedValue({ tracks: [] });
    render();
    type('a');
    await flush();
    expect(
      mocks.apiFetch.mock.calls.some(([url]) => String(url).startsWith('/api/music/search')),
    ).toBe(false);
  });

  it('un clic su un suggerimento avvia la riproduzione dal player', async () => {
    mocks.apiFetch.mockResolvedValue({ tracks: [track('a', 'Primo')] });
    render();
    type('primo');
    await flush();

    const button = container.querySelector('[id$="-opt-a"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    act(() => {
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [, streamPath] = mocks.playTrack.mock.calls[0] ?? [];
    expect(streamPath).toBe('/api/music/audius/tracks/a/stream');
  });
});
