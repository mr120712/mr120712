// @polsia:user-owned — anteprima social di un brano condiviso: scheda JPEG canonica, dati del
// brano Audius letti dal server (mai un URL di immagine dal link), testo libero presentato come
// una ricerca e ripulito, metadati della pagina /search identici all'immagine del player.
// @vitest-environment node
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  getTrack: vi.fn(),
  drawn: [] as ReactElement[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  getRateLimitIdentity: (_userId: string | null, headers: Headers) =>
    headers.get('x-real-ip') ? `ip:${headers.get('x-real-ip')}` : null,
}));
// Il fetch SSRF-safe delega al fetch globale stubbato: la logica resta reale, niente rete.
vi.mock('@/lib/net/ssrf-safe-fetch.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/net/ssrf-safe-fetch.server')>()),
  ssrfSafeFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));
vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusActivation: () => ({ active: true, apiKey: 'chiave-di-prova', blockers: [] }),
}));
vi.mock('@/lib/music/audius-api.server', () => ({
  createAudiusApiClient: () => ({ getTrack: mocks.getTrack }),
  reserveAudiusRequestSlot: vi.fn(),
}));
// next/og vero; si registra solo la scheda disegnata, per leggerne il testo.
vi.mock('next/og', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/og')>();
  class RecordingImageResponse extends actual.ImageResponse {
    constructor(...args: ConstructorParameters<typeof actual.ImageResponse>) {
      mocks.drawn.push(args[0] as ReactElement);
      super(...args);
    }
  }
  return { ...actual, ImageResponse: RecordingImageResponse };
});

import { GET as previewImage } from '@/app/(custom)/search/anteprima.jpg/route';
import { GET as legacyPreview } from '@/app/(custom)/search/anteprima.png/route';
import { generateMetadata } from '@/app/(custom)/search/page';
import { songShareImagePath, songShareUrl } from '@/lib/business/social-share';
import { clearAudiusShareCardCacheForTests } from '@/lib/music/audius-share-card.server';
import { linkPreviewFor } from '@/lib/security/uam-preview';

const CID = 'baeaaaiqsec3v4qj7c6afbm4jcuij6qqq4ycn5plde7u6lhldnierwopply35m';
const AUDIUS_COVER = `https://audius-01.staked.cloud/content/${CID}/480x480.jpg`;
const EVIL = 'https://evil.example/content/QmAbcdefghijklmnopqrstuvwxyz12/480x480.jpg';
const TRACK_ID = 'J7Xb000';
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
const REDIRECT_CACHE = 'public, max-age=3600, s-maxage=86400';

let JPEG: Uint8Array;
let NOISY: Uint8Array;
let BOMB: Uint8Array;
let fetched: string[] = [];
let covers: Record<string, () => Response> = {};

function audiusTrack(
  id: string,
  title = 'Luci basse',
  artist = 'Artista Audius',
  extra: Record<string, unknown> = {},
) {
  return {
    data: {
      id,
      title,
      permalink: `/artista/${id}`,
      duration: 201,
      is_available: true,
      is_streamable: true,
      is_stream_gated: false,
      access: { stream: true, download: false },
      access_authorities: [],
      license: null,
      artwork: { '480x480': AUDIUS_COVER },
      user: { id: 'u1', handle: 'artista', name: artist },
      ...extra,
    },
  };
}

beforeAll(async () => {
  JPEG = new Uint8Array(
    await sharp({ create: { width: 48, height: 48, channels: 3, background: '#7c3aed' } })
      .jpeg()
      .toBuffer(),
  );
  // Copertina "fotografica" nel caso peggiore: rumore su ogni pixel.
  NOISY = new Uint8Array(
    await sharp({
      create: {
        width: 480,
        height: 480,
        channels: 3,
        background: '#000000',
        noise: { type: 'gaussian', mean: 128, sigma: 90 },
      },
    })
      .jpeg({ quality: 92 })
      .toBuffer(),
  );
  // Pochi KB, ma dichiara 12000×12000 pixel.
  BOMB = new Uint8Array(JPEG);
  for (let index = 0; index < BOMB.length - 9; index += 1) {
    if (BOMB[index] === 0xff && (BOMB[index + 1] === 0xc0 || BOMB[index + 1] === 0xc2)) {
      BOMB.set([12_000 >> 8, 12_000 & 0xff, 12_000 >> 8, 12_000 & 0xff], index + 5);
      break;
    }
  }
});

