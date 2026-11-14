// @polsia:user-owned
// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSharedPlaylist: vi.fn(),
  /** La lettura leggera dei metadati (solo la descrizione) e il controllo del proprietario. */
  findCollection: vi.fn(),
  findUser: vi.fn(),
  consumeRateLimit: vi.fn(),
  /** How many of the next drawings fail (next/og throws), to exercise the fallbacks. */
  failDraws: 0,
  /** Intestazioni della richiesta della pagina, lette dai metadati (IP per il limite share.og). */
  requestHeaders: {} as Record<string, string>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    userMusicCollection: { findFirst: mocks.findCollection },
    user: { findUnique: mocks.findUser },
  },
}));
vi.mock('@/lib/site', () => ({ siteUrl: 'https://solco.test' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(mocks.requestHeaders) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  getRateLimitIdentity: (userId: string | null, headers: Headers) =>
    userId ? `user:${userId}` : headers.get('x-real-ip') ? `ip:${headers.get('x-real-ip')}` : null,
}));
// The real cover selection (Audius only); only the database read is replaced.
vi.mock('@/lib/music/shared-playlists.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/shared-playlists.server')>()),
  getSharedPlaylist: mocks.getSharedPlaylist,
}));
// Il fetch SSRF-safe delle copertine delega al fetch globale (stubbato qui sotto), così il test
// continua a registrare gli URL richiesti; la logica di sicurezza resta reale ma non va in rete.
vi.mock('@/lib/net/ssrf-safe-fetch.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/net/ssrf-safe-fetch.server')>()),
  ssrfSafeFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

// The real next/og; a drawing can be made to fail on demand.
vi.mock('next/og', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/og')>();
  class FlakyImageResponse extends actual.ImageResponse {
    constructor(...args: ConstructorParameters<typeof actual.ImageResponse>) {
      if (mocks.failDraws > 0) {
        mocks.failDraws -= 1;
        throw new Error('drawing failed');
      }
      super(...args);
    }
  }
  return { ...actual, ImageResponse: FlakyImageResponse };
});

import { GET as previewImage } from '@/app/(custom)/playlist/[shareId]/anteprima.jpg/route';
import { GET as legacyPreview } from '@/app/(custom)/playlist/[shareId]/anteprima.png/route';
import { generateMetadata } from '@/app/(custom)/playlist/[shareId]/page';
import PrivacyPage from '@/app/(custom)/privacy/page';
import { linkPreviewFor } from '@/lib/security/uam-preview';

const SHARE_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const IMAGE_PATH = `/playlist/${SHARE_ID}/anteprima.jpg`;
const AUDIUS_COVER =
  'https://audius.co/content/baeaaaiqsec3v4qj7c6afbm4jcuij6qqq4ycn5plde7u6lhldnierwopply35m/480x480.jpg';
const YOUTUBE_THUMB = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg';

function item(source: 'audius' | 'youtube', artworkUrl: string, id: string) {
  return {
    source,
    sourceId: id,
    title: `Titolo ${id}`,
    creatorName: 'Artista',
    artworkUrl,
    sourceUrl: null,
    artistUrl: null,
    durationSeconds: null,
  };
}

const playlist = {
  name: 'Viaggio notturno',
  owner: 'Giulia',
  itemCount: 2,
  items: [item('youtube', YOUTUBE_THUMB, 'yt-1'), item('audius', AUDIUS_COVER, 'au-1')],
  updatedAt: '2026-11-10T12:00:00.000Z',
};

function requestImage(shareId = SHARE_ID, { query = '', ip = '203.0.113.7' } = {}) {
  return previewImage(
    new Request(`https://solco.test/playlist/${shareId}/anteprima.jpg${query}`, {
      headers: ip ? { 'x-real-ip': ip } : {},
    }),
    { params: Promise.resolve({ shareId }) },
  );
}

const PUBLIC_IMAGE_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=240';

async function expectJpeg(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/jpeg');
  // Never in image search, whatever the card.
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  const jpeg = new Uint8Array(await response.arrayBuffer());
  expect([...jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  return jpeg;
}

let fetched: string[] = [];
let COVER: Uint8Array;
let NOISY: Uint8Array;
let BOMB: Uint8Array;

/** A distinct, valid Audius cover URL per letter. */
function coverUrl(letter: string) {
  return `https://audius.co/content/baeaaaiq${letter.repeat(40)}/480x480.jpg`;
}

/** Every outgoing request is recorded; covers answer with `respond`, nothing reaches the network. */
function useCovers(respond: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('http')) return new Response(null, { status: 404 });
      fetched.push(url);
      return respond();
    }),
  );
}

