// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  playTrack: vi.fn(),
  replaceCurrentTrack: vi.fn(),
  primeAudio: vi.fn(),
  current: 'youtube:abcdefghijk' as string | null,
  toast: vi.fn(),
  success: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(mocks.toast, { success: mocks.success }) }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    playTrack: mocks.playTrack,
    primeAudio: mocks.primeAudio,
    isCurrentTrack: (id: string) => mocks.current === id,
    replaceCurrentTrack: mocks.replaceCurrentTrack,
  }),
  trackStreamPath: (track: { qualifiedId: string }) =>
    `/api/music/jamendo/${track.qualifiedId.split(':')[1]}/stream`,
}));

const video = { videoId: 'abcdefghijk', title: 'Artista Uno - Notte Chiara', channelTitle: 'X' };
const audiusTrack = {
  provider: 'audius',
  id: 'a1',
  qualifiedId: 'audius:a1',
  title: 'Notte Chiara',
  artistName: 'Artista Uno',
  artistHandle: 'artistauno',
  artistId: 'u1',
  artistQualifiedId: 'audius:u1',
  artistUrl: 'https://audius.co/artistauno',
  trackUrl: 'https://audius.co/artistauno/notte-chiara',
  artworkUrl: 'https://example.test/a.jpg',
  durationSeconds: 200,
  genre: null,
  mood: null,
  tags: null,
  releaseDate: null,
  license: null,
  licensorName: null,
  copyrightNotice: null,
  producerCopyrightNotice: null,
  attributionRemovalRequested: false,
  attributionComplete: true,
  playbackEligible: true,
  playbackReason: 'ready',
};

function respond(url: string, audiusTracks: unknown[]) {
  if (url.includes('source-status')) return { sources: [{ id: 'audius', active: true }] };
  if (url.includes('/api/music/jamendo')) return { outcome: 'not_configured', tracks: [] };
  return {
    source: 'audius',
    outcome: audiusTracks.length ? 'results' : 'no_results',
    tracks: audiusTracks,
    artists: [],
    playlists: [],
    albums: [],
    videos: [],
    sourceStatus: {
      id: 'audius',
      label: 'Audius',
      active: true,
      searchOutcome: 'results',
      summary: 'ok',
      prerequisite: 'ok',
    },
  };
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(audiusTracks: unknown[], searchFails = false) {
  vi.resetModules();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (searchFails && String(url).includes('/api/music/search')) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(JSON.stringify(respond(String(url), audiusTracks)));
    }),
  );
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
  return container;
}

async function click(container: HTMLElement) {
  const button = container.querySelector('button');
  if (!button) throw new Error('pulsante mancante');
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.playTrack.mockReset();
  mocks.replaceCurrentTrack.mockReset();
  mocks.current = 'youtube:abcdefghijk';
  mocks.toast.mockReset();
  mocks.success.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('pulsante Ascolta in background', () => {
  it('avvia lo stesso brano da Audius al posto del video, senza buttare la coda', async () => {
    const container = await mount([audiusTrack]);
    await click(container);
    expect(mocks.replaceCurrentTrack).toHaveBeenCalledWith(
      expect.objectContaining({ qualifiedId: 'audius:a1', playbackMode: 'audius' }),
      '/api/music/audius/tracks/a1/stream',
    );
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('avvisa quando il brano non esiste in una versione ascoltabile in background', async () => {
    const container = await mount([]);
    await click(container);
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      'Questo brano non è disponibile per l’ascolto in background.',
      expect.anything(),
    );
  });

  it('una ricerca fallita invita a riprovare, senza dire che il brano non esiste', async () => {
    const container = await mount([audiusTrack], true);
    await click(container);
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      'Non riesco a cercare il brano adesso. Riprova tra poco.',
    );
  });

  it('se intanto il video è cambiato, non avvia nulla e non dice nulla', async () => {
    const container = await mount([audiusTrack]);
    mocks.current = 'youtube:zzzzzzzzzzz';
    await click(container);
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(mocks.replaceCurrentTrack).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('un controllo dei cataloghi fallito non resta in memoria: il controllo successivo riprova', async () => {
    vi.resetModules();
    let failing = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (failing && String(url).includes('source-status')) throw new TypeError('offline');
        return new Response(JSON.stringify(respond(String(url), [audiusTrack])));
      }),
    );
    const { BackgroundListenButton } = await import(
      '@/components/custom/music/background-listen-button'
    );
    const first = document.createElement('div');
    const firstRoot = createRoot(first);
    roots.push(firstRoot);
    await act(async () => firstRoot.render(<BackgroundListenButton video={video} />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Disponibilità sconosciuta: il pulsante resta nascosto, ma non è "nessun catalogo".
    expect(first.querySelector('button')).toBeNull();

    failing = false;
    const second = document.createElement('div');
    const secondRoot = createRoot(second);
    roots.push(secondRoot);
    await act(async () => secondRoot.render(<BackgroundListenButton video={video} />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(second.querySelector('button')).not.toBeNull();
  });
});
