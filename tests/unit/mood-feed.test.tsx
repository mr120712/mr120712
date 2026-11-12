// @polsia:user-owned — feed per mood della Home: sezioni, scheletri, stati di errore e vuoto,
// annuncio aria-live e riproduzione identica alla lista Audius esistente.
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoodFeedResponse, MoodTrack } from '@/lib/contracts/moods';
import type { MusicTrendingResponse } from '@/lib/contracts/music';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  isHidden: vi.fn((_kind: string, _id: string) => false),
  player: {
    currentTrack: null as null | { qualifiedId: string },
    status: 'idle' as 'idle' | 'loading' | 'paused' | 'playing',
    togglePlayback: vi.fn(),
    playTrack: vi.fn(),
  },
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => mocks.player,
  trackStreamPath: (track: { qualifiedId: string }) =>
    `/api/music/radio/${track.qualifiedId.slice('radio:'.length)}/stream`,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/image', () => ({ default: ({ alt }: { alt: string }) => <span>{alt}</span> }));
// The real (empty) Library, with items the listener chose to hide.
vi.mock('@/components/custom/music/library-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/custom/music/library-context')>();
  return {
    ...actual,
    useLibrary: () => ({ ...actual.useLibrary(), isHidden: mocks.isHidden }),
  };
});

import { AudiusSection } from '@/components/custom/music/audius-section';
import {
  MOOD_TRACKS_PREVIEW,
  MoodFeed,
  moodAnnouncement,
} from '@/components/custom/music/mood-feed';
import { findMood } from '@/lib/music/moods';

const relax = findMood('relax');
if (!relax) throw new Error('relax missing');

function track(id: string, overrides: Partial<MoodTrack> = {}): MoodTrack {
  return {
    id,
    qualifiedId: `audius:${id}`,
    title: `Brano ${id}`,
    artistName: 'Artista calmo',
    artistUrl: 'https://audius.co/artista',
    trackUrl: `https://audius.co/artista/${id}`,
    artworkUrl: 'https://audius.co/images/cover.jpg',
    durationSeconds: 185,
    license: null,
    licensorName: 'Artista calmo',
    copyrightNotice: null,
    attributionRemovalRequested: false,
    playbackEligible: true,
    playbackReason: 'ready',
    ...overrides,
  };
}

function feed(overrides: Partial<MoodFeedResponse> = {}): MoodFeedResponse {
  return {
    mood: { id: 'relax', label: 'Relax', description: relax?.description ?? '' },
    tracks: { status: 'results', items: [track('t1'), track('t2')] },
    stations: {
      status: 'results',
      items: [
        {
          id: 'station-1',
          name: 'Radio Calma',
          artworkUrl: null,
          country: 'Italy',
          countryCode: 'IT',
          tags: ['chillout'],
          codec: 'MP3',
          bitrate: 128,
          homepage: null,
          votes: 30,
        },
        {
          id: 'station-2',
          name: 'Lounge FM',
          artworkUrl: null,
          country: null,
          countryCode: null,
          tags: ['lounge'],
          codec: null,
          bitrate: null,
          homepage: null,
          votes: 12,
        },
      ],
    },
    podcasts: {
      status: 'results',
      items: [
        { id: '101', title: 'Respira', author: 'Autrice', artworkUrl: null, genre: 'Salute' },
      ],
    },
    genres: {
      status: 'results',
      items: [{ slug: 'lofi-studio', name: 'Lo-fi per studiare', href: '/generi/lofi-studio' }],
    },
    ...overrides,
  };
}

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount(node: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function button(container: HTMLElement, name: string) {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`button ${name} missing`);
  return found;
}

