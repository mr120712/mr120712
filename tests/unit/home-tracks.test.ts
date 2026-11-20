// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  token: 'tok_test' as string | undefined,
}));

vi.mock('@vercel/blob', () => ({ list: mocks.list }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));

import {
  collectHomeStore,
  homeTrackCatalogFromListing,
  homeTrackSectionsFromListing,
  isHomeAudioBlob,
  isHomeImageBlob,
  isHomeTracksConfigured,
  listHomeTrackCatalog,
  listHomeTrackSections,
  listHomeTracks,
  trackNameFromPathname,
} from '@/lib/music/home-tracks.server';

function blob(pathname: string, url: string, uploadedAt: string) {
  return { pathname, url, downloadUrl: url, size: 1000, uploadedAt: new Date(uploadedAt) };
}
function page(blobs: ReturnType<typeof blob>[], hasMore = false, cursor?: string) {
  return { blobs, hasMore, cursor };
}

const PUBLIC = 'https://store.public.blob.vercel-storage.com';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.token = 'tok_test';
});

describe('isHomeTracksConfigured', () => {
  it('true con token, false senza', () => {
    mocks.token = 'tok_test';
    expect(isHomeTracksConfigured()).toBe(true);
    mocks.token = undefined;
    expect(isHomeTracksConfigured()).toBe(false);
  });
});

