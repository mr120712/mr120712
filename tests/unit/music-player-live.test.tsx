// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(async (_path: string) => ({ allowed: true })) }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/radio' }));

import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const station: MusicPlayerTrack = {
  qualifiedId: 'radio:station-1',
  title: 'Radio Prova',
  artistName: 'Italy',
  sourceLabel: 'Radio dal vivo',
  sourceUrl: null,
  playbackMode: 'radio',
};
const episodeA: MusicPlayerTrack = {
  qualifiedId: 'podcast:123~episodeA',
  title: 'Episodio A',
  artistName: 'Show',
  sourceLabel: 'Podcast',
  sourceUrl: null,
  durationSeconds: 600,
  playbackMode: 'podcast',
};
const episodeB: MusicPlayerTrack = {
  ...episodeA,
  qualifiedId: 'podcast:123~episodeB',
  title: 'Episodio B',
};
const roots: Array<ReturnType<typeof createRoot>> = [];

function Probe() {
  const player = useMusicPlayer();
  return (
    <>
      <button
        type="button"
        onClick={() => void player.playTrack(station, '/api/music/radio/station-1/stream')}
      >
        Avvia radio
      </button>
      <button
        type="button"
        onClick={() =>
          void player.playTrack(episodeA, '/api/music/podcasts/123/episodes/episodeA/stream', [
            episodeA,
            episodeB,
          ])
        }
      >
        Avvia podcast
      </button>
    </>
  );
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <Probe />
      </MusicPlayerProvider>,
    ),
  );
  return container;
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Pulsante ${label} non trovato.`);
  return found;
}

beforeEach(() => {
  mocks.apiFetch.mockReset().mockResolvedValue({ allowed: true });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('player: radio e podcast', () => {
  it('calcola percorsi di stream solo per ID validi', () => {
    expect(trackStreamPath(station)).toBe('/api/music/radio/station-1/stream');
    expect(trackStreamPath(episodeA)).toBe('/api/music/podcasts/123/episodes/episodeA/stream');
    expect(trackStreamPath({ ...station, qualifiedId: 'radio:../x' })).toBeNull();
    expect(trackStreamPath({ ...episodeA, qualifiedId: 'podcast:abc~x' })).toBeNull();
  });

  it('avvia una radio in diretta senza verifica Audius e senza avanzamento', async () => {
    const container = await mount();
    await act(async () => {
      button(container, 'Avvia radio').click();
      await Promise.resolve();
    });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      '/api/music/radio/station-1/stream',
    );
    expect(container.textContent).toContain('LIVE');
    expect(container.textContent).toContain('In diretta');
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')?.disabled).toBe(true);
  });

  it('apre e chiude il player a schermo intero e gestisce casuale e ripeti', async () => {
    const container = await mount();
    await act(async () => {
      button(container, 'Avvia podcast').click();
      await Promise.resolve();
    });
    const full = container.querySelector<HTMLElement>(
      'section[aria-label="Player a schermo intero"]',
    );
    expect(full?.hidden).toBe(true);
    await act(async () => button(container, 'Apri il player: Episodio A').click());
    expect(full?.hidden).toBe(false);
    expect(document.body.classList.contains('music-player-expanded')).toBe(true);

    const shuffle = button(container, 'Riproduzione casuale');
    await act(async () => shuffle.click());
    expect(shuffle.getAttribute('aria-pressed')).toBe('true');
    await act(async () => button(container, 'Ripeti: disattivato').click());
    expect(container.querySelector('button[aria-label="Ripeti: tutta la coda"]')).not.toBeNull();

    await act(async () => button(container, 'Riduci il player').click());
    expect(full?.hidden).toBe(true);
  });
});