function sectionByHeading(container: HTMLElement, heading: string) {
  const title = [...container.querySelectorAll('h3')].find((node) => node.textContent === heading);
  return title?.closest('section') ?? null;
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.isHidden.mockReset().mockReturnValue(false);
  mocks.player.currentTrack = null;
  mocks.player.status = 'idle';
  mocks.player.playTrack.mockReset();
  mocks.player.togglePlayback.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('MoodFeed', () => {
  it('mostra titolo, descrizione e scheletri mentre carica', async () => {
    mocks.apiFetch.mockReturnValue(new Promise(() => undefined));
    const container = await mount(<MoodFeed mood={relax} onBack={vi.fn()} />);

    expect(container.querySelector('h2')?.textContent).toBe('Relax');
    expect(container.textContent).toContain(relax.description);
    expect(container.querySelectorAll('[data-testid="mood-skeleton"]')).toHaveLength(3);
    expect(
      container.querySelector('[data-testid="mood-skeleton"]')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(sectionByHeading(container, 'Brani da Audius')?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('Caricamento dei brani…');
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/music/moods/relax',
      expect.objectContaining({ schema: expect.anything() }),
    );
  });

  it('mostra brani con nota di licenza OML, radio, podcast e playlist collegate', async () => {
    mocks.apiFetch.mockResolvedValue(feed());
    const onAnnounce = vi.fn();
    const container = await mount(
      <MoodFeed mood={relax} onBack={vi.fn()} onAnnounce={onAnnounce} />,
    );

    const tracks = sectionByHeading(container, 'Brani da Audius');
    expect(tracks?.getAttribute('aria-busy')).toBe('false');
    expect([...(tracks?.querySelectorAll('li strong') ?? [])].map((n) => n.textContent)).toEqual([
      'Brano t1',
      'Brano t2',
    ]);
    expect(tracks?.textContent).toContain('Artista calmo · 3:05');
    expect(
      tracks?.querySelectorAll('a[href="https://openaudiofoundation.org/open-music-license.pdf"]'),
    ).toHaveLength(2);
    expect(tracks?.textContent).toContain('con Free contano nei 40');

    const radio = sectionByHeading(container, 'Radio dal vivo');
    expect(radio?.querySelectorAll('article')).toHaveLength(2);
    expect(radio?.textContent).toContain('Radio Calma');
    expect(radio?.textContent).toContain('non contano negli ascolti del piano Free');

    const podcasts = sectionByHeading(container, 'Podcast');
    expect(podcasts?.querySelector('a[href="/podcasts/101"]')).not.toBeNull();

    const genres = sectionByHeading(container, 'Playlist Solco a tema');
    expect(genres?.querySelector('a[href="/generi/lofi-studio"]')?.textContent).toBe(
      'Lo-fi per studiare',
    );
    expect(container.querySelector('[data-testid="mood-skeleton"]')).toBeNull();
    expect(onAnnounce).toHaveBeenLastCalledWith('Mood Relax: 2 brani, 2 radio e 1 podcast.');
  });

  it('riproduce come la lista Audius esistente: stesso brano, stesso stream, stessa coda', async () => {
    const tracks = [track('t1'), track('t2')];
    const trending = {
      outcome: 'results',
      tracks: tracks.map((item) => ({ ...item, provider: 'audius' })),
      albums: [],
    } as unknown as MusicTrendingResponse;
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path === '/api/music/trending'
        ? trending
        : feed({ tracks: { status: 'results', items: tracks } }),
    );
    const moodContainer = await mount(<MoodFeed mood={relax} onBack={vi.fn()} />);
    const sectionContainer = await mount(<AudiusSection />);

    await act(async () => button(moodContainer, 'Riproduci Brano t2').click());
    await act(async () => button(sectionContainer, 'Riproduci Brano t2').click());

    expect(mocks.player.playTrack).toHaveBeenCalledTimes(2);
    const [fromMood, fromSection] = mocks.player.playTrack.mock.calls;
    expect(fromMood).toEqual(fromSection);
    expect(fromMood?.[0]).toMatchObject({
      qualifiedId: 'audius:t2',
      playbackMode: 'audius',
      sourceLabel: 'Audius',
    });
    expect(fromMood?.[1]).toBe('/api/music/audius/tracks/t2/stream');
    expect(fromMood?.[2]).toHaveLength(2);
  });

  it('mette in pausa il brano già in riproduzione invece di ripartire', async () => {
    mocks.apiFetch.mockResolvedValue(feed());
    mocks.player.currentTrack = { qualifiedId: 'audius:t1' };
    mocks.player.status = 'playing';
    const container = await mount(<MoodFeed mood={relax} onBack={vi.fn()} />);

    await act(async () => button(container, 'Metti in pausa Brano t1').click());
    expect(mocks.player.togglePlayback).toHaveBeenCalledTimes(1);
    expect(mocks.player.playTrack).not.toHaveBeenCalled();
  });

  it('non mostra brani non riproducibili su Solco', async () => {
    mocks.apiFetch.mockResolvedValue(
      feed({
        tracks: {
          status: 'results',
          items: [
            track('cc', { playbackEligible: false, playbackReason: 'license_not_allowed' }),
            track('ok'),
          ],
        },
      }),
    );
    const container = await mount(<MoodFeed mood={relax} onBack={vi.fn()} />);
    const titles = [...container.querySelectorAll('li strong')].map((node) => node.textContent);
    expect(titles).toEqual(['Brano ok']);
  });

  it('mostra errore o vuoto per sezione senza toccare le altre', async () => {
    mocks.apiFetch.mockResolvedValue(
      feed({
        tracks: { status: 'unavailable', items: [] },
        stations: { status: 'results', items: [] },
        podcasts: { status: 'unavailable', items: [] },
        genres: { status: 'results', items: [] },
      }),
    );
    const onAnnounce = vi.fn();
    const container = await mount(
      <MoodFeed mood={relax} onBack={vi.fn()} onAnnounce={onAnnounce} />,
    );

    expect(sectionByHeading(container, 'Brani da Audius')?.textContent).toContain(
      'I brani Audius non sono raggiungibili in questo momento.',
    );
    expect(sectionByHeading(container, 'Radio dal vivo')?.textContent).toContain(
      'Nessuna radio per questo mood, per ora.',
    );
    expect(sectionByHeading(container, 'Podcast')?.textContent).toContain(
      'I podcast non sono raggiungibili in questo momento.',
    );
    expect(sectionByHeading(container, 'Playlist Solco a tema')).toBeNull();
    // An unreachable source is not "0": the announcement says so, like the section on screen.
    expect(onAnnounce).toHaveBeenLastCalledWith(
      'Mood Relax: brani non disponibili, 0 radio e podcast non disponibili.',
    );
  });

  it('senza brani mostra il messaggio di vuoto e lascia le altre sezioni', async () => {
    mocks.apiFetch.mockResolvedValue(feed({ tracks: { status: 'results', items: [] } }));
    const container = await mount(<MoodFeed mood={relax} onBack={vi.fn()} />);
    expect(sectionByHeading(container, 'Brani da Audius')?.textContent).toContain(
      'Nessun brano Audius per questo mood, per ora.',
    );
    expect(sectionByHeading(container, 'Radio dal vivo')?.querySelectorAll('article')).toHaveLength(
      2,
    );
  });

  it('se la richiesta fallisce offre "Riprova" e lo annuncia', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(feed());
    const onAnnounce = vi.fn();
    const container = await mount(
      <MoodFeed mood={relax} onBack={vi.fn()} onAnnounce={onAnnounce} />,
    );

    expect(container.textContent).toContain('Non riusciamo a caricare il mood Relax');
    expect(onAnnounce).toHaveBeenLastCalledWith('Non è stato possibile caricare il mood Relax.');

    const retry = button(container, 'Riprova');
    retry.focus();
    await act(async () => retry.click());
    // The button is gone while reloading: focus stays on the mood heading, not on <body>.
    expect(retry.isConnected).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('h2'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('li strong')).toHaveLength(2);
    expect(document.activeElement).toBe(container.querySelector('h2'));
  });

  it('se anche "Riprova" fallisce lo annuncia di nuovo (la regione si svuota e si riempie)', async () => {
    let failRetry: (error: Error) => void = () => undefined;
    mocks.apiFetch.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failRetry = reject;
      }),
    );
    // The page's live region (HomeMoodSwitch keeps the message in state the same way).
    const Page = () => {
      const [message, setMessage] = useState('');
      return (
        <>
          <output aria-live="polite">{message}</output>
          <MoodFeed mood={relax} onBack={vi.fn()} onAnnounce={setMessage} />
        </>
      );
    };
    const container = await mount(<Page />);
    const region = () => container.querySelector('output')?.textContent;
    const failure = 'Non è stato possibile caricare il mood Relax.';
    expect(region()).toBe(failure);

    await act(async () => button(container, 'Riprova').click());
    // Emptied while reloading: re-inserting the same text is a change screen readers announce.
    expect(region()).toBe('');
    await act(async () => failRetry(new Error('ancora offline')));

    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Non riusciamo a caricare il mood Relax');
    expect(region()).toBe(failure);
  });

  it('annuncia le radio e i podcast mostrati, senza quelli nascosti nella Libreria', async () => {
    mocks.isHidden.mockImplementation(
      (kind: string, id: string) =>
        (kind === 'station' && id === 'station-1') || (kind === 'podcast' && id === '101'),
    );
    mocks.apiFetch.mockResolvedValue(feed());
    const onAnnounce = vi.fn();
    const container = await mount(
      <MoodFeed mood={relax} onBack={vi.fn()} onAnnounce={onAnnounce} />,
    );

    expect(sectionByHeading(container, 'Radio dal vivo')?.querySelectorAll('article')).toHaveLength(
      1,
    );
    expect(sectionByHeading(container, 'Podcast')?.textContent).toContain(
      'Nessun podcast per questo mood, per ora.',
    );
    expect(onAnnounce).toHaveBeenLastCalledWith('Mood Relax: 2 brani, 1 radio e 0 podcast.');
  });

  it(`mostra i primi ${MOOD_TRACKS_PREVIEW} brani con "Mostra altri brani", ma mette in coda tutti`, async () => {
    const tracks = Array.from({ length: 12 }, (_, index) => track(`t${index + 1}`));
    mocks.apiFetch.mockResolvedValue(feed({ tracks: { status: 'results', items: tracks } }));
    const onAnnounce = vi.fn();
    const container = await mount(
      <MoodFeed mood={relax} onBack={vi.fn()} onAnnounce={onAnnounce} />,
    );
    const section = sectionByHeading(container, 'Brani da Audius');
    const titles = () =>
      [...(section?.querySelectorAll('li strong') ?? [])].map((node) => node.textContent);

    expect(MOOD_TRACKS_PREVIEW).toBe(8);
    expect(titles()).toEqual(tracks.slice(0, 8).map((item) => item.title));
    // The announcement counts every track, not only the rows shown first.
    expect(onAnnounce).toHaveBeenLastCalledWith('Mood Relax: 12 brani, 2 radio e 1 podcast.');
    const more = button(container, 'Mostra altri brani');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const controlled = more.getAttribute('aria-controls');
    expect(controlled).toBeTruthy();
    expect(document.getElementById(controlled ?? '')?.querySelectorAll('li')).toHaveLength(8);

    // Playing a shown track queues the whole mood, also the rows not shown yet.
    await act(async () => button(container, 'Riproduci Brano t2').click());
    expect(mocks.player.playTrack.mock.calls[0]?.[2]).toHaveLength(12);
    expect(mocks.player.playTrack.mock.calls[0]?.[2]?.[11]).toMatchObject({
      qualifiedId: 'audius:t12',
    });

    await act(async () => more.click());
    expect(titles()).toHaveLength(12);
    expect(more.textContent?.trim()).toBe('Mostra meno');
    expect(more.getAttribute('aria-expanded')).toBe('true');

    await act(async () => more.click());
    expect(titles()).toHaveLength(8);
    expect(more.textContent?.trim()).toBe('Mostra altri brani');
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it(`con ${MOOD_TRACKS_PREVIEW} brani o meno non mostra "Mostra altri brani"`, async () => {
    const tracks = Array.from({ length: 8 }, (_, index) => track(`t${index + 1}`));
    mocks.apiFetch.mockResolvedValue(feed({ tracks: { status: 'results', items: tracks } }));
    const container = await mount(<MoodFeed mood={relax} onBack={vi.fn()} />);

    expect(container.querySelectorAll('li strong')).toHaveLength(8);
    expect(container.textContent).not.toContain('Mostra altri brani');
  });

  it('"Torna a Tutto" chiama onBack', async () => {
    mocks.apiFetch.mockResolvedValue(feed());
    const onBack = vi.fn();
    const container = await mount(<MoodFeed mood={relax} onBack={onBack} />);

    await act(async () => button(container, 'Torna a Tutto').click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('moodAnnouncement', () => {
  it('usa il singolare per un solo elemento', () => {
    expect(
      moodAnnouncement(
        { label: 'Notte' },
        {
          tracks: { status: 'results', count: 1 },
          stations: { status: 'results', count: 0 },
          podcasts: { status: 'results', count: 1 },
        },
      ),
    ).toBe('Mood Notte: 1 brano, 0 radio e 1 podcast.');
  });

  it('dice "non disponibili" per le fonti che non hanno risposto', () => {
    expect(
      moodAnnouncement(
        { label: 'Festa' },
        {
          tracks: { status: 'results', count: 12 },
          stations: { status: 'unavailable', count: 0 },
          podcasts: { status: 'results', count: 3 },
        },
      ),
    ).toBe('Mood Festa: 12 brani, radio non disponibili e 3 podcast.');
  });
});