describe('listHomeTracks', () => {
  it('elenca solo audio, esclude gli upload utenti, ordina dal più recente', async () => {
    mocks.list.mockResolvedValue(
      page([
        blob('ciao-mondo.mp3', `${PUBLIC}/ciao-mondo.mp3`, '2026-01-01T00:00:00.000Z'),
        blob('bella.wav', `${PUBLIC}/bella.wav`, '2026-03-01T00:00:00.000Z'),
        blob(
          'public-uploads/di-un-utente.mp3',
          `${PUBLIC}/public-uploads/di-un-utente.mp3`,
          '2026-05-01T00:00:00.000Z',
        ),
        blob('copertina.png', `${PUBLIC}/copertina.png`, '2026-04-01T00:00:00.000Z'),
      ]),
    );
    const items = await listHomeTracks();
    expect(items.map((i) => i.id)).toEqual(['bella.wav', 'ciao-mondo.mp3']);
    expect(items[0]?.title).toBe('Bella');
    expect(items[1]?.title).toBe('Ciao mondo');
    // Anche un file pubblico passa dal proxy same-origin (sessione, limite, niente hotlinking).
    expect(items[0]?.streamUrl).toBe('/api/music/home-tracks/stream?p=bella.wav');
    expect(items[0]?.durationSeconds).toBe(0);
    expect(items[0]?.artist).toBeNull();
  });

  it('un file PRIVATO è servito dal proxy same-origin, non dall’URL diretto', async () => {
    mocks.list.mockResolvedValue(
      page([blob('mia canzone.m4a', `${PRIVATE}/mia%20canzone.m4a`, '2026-01-01T00:00:00.000Z')]),
    );
    const items = await listHomeTracks();
    expect(items[0]?.streamUrl).toBe('/api/music/home-tracks/stream?p=mia%20canzone.m4a');
  });

  it('ricava il titolo dalla cartella/nome e rispetta i nomi già leggibili', async () => {
    mocks.list.mockResolvedValue(
      page([
        blob('home/Bella Ciao.mp3', `${PUBLIC}/home/Bella%20Ciao.mp3`, '2026-01-01T00:00:00.000Z'),
      ]),
    );
    const items = await listHomeTracks();
    expect(items[0]?.title).toBe('Bella Ciao');
  });

  it('pagina oltre la prima pagina (cursore) per non perdere brani quando lo store cresce', async () => {
    mocks.list
      .mockResolvedValueOnce(
        page([blob('a.mp3', `${PUBLIC}/a.mp3`, '2026-01-01T00:00:00.000Z')], true, 'cur1'),
      )
      .mockResolvedValueOnce(
        page([blob('b.mp3', `${PUBLIC}/b.mp3`, '2026-02-01T00:00:00.000Z')], false),
      );
    const items = await listHomeTracks();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list.mock.calls[1]?.[0]).toMatchObject({ cursor: 'cur1' });
    // Ordinati per data: b (feb) prima di a (gen).
    expect(items.map((i) => i.id)).toEqual(['b.mp3', 'a.mp3']);
  });

  it('ritorna [] senza token (storage non configurato)', async () => {
    mocks.token = undefined;
    const items = await listHomeTracks();
    expect(items).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('ritorna [] se list() va in errore (degradazione, niente crash della Home)', async () => {
    mocks.list.mockRejectedValue(new Error('blob down'));
    expect(await listHomeTracks()).toEqual([]);
  });

  it('se una pagina successiva fallisce, mostra comunque quanto già raccolto', async () => {
    mocks.list
      .mockResolvedValueOnce(
        page([blob('ok.mp3', `${PUBLIC}/ok.mp3`, '2026-01-01T00:00:00.000Z')], true, 'cur1'),
      )
      .mockRejectedValueOnce(new Error('timeout'));
    const items = await listHomeTracks();
    expect(items.map((i) => i.id)).toEqual(['ok.mp3']);
  });
});

describe('sezioni, artista e copertine', () => {
  it('"Artista - Titolo" dal nome del file; altrimenti solo il titolo', () => {
    expect(trackNameFromPathname('Novità/Vasco Rossi - Albachiara.mp3')).toEqual({
      artist: 'Vasco Rossi',
      title: 'Albachiara',
    });
    expect(trackNameFromPathname('artista_-_canzone-bella.mp3')).toEqual({
      artist: 'Artista',
      title: 'Canzone bella',
    });
    expect(trackNameFromPathname('Ciao%20Mondo%20%E2%80%93%20Live.flac')).toEqual({
      artist: 'Ciao Mondo',
      title: 'Live',
    });
    expect(trackNameFromPathname('ciao-mondo.mp3')).toEqual({ title: 'Ciao mondo', artist: null });
  });

  it('una sezione per cartella: la radice ("In evidenza") prima, poi la cartella più recente', async () => {
    mocks.list.mockResolvedValue(
      page([
        blob('radice.mp3', `${PUBLIC}/radice.mp3`, '2026-01-01T00:00:00.000Z'),
        blob('Rock/a.mp3', `${PUBLIC}/Rock/a.mp3`, '2026-02-01T00:00:00.000Z'),
        blob('Rock/b.mp3', `${PUBLIC}/Rock/b.mp3`, '2026-05-01T00:00:00.000Z'),
        blob('pop_italiano/c.mp3', `${PUBLIC}/pop_italiano/c.mp3`, '2026-06-01T00:00:00.000Z'),
      ]),
    );
    const { sections, items } = await listHomeTrackSections();
    expect(sections.map((section) => [section.id, section.title])).toEqual([
      ['', 'In evidenza'],
      ['pop_italiano', 'Pop italiano'],
      ['Rock', 'Rock'],
    ]);
    expect(sections[2]?.items.map((item) => item.id)).toEqual(['Rock/b.mp3', 'Rock/a.mp3']);
    // La lista piatta resta dal più recente, per i client meno recenti.
    expect(items.map((item) => item.id)).toEqual([
      'pop_italiano/c.mp3',
      'Rock/b.mp3',
      'Rock/a.mp3',
      'radice.mp3',
    ]);
  });

  it('copertina: stesso nome, poi copertina della cartella, poi quella incorporata', async () => {
    mocks.list.mockResolvedValue(
      page([
        blob(
          'Rock/Artista - Uno.mp3',
          `${PRIVATE}/Rock/Artista%20-%20Uno.mp3`,
          '2026-01-01T00:00:00.000Z',
        ),
        blob(
          'Rock/artista - uno.JPG',
          `${PUBLIC}/Rock/artista%20-%20uno.JPG`,
          '2026-01-01T00:00:00.000Z',
        ),
        blob('Rock/Due.m4a', `${PUBLIC}/Rock/Due.m4a`, '2026-01-02T00:00:00.000Z'),
        blob('Rock/Cover.png', `${PRIVATE}/Rock/Cover.png`, '2026-01-01T00:00:00.000Z'),
        blob('Jazz/Tre.mp3', `${PUBLIC}/Jazz/Tre.mp3`, '2026-01-03T00:00:00.000Z'),
        blob('Jazz/Quattro.wav', `${PRIVATE}/Jazz/Quattro.wav`, '2026-01-01T00:00:00.000Z'),
        blob(
          'public-uploads/cover.jpg',
          `${PUBLIC}/public-uploads/cover.jpg`,
          '2026-01-01T00:00:00.000Z',
        ),
      ]),
    );
    const { sections } = await listHomeTrackSections();
    const art = Object.fromEntries(
      sections.flatMap((section) => section.items.map((item) => [item.id, item.artworkUrl])),
    );
    // La copertina versiona l'URL con la data di caricamento del blob (cache-busting): sostituire una
    // copertina cambia l'URL e invalida la miniatura in cache sulla CDN.
    const vJan1 = new Date('2026-01-01T00:00:00.000Z').getTime();
    const vJan3 = new Date('2026-01-03T00:00:00.000Z').getTime();
    // Immagine pubblica con lo stesso nome (maiuscole indifferenti): dal proxy, che la riduce.
    expect(art['Rock/Artista - Uno.mp3']).toBe(
      `/api/music/home-tracks/cover?p=Rock%2Fartista%20-%20uno.JPG&pub=1&v=${vJan1}`,
    );
    // Nessuna immagine con il suo nome: copertina (privata) della cartella, via proxy.
    expect(art['Rock/Due.m4a']).toBe(`/api/music/home-tracks/cover?p=Rock%2FCover.png&v=${vJan1}`);
    // Nessuna immagine: copertina incorporata nell'MP3 (file pubblico).
    expect(art['Jazz/Tre.mp3']).toBe(
      `/api/music/home-tracks/cover?p=Jazz%2FTre.mp3&pub=1&v=${vJan3}`,
    );
    // WAV: niente copertina incorporata da leggere.
    expect(art['Jazz/Quattro.wav']).toBeNull();
    // Le immagini non diventano brani.
    expect(Object.keys(art)).toHaveLength(4);
  });

  it('nomi scritti a mano restano intatti; numeri di traccia e titoli lunghi', () => {
    expect(trackNameFromPathname('AC-DC - Back in Black.mp3')).toEqual({
      artist: 'AC-DC',
      title: 'Back in Black',
    });
    expect(trackNameFromPathname('Jay-Z - 99 Problems.mp3')).toEqual({
      artist: 'Jay-Z',
      title: '99 Problems',
    });
    expect(trackNameFromPathname('01 - Intro.mp3')).toEqual({ title: 'Intro', artist: null });
    expect(trackNameFromPathname('03. Vasco Rossi - Albachiara.mp3')).toEqual({
      artist: 'Vasco Rossi',
      title: 'Albachiara',
    });
    expect(trackNameFromPathname('50 Cent - In Da Club.mp3').artist).toBe('50 Cent');
    // Emoji: mai oltre le 200 unità del contratto, mai un carattere spezzato.
    const long = trackNameFromPathname(`${'🎵'.repeat(150)}.mp3`).title;
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long).toBe('🎵'.repeat(100));
  });

  it('cartelle con lo stesso nome o chiamate "In evidenza": titoli distinti', async () => {
    mocks.list.mockResolvedValue(
      page([
        blob('a.mp3', `${PUBLIC}/a.mp3`, '2026-01-04T00:00:00.000Z'),
        blob('Pop/Novità/b.mp3', `${PUBLIC}/Pop/Novit%C3%A0/b.mp3`, '2026-01-03T00:00:00.000Z'),
        blob('Rock/Novità/c.mp3', `${PUBLIC}/Rock/Novit%C3%A0/c.mp3`, '2026-01-02T00:00:00.000Z'),
        blob('In evidenza/d.mp3', `${PUBLIC}/In%20evidenza/d.mp3`, '2026-01-01T00:00:00.000Z'),
      ]),
    );
    const { sections } = await listHomeTrackSections();
    expect(sections.map((section) => section.title)).toEqual([
      'In evidenza',
      'Pop › Novità',
      'Rock › Novità',
      'In evidenza',
    ]);
    expect(sections.map((section) => section.id)).toEqual([
      '',
      'Pop/Novità',
      'Rock/Novità',
      'In evidenza',
    ]);
  });

  it('percorsi che risalgono o con barre rovesciate non sono mai brani o copertine', () => {
    for (const path of [
      'x/../public-uploads/brano.mp3',
      './a.mp3',
      'a//b.mp3',
      '/a.mp3',
      'a\\..\\b.mp3',
      'a\u0000.mp3',
    ]) {
      expect(isHomeAudioBlob(path), path).toBe(false);
    }
    expect(isHomeImageBlob('Rock/../public-uploads/c.jpg')).toBe(false);
    expect(isHomeImageBlob('logo.svg')).toBe(false);
    // Nomi normali con caratteri particolari restano validi (il proxy li codifica).
    expect(isHomeAudioBlob('Che cosa? #1.mp3')).toBe(true);
  });

  it('storage che non risponde (l’SDK ritenta per minuti): elenco vuoto entro la scadenza', async () => {
    vi.useFakeTimers();
    try {
      mocks.list.mockReturnValue(new Promise(() => undefined));
      const pending = listHomeTrackSections();
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await pending).toEqual({ items: [], sections: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('listHomeTrackCatalog (ricerca globale)', () => {
  it('tutti i brani come in Home (stessa copertina e streamUrl) più i file chiesti per nome', async () => {
    const store = [
      blob('Pop/A - Uno.mp3', `${PRIVATE}/Pop/A%20-%20Uno.mp3`, '2026-01-01T00:00:00.000Z'),
      blob('Pop/cover.jpg', `${PUBLIC}/Pop/cover.jpg`, '2026-01-01T00:00:00.000Z'),
      blob('Due.mp3', `${PUBLIC}/Due.mp3`, '2026-02-01T00:00:00.000Z'),
      blob('diritti.json', `${PRIVATE}/diritti.json`, '2026-03-01T00:00:00.000Z'),
      blob('altro.json', `${PRIVATE}/altro.json`, '2026-03-01T00:00:00.000Z'),
      blob('public-uploads/x.mp3', `${PUBLIC}/public-uploads/x.mp3`, '2026-04-01T00:00:00.000Z'),
    ];
    mocks.list.mockResolvedValue(page(store));
    const catalog = await listHomeTrackCatalog(['diritti.json']);
    mocks.list.mockResolvedValue(page(store));
    const home = await listHomeTrackSections();

    expect(catalog?.complete).toBe(true);
    expect(catalog?.tracks.map((track) => track.id)).toEqual(['Due.mp3', 'Pop/A - Uno.mp3']);
    // Ogni brano è identico a quello della Home.
    const homeItems = home.sections.flatMap((section) => section.items);
    for (const track of catalog?.tracks ?? []) {
      expect(track).toEqual(homeItems.find((item) => item.id === track.id));
    }
    expect([...(catalog?.files.keys() ?? [])]).toEqual(['diritti.json']);
    expect(catalog?.files.get('diritti.json')).toMatchObject({
      pathname: 'diritti.json',
      url: `${PRIVATE}/diritti.json`,
      size: 1000,
    });
  });

  it('segnala un elenco parziale (pagina successiva fallita) e null senza token', async () => {
    mocks.list
      .mockResolvedValueOnce(
        page([blob('a.mp3', `${PUBLIC}/a.mp3`, '2026-01-01T00:00:00.000Z')], true, 'c1'),
      )
      .mockRejectedValueOnce(new Error('rete'));
    const partial = await listHomeTrackCatalog(['diritti.json']);
    expect(partial?.complete).toBe(false);
    expect(partial?.tracks.map((track) => track.id)).toEqual(['a.mp3']);

    mocks.token = undefined;
    expect(await listHomeTrackCatalog()).toBeNull();
  });
});

describe('titoli e artisti personalizzati (titoli.json)', () => {
  it('sezioni e catalogo con i nomi del manifest; senza voce, il nome dal file', async () => {
    mocks.list.mockResolvedValueOnce(
      page([
        blob('spotifydown.com - Aura..mp3', `${PUBLIC}/aura.mp3`, '2026-03-01T00:00:00.000Z'),
        blob('Rock/Band - Hit.mp3', `${PUBLIC}/Rock/hit.mp3`, '2026-02-01T00:00:00.000Z'),
      ]),
    );
    const listing = await collectHomeStore('tok_test');
    const names = new Map([
      ['spotifydown.com - Aura..mp3', { title: 'Aura', artist: 'Nome artista' }],
      ['Rock/Band - Hit.mp3', { artist: null }],
    ]);
    const { items, sections } = homeTrackSectionsFromListing(listing, names);
    expect(items.map((item) => [item.title, item.artist])).toEqual([
      ['Aura', 'Nome artista'],
      ['Hit', null],
    ]);
    expect(sections.map((section) => section.items[0]?.title)).toEqual(['Aura', 'Hit']);
    const catalog = homeTrackCatalogFromListing(listing, [], names);
    expect(catalog.tracks.map((track) => track.artist)).toEqual(['Nome artista', null]);
    // Senza nomi: come sempre.
    expect(homeTrackSectionsFromListing(listing).items.map((item) => item.artist)).toEqual([
      'Spotifydown.com',
      'Band',
    ]);
  });
});
