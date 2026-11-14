// @polsia:user-owned — anteprima social del quiz musicale (quiz/anteprima.jpg): scheda JPEG
// canonica, titolo e copertina SFOCATA solo da Audius (mai un URL dal link), titolo del link
// ripulito, mai l'artista; stessa difesa della scheda dei brani (308 canonico, segmenti vuoti,
// limite per IP, nessuna cache per una scheda incompleta).
// @vitest-environment node
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  getTrack: vi.fn(),
  drawn: [] as ReactElement[],
  failDraws: 0,
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
// next/og vero; si registra la scheda disegnata (per leggerne testo e copertina) e un disegno può
// fallire su richiesta, per provare i ripieghi.
vi.mock('next/og', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/og')>();
  class RecordingImageResponse extends actual.ImageResponse {
    constructor(...args: ConstructorParameters<typeof actual.ImageResponse>) {
      mocks.drawn.push(args[0] as ReactElement);
      if (mocks.failDraws > 0) {
        mocks.failDraws -= 1;
        throw new Error('disegno non riuscito');
      }
      super(...args);
    }
  }
  return { ...actual, ImageResponse: RecordingImageResponse };
});

import { GET as quizImage } from '@/app/(custom)/quiz/anteprima.jpg/route';
import { clearAudiusShareCardCacheForTests } from '@/lib/music/audius-share-card.server';

const CID = 'baeaaaiqsec3v4qj7c6afbm4jcuij6qqq4ycn5plde7u6lhldnierwopply35m';
const AUDIUS_COVER = `https://audius-01.staked.cloud/content/${CID}/480x480.jpg`;
const EVIL = 'https://evil.example/content/QmAbcdefghijklmnopqrstuvwxyz12/480x480.jpg';
const TRACK_ID = 'J7Xb000';
const ARTIST = 'Artista Segreto';
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
const REDIRECT_CACHE = 'public, max-age=3600, s-maxage=86400';

/** Copertina con forti contrasti (strisce bianche e nere di 8 px): sfocata diventa uniforme. */
let STRIPES: Uint8Array;
let NOISY: Uint8Array;
let STRIPES_STDEV = 0;
let fetched: string[] = [];
let covers: Record<string, () => Response> = {};

function audiusTrack(id: string, title = 'Luci basse', artist = ARTIST) {
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
    },
  };
}

async function stdev(image: Uint8Array | Buffer) {
  const stats = await sharp(image).greyscale().stats();
  return stats.channels[0]?.stdev ?? 0;
}

