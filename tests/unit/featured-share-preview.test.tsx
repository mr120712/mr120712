// @polsia:user-owned — anteprima social del link diretto di un brano in evidenza: scheda JPEG
// /evidenza/<id>/anteprima.jpg costruita SOLO dai dati dell'indice dei brani dichiarati (titolo,
// artista e la copertina del brano dichiarato letta dallo store, mai un URL esterno), cache CDN se
// completa e no-store se degradata, 404 per id sconosciuti/non dichiarati/malformati, 308 per ogni
// query string; metadati della pagina /evidenza/<id> con il titolo vero (entro ~1,5 s, altrimenti
// generici) e nessun pathname del file in metadati o HTML.
// @vitest-environment node
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
  consumeRateLimit: vi.fn(),
  drawn: [] as ReactElement[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@vercel/blob', () => ({
  list: mocks.list,
  get: mocks.get,
  BlobNotFoundError: class BlobNotFoundError extends Error {},
}));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  getRateLimitIdentity: (_userId: string | null, headers: Headers) =>
    headers.get('x-real-ip') ? `ip:${headers.get('x-real-ip')}` : null,
}));
// Il guscio della pagina: la vista client vera, con sessione e player finti.
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: null, isPending: true }) }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: 'idle',
    playTrack: vi.fn(),
    togglePlayback: vi.fn(),
  }),
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

import { GET as previewImage } from '@/app/(custom)/evidenza/[shareId]/anteprima.jpg/route';
import FeaturedSharePage, { generateMetadata } from '@/app/(custom)/evidenza/[shareId]/page';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';
import { featuredShareId } from '@/lib/music/featured-share.server';

const SECRET = 'segreto-di-prova-per-le-anteprime-0123456789';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600';