beforeAll(async () => {
  COVER = new Uint8Array(
    await sharp({ create: { width: 48, height: 48, channels: 3, background: '#7c3aed' } })
      .jpeg()
      .toBuffer(),
  );
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
  BOMB = new Uint8Array(COVER);
  for (let index = 0; index < BOMB.length - 9; index += 1) {
    if (BOMB[index] === 0xff && (BOMB[index + 1] === 0xc0 || BOMB[index + 1] === 0xc2)) {
      BOMB.set([12_000 >> 8, 12_000 & 0xff, 12_000 >> 8, 12_000 & 0xff], index + 5);
      break;
    }
  }
});

beforeEach(() => {
  mocks.getSharedPlaylist.mockReset().mockResolvedValue(playlist);
  mocks.findCollection.mockReset().mockResolvedValue(null);
  mocks.findUser.mockReset().mockResolvedValue({ name: 'Giulia', banned: null });
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.failDraws = 0;
  mocks.requestHeaders = { 'x-real-ip': '198.51.100.20' };
  fetched = [];
  useCovers(() => new Response(null, { status: 404 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pagina /playlist/[shareId]', () => {
  it('non viene indicizzata, ha titolo generico e un’unica anteprima canonica', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ shareId: SHARE_ID }) });
    expect(metadata.title).toBe('Playlist condivisa');
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(JSON.stringify(metadata.openGraph)).toContain(`"${IMAGE_PATH}"`);
    expect(JSON.stringify(metadata.openGraph)).toContain('"image/jpeg"');
    expect(JSON.stringify(metadata.twitter)).toContain(`"${IMAGE_PATH}"`);
    expect(JSON.stringify(metadata)).not.toContain('Viaggio');
  });

  it('stessa anteprima della paginetta per i bot in modalità attacco (titolo, testo, og:url)', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ shareId: SHARE_ID }) });
    const og = metadata.openGraph as {
      title?: string;
      description?: string;
      url?: string;
      images?: Array<{ alt?: string }>;
    };
    const base = 'https://www.solcomusic.online';
    const preview = linkPreviewFor(new URL(`/playlist/${SHARE_ID}`, base), base);
    expect(og.title).toBe(preview.title);
    expect(og.description).toBe(preview.description);
    expect(og.images?.[0]?.alt).toBe(preview.imageAlt);
    // Relativo: metadataBase lo rende assoluto sulla stessa origine dell'app.
    expect(og.url).toBe(`/playlist/${SHARE_ID}`);
    expect(`${base}${og.url}`).toBe(preview.url);
  });

  it('senza un id valido non punta a nessuna immagine', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ shareId: 'x' }) });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(JSON.stringify(metadata)).not.toContain('anteprima');
    // Un id malformato non arriva mai al database, nemmeno per la descrizione.
    expect(mocks.findCollection).not.toHaveBeenCalled();
    expect(metadata.description).toBe(GENERIC_DESCRIPTION);
  });
});

const GENERIC_DESCRIPTION =
  'Una playlist condivisa su Solco: ascoltala gratis e salvala nella tua Libreria.';

let shareCounter = 0;
/** Un id valido nuovo per ogni test: la lettura della descrizione ricorda ogni id per un minuto. */
function freshShareId() {
  shareCounter += 1;
  return `Descr${String(shareCounter).padStart(17, '0')}`;
}

function sharedRow(description: string | null, extra: Record<string, unknown> = {}) {
  return {
    description,
    kind: 'playlist',
    sharedAt: new Date('2026-11-10T12:00:00.000Z'),
    userId: 'owner',
    ...extra,
  };
}

async function metadataFor(shareId: string) {
  const metadata = await generateMetadata({ params: Promise.resolve({ shareId }) });
  const og = metadata.openGraph as { title?: string; description?: string };
  const twitter = metadata.twitter as { title?: string; description?: string };
  return { metadata, og, twitter };
}

