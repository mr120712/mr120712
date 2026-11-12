// @polsia:user-owned
// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSharedPlaylist: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/site', () => ({ siteUrl: 'https://solco.test' }));
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

import { GET as previewImage } from '@/app/(custom)/playlist/[shareId]/anteprima.png/route';
import { generateMetadata } from '@/app/(custom)/playlist/[shareId]/page';
import PrivacyPage from '@/app/(custom)/privacy/page';

const SHARE_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const IMAGE_PATH = `/playlist/${SHARE_ID}/anteprima.png`;
const AUDIUS_COVER = 'https://audius.co/content/abc/480x480.jpg';
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
    new Request(`https://solco.test/playlist/${shareId}/anteprima.png${query}`, {
      headers: ip ? { 'x-real-ip': ip } : {},
    }),
    { params: Promise.resolve({ shareId }) },
  );
}

const PUBLIC_IMAGE_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=240';

async function expectPng(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  // Never in image search, whatever the card.
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  const png = new Uint8Array(await response.arrayBuffer());
  expect([...png.slice(1, 4)].map((code) => String.fromCharCode(code)).join('')).toBe('PNG');
}

let fetched: string[] = [];

beforeEach(() => {
  mocks.getSharedPlaylist.mockReset().mockResolvedValue(playlist);
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  fetched = [];
  // Records every outgoing request (covers included); nothing reaches the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response(null, { status: 404 });
    }),
  );
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
    expect(JSON.stringify(metadata.twitter)).toContain(`"${IMAGE_PATH}"`);
    expect(JSON.stringify(metadata)).not.toContain('Viaggio');
  });

  it('senza un id valido non punta a nessuna immagine', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ shareId: 'x' }) });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(JSON.stringify(metadata)).not.toContain('anteprima');
  });
});

describe('anteprima social di una playlist condivisa', () => {
  it('non lancia mai errori, ma una lettura fallita non va in cache', async () => {
    mocks.getSharedPlaylist.mockRejectedValue(new Error('database down'));
    const response = await requestImage();
    await expectPng(response);
    // Link-preview crawlers keep the first image: a blip must not stick to the link.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('ha una cache CDN breve: un link non più condiviso sparisce entro ~5 minuti', async () => {
    const response = await requestImage();
    await expectPng(response);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_IMAGE_CACHE);

    // "Not shared" is a stable answer: the generic card may be cached too.
    mocks.getSharedPlaylist.mockResolvedValue(null);
    const notShared = await requestImage();
    await expectPng(notShared);
    expect(notShared.headers.get('cache-control')).toBe(PUBLIC_IMAGE_CACHE);
  });

  it('se la scheda completa non si disegna, la versione ripiegata non va in cache', async () => {
    // A cover that downloads fine but is not a real image: the full card fails to draw.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
            headers: { 'content-type': 'image/jpeg' },
          }),
      ),
    );
    const response = await requestImage();
    await expectPng(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('usa solo copertine Audius: non scarica mai miniature YouTube', async () => {
    await expectPng(await requestImage());
    expect(fetched).toContain(AUDIUS_COVER);
    expect(fetched.some((url) => url.includes('ytimg.com'))).toBe(false);

    // Only YouTube items: the plain Solco card, no cover request at all.
    fetched = [];
    mocks.getSharedPlaylist.mockResolvedValue({
      ...playlist,
      items: [item('youtube', YOUTUBE_THUMB, 'yt-1')],
    });
    await expectPng(await requestImage());
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
    await expectPng(await requestImage());
    expect(mocks.getSharedPlaylist).toHaveBeenCalledTimes(1);

    mocks.consumeRateLimit.mockClear().mockRejectedValue(new Error('database down'));
    await expectPng(await requestImage());

    mocks.consumeRateLimit.mockClear();
    await expectPng(await requestImage(SHARE_ID, { ip: '' }));
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('disegna anche un nome lungo senza spazi', async () => {
    mocks.getSharedPlaylist.mockResolvedValue({
      ...playlist,
      name: 'X'.repeat(50),
      owner: 'un ascoltatore Solco',
      items: [],
    });
    await expectPng(await requestImage());
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
  });
});
