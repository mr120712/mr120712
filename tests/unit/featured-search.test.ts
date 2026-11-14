// @polsia:user-owned — indice dei brani in evidenza per la ricerca globale: solo i brani dichiarati
// in diritti.json (un brano non dichiarato con il titolo cercato non compare MAI), dati identici
// alla Home (copertina, streamUrl), cache (~5 minuti se valido, ~1 minuto dopo un problema, una
// sola scansione dello store per finestra anche con ricerche concorrenti), stato quando Blob non è
// configurato o non risponde.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
}));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));

import { homeTrackToTrack } from '@/components/custom/music/live-tracks';
import { songShareUrl } from '@/lib/business/social-share';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import {
  clearFeaturedSearchCacheForTests,
  matchFeaturedTracks,
  searchFeaturedTracks,
} from '@/lib/music/featured-search.server';
import { listHomeTrackSections, trackNameFromPathname } from '@/lib/music/home-tracks.server';

const PUBLIC = 'https://store.public.blob.vercel-storage.com';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';

function blob(
  pathname: string,
  base = PRIVATE,
  uploadedAt = '2026-10-01T00:00:00.000Z',
  size = 1000,
) {
  const url = `${base}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

function rights(files: string[]) {
  return JSON.stringify({
    versione: 1,
    brani: files.map((file) => ({ file, licenza: 'propria', titolare: 'Solco' })),
  });
}

function storedText(text: string) {
  return {
    statusCode: 200,
    stream: new Response(text).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: text.length },
  };
}

// Lo store: un brano dichiarato, uno commerciale NON dichiarato con lo stesso titolo cercato, una
// copertina, un upload utente e il manifest.
const STORE = [
  blob('Rock italiano/Lucio Dalla - Caruso.mp3', PRIVATE, '2026-10-02T00:00:00.000Z'),
  blob('Rock italiano/cover.jpg', PRIVATE, '2026-10-01T00:00:00.000Z'),
  blob('Spotify/Lucio Dalla - Caruso (Live).mp3', PUBLIC, '2026-10-03T00:00:00.000Z'),
  blob('Spotify/Altro - Caruso remix.mp3', PRIVATE, '2026-10-04T00:00:00.000Z'),
  blob('public-uploads/utente - Caruso.mp3', PUBLIC, '2026-10-05T00:00:00.000Z'),
  blob('diritti.json', PRIVATE, '2026-10-06T00:00:00.000Z', 200),
];

function serveStore(blobs = STORE, manifest = rights(['Rock italiano/Lucio Dalla - Caruso.mp3'])) {
  mocks.list.mockImplementation(async () => ({ blobs, hasMore: false }));
  mocks.get.mockImplementation(async () => storedText(manifest));
}

const T0 = new Date('2026-11-14T10:00:00.000Z').getTime();
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.token = 'tok_test';
  clearFeaturedSearchCacheForTests();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('searchFeaturedTracks: cancello dei diritti', () => {
  it('trova SOLO i brani dichiarati: quelli non dichiarati con lo stesso titolo non compaiono mai', async () => {
    serveStore();
    const result = await searchFeaturedTracks('caruso');
    expect(result.outcome).toBe('results');
    expect(result.tracks.map((track) => track.id)).toEqual([
      'Rock italiano/Lucio Dalla - Caruso.mp3',
    ]);
    // Anche cercando proprio il nome del file non dichiarato.
    expect((await searchFeaturedTracks('caruso remix')).tracks).toEqual([]);
    expect((await searchFeaturedTracks('caruso (live)')).tracks).toEqual([]);
  });

  it('i dati del brano sono identici a quelli della Home (copertina, streamUrl, titolo, artista)', async () => {
    serveStore();
    const [found] = (await searchFeaturedTracks('lucio dalla')).tracks;
    const home = await listHomeTrackSections();
    const inHome = home.sections
      .flatMap((section) => section.items)
      .find((item) => item.id === found?.id);
    // Identico alla Home più il link alla pagina dell'artista (brano dichiarato).
    expect(found).toEqual({ ...inHome, artistSlug: 'lucio-dalla' });
    expect(found).toMatchObject({
      title: 'Caruso',
      artist: 'Lucio Dalla',
      streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent('Rock italiano/Lucio Dalla - Caruso.mp3')}`,
      artworkUrl: `/api/music/home-tracks/cover?p=${encodeURIComponent('Rock italiano/cover.jpg')}`,
    });
  });

  it('la Home non cambia: mostra anche i brani non dichiarati', async () => {
    serveStore();
    const home = await listHomeTrackSections();
    const ids = home.sections.flatMap((section) => section.items.map((item) => item.id));
    expect(ids).toContain('Spotify/Lucio Dalla - Caruso (Live).mp3');
    expect(ids).toContain('Rock italiano/Lucio Dalla - Caruso.mp3');
  });

  it('manifest assente → nessun brano ricercabile (vuoto, non errore)', async () => {
    serveStore(STORE.filter((item) => item.pathname !== 'diritti.json'));
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'no_results', tracks: [] });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('manifest non valido o con licenza NC → nessun brano ricercabile', async () => {
    serveStore(STORE, '{ "versione": 1, "brani": [');
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'no_results', tracks: [] });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non valido'));

    clearFeaturedSearchCacheForTests();
    serveStore(
      STORE,
      JSON.stringify({
        versione: 1,
        brani: [
          {
            file: 'Rock italiano/Lucio Dalla - Caruso.mp3',
            licenza: 'cc-by-nc',
            titolare: 'X',
          },
        ],
      }),
    );
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'no_results', tracks: [] });
  });

  it('manifest oltre 256 KB → nessun brano ricercabile, senza scaricarlo', async () => {
    serveStore(
      STORE.map((item) =>
        item.pathname === 'diritti.json' ? { ...item, size: 256 * 1024 + 1 } : item,
      ),
    );
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'no_results', tracks: [] });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('una voce che punta a un upload utente o a un file inesistente non rende ricercabile nulla', async () => {
    serveStore(STORE, rights(['public-uploads/utente - Caruso.mp3', 'Rock/Non esiste.mp3']));
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'no_results', tracks: [] });
  });
});

