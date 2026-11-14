// @polsia:user-owned — "Testo" nel player a schermo intero: il pulsante c'è SOLO per i brani in
// evidenza, gli upload degli utenti e i file dell'ascoltatore; mai per Audius, YouTube, radio o i
// brani scaricati. Aperto, il pannello chiede il testo del brano corrente (stessa richiesta per
// ogni brano idoneo) e si chiude col pulsante (aria-pressed).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (path: string, _init?: unknown): Promise<unknown> => {
    if (path.startsWith('/api/music/lyrics')) {
      return {
        lyrics: {
          kind: 'synced',
          lines: [{ timeMs: 0, text: 'Riga del testo' }],
          source: 'featured',
          credit: 'Testo: Autrice',
        },
      };
    }
    return { allowed: true };
  }),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@/lib/local-music/playback', () => ({
  createObjectUrlForTrack: vi.fn(async () => ({
    url: 'blob:http://localhost/x',
    revoke: () => {},
  })),
  createObjectUrlForArtwork: vi.fn(async () => null),
  getTrack: vi.fn(async () => null),
  setTrackDuration: vi.fn(async () => undefined),
}));
vi.mock('@/lib/local-music/lyrics', () => ({
  loadLocalLyrics: vi.fn(async () => null),
}));

import {
  homeTrackToTrack,
  publicUploadToTrack,
  stationToTrack,
  videoToTrack,
} from '@/components/custom/music/live-tracks';
import {
  localTrackToPlayerTrack,
  persistedQueueItem,
} from '@/components/custom/music/local-tracks';
import { lyricsTargetFor } from '@/components/custom/music/lyrics-target';
import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import type { LocalTrack } from '@/lib/local-music/types';