describe('descrizione della playlist nei metadati della pagina', () => {
  it('usa la descrizione del proprietario per description, og:description e twitter', async () => {
    const shareId = freshShareId();
    mocks.findCollection.mockResolvedValue(sharedRow('Brani lenti\nper le sere d’inverno'));
    const { metadata, og, twitter } = await metadataFor(shareId);
    expect(mocks.findCollection).toHaveBeenCalledWith({
      where: { shareId },
      select: { description: true, kind: true, sharedAt: true, userId: true },
    });
    // Su una riga nell'anteprima; il titolo resta generico.
    expect(metadata.description).toBe('Brani lenti per le sere d’inverno');
    expect(og.description).toBe(metadata.description);
    expect(twitter.description).toBe(metadata.description);
    expect(metadata.title).toBe('Playlist condivisa');
    expect(og.title).toBe('Playlist condivisa');
  });

  it('toglie gli indirizzi web e accorcia a 160 caratteri', async () => {
    mocks.findCollection.mockResolvedValue(
      sharedRow('Iscriviti su https://spam.example/promo e www.altro.example per altri brani'),
    );
    const { metadata, og } = await metadataFor(freshShareId());
    expect(metadata.description).toBe('Iscriviti su e per altri brani');
    expect(JSON.stringify(og)).not.toContain('spam.example');
    expect(JSON.stringify(og)).not.toContain('altro.example');

    mocks.findCollection.mockResolvedValue(sharedRow('lungo '.repeat(80)));
    const long = await metadataFor(freshShareId());
    expect(long.metadata.description?.length).toBeLessThanOrEqual(160);
    expect(long.metadata.description?.endsWith('…')).toBe(true);
  });

  it('senza descrizione resta la descrizione generica, uguale all’anteprima in modalità attacco', async () => {
    const shareId = freshShareId();
    mocks.findCollection.mockResolvedValue(sharedRow(null));
    const { metadata, og } = await metadataFor(shareId);
    const base = 'https://www.solcomusic.online';
    const preview = linkPreviewFor(new URL(`/playlist/${shareId}`, base), base);
    expect(metadata.description).toBe(GENERIC_DESCRIPTION);
    expect(og.description).toBe(preview.description);
  });

  it('playlist non condivisa, dei Preferiti o di un proprietario bannato: descrizione generica', async () => {
    mocks.findCollection.mockResolvedValue(sharedRow('Privata', { sharedAt: null }));
    expect((await metadataFor(freshShareId())).metadata.description).toBe(GENERIC_DESCRIPTION);
    mocks.findCollection.mockResolvedValue(sharedRow('Preferiti', { kind: 'favorites' }));
    expect((await metadataFor(freshShareId())).metadata.description).toBe(GENERIC_DESCRIPTION);
    mocks.findCollection.mockResolvedValue(sharedRow('Bannato'));
    mocks.findUser.mockResolvedValue({ name: 'Giulia', banned: true });
    expect((await metadataFor(freshShareId())).metadata.description).toBe(GENERIC_DESCRIPTION);
  });

  it('toglie anche gli indirizzi senza schema e quelli a larghezza piena', async () => {
    mocks.findCollection.mockResolvedValue(
      sharedRow(
        'Avviso Solco: Premium scaduto, rinnova su solco-premium.it/rinnovo o bit.ly/abc entro 24h',
      ),
    );
    const { metadata, og } = await metadataFor(freshShareId());
    expect(metadata.description).toBe('Avviso Solco: Premium scaduto, rinnova su o entro 24h');
    expect(JSON.stringify(og)).not.toMatch(/solco-premium|bit\.ly/);

    mocks.findCollection.mockResolvedValue(
      sharedRow('Vai su ｈｔｔｐｓ：／／ｅｖｉｌ．ｃｏｍ ora'),
    );
    expect((await metadataFor(freshShareId())).metadata.description).toBe('Vai su ora');
  });

  it('ogni lettura consuma il budget per IP delle anteprime (share.og)', async () => {
    mocks.findCollection.mockResolvedValue(sharedRow('Per correre'));
    const shareId = freshShareId();
    expect((await metadataFor(shareId)).metadata.description).toBe('Per correre');
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og', 'ip:198.51.100.20');

    // La stessa pagina entro un minuto arriva dalla memoria: niente database, niente budget.
    expect((await metadataFor(shareId)).metadata.description).toBe('Per correre');
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.findCollection).toHaveBeenCalledTimes(1);
  });

  it('limite raggiunto, limitatore che non risponde o IP sconosciuto: generica, senza leggere', async () => {
    mocks.findCollection.mockResolvedValue(sharedRow('Per correre'));
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 30,
      error: 'rate_limited',
      message: 'Troppe richieste.',
    });
    expect((await metadataFor(freshShareId())).metadata.description).toBe(GENERIC_DESCRIPTION);

    mocks.consumeRateLimit.mockRejectedValue(new Error('database down'));
    expect((await metadataFor(freshShareId())).metadata.description).toBe(GENERIC_DESCRIPTION);
    expect(mocks.findCollection).not.toHaveBeenCalled();

    // Senza IP affidabile il limitatore risponde 503 (come il vero consumeRateLimit con null).
    mocks.requestHeaders = {};
    mocks.consumeRateLimit.mockReset().mockImplementation(async (_action, identity) =>
      identity
        ? { allowed: true }
        : {
            allowed: false,
            status: 503,
            retryAfterSeconds: 60,
            error: 'rate_limit_identity_unavailable',
            message: 'Non disponibile.',
          },
    );
    expect((await metadataFor(freshShareId())).metadata.description).toBe(GENERIC_DESCRIPTION);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og', null);
    expect(mocks.findCollection).not.toHaveBeenCalled();

    // Un rifiuto non resta in memoria: con il budget di nuovo disponibile la descrizione torna.
    mocks.requestHeaders = { 'x-real-ip': '198.51.100.20' };
    const shareId = freshShareId();
    mocks.consumeRateLimit.mockResolvedValueOnce({
      allowed: false,
      status: 429,
      retryAfterSeconds: 30,
      error: 'rate_limited',
      message: 'Troppe richieste.',
    });
    expect((await metadataFor(shareId)).metadata.description).toBe(GENERIC_DESCRIPTION);
    expect((await metadataFor(shareId)).metadata.description).toBe('Per correre');
  });

  it('un id che non esiste non resta in memoria (non spinge fuori le playlist vere)', async () => {
    const shareId = freshShareId();
    mocks.findCollection.mockResolvedValue(null);
    expect((await metadataFor(shareId)).metadata.description).toBe(GENERIC_DESCRIPTION);
    // Se poi esiste (o è stato un caso), la lettura successiva va di nuovo al database.
    mocks.findCollection.mockResolvedValue(sharedRow('Adesso c’è'));
    expect((await metadataFor(shareId)).metadata.description).toBe('Adesso c’è');
    expect(mocks.findCollection).toHaveBeenCalledTimes(2);
  });

  it('se il database non risponde o è lento i metadati usano la descrizione generica', async () => {
    mocks.findCollection.mockRejectedValue(new Error('database down'));
    expect((await metadataFor(freshShareId())).metadata.description).toBe(GENERIC_DESCRIPTION);
    // La lettura è stata tentata davvero (il budget c'era): è il database a non rispondere.
    expect(mocks.findCollection).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      mocks.findCollection.mockImplementation(() => new Promise(() => undefined));
      const pending = metadataFor(freshShareId());
      await vi.advanceTimersByTimeAsync(1_500);
      expect((await pending).metadata.description).toBe(GENERIC_DESCRIPTION);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('anteprima social di una playlist condivisa', () => {
  it('non lancia mai errori, ma una lettura fallita non va in cache', async () => {
    mocks.getSharedPlaylist.mockRejectedValue(new Error('database down'));
    const response = await requestImage();
    await expectJpeg(response);
    // Link-preview crawlers keep the first image: a blip must not stick to the link.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('ha una cache CDN breve: un link non più condiviso sparisce entro ~5 minuti', async () => {
    const response = await requestImage();
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_IMAGE_CACHE);

    // "Not shared" is a stable answer: the generic card may be cached too.
    mocks.getSharedPlaylist.mockResolvedValue(null);
    const notShared = await requestImage();
    await expectJpeg(notShared);
    expect(notShared.headers.get('cache-control')).toBe(PUBLIC_IMAGE_CACHE);
  });

  it('se la scheda completa non si disegna, la versione ripiegata non va in cache', async () => {
    useCovers(() => new Response(COVER, { headers: { 'content-type': 'image/jpeg' } }));
    mocks.failDraws = 1;
    const response = await requestImage();
    await expectJpeg(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.failDraws).toBe(0);
  });

  it('una copertina che non è un’immagine vera (o troppo grande) non entra nella scheda', async () => {
    useCovers(
      () =>
        new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
          headers: { 'content-type': 'image/jpeg' },
        }),
    );
    await expectJpeg(await requestImage());
    expect(fetched).toContain(AUDIUS_COVER);

    // Pochi KB che dichiarano 12000×12000 pixel: rifiutati prima di decodificarli.
    useCovers(() => new Response(BOMB, { headers: { 'content-type': 'image/jpeg' } }));
    const started = Date.now();
    await expectJpeg(await requestImage());
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('JPEG leggero anche con 4 copertine fotografiche (WhatsApp: ~300 KB al massimo)', async () => {
    useCovers(() => new Response(NOISY, { headers: { 'content-type': 'image/jpeg' } }));
    mocks.getSharedPlaylist.mockResolvedValue({
      ...playlist,
      itemCount: 4,
      items: ['a', 'b', 'c', 'd'].map((letter) => item('audius', coverUrl(letter), letter)),
    });
    const jpeg = await expectJpeg(await requestImage());
    expect(fetched).toHaveLength(4);
    expect(jpeg.byteLength).toBeLessThan(250_000);
    const meta = await sharp(jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1200, 630]);
  });

  it('usa solo copertine Audius: non scarica mai miniature YouTube', async () => {
    await expectJpeg(await requestImage());
    expect(fetched).toContain(AUDIUS_COVER);
    expect(fetched.some((url) => url.includes('ytimg.com'))).toBe(false);

    // Only YouTube items: the plain Solco card, no cover request at all.
    fetched = [];
    mocks.getSharedPlaylist.mockResolvedValue({
      ...playlist,
      items: [item('youtube', YOUTUBE_THUMB, 'yt-1')],
    });
    await expectJpeg(await requestImage());
    expect(fetched.some((url) => url.includes('ytimg.com'))).toBe(false);
  });

  it('reindirizza le query string all’indirizzo canonico senza leggere né disegnare', async () => {
    const response = await requestImage(SHARE_ID, { query: '?v=1&x=2' });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(IMAGE_PATH);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(mocks.getSharedPlaylist).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('il vecchio indirizzo .png reindirizza (308) al JPEG canonico, senza query', async () => {
    for (const query of ['', '?v=1']) {
      const response = await legacyPreview(
        new Request(`https://solco.test/playlist/${SHARE_ID}/anteprima.png${query}`),
        { params: Promise.resolve({ shareId: SHARE_ID }) },
      );
      expect(response.status).toBe(308);
      expect(response.headers.get('location')).toBe(IMAGE_PATH);
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    const invalid = await legacyPreview(
      new Request('https://solco.test/playlist/x/anteprima.png'),
      {
        params: Promise.resolve({ shareId: 'x' }),
      },
    );
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
    expect(mocks.getSharedPlaylist).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('risponde 404 a un id non valido senza leggere il database', async () => {
    const response = await requestImage('non-valido');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(mocks.getSharedPlaylist).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('limita le richieste per IP con l’azione share.og', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 42,
      error: 'rate_limited',
      message: 'Troppe richieste.',
    });
    const response = await requestImage();
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og', 'ip:203.0.113.7');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Riprova tra 42 secondi');
    expect(mocks.getSharedPlaylist).not.toHaveBeenCalled();

    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 1,
      error: 'rate_limited',
      message: 'Troppe richieste.',
    });
    expect(await (await requestImage()).text()).toContain('Riprova tra 1 secondo.');
  });

  it('se il limitatore non risponde o manca l’IP l’anteprima resta disponibile (fail open)', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 503,
      retryAfterSeconds: 30,
      error: 'rate_limit_unavailable',
      message: 'Non disponibile.',
    });
    await expectJpeg(await requestImage());
    expect(mocks.getSharedPlaylist).toHaveBeenCalledTimes(1);

    mocks.consumeRateLimit.mockClear().mockRejectedValue(new Error('database down'));
    await expectJpeg(await requestImage());

    mocks.consumeRateLimit.mockClear();
    await expectJpeg(await requestImage(SHARE_ID, { ip: '' }));
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('disegna anche un nome lungo senza spazi', async () => {
    mocks.getSharedPlaylist.mockResolvedValue({
      ...playlist,
      name: 'X'.repeat(50),
      owner: 'un ascoltatore Solco',
      items: [],
    });
    await expectJpeg(await requestImage());
  });
});

describe('informativa privacy', () => {
  it('spiega cosa vede chi ha il link di una playlist condivisa', () => {
    const html = renderToStaticMarkup(<PrivacyPage />);
    expect(html).toContain('Playlist condivise');
    expect(html).toContain('la prima parola del nome del tuo account (mai l’email)');
    expect(html).not.toContain('nome di battesimo');
    expect(html).toContain('Smetti di condividere');
    expect(html).toContain('non vengono indicizzate');
    expect(html).toContain('email verificato');
    expect(html).toContain('restano nelle loro Librerie');
    expect(html).toContain('per qualche minuto');
    // La descrizione è pubblica e finisce anche nelle anteprime che le app conservano.
    expect(html).toContain('la sua descrizione se ne hai scritta una');
    expect(html).toContain('La descrizione compare anche nell’anteprima del link');
    expect(html).toContain('le anteprime già mostrate restano come le hanno conservate quelle app');
  });
});