beforeAll(async () => {
  const size = 480;
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = Math.floor(x / 8) % 2 === 0 ? 0 : 255;
      raw.fill(value, (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
  }
  STRIPES = new Uint8Array(
    await sharp(raw, { raw: { width: size, height: size, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer(),
  );
  STRIPES_STDEV = await stdev(STRIPES);
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
});

function request(query: string, ip = '203.0.113.7') {
  return quizImage(
    new Request(`https://solco.test/quiz/anteprima.jpg${query ? `?${query}` : ''}`, {
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

function lastCardMarkup() {
  const node = mocks.drawn.at(-1);
  return node ? renderToStaticMarkup(node) : '';
}

/** Il testo della scheda disegnata per ultima. */
function lastCardText() {
  return lastCardMarkup()
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/** La copertina disegnata (data URL), se c'è. */
function lastCover(): Buffer | null {
  const match = /src="data:image\/jpeg;base64,([^"]+)"/.exec(lastCardMarkup());
  return match?.[1] ? Buffer.from(match[1], 'base64') : null;
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
  mocks.failDraws = 0;
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.getTrack.mockReset().mockImplementation(async (id: string) => audiusTrack(id));
  fetched = [];
  covers = {
    [AUDIUS_COVER]: () => new Response(STRIPES, { headers: { 'content-type': 'image/jpeg' } }),
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

describe('quiz di un brano Audius (?au=)', () => {
  it('titolo e copertina sfocata solo da Audius, mai l’artista; in cache sulla CDN', async () => {
    const response = await request(`au=${TRACK_ID}`);
    const jpeg = await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(mocks.getTrack).toHaveBeenCalledWith(TRACK_ID);
    // L'unica immagine scaricata è la copertina indicata da Audius.
    expect(fetched).toEqual([AUDIUS_COVER]);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og', 'ip:203.0.113.7');
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og.audius', 'ip:203.0.113.7');
    const text = lastCardText();
    expect(text).toContain('QUIZ MUSICALE · SOLCO');
    expect(text).toContain('Chi interpreta');
    expect(text).toContain('«Luci basse»?');
    expect(text).toContain('Gira la carta su Solco');
    expect(text).not.toContain(ARTIST);
    expect(text).not.toContain('Segreto');
    // La copertina c'è ed è sfocata: le strisce nette diventano (quasi) uniformi.
    const cover = lastCover();
    expect(cover).not.toBeNull();
    expect(STRIPES_STDEV).toBeGreaterThan(100);
    expect(await stdev(cover as Buffer)).toBeLessThan(STRIPES_STDEV / 5);
    expect(jpeg.byteLength).toBeLessThan(250_000);
    const meta = await sharp(jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1200, 630]);
  });

  it('copertina fotografica: JPEG 1200×630 sotto i 250 KB (WhatsApp: ~300 KB al massimo)', async () => {
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

  it('indirizzi web nel titolo Audius: tolti dalla scheda', async () => {
    mocks.getTrack.mockResolvedValue(
      audiusTrack(TRACK_ID, 'Solco chiude: vai su https://evil.example/login', 'www.evil.example'),
    );
    await expectJpeg(await request(`au=${TRACK_ID}`));
    expect(lastCardText()).not.toContain('evil');
  });

  it('lettura Audius non riuscita: scheda generica «Quiz musicale su Solco», mai in cache', async () => {
    mocks.getTrack.mockRejectedValue(new Error('Audius down'));
    const response = await request(`au=${TRACK_ID}`);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetched).toEqual([]);
    const text = lastCardText();
    expect(text).toContain('Quiz musicale su Solco');
    expect(text).not.toContain('Chi interpreta');
    expect(lastCover()).toBeNull();
  });

  it('brano che Solco non può far ascoltare: scheda generica, mai in cache', async () => {
    mocks.getTrack.mockResolvedValue({
      data: { ...audiusTrack(TRACK_ID).data, license: 'All rights reserved' },
    });
    const response = await request(`au=${TRACK_ID}`);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(lastCardText()).toContain('Quiz musicale su Solco');
    expect(lastCardText()).not.toContain('Luci basse');
  });

  it('copertina che non arriva: scheda con il «?» ma non in cache', async () => {
    covers = { [AUDIUS_COVER]: () => new Response(null, { status: 500 }) };
    const response = await request(`au=${TRACK_ID}`);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(lastCardText()).toContain('«Luci basse»?');
    expect(lastCover()).toBeNull();
  });

  it('disegno con la copertina fallito: si ripiega senza copertina, mai in cache', async () => {
    mocks.failDraws = 1;
    const response = await request(`au=${TRACK_ID}`);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(lastCardText()).toContain('«Luci basse»?');
    expect(lastCover()).toBeNull();
  });

  it('la copertina sfocata non è quella nitida della scheda dei brani (voci di memoria diverse)', async () => {
    const { getAudiusShareCover } = await import('@/lib/music/audius-share-card.server');
    const sharp1 = await getAudiusShareCover(AUDIUS_COVER, 358, '#000000');
    const blurred = await getAudiusShareCover(AUDIUS_COVER, 358, '#000000', { blur: 28 });
    expect(sharp1).not.toBeNull();
    expect(blurred).not.toBeNull();
    expect(blurred).not.toBe(sharp1);
    const decode = (url: string | null) => Buffer.from(String(url).split(',')[1] ?? '', 'base64');
    expect(await stdev(decode(blurred))).toBeLessThan((await stdev(decode(sharp1))) / 5);
  });
});

describe('quiz dal titolo del link (?t=)', () => {
  it('titolo tra « », grande «?» e nessuna copertina; in cache', async () => {
    const response = await request('t=Notte%20Chiara');
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(fetched).toEqual([]);
    expect(mocks.getTrack).not.toHaveBeenCalled();
    const text = lastCardText();
    expect(text).toContain('QUIZ MUSICALE · SOLCO');
    expect(text).toContain('Chi interpreta');
    expect(text).toContain('«Notte Chiara»?');
    expect(text).toContain('?');
    expect(lastCover()).toBeNull();
  });

  it('senza parametri: scheda generica del quiz, in cache', async () => {
    const response = await request('');
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(lastCardText()).toContain('Quiz musicale su Solco');
  });
});

describe('indirizzo canonico', () => {
  it('parametri in più, ripetuti, l’artista o un img: 308 verso la forma canonica', async () => {
    expectRedirect(await request('t=A&x=1'), '/quiz/anteprima.jpg?t=A');
    expectRedirect(await request('t=A&a=Artista'), '/quiz/anteprima.jpg?t=A');
    expectRedirect(await request('t=A&t=B'), '/quiz/anteprima.jpg?t=A');
    expectRedirect(
      await request('t=%20Notte%20%20Chiara%20'),
      '/quiz/anteprima.jpg?t=Notte%20Chiara',
    );
    expectRedirect(
      await request(`t=Video&img=${encodeURIComponent(EVIL)}`),
      '/quiz/anteprima.jpg?t=Video',
    );
    // Con un id Audius conta solo l'id: il titolo arriva da Audius.
    expectRedirect(await request(`t=Falso&au=${TRACK_ID}`), `/quiz/anteprima.jpg?au=${TRACK_ID}`);
    expectRedirect(await request(`au=${TRACK_ID}&t=Falso`), `/quiz/anteprima.jpg?au=${TRACK_ID}`);
    expectRedirect(await request('au=non%20valido&t=A'), '/quiz/anteprima.jpg?t=A');
    // Un codice di quiz (con la risposta) non entra mai nell'indirizzo dell'immagine.
    expectRedirect(await request('c=1.QnJhbm8fQXJ0aXN0YQ&t=A'), '/quiz/anteprima.jpg?t=A');
    expectRedirect(await request('x=1'), '/quiz/anteprima.jpg');
    expectRedirect(
      await request(`t=${encodeURIComponent('Ascolta www.evil.example/x ora')}`),
      '/quiz/anteprima.jpg?t=Ascolta%20ora',
    );
    // Nessun redirect consuma il limite né legge Audius.
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.getTrack).not.toHaveBeenCalled();
    expect(mocks.drawn).toHaveLength(0);
  });

  it('segmenti vuoti nella query: 308 verso la forma canonica (una sola voce in CDN)', async () => {
    expectRedirect(await request('t=A&'), '/quiz/anteprima.jpg?t=A');
    expectRedirect(await request('&t=A'), '/quiz/anteprima.jpg?t=A');
    expectRedirect(await request('t=A&&&&'), '/quiz/anteprima.jpg?t=A');
    expectRedirect(await request(`au=${TRACK_ID}&`), `/quiz/anteprima.jpg?au=${TRACK_ID}`);
    const bare = await quizImage(new Request('https://solco.test/quiz/anteprima.jpg?'));
    expectRedirect(bare, '/quiz/anteprima.jpg');
    expect(mocks.getTrack).not.toHaveBeenCalled();
  });

  it('la stessa query codificata in altro modo non viene reindirizzata (niente giri in tondo)', async () => {
    for (const query of ['t=Notte+Chiara', 't=Help!', 't=%4Eotte', 't=%C3%A8%20cos%C3%AC']) {
      const response = await request(query);
      expect(response.status, query).toBe(200);
    }
  });

  it('il canonico di un canonico è sé stesso (anche con testo difficile)', async () => {
    for (const query of [
      `t=${encodeURIComponent('😀'.repeat(130))}`,
      `t=${encodeURIComponent('a'.repeat(118))}%20htt`,
      `t=${encodeURIComponent('Titolo � rotto')}`,
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
    expect(await limited.text()).toContain('Riprova tra 30 secondi');
    expect(mocks.drawn).toHaveLength(0);
    expect(mocks.getTrack).not.toHaveBeenCalled();

    mocks.consumeRateLimit.mockRejectedValue(new Error('database down'));
    await expectJpeg(await request('t=X'));
  });
});