function request(query: string, ip = '203.0.113.7') {
  return previewImage(
    new Request(`https://solco.test/search/anteprima.jpg${query ? `?${query}` : ''}`, {
      headers: ip ? { 'x-real-ip': ip } : {},
    }),
  );
}

async function expectJpeg(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/jpeg');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  const jpeg = new Uint8Array(await response.arrayBuffer());
  expect([...jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  return jpeg;
}

/** Il testo della scheda disegnata per ultima. */
function lastCardText() {
  const node = mocks.drawn.at(-1);
  return node ? renderToStaticMarkup(node).replace(/<[^>]+>/g, ' ') : '';
}

function expectRedirect(response: Response, location: string) {
  expect(response.status).toBe(308);
  expect(response.headers.get('location')).toBe(location);
  expect(response.headers.get('cache-control')).toBe(REDIRECT_CACHE);
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
}

beforeEach(() => {
  clearAudiusShareCardCacheForTests();
  mocks.drawn.length = 0;
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.getTrack.mockReset().mockImplementation(async (id: string) => audiusTrack(id));
  fetched = [];
  covers = {
    [AUDIUS_COVER]: () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      // Solo le richieste di rete (next/og carica il suo wasm da un URL data:).
      if (url.startsWith('http')) fetched.push(url);
      return covers[url]?.() ?? new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scheda di un brano Audius (?au=)', () => {
  it('copertina, titolo e artista solo da Audius; in cache sulla CDN', async () => {
    const response = await request(`au=${TRACK_ID}`);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(mocks.getTrack).toHaveBeenCalledWith(TRACK_ID);
    // L'unica immagine scaricata è la copertina indicata da Audius.
    expect(fetched).toEqual([AUDIUS_COVER]);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og.audius', 'ip:203.0.113.7');
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og.audius.global', 'global');
    const text = lastCardText();
    expect(text).toContain('ASCOLTA SU SOLCO');
    expect(text).toContain('Luci basse');
    expect(text).toContain('Artista Audius');
  });

  it('copertina già scaricata: riusata dalla memoria, nessun nuovo download', async () => {
    await expectJpeg(await request(`au=${TRACK_ID}`));
    await expectJpeg(await request(`au=${TRACK_ID}`));
    expect(fetched).toEqual([AUDIUS_COVER]);
    expect(mocks.getTrack).toHaveBeenCalledTimes(1);
  });

  it('indirizzi web nel titolo o nell’artista Audius: tolti dalla scheda', async () => {
    mocks.getTrack.mockResolvedValue(
      audiusTrack(TRACK_ID, 'Solco chiude: vai su https://evil.example/login', 'www.evil.example'),
    );
    const response = await request(`au=${TRACK_ID}`);
    await expectJpeg(response);
    expect(lastCardText()).not.toContain('evil');
  });

  it('brano che Solco non può far ascoltare: scheda generica, mai in cache', async () => {
    for (const [index, extra] of [
      { license: 'All rights reserved' },
      { is_available: false },
      { is_stream_gated: true, access: { stream: false, download: false } },
    ].entries()) {
      const id = `Blocco${index}`;
      mocks.getTrack.mockResolvedValue(audiusTrack(id, 'Brano riservato', 'Artista', extra));
      const response = await request(`au=${id}`);
      await expectJpeg(response);
      expect(response.headers.get('cache-control'), id).toBe('no-store');
      expect(lastCardText()).toContain('Musica su Solco');
      expect(lastCardText()).not.toContain('Brano riservato');
    }
    expect(fetched).toEqual([]);
  });

  it('lettura Audius non riuscita: scheda generica senza testo libero, mai in cache', async () => {
    mocks.getTrack.mockRejectedValue(new Error('Audius down'));
    const response = await request(`au=${TRACK_ID}`);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetched).toEqual([]);
    expect(lastCardText()).toContain('Musica su Solco');

    // Tetto giornaliero pieno: nessuna lettura, stessa scheda generica senza cache.
    clearAudiusShareCardCacheForTests();
    mocks.getTrack.mockClear();
    mocks.consumeRateLimit.mockImplementation(async (action: string) =>
      action === 'share.og.audius.global'
        ? { allowed: false, status: 429, retryAfterSeconds: 60, error: 'rate_limited', message: '' }
        : { allowed: true },
    );
    const limited = await request(`au=${TRACK_ID}`);
    await expectJpeg(limited);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(mocks.getTrack).not.toHaveBeenCalled();
  });

  it('copertina che non arriva: scheda verificata con l’iniziale, ma non in cache', async () => {
    covers = { [AUDIUS_COVER]: () => new Response(null, { status: 500 }) };
    const response = await request(`au=${TRACK_ID}`);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(lastCardText()).toContain('Luci basse');
  });

  it('una "bomba" di pixel: nessuna copertina e risposta rapida', async () => {
    covers = {
      [AUDIUS_COVER]: () => new Response(BOMB, { headers: { 'content-type': 'image/jpeg' } }),
    };
    const started = Date.now();
    const response = await request(`au=${TRACK_ID}`);
    await expectJpeg(response);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetched).toEqual([AUDIUS_COVER]);
  });

  it('JPEG leggero anche con una copertina fotografica (WhatsApp: ~300 KB al massimo)', async () => {
    covers = {
      [AUDIUS_COVER]: () => new Response(NOISY, { headers: { 'content-type': 'image/jpeg' } }),
    };
    const response = await request(`au=${TRACK_ID}`);
    const jpeg = await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(jpeg.byteLength).toBeLessThan(250_000);
    const meta = await sharp(jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1200, 630]);
  });
});