function blob(pathname: string, uploadedAt = '2026-10-01T00:00:00.000Z', size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

const DECLARED = 'Cantautori Segreti/Lucio Dalla - Caruso.mp3';
const DECLARED_NO_COVER = 'Lucio Dalla - Anna e Marco.ogg';
const UNDECLARED = 'Download/Artista Commerciale - Hit.mp3';
const FOLDER_COVER = 'Cantautori Segreti/cover.jpg';
const UNDECLARED_COVER = 'Download/cover.jpg';
const STORE = [
  blob(DECLARED, '2026-10-03T00:00:00.000Z'),
  blob(DECLARED_NO_COVER, '2026-10-02T00:00:00.000Z'),
  blob(FOLDER_COVER),
  blob(UNDECLARED, '2026-10-05T00:00:00.000Z'),
  blob(UNDECLARED_COVER),
  blob('diritti.json', '2026-10-07T00:00:00.000Z', 200),
];
const MANIFEST = JSON.stringify({
  versione: 1,
  brani: [DECLARED, DECLARED_NO_COVER].map((file) => ({
    file,
    licenza: 'propria',
    titolare: 'Solco',
  })),
});

const DECLARED_ID = featuredShareId(DECLARED, SECRET);
const NO_COVER_ID = featuredShareId(DECLARED_NO_COVER, SECRET);
const UNDECLARED_ID = featuredShareId(UNDECLARED, SECRET);
const UNKNOWN_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

let JPEG: Uint8Array;
let fetched: string[] = [];

beforeAll(async () => {
  JPEG = new Uint8Array(
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#7c3aed' } })
      .jpeg()
      .toBuffer(),
  );
});

function stored(data: Uint8Array | string, pathname: string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return {
    statusCode: 200,
    stream: new Response(bytes).body,
    headers: new Headers({ 'content-length': String(bytes.byteLength) }),
    blob: { pathname, size: bytes.byteLength },
  };
}

/** Le immagini lette dallo store (pathname decodificati). */
function imageReads() {
  return mocks.get.mock.calls
    .map(([target]) => decodeURIComponent(String(target)))
    .filter((target) => target.endsWith('.jpg'));
}

function serveStore() {
  mocks.list.mockImplementation(async () => ({ blobs: STORE, hasMore: false }));
  mocks.get.mockImplementation(async (target: string) => {
    if (String(target).endsWith('.jpg')) return stored(JPEG, decodeURIComponent(String(target)));
    return stored(MANIFEST, 'diritti.json');
  });
}

function request(shareId: string, query = '', ip = '203.0.113.7') {
  return previewImage(
    new Request(`https://solco.test/evidenza/${shareId}/anteprima.jpg${query}`, {
      headers: ip ? { 'x-real-ip': ip } : {},
    }),
    { params: Promise.resolve({ shareId }) },
  );
}

async function expectJpeg(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/jpeg');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  const jpeg = new Uint8Array(await response.arrayBuffer());
  expect([...jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  const meta = await sharp(Buffer.from(jpeg)).metadata();
  expect([meta.width, meta.height]).toEqual([1200, 630]);
}

/** Il testo (e le immagini) della scheda disegnata per ultima. */
function lastCardMarkup() {
  const node = mocks.drawn.at(-1);
  return node ? renderToStaticMarkup(node) : '';
}

function lastCardText() {
  return lastCardMarkup().replace(/<[^>]+>/g, ' ');
}

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  mocks.token = 'tok_test';
  mocks.drawn.length = 0;
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  serveStore();
  fetched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('http')) fetched.push(url);
      return new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /evidenza/<id>/anteprima.jpg', () => {
  it('scheda «ASCOLTA SU SOLCO» del brano dichiarato, con la sua copertina; in cache sulla CDN', async () => {
    const response = await request(DECLARED_ID);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    const text = lastCardText();
    expect(text).toContain('ASCOLTA SU SOLCO');
    expect(text).toContain('Caruso');
    expect(text).toContain('Lucio Dalla');
    expect(lastCardMarkup()).toContain('data:image/jpeg;base64,');
    // La copertina viene SOLO dal brano dichiarato (la sua cartella), mai dalla rete né da altri.
    expect(imageReads()).toEqual([FOLDER_COVER]);
    expect(fetched).toEqual([]);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og', 'ip:203.0.113.7');
    // Nessun pathname nella scheda.
    expect(lastCardMarkup()).not.toContain('Cantautori');
  });

  it('brano dichiarato senza copertina: l’iniziale, scheda completa (in cache)', async () => {
    const response = await request(NO_COVER_ID);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(lastCardText()).toContain('Anna e Marco');
    expect(lastCardMarkup()).not.toContain('data:image/jpeg');
    expect(imageReads()).toEqual([]);
  });

  it('copertina attesa ma non letta: scheda senza copertina, mai in cache', async () => {
    mocks.get.mockImplementation(async (target: string) => {
      if (String(target).endsWith('.jpg')) throw new Error('rete');
      return stored(MANIFEST, 'diritti.json');
    });
    const response = await request(DECLARED_ID);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(lastCardText()).toContain('Caruso');
  });

  it('id sconosciuto, non dichiarato o malformato: 404 no-store, nessun disegno', async () => {
    for (const id of [UNKNOWN_ID, UNDECLARED_ID, 'non-valido']) {
      const response = await request(id);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    expect(mocks.drawn).toEqual([]);
    expect(imageReads()).toEqual([]);
  });

  it('qualsiasi query string: 308 verso l’indirizzo senza query', async () => {
    for (const query of ['?v=2', '?p=Download%2Fcover.jpg', '?t=Altro']) {
      const response = await request(DECLARED_ID, query);
      expect(response.status).toBe(308);
      expect(response.headers.get('location')).toBe(`/evidenza/${DECLARED_ID}/anteprima.jpg`);
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    expect(mocks.drawn).toEqual([]);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('troppe anteprime da un IP: 429 no-store; limitatore giù: si disegna (fail open)', async () => {
    mocks.consumeRateLimit.mockResolvedValueOnce({
      allowed: false,
      status: 429,
      retryAfterSeconds: 30,
    });
    const limited = await request(DECLARED_ID);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(limited.headers.get('cache-control')).toBe('no-store');

    mocks.consumeRateLimit.mockRejectedValueOnce(new Error('db giù'));
    await expectJpeg(await request(DECLARED_ID));
  });

  it('indice non leggibile: scheda generica, mai in cache', async () => {
    mocks.token = undefined;
    const response = await request(DECLARED_ID);
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(lastCardText()).toContain('Musica su Solco');
  });
});

describe('metadati della pagina /evidenza/<id>', () => {
  async function metadataFor(shareId: string) {
    return generateMetadata({ params: Promise.resolve({ shareId }) });
  }

  it('titolo «Titolo · Artista», descrizione, og:image JPEG 1200×630, og:url, twitter, noindex', async () => {
    const metadata = await metadataFor(DECLARED_ID);
    expect(metadata.title).toBe('Caruso · Lucio Dalla');
    expect(metadata.description).toBe('Ascoltalo su Solco.');
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.openGraph).toMatchObject({
      type: 'music.song',
      // L'openGraph della pagina sostituisce quello del layout: nome del sito e lingua ripetuti.
      siteName: 'Solco',
      locale: 'it_IT',
      title: 'Caruso · Lucio Dalla',
      description: 'Ascoltalo su Solco.',
      url: `/evidenza/${DECLARED_ID}`,
      images: [
        {
          url: `/evidenza/${DECLARED_ID}/anteprima.jpg`,
          type: 'image/jpeg',
          width: 1200,
          height: 630,
          alt: 'Caruso · Lucio Dalla',
        },
      ],
    });
    expect(metadata.twitter).toMatchObject({
      card: 'summary_large_image',
      title: 'Caruso · Lucio Dalla',
      images: [`/evidenza/${DECLARED_ID}/anteprima.jpg`],
    });
    // Nessun pathname: né la cartella, né il nome del file, né l'estensione.
    const serialized = JSON.stringify(metadata);
    for (const leak of ['Cantautori', 'Segreti', '.mp3', 'cover.jpg', 'home-tracks']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('indice lento: entro ~1,5 s metadati generici (con l’immagine), mai un errore', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Il manifest non arriva mai: l'indice resta in costruzione.
    mocks.get.mockImplementation(() => new Promise(() => undefined));
    let settled = false;
    const pending = metadataFor(DECLARED_ID).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    const metadata = await pending;
    expect(metadata.title).toBe('Un brano in evidenza su Solco');
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.openGraph).toMatchObject({
      siteName: 'Solco',
      locale: 'it_IT',
      url: `/evidenza/${DECLARED_ID}`,
      images: [{ url: `/evidenza/${DECLARED_ID}/anteprima.jpg` }],
    });
  });

  it('id sconosciuto, non dichiarato o malformato: generici, senza immagine né og:url', async () => {
    for (const id of [UNKNOWN_ID, UNDECLARED_ID, 'non-valido']) {
      const metadata = await metadataFor(id);
      expect(metadata).toEqual({
        title: 'Un brano in evidenza su Solco',
        description: 'Ascoltalo su Solco.',
        robots: { index: false, follow: true },
      });
    }
  });

  it('l’HTML della pagina (guscio) non contiene il pathname', async () => {
    const page = await FeaturedSharePage({ params: Promise.resolve({ shareId: DECLARED_ID }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('Caricamento del brano');
    for (const leak of ['Cantautori', 'Caruso', '.mp3', 'home-tracks']) {
      expect(html).not.toContain(leak);
    }
  });
});