const featured = homeTrackToTrack({
  id: 'Pop/Autrice - Canzone.mp3',
  title: 'Canzone',
  artist: 'Autrice',
  streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent('Pop/Autrice - Canzone.mp3')}`,
  durationSeconds: 0,
  artworkUrl: null,
});
const upload = publicUploadToTrack({
  id: 'c'.repeat(25),
  title: 'Mio brano',
  artist: 'Io',
  streamUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/mio.mp3',
  durationSeconds: 120,
});
const audius: MusicPlayerTrack = {
  qualifiedId: 'audius:J7Xb000',
  title: 'Luci basse',
  artistName: 'Artista Audius',
  artworkUrl: null,
  sourceLabel: 'Audius',
  sourceUrl: null,
  durationSeconds: 201,
  playbackMode: 'audius',
};
const video = videoToTrack({
  videoId: 'dQw4w9WgXcQ',
  title: 'Artista - Canzone (Official Video)',
  channelTitle: 'Canale',
  thumbnailUrl: null,
});
const radio = stationToTrack({
  id: 'stazione-1',
  name: 'Radio Uno',
  artworkUrl: null,
  country: 'Italia',
  countryCode: 'IT',
  tags: [],
  codec: 'MP3',
  bitrate: 128,
  homepage: null,
  votes: 0,
});
const localTrack = (source?: LocalTrack['source']): LocalTrack => ({
  id: 'loc-1',
  title: 'Dal telefono',
  artist: 'Io',
  album: null,
  durationSeconds: 100,
  mimeType: 'audio/mpeg',
  size: 10,
  addedAt: 0,
  hasArtwork: false,
  source,
  attribution:
    source === 'audius-download'
      ? {
          sourceName: 'Audius',
          sourceUrl: 'https://audius.co/x/y',
          licenseName: 'Audius Open Music License',
          licenseUrl: null,
          creditLine: null,
        }
      : null,
});

const roots: Array<ReturnType<typeof createRoot>> = [];

function Probe({ track }: { track: MusicPlayerTrack }) {
  const player = useMusicPlayer();
  return (
    <button
      type="button"
      data-start
      onClick={() => void player.playTrack(track, trackStreamPath(track) ?? '', [track])}
    >
      Avvia
    </button>
  );
}

async function openFullPlayer(track: MusicPlayerTrack) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <Probe track={track} />
      </MusicPlayerProvider>,
    ),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[data-start]')?.click();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  const expand = document.querySelector<HTMLButtonElement>('button[aria-label^="Apri il player"]');
  expect(expand).not.toBeNull();
  await act(async () => expand?.click());
}

function lyricsToggle() {
  return [...document.querySelectorAll<HTMLButtonElement>('section button[aria-pressed]')].find(
    (button) => button.textContent?.trim() === 'Testo',
  );
}

function lyricsCalls() {
  return mocks.apiFetch.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith('/api/music/lyrics'));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ premium: false, allowed: true }))),
  );
  vi.stubGlobal('YT', {
    Player: function Player() {
      return {
        loadVideoById: vi.fn(),
        cueVideoById: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
        getDuration: vi.fn(() => 200),
        destroy: vi.fn(),
      };
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('player: pulsante "Testo"', () => {
  it('brano in evidenza: "Testo" apre il pannello e chiede il testo di quel file', async () => {
    await openFullPlayer(featured);
    const toggle = lyricsToggle();
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(lyricsCalls()).toEqual([]);
    expect(document.querySelector('[data-lyrics-panel]')).toBeNull();

    await act(async () => {
      toggle?.click();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(lyricsToggle()?.getAttribute('aria-pressed')).toBe('true');
    expect(lyricsCalls()).toEqual([
      `/api/music/lyrics?featured=${encodeURIComponent('Pop/Autrice - Canzone.mp3')}`,
    ]);
    expect(document.querySelector('[data-lyrics-panel]')?.textContent).toContain('Riga del testo');

    await act(async () => lyricsToggle()?.click());
    expect(document.querySelector('[data-lyrics-panel]')).toBeNull();
  });

  it('premendo "Testo" il pannello (sotto i controlli) si porta in vista, una volta', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    try {
      await openFullPlayer(featured);
      expect(scrollIntoView).not.toHaveBeenCalled();
      await act(async () => {
        lyricsToggle()?.click();
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(document.querySelector('[data-lyrics-panel]'));
      expect(scrollIntoView.mock.calls[0]?.[0]).toMatchObject({ block: 'start' });
      // Chiuso e riaperto: di nuovo in vista (è sempre un tocco dell'ascoltatore).
      await act(async () => lyricsToggle()?.click());
      await act(async () => {
        lyricsToggle()?.click();
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('upload di un utente: chiede ?upload=<id>', async () => {
    await openFullPlayer(upload);
    await act(async () => {
      lyricsToggle()?.click();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(lyricsCalls()).toEqual([`/api/music/lyrics?upload=${'c'.repeat(25)}`]);
  });

  it('file dell’ascoltatore: pulsante presente; brano scaricato da Audius: assente', async () => {
    await openFullPlayer(localTrackToPlayerTrack(localTrack()));
    expect(lyricsToggle()).toBeDefined();
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();

    await openFullPlayer(localTrackToPlayerTrack(localTrack('audius-download')));
    expect(lyricsToggle()).toBeUndefined();
  });

  it.each([
    ['Audius', audius],
    ['YouTube', video],
    ['radio', radio],
  ])('%s: nessun pulsante "Testo" e nessuna richiesta', async (_name, track) => {
    await openFullPlayer(track);
    expect(lyricsToggle()).toBeUndefined();
    expect(lyricsCalls()).toEqual([]);
  });
});

describe('lyricsTargetFor', () => {
  it('solo brani in evidenza, upload e file dell’ascoltatore', () => {
    expect(lyricsTargetFor(featured)).toEqual({
      source: 'featured',
      id: 'Pop/Autrice - Canzone.mp3',
    });
    expect(lyricsTargetFor(upload)).toEqual({ source: 'upload', id: 'c'.repeat(25) });
    expect(lyricsTargetFor(localTrackToPlayerTrack(localTrack()))).toEqual({
      source: 'local',
      id: 'loc-1',
    });
    for (const track of [
      audius,
      video,
      radio,
      localTrackToPlayerTrack(localTrack('audius-download')),
      localTrackToPlayerTrack(localTrack('podcast-download')),
      null,
    ]) {
      expect(lyricsTargetFor(track)).toBeNull();
    }
    // Coda salvata: l'elemento locale è solo un segnaposto, ma resta un file del dispositivo.
    expect(lyricsTargetFor(persistedQueueItem(localTrackToPlayerTrack(localTrack())))).toEqual({
      source: 'local',
      id: 'loc-1',
    });
  });

  it('pathname non plausibili non diventano richieste', () => {
    const base = { ...featured };
    for (const id of [
      'upload:public-uploads/x.mp3',
      'upload:../x.mp3',
      'upload:/x.mp3',
      'upload:a\\b.mp3',
      'upload:diritti.json',
      'upload:x.lrc',
      'upload:',
    ]) {
      expect(lyricsTargetFor({ ...base, qualifiedId: id })).toBeNull();
    }
    expect(lyricsTargetFor({ ...base, playbackMode: 'audius' })).toBeNull();
  });
});