describe('scheda dal testo del link (?t=…&a=…)', () => {
  it('presentata come una ricerca: titolo tra virgolette, artista, nessuna copertina', async () => {
    const response = await request('t=Notte%20Chiara&a=Artista%20Uno');
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(fetched).toEqual([]);
    expect(mocks.getTrack).not.toHaveBeenCalled();
    const text = lastCardText();
    expect(text).toContain('CERCA SU SOLCO');
    expect(text).toContain('«Notte Chiara»');
    expect(text).toContain('Artista Uno');
    expect(text).not.toContain('ASCOLTA SU SOLCO');
  });

  it('un vecchio img= (anche malevolo) è ignorato: nessun download', async () => {
    for (const img of [EVIL, AUDIUS_COVER, 'http://127.0.0.1/a.jpg']) {
      const response = await request(`t=Video&img=${encodeURIComponent(img)}`);
      expectRedirect(response, '/search/anteprima.jpg?t=Video');
    }
    await expectJpeg(await request('t=Video'));
    expect(fetched).toEqual([]);
  });

  it('senza parametri: scheda generica di Solco, in cache', async () => {
    const response = await request('');
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(lastCardText()).toContain('Musica su Solco');
  });
});

describe('indirizzo canonico', () => {
  it('parametri in più, in un altro ordine o testo non pulito: 308 verso la forma canonica', async () => {
    expectRedirect(await request('t=A&x=1'), '/search/anteprima.jpg?t=A');
    expectRedirect(await request('a=B&t=A'), '/search/anteprima.jpg?t=A&a=B');
    expectRedirect(
      await request('t=%20Notte%20%20Chiara%20'),
      '/search/anteprima.jpg?t=Notte%20Chiara',
    );
    expectRedirect(await request('t=A&t=B'), '/search/anteprima.jpg?t=A');
    expectRedirect(
      await request('q=Vasco%20Albachiara'),
      '/search/anteprima.jpg?t=Vasco%20Albachiara',
    );
    // Con un id Audius conta solo l'id: titolo e artista arrivano da Audius.
    expectRedirect(
      await request(`t=Falso&a=Altro&au=${TRACK_ID}`),
      `/search/anteprima.jpg?au=${TRACK_ID}`,
    );
    expectRedirect(await request('au=non%20valido&t=A'), '/search/anteprima.jpg?t=A');
    expectRedirect(await request('x=1'), '/search/anteprima.jpg');
    // Nessun redirect consuma il limite né legge Audius.
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.getTrack).not.toHaveBeenCalled();
  });

  it('segmenti vuoti nella query: 308 verso la forma canonica (una sola voce in CDN)', async () => {
    expectRedirect(await request('t=A&'), '/search/anteprima.jpg?t=A');
    expectRedirect(await request('&t=A'), '/search/anteprima.jpg?t=A');
    expectRedirect(await request('t=A&&a=B'), '/search/anteprima.jpg?t=A&a=B');
    expectRedirect(await request('t=A&&&&&&&&'), '/search/anteprima.jpg?t=A');
    expectRedirect(await request(`au=${TRACK_ID}&`), `/search/anteprima.jpg?au=${TRACK_ID}`);
    // Un "?" senza nulla: verso l'indirizzo senza query.
    const bare = await previewImage(new Request('https://solco.test/search/anteprima.jpg?'));
    expectRedirect(bare, '/search/anteprima.jpg');
    expect(mocks.getTrack).not.toHaveBeenCalled();
  });

  it('indirizzi web attaccati a una parola o senza schema spariscono', async () => {
    expectRedirect(
      await request(`t=${encodeURIComponent('_https://evil.example/login')}`),
      '/search/anteprima.jpg?t=_',
    );
    expectRedirect(
      await request(`t=Ciao&a=${encodeURIComponent('1www.evil.example/x')}`),
      '/search/anteprima.jpg?t=Ciao',
    );
    expectRedirect(
      await request(`t=${encodeURIComponent('Vaiahttps://evil.example ora')}`),
      '/search/anteprima.jpg?t=Vaia%20ora',
    );
    expectRedirect(
      await request(`t=${encodeURIComponent('Solco chiude, vai su evil.com')}`),
      '/search/anteprima.jpg?t=Solco%20chiude%2C%20vai%20su',
    );
    expectRedirect(
      await request(`t=${encodeURIComponent('Brano sito.example/login')}`),
      '/search/anteprima.jpg?t=Brano',
    );
    // Nomi veri con un punto restano.
    for (const name of ['will.i.am', 'Vol.II', 'Mr.Brightside']) {
      const response = await request(`t=${encodeURIComponent(name)}`);
      expect(response.status, name).toBe(200);
    }
  });

  it('indirizzi web nel testo libero spariscono (anche dal canonico)', async () => {
    expectRedirect(
      await request(`t=${encodeURIComponent('Ascolta www.evil.example/x ora')}`),
      '/search/anteprima.jpg?t=Ascolta%20ora',
    );
    expectRedirect(
      await request(`t=Brano&a=${encodeURIComponent('Vai su https://evil.example')}`),
      '/search/anteprima.jpg?t=Brano&a=Vai%20su',
    );
    expectRedirect(
      await request(`t=${encodeURIComponent('https://evil.example/phish')}`),
      '/search/anteprima.jpg',
    );
  });

  it('la stessa query codificata in altro modo non viene reindirizzata (niente giri in tondo)', async () => {
    for (const query of [
      't=Notte+Chiara&a=Artista%20Uno',
      't=Notte%20Chiara&a=Artista+Uno',
      't=Help!&a=The%20Beatles',
      't=%4Eotte',
      't=%C3%A8%20cos%C3%AC',
      't=è%20così',
    ]) {
      const response = await request(query);
      expect(response.status, query).toBe(200);
    }
  });

  it('il canonico di un canonico è sé stesso (anche con testo difficile)', async () => {
    for (const query of [
      `t=${encodeURIComponent('😀'.repeat(130))}`,
      `t=${encodeURIComponent('a'.repeat(118))}%20htt`,
      `t=${encodeURIComponent('Titolo � rotto')}&a=%E0%A4%A`,
      `t=${encodeURIComponent('www.a www.b fine')}`,
    ]) {
      const first = await request(query);
      expect([200, 308], query).toContain(first.status);
      const location = first.status === 308 ? (first.headers.get('location') ?? '') : null;
      if (location) {
        const again = await request(location.split('?')[1] ?? '');
        expect(again.status, location).toBe(200);
      }
    }
  });
});

