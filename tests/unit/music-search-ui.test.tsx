// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicSearchResponse, MusicSearchSource } from '@/lib/contracts/music';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));
vi.mock('next/image', () => ({
  default: (props: { alt: string }) => <span role="img" aria-label={props.alt}>{props.alt}</span>,
}));

import { MusicSearch } from '@/components/custom/music/music-search';
import { MusicPlayerProvider } from '@/components/custom/music/music-player';
import { AUDIUS_PREREQUISITE, YOUTUBE_PREREQUISITE } from '@/lib/music/source-policy';

const audiusSource: MusicSearchSource = {
  id: 'audius', label: 'Solco', active: false, searchOutcome: 'inactive',
  blockers: ['credential_missing'],
  summary: 'Audius inattiva.', prerequisite: AUDIUS_PREREQUISITE,
};
const youtubeMissing: MusicSearchSource = {
  id: 'youtube', label: 'YouTube', active: false, searchOutcome: 'inactive',
  unavailableReason: 'not_configured', summary: 'YouTube inattiva.', prerequisite: YOUTUBE_PREREQUISITE,
};
const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

function searchCalls() {
  return mocks.apiFetch.mock.calls.filter(([path]) => path.startsWith('/api/music/search'));
}

function audiusTrack(
  playbackEligible: boolean,
  playbackReason: 'ready' | 'access_denied' | 'access_unknown',
): MusicSearchResponse['tracks'][number] {
  return {
    provider: 'audius',
    id: 'track-71',
    qualifiedId: 'audius:track-71',
    title: 'Titolo Audius',
    artistName: 'Artista Audius',
    artistHandle: 'artista',
    artistId: 'artist-71',
    artistQualifiedId: 'audius:artist-71',
    artistUrl: 'https://audius.co/artista',
    trackUrl: 'https://audius.co/artista/titolo',
    artworkUrl: 'https://audius.co/images/copertina.jpg',
    durationSeconds: 180,
    genre: 'Alternative',
    mood: null,
    tags: null,
    releaseDate: null,
    license: null,
    licensorName: 'Artista Audius',
    copyrightNotice: null,
    producerCopyrightNotice: null,
    attributionRemovalRequested: false,
    attributionComplete: true,
    playbackEligible,
    playbackReason,
  };
}

function audiusArtist(): MusicSearchResponse['artists'][number] {
  return {
    provider: 'audius',
    id: 'artist-92',
    qualifiedId: 'audius:artist-92',
    name: 'Profilo di prova',
    handle: 'profilo-prova',
    artworkUrl: 'https://audius.co/images/profilo.jpg',
    profileUrl: 'https://audius.co/profilo-prova',
  };
}

function audiusPlaylist(): MusicSearchResponse['playlists'][number] {
  return {
    provider: 'audius',
    id: 'playlist-92',
    qualifiedId: 'audius:playlist:playlist-92',
    title: 'Playlist di prova',
    artistName: 'Curatore di prova',
    artistUrl: 'https://audius.co/curatore-prova',
    playlistUrl: 'https://audius.co/curatore-prova/selezione',
    artworkUrl: 'https://audius.co/images/selezione.jpg',
    trackCount: 9,
  };
}