describe('searchFeaturedTracks: stato della fonte', () => {
  it('Blob non configurato → unavailable, nessuna chiamata allo store', async () => {
    mocks.token = undefined;
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'unavailable', tracks: [] });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('elenco dello store in errore → unavailable (non "vuoto")', async () => {
    mocks.list.mockRejectedValue(new Error('rete'));
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'unavailable', tracks: [] });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('manifest illeggibile (errore dello store) → unavailable', async () => {
    serveStore();
    mocks.get.mockRejectedValue(new Error('rete'));
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'unavailable', tracks: [] });
  });

  it('elenco parziale prima di trovare il manifest → unavailable (non si sa se c’è)', async () => {
    mocks.list
      .mockResolvedValueOnce({ blobs: [STORE[0]], hasMore: true, cursor: 'c1' })
      .mockRejectedValueOnce(new Error('rete'));
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'unavailable', tracks: [] });
  });

  it('nessun brano pertinente → no_results', async () => {
    serveStore();
    expect(await searchFeaturedTracks('vasco')).toEqual({ outcome: 'no_results', tracks: [] });
  });
});

describe('searchFeaturedTracks: cache', () => {
  it('elenca lo store e legge il manifest UNA volta per finestra (~5 minuti), non a ogni ricerca', async () => {
    serveStore();
    await searchFeaturedTracks('caruso');
    await searchFeaturedTracks('lucio');
    await searchFeaturedTracks('dalla');
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 4 * 60_000);
    await searchFeaturedTracks('caruso');
    expect(mocks.list).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 5 * 60_000 + 1);
    await searchFeaturedTracks('caruso');
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('manifest assente (stato stabile): si ricontrolla dopo ~5 minuti, non ogni minuto', async () => {
    serveStore(STORE.filter((item) => item.pathname !== 'diritti.json'));
    expect((await searchFeaturedTracks('caruso')).tracks).toEqual([]);

    // L'amministratore carica diritti.json.
    serveStore();
    vi.setSystemTime(T0 + 61_000);
    expect((await searchFeaturedTracks('caruso')).tracks).toEqual([]);
    vi.setSystemTime(T0 + 2 * 61_000);
    expect((await searchFeaturedTracks('caruso')).tracks).toEqual([]);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 5 * 60_000 + 1);
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['non valido', () => serveStore(STORE, '{ "versione": 1, "brani": [')],
    [
      'oltre 256 KB',
      () =>
        serveStore(
          STORE.map((item) =>
            item.pathname === 'diritti.json' ? { ...item, size: 256 * 1024 + 1 } : item,
          ),
        ),
    ],
  ])(
    'manifest %s (stato stabile): nessun brano, ricontrollato dopo ~5 minuti',
    async (_label, serve) => {
      serve();
      expect((await searchFeaturedTracks('caruso')).tracks).toEqual([]);
      vi.setSystemTime(T0 + 2 * 61_000);
      expect((await searchFeaturedTracks('caruso')).tracks).toEqual([]);
      expect(mocks.list).toHaveBeenCalledTimes(1);
      vi.setSystemTime(T0 + 5 * 60_000 + 1);
      await searchFeaturedTracks('caruso');
      expect(mocks.list).toHaveBeenCalledTimes(2);
    },
  );

  it('manifest illeggibile (errore transitorio): si riprova dopo ~1 minuto', async () => {
    serveStore();
    mocks.get.mockRejectedValueOnce(new Error('rete'));
    expect(await searchFeaturedTracks('caruso')).toEqual({ outcome: 'unavailable', tracks: [] });

    vi.setSystemTime(T0 + 30_000);
    expect((await searchFeaturedTracks('caruso')).outcome).toBe('unavailable');
    expect(mocks.list).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 60_001);
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('elenco interrotto prima del manifest: si riprova dopo ~1 minuto', async () => {
    mocks.list
      .mockResolvedValueOnce({ blobs: [STORE[0]], hasMore: true, cursor: 'c1' })
      .mockRejectedValueOnce(new Error('rete'));
    expect((await searchFeaturedTracks('caruso')).outcome).toBe('unavailable');
    serveStore();
    vi.setSystemTime(T0 + 60_001);
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
  });

  it('store oltre il tetto di pagine con il manifest trovato: 20 elenchi ogni ~5 minuti, non ogni minuto', async () => {
    mocks.list.mockImplementation(async () => ({
      blobs: mocks.list.mock.calls.length === 1 ? STORE : [],
      hasMore: true,
      cursor: 'altro',
    }));
    mocks.get.mockImplementation(async () =>
      storedText(rights(['Rock italiano/Lucio Dalla - Caruso.mp3'])),
    );
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledTimes(20);

    vi.setSystemTime(T0 + 61_000);
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledTimes(20);

    vi.setSystemTime(T0 + 5 * 60_000 + 1);
    await searchFeaturedTracks('caruso');
    expect(mocks.list).toHaveBeenCalledTimes(40);
  });

  it('un diritto tolto dal manifest sparisce dalla ricerca alla ricostruzione successiva', async () => {
    serveStore();
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
    serveStore(STORE, rights([]));
    vi.setSystemTime(T0 + 5 * 60_000 + 1);
    expect((await searchFeaturedTracks('caruso')).tracks).toEqual([]);
  });

  it('ricerche concorrenti a cache vuota condividono UNA sola ricostruzione', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.list.mockImplementation(async () => {
      await gate;
      return { blobs: STORE, hasMore: false };
    });
    mocks.get.mockImplementation(async () =>
      storedText(rights(['Rock italiano/Lucio Dalla - Caruso.mp3'])),
    );
    const searches = [
      searchFeaturedTracks('caruso'),
      searchFeaturedTracks('lucio'),
      searchFeaturedTracks('dalla'),
    ];
    release();
    const results = await Promise.all(searches);
    expect(results.map((result) => result.tracks.length)).toEqual([1, 1, 1]);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});

describe('ricerca "Artista Titolo" e link di condivisione', () => {
  function fromStore(pathname: string): HomeTrack {
    return {
      id: pathname,
      ...trackNameFromPathname(pathname),
      streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(pathname)}`,
      durationSeconds: 0,
      artworkUrl: null,
    };
  }
  const vasco = fromStore('Rock italiano/Vasco Rossi - Albachiara.mp3');
  const pioggia = fromStore('Pioggia.mp3');

  it.each([
    'Albachiara',
    'Vasco Rossi',
    'Albachiara Vasco Rossi',
    'Vasco Rossi Albachiara',
    'Vasco Rossi - Albachiara',
    'vasco rossi – albachiara',
  ])('trova il brano cercando "%s"', (query) => {
    expect(matchFeaturedTracks([vasco, pioggia], query).map((item) => item.id)).toEqual([vasco.id]);
  });

  it('trova il brano con la query del link di condivisione del player (anche senza artista)', () => {
    for (const track of [vasco, pioggia]) {
      // Lo stesso percorso del player: brano della Home → brano del player → link di condivisione.
      const player = homeTrackToTrack(track);
      const q = new URL(
        songShareUrl(player.title, player.artistName, 'https://solco.test'),
      ).searchParams.get('q');
      expect(q).toBe(track === vasco ? 'Vasco Rossi Albachiara' : 'Solco Pioggia');
      expect(matchFeaturedTracks([vasco, pioggia], q ?? '').map((item) => item.id)).toEqual([
        track.id,
      ]);
    }
  });

  it('dallo store: "Artista - Titolo" trova il brano dichiarato, mai quello non dichiarato', async () => {
    serveStore();
    const result = await searchFeaturedTracks('Lucio Dalla - Caruso');
    expect(result.tracks.map((track) => track.id)).toEqual([
      'Rock italiano/Lucio Dalla - Caruso.mp3',
    ]);
  });
});

describe('matchFeaturedTracks', () => {
  function track(id: string, title: string, artist: string | null) {
    return {
      id,
      title,
      artist,
      streamUrl: `/api/music/home-tracks/stream?p=${id}`,
      durationSeconds: 0,
      artworkUrl: null,
    };
  }

  it('rilevanza minima 40 su titolo + artista, dal più rilevante, al massimo 8', () => {
    const tracks = [
      track('1', 'Una notte a Napoli', 'Band'), // contiene → 40
      track('2', 'Napoli', null), // uguale → 100
      track('3', 'Roma', 'Napoli Centrale'), // artista inizia con → 70
      track('4', 'Milano', 'Band'), // 0
      ...Array.from({ length: 10 }, (_, index) => track(`x${index}`, `Napoli ${index}`, null)),
    ];
    const found = matchFeaturedTracks(tracks, 'napoli');
    expect(found).toHaveLength(8);
    expect(found[0]?.id).toBe('2');
    expect(found.map((item) => item.id)).not.toContain('4');
    // A parità di rilevanza resta l'ordine dell'indice (dal più recente).
    expect(found.slice(1).map((item) => item.id)).toEqual([
      '3',
      'x0',
      'x1',
      'x2',
      'x3',
      'x4',
      'x5',
    ]);
  });
});