describe('limite per IP', () => {
  it('oltre il limite: 429 senza disegnare; limitatore giù: l’anteprima resta (fail open)', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 30,
      error: 'rate_limited',
      message: 'troppe',
    });
    const limited = await request('t=X');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(mocks.drawn).toHaveLength(0);

    mocks.consumeRateLimit.mockRejectedValue(new Error('database down'));
    await expectJpeg(await request('t=X'));
  });
});

describe('vecchio indirizzo .png', () => {
  it('308 verso .jpg con la stessa query, in cache, senza disegnare', async () => {
    const response = await legacyPreview(
      new Request(
        `https://solco.test/search/anteprima.png?t=Notte&img=${encodeURIComponent(EVIL)}`,
      ),
    );
    expectRedirect(response, `/search/anteprima.jpg?t=Notte&img=${encodeURIComponent(EVIL)}`);
    expect(mocks.drawn).toHaveLength(0);
    expect(fetched).toEqual([]);
    // La rotta .jpg poi riporta la query alla forma canonica (img scartato).
    expectRedirect(
      await request(`t=Notte&img=${encodeURIComponent(EVIL)}`),
      '/search/anteprima.jpg?t=Notte',
    );
  });
});

describe('metadati di /search per un brano condiviso', () => {
  it('titolo e immagine JPEG canonica; con un id Audius l’immagine porta solo l’id', async () => {
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({
        q: 'Artista Uno Notte Chiara',
        t: 'Notte Chiara',
        a: 'Artista Uno',
        au: TRACK_ID,
        img: EVIL,
      }),
    });
    expect(metadata.title).toBe('Notte Chiara · Artista Uno');
    const og = JSON.stringify(metadata.openGraph);
    expect(og).toContain(JSON.stringify(`/search/anteprima.jpg?au=${TRACK_ID}`));
    expect(og).toContain('"image/jpeg"');
    expect(og).toContain('"width":1200');
    expect(JSON.stringify(metadata)).not.toContain('evil.example');
    expect(JSON.stringify(metadata.twitter)).toContain('summary_large_image');
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('senza id: immagine ?t=…&a=…; testo libero senza indirizzi web', async () => {
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({
        t: 'Notte Chiara www.evil.example',
        a: 'Artista https://evil.example/x',
      }),
    });
    expect(metadata.title).toBe('Notte Chiara · Artista');
    expect(JSON.stringify(metadata.openGraph)).toContain(
      JSON.stringify('/search/anteprima.jpg?t=Notte%20Chiara&a=Artista'),
    );
    expect(JSON.stringify(metadata)).not.toContain('evil');
  });

  it('og:url: il link canonico del brano, lo stesso della paginetta in modalità attacco', async () => {
    const base = 'https://www.solcomusic.online';
    for (const [title, artist, audiusId] of [
      ['Albachiara', 'Vasco Rossi', null],
      ['Luci basse', 'Artista Audius', TRACK_ID],
      ['Radio Deejay', null, null],
    ] as const) {
      const link = songShareUrl(title, artist, base, audiusId);
      const params = Object.fromEntries(new URL(link).searchParams);
      const metadata = await generateMetadata({
        searchParams: Promise.resolve({ ...params, fbclid: 'abc' }),
      });
      const url = (metadata.openGraph as { url?: string } | undefined)?.url;
      // Relativo: metadataBase lo rende assoluto sulla stessa origine dell'app.
      expect(url, title).toBe(link.slice(base.length));
      const preview = linkPreviewFor(new URL(`${link}&fbclid=abc`), base);
      expect(preview.url, title).toBe(link);
    }
  });

  it('una ricerca normale resta com’è', async () => {
    const plain = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(plain.title).toBe('Cerca');
    expect(plain.openGraph).toBeUndefined();
  });

  it('l’immagine allegata dal player è identica, byte per byte, all’og:image della pagina', async () => {
    const cases: Array<[string, string | null, string | null]> = [
      ['Albachiara', 'Vasco Rossi', null],
      ['Luci basse', 'Artista Audius', TRACK_ID],
      ['  Help!  (Remastered) ', 'The   Beatles', null],
      [`${'Ж'.repeat(119)}😀😀`, 'Ω'.repeat(90), null],
      ['Brano www.evil.example', null, null],
      ['Radio Deejay', null, null],
    ];
    for (const [title, artist, audiusId] of cases) {
      const link = songShareUrl(title, artist, 'https://www.solcomusic.online', audiusId);
      const params = Object.fromEntries(new URL(link).searchParams);
      const metadata = await generateMetadata({ searchParams: Promise.resolve(params) });
      const images = (metadata.openGraph as { images?: Array<{ url: string }> } | undefined)
        ?.images;
      expect(images?.[0]?.url, title).toBe(songShareImagePath(link));
    }
  });
});
