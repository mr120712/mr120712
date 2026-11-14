// @polsia:user-owned — anteprima social di un brano condiviso: scheda PNG con la copertina Audius
// e metadati della pagina /search; mai miniature YouTube, mai URL arbitrari scaricati.
// @vitest-environment node
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ consumeRateLimit: vi.fn() }));

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

import { GET as previewImage } from '@/app/(custom)/search/anteprima.png/route';
import { generateMetadata } from '@/app/(custom)/search/page';

const AUDIUS_COVER = 'https://audius.co/content/QmAbcdefghijklmnopqrstuvwxyz12/480x480.jpg';
const YOUTUBE_THUMB = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
let JPEG: Uint8Array;
let fetched: string[] = [];

beforeAll(async () => {
  JPEG = new Uint8Array(
    await sharp({ create: { width: 48, height: 48, channels: 3, background: '#7c3aed' } })
      .jpeg()
      .toBuffer(),
  );
});

function request(query: string, ip = '203.0.113.7') {
  return previewImage(
    new Request(`https://solco.test/search/anteprima.png?${query}`, {
      headers: ip ? { 'x-real-ip': ip } : {},
    }),
  );
}

async function expectPng(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  const png = new Uint8Array(await response.arrayBuffer());
  expect([...png.slice(1, 4)].map((code) => String.fromCharCode(code)).join('')).toBe('PNG');
}

const PUBLIC_CACHE = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';

beforeEach(() => {
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  fetched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      // Solo le richieste di rete (next/og carica il suo wasm da un URL data:).
      if (url.startsWith('http')) fetched.push(url);
      return url === AUDIUS_COVER
        ? new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
        : new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anteprima social di un brano condiviso', () => {
  it('scheda con la copertina Audius, in cache sulla CDN', async () => {
    const response = await request(
      `t=Notte%20Chiara&a=Artista%20Uno&img=${encodeURIComponent(AUDIUS_COVER)}`,
    );
    await expectPng(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(fetched).toEqual([AUDIUS_COVER]);
  });

  it('mai miniature YouTube né host qualsiasi: scheda tipografica, nessun download', async () => {
    for (const img of [YOUTUBE_THUMB, 'https://evil.example/x.jpg', 'http://127.0.0.1/a.jpg']) {
      const response = await request(`t=Video&img=${encodeURIComponent(img)}`);
      await expectPng(response);
      expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    }
    expect(fetched).toEqual([]);
  });

  it('copertina che non arriva: la scheda c’è, ma non resta in cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const response = await request(`t=Notte&img=${encodeURIComponent(AUDIUS_COVER)}`);
    await expectPng(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('senza titolo: scheda di Solco; oltre il limite: 429 senza disegnare', async () => {
    await expectPng(await request(''));
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
  });
});

describe('metadati di /search per un brano condiviso', () => {
  it('titolo, descrizione e immagine della scheda per WhatsApp, Telegram, X, Facebook', async () => {
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({
        q: 'Artista Uno Notte Chiara',
        t: 'Notte Chiara',
        a: 'Artista Uno',
        img: AUDIUS_COVER,
      }),
    });
    expect(metadata.title).toBe('Notte Chiara · Artista Uno');
    const image = `/search/anteprima.png?t=Notte%20Chiara&a=Artista%20Uno&img=${encodeURIComponent(AUDIUS_COVER)}`;
    expect(JSON.stringify(metadata.openGraph)).toContain(JSON.stringify(image));
    expect(JSON.stringify(metadata.twitter)).toContain('summary_large_image');
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('una ricerca normale resta com’è; una copertina YouTube non entra nell’immagine', async () => {
    const plain = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(plain.title).toBe('Cerca');
    expect(plain.openGraph).toBeUndefined();
    const video = await generateMetadata({
      searchParams: Promise.resolve({ t: 'Video', img: YOUTUBE_THUMB }),
    });
    expect(JSON.stringify(video)).not.toContain('ytimg');
  });
});