async function mount(initialQuery: string) {
  const container = document.createElement('div');
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => root.render(<MusicPlayerProvider><MusicSearch initialQuery={initialQuery} /></MusicPlayerProvider>));
  return container;
}

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  mocks.apiFetch.mockReset().mockImplementation(async (path) => {
    if (path === '/api/music/source-status') return { sources: [audiusSource, youtubeMissing] };
    if (path === '/api/music/collections') throw new Error('Unauthorized');
    return null;
  });
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ricerca Solco unificata', () => {
  it('riproduce dalla ricerca i brani Audius pubblici confermati senza Solco Pro', async () => {
    const source: MusicSearchSource = {
      ...audiusSource,
      active: true,
      searchOutcome: 'results',
      summary: 'Audius configurata.',
    };
    const track = audiusTrack(true, 'ready');
    const response: MusicSearchResponse = {
      source: 'audius', outcome: 'results', tracks: [track], artists: [], playlists: [], albums: [], videos: [],
      sourceStatus: source,
    };
    mocks.apiFetch.mockImplementation(async (path) => {
      if (path === '/api/music/source-status') return { sources: [source, youtubeMissing] };
      if (path === '/api/music/collections') throw new Error('Unauthorized');
      if (path.startsWith('/api/music/search')) return response;
      if (path === '/api/music/audius/tracks/track-71/playback') return { allowed: true };
      return null;
    });

    const container = await mount('');
    const query = container.querySelector<HTMLInputElement>('#music-query');
    const form = container.querySelector<HTMLFormElement>('form');
    if (!query || !form) throw new Error('Controlli di ricerca mancanti.');
    await setInput(query, 'Titolo Audius');
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });

    expect(container.textContent).toContain('Titolo Audius');
    expect(container.textContent).toContain('Artista Audius');
    expect(container.textContent).toContain('Copertina di Titolo Audius');
    expect(container.querySelector('a[href="https://audius.co/artista"]')?.textContent).toContain('Artista Audius');
    const play = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent === 'Riproduci su Solco',
    );
    if (!play) throw new Error('Controllo di riproduzione Audius non trovato.');
    await act(async () => { play.click(); await Promise.resolve(); });
    expect(mocks.apiFetch.mock.calls.some(([path]) => path === '/api/music/audius/tracks/track-71/playback')).toBe(true);
    expect(container.querySelector('audio')?.getAttribute('src')).toBe('/api/music/audius/tracks/track-71/stream');
    expect(container.textContent).not.toContain('Solco Pro');
  });

  it('separa Brani, Artisti e Playlist con copertine e link di attribuzione Audius', async () => {
    const source: MusicSearchSource = {
      ...audiusSource, active: true, searchOutcome: 'results', summary: 'Audius configurata.',
    };
    const response: MusicSearchResponse = {
      source: 'audius', outcome: 'results', tracks: [audiusTrack(false, 'access_unknown')],
      artists: [audiusArtist()], playlists: [audiusPlaylist()], albums: [], videos: [], sourceStatus: source,
    };
    mocks.apiFetch.mockImplementation(async (path) => {
      if (path === '/api/music/source-status') return { sources: [source, youtubeMissing] };
      if (path === '/api/music/collections') throw new Error('Unauthorized');
      if (path.startsWith('/api/music/search')) return response;
      return null;
    });

    const container = await mount('catalogo');
    expect(container.textContent).toContain('Titolo Audius');
    expect(container.textContent).toContain('Profilo di prova');
    expect(container.textContent).toContain('Playlist di prova');
    expect(container.querySelector('a[href="https://audius.co/profilo-prova"] [role="img"][aria-label="Profilo di Profilo di prova"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://audius.co/curatore-prova/selezione"] [role="img"][aria-label="Copertina della playlist Playlist di prova"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://audius.co/curatore-prova"]')?.textContent).toContain('Curatore di prova');

    const categories = [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')];
    const artistsTab = categories.find((button) => button.textContent?.includes('Artisti'));
    const playlistsTab = categories.find((button) => button.textContent?.includes('Playlist'));
    const tracksTab = categories.find((button) => button.textContent?.includes('Brani'));
    if (!artistsTab || !playlistsTab || !tracksTab) throw new Error('Categorie Audius mancanti.');
    await act(async () => artistsTab.click());
    expect(container.querySelector('a[href="https://audius.co/profilo-prova"]')).not.toBeNull();
    await act(async () => playlistsTab.click());
    expect(container.querySelector('a[href="https://audius.co/curatore-prova/selezione"]')).not.toBeNull();
    await act(async () => tracksTab.click());
    expect(container.querySelector('a[href="https://audius.co/artista"]')?.textContent).toContain('Artista Audius');
  });

  it('interroga Audius per ogni genere e mostra i sei collegamenti nell’ordine richiesto', async () => {
    const container = await mount('');
    const genreSection = container.querySelector('section[aria-labelledby="search-genres-heading"]');
    const genreLinks = [...(genreSection?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
    expect(genreLinks.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Electronic', '/search?q=Electronic'],
      ['Hip-Hop', '/search?q=Hip-Hop'],
      ['Rock', '/search?q=Rock'],
      ['Lo-fi', '/search?q=Lo-fi'],
      ['Pop', '/search?q=Pop'],
      ['Ambient', '/search?q=Ambient'],
    ]);
    expect(genreLinks.every((link) => link.href.includes('/search?q='))).toBe(true);

    const unavailable: MusicSearchResponse = {
      source: 'audius', outcome: 'unavailable', tracks: [], artists: [], playlists: [], albums: [], videos: [],
      sourceStatus: audiusSource,
    };
    mocks.apiFetch.mockImplementation(async (path) => {
      if (path === '/api/music/source-status') return { sources: [audiusSource, youtubeMissing] };
      if (path === '/api/music/collections') throw new Error('Unauthorized');
      if (path.startsWith('/api/music/search')) return unavailable;
      return null;
    });
    const terms = ['Electronic', 'Hip-Hop', 'Rock', 'Lo-fi', 'Pop', 'Ambient'];
    for (const term of terms) {
      const resultPage = await mount(term);
      expect(resultPage.querySelector<HTMLInputElement>('#music-query')?.value).toBe(term);
      expect(searchCalls().at(-1)?.[0]).toBe(`/api/music/search?source=audius&q=${encodeURIComponent(term).replaceAll('%20', '+')}`);
    }
  });

  it('ignora una risposta asincrona vecchia quando la query più recente ha già completato', async () => {
    vi.useFakeTimers();
    const source: MusicSearchSource = {
      ...audiusSource, active: true, searchOutcome: 'results', summary: 'Audius configurata.',
    };
    let resolveOlder: ((value: MusicSearchResponse) => void) | undefined;
    let resolveNewer: ((value: MusicSearchResponse) => void) | undefined;
    mocks.apiFetch.mockImplementation((path) => {
      if (path === '/api/music/source-status') return Promise.resolve({ sources: [source, youtubeMissing] });
      if (path === '/api/music/collections') return Promise.reject(new Error('Unauthorized'));
      if (String(path).includes('q=vecchia')) return new Promise((resolve) => { resolveOlder = resolve; });
      if (String(path).includes('q=nuova')) return new Promise((resolve) => { resolveNewer = resolve; });
      return Promise.resolve(null);
    });
    const older: MusicSearchResponse = {
      source: 'audius', outcome: 'results', tracks: [{ ...audiusTrack(false, 'access_unknown'), title: 'Risposta vecchia' }],
      artists: [], playlists: [], albums: [], videos: [], sourceStatus: source,
    };
    const newer: MusicSearchResponse = {
      source: 'audius', outcome: 'results', tracks: [{ ...audiusTrack(false, 'access_unknown'), title: 'Risposta nuova' }],
      artists: [], playlists: [], albums: [], videos: [], sourceStatus: source,
    };

    const container = await mount('');
    const input = container.querySelector<HTMLInputElement>('#music-query');
    if (!input) throw new Error('Campo di ricerca mancante.');
    await setInput(input, 'vecchia');
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(resolveOlder).toBeDefined();
    await setInput(input, 'nuova');
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(resolveNewer).toBeDefined();
    await act(async () => resolveNewer?.(newer));
    expect(container.textContent).toContain('Risposta nuova');
    await act(async () => resolveOlder?.(older));
    expect(container.textContent).toContain('Risposta nuova');
    expect(container.textContent).not.toContain('Risposta vecchia');
  });

  it.each([
    ['negato', false, 'access_denied'],
    ['non verificabile', false, 'access_unknown'],
  ] as const)('non offre riproduzione se Audius risponde con accesso %s', async (_label, allowed, reason) => {
    const source: MusicSearchSource = {
      ...audiusSource,
      active: true,
      searchOutcome: 'results',
      summary: 'Audius configurata.',
    };
    const response: MusicSearchResponse = {
      source: 'audius',
      outcome: 'results',
      tracks: [audiusTrack(allowed, reason)],
      artists: [],
      playlists: [],
      albums: [],
      videos: [],
      sourceStatus: source,
    };
    mocks.apiFetch.mockImplementation(async (path) => {
      if (path === '/api/music/source-status') return { sources: [source, youtubeMissing] };
      if (path === '/api/music/collections') throw new Error('Unauthorized');
      if (path.startsWith('/api/music/search')) return response;
      return null;
    });

    const container = await mount('Titolo Audius');
    expect(container.textContent).toContain('Titolo Audius');
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent === 'Riproduci su Solco')).toBe(false);
    expect(container.textContent).toMatch(/Audius non autorizza|non è verificabile/);
    expect(mocks.apiFetch.mock.calls.some(([path]) => String(path).includes('/playback'))).toBe(false);
  });

  it('conserva la query tra le schede e cerca entrambe le fonti dopo consenso e un solo invio', async () => {
    const container = await mount('artista esempio');
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Solco (Audius)',
      'YouTube',
    ]);
    expect(container.querySelector<HTMLInputElement>('#music-query')?.value).toBe('artista esempio');
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0]?.[0]).toBe('/api/music/search?source=audius&q=artista+esempio');
    expect(container.textContent).toContain('AUDIUS_API_KEY');

    const youtubeTab = tabs[1];
    const query = container.querySelector<HTMLInputElement>('#music-query');
    const form = container.querySelector<HTMLFormElement>('form');
    if (!youtubeTab || !query || !form) throw new Error('Controlli di ricerca mancanti.');
    await act(async () => youtubeTab.click());
    expect(query.value).toBe('artista esempio');
    const consent = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!consent) throw new Error('Controllo di consenso YouTube mancante.');
    expect(container.textContent).toContain('YOUTUBE_DATA_API_KEY');
    expect(searchCalls()).toHaveLength(1);

    await setInput(query, 'query youtube');
    await act(async () => consent.click());
    expect(searchCalls()).toHaveLength(1);

    const unavailableResult: MusicSearchResponse = {
      source: 'youtube', outcome: 'unavailable', tracks: [], artists: [], playlists: [], albums: [], videos: [],
      sourceStatus: { ...youtubeMissing, searchOutcome: 'unavailable', unavailableReason: 'not_configured' },
    };
    const audiusUnavailable: MusicSearchResponse = {
      source: 'audius', outcome: 'unavailable', tracks: [], artists: [], playlists: [], albums: [], videos: [],
      sourceStatus: { ...audiusSource, searchOutcome: 'unavailable', unavailableReason: 'not_configured' },
    };
    mocks.apiFetch.mockImplementation(async (path) => {
      if (path === '/api/music/source-status') return { sources: [audiusSource, youtubeMissing] };
      if (path === '/api/music/collections') throw new Error('Unauthorized');
      if (path.startsWith('/api/music/search')) {
        return String(path).includes('source=audius') ? audiusUnavailable : unavailableResult;
      }
      return null;
    });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });

    expect(searchCalls()).toHaveLength(3);
    expect(searchCalls().slice(-2).map(([path]) => path).sort()).toEqual([
      '/api/music/search?source=audius&q=query+youtube',
      '/api/music/search?source=youtube&q=query+youtube&youtubeConsent=accepted',
    ]);
    expect(container.textContent).toContain('YOUTUBE_DATA_API_KEY');
    expect(container.textContent).not.toContain('Nessun risultato restituito');
    expect(container.querySelector('iframe')).toBeNull();
    await act(async () => tabs[0]?.click());
    expect(query.value).toBe('query youtube');
    expect(container.textContent).toContain('AUDIUS_API_KEY');
  });

  it('distingue il risultato vuoto dall’errore reale della fonte', async () => {
    const noResults: MusicSearchResponse = {
      source: 'youtube', outcome: 'no_results', tracks: [], artists: [], playlists: [], albums: [], videos: [],
      sourceStatus: { ...youtubeMissing, active: true, searchOutcome: 'no_results', unavailableReason: undefined, summary: 'YouTube configurata.' },
    };
    mocks.apiFetch.mockImplementation(async (path) => {
      if (path === '/api/music/source-status') return { sources: [audiusSource, { ...youtubeMissing, active: true }] };
      if (path === '/api/music/collections') throw new Error('Unauthorized');
      if (path.startsWith('/api/music/search')) {
        return { ...noResults, source: String(path).includes('source=audius') ? 'audius' : 'youtube',
          sourceStatus: String(path).includes('source=audius') ? audiusSource : noResults.sourceStatus };
      }
      return null;
    });
    const container = await mount('nobody');
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const query = container.querySelector<HTMLInputElement>('#music-query');
    const form = container.querySelector<HTMLFormElement>('form');
    const youtubeTab = tabs[1];
    if (!youtubeTab || !query || !form) throw new Error('Controlli di ricerca mancanti.');
    await act(async () => youtubeTab.click());
    const consent = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!consent) throw new Error('Controllo di consenso YouTube mancante.');
    await setInput(query, 'nessun video');
    await act(async () => consent.click());
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(container.textContent).toContain('Nessun risultato restituito da questa fonte.');

    mocks.apiFetch.mockImplementation(async (path) => {
      if (path === '/api/music/source-status') return { sources: [audiusSource, { ...youtubeMissing, active: true }] };
      if (path === '/api/music/collections') throw new Error('Unauthorized');
      if (path.startsWith('/api/music/search')) throw new Error('API unavailable');
      return null;
    });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(container.textContent).toContain('La richiesta di ricerca è terminata con un errore.');
  });

  it('distingue risultati parziali e quota YouTube esaurita', async () => {
    const audiusActive: MusicSearchSource = {
      ...audiusSource,
      active: true,
      searchOutcome: 'results',
      summary: 'Audius configurata.',
    };
    const youtubeQuota: MusicSearchResponse = {
      source: 'youtube',
      outcome: 'unavailable',
      tracks: [],
      artists: [],
      playlists: [],
      albums: [],
      videos: [],
      sourceStatus: {
        ...youtubeMissing,
        active: true,
        searchOutcome: 'unavailable',
        unavailableReason: 'quota_exceeded',
        summary: 'Quota esaurita.',
      },
    };
    const audiusPartial: MusicSearchResponse = {
      source: 'audius',
      outcome: 'partial',
      tracks: [],
      artists: [],
      playlists: [],
      albums: [],
      videos: [],
      sourceStatus: { ...audiusActive, searchOutcome: 'partial' },
    };
    mocks.apiFetch.mockImplementation(async (path) => {
      if (path === '/api/music/source-status') return { sources: [audiusActive, { ...youtubeMissing, active: true }] };
      if (path === '/api/music/collections') throw new Error('Unauthorized');
      if (path.startsWith('/api/music/search')) {
        return String(path).includes('source=audius') ? audiusPartial : youtubeQuota;
      }
      return null;
    });

    const container = await mount('');
    const query = container.querySelector<HTMLInputElement>('#music-query');
    const form = container.querySelector<HTMLFormElement>('form');
    const consent = container.querySelector<HTMLInputElement>('#youtube-consent');
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    if (!query || !form || !consent || !tabs[1]) throw new Error('Controlli di ricerca mancanti.');
    await setInput(query, 'artista');
    await act(async () => consent.click());
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });

    expect(container.textContent).toContain('Risultati parziali: una fonte ha restituito risultati e un’altra non è disponibile.');
    await act(async () => tabs[1]?.click());
    expect(container.textContent).toContain('Quota YouTube Data API v3 esaurita.');
    expect(container.textContent).not.toContain('Nessun risultato restituito da questa fonte.');
  });
});
