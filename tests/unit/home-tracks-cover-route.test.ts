// @polsia:user-owned — copertine dei brani in evidenza: immagini private e copertine incorporate.
// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  token: 'tok_test' as string | undefined,
  limited: null as Response | null,
}));

vi.mock('@vercel/blob', () => ({
  get: mocks.get,
  list: mocks.list,
  BlobNotFoundError: class BlobNotFoundError extends Error {},
}));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  getRateLimitIdentity: () => 'ip:203.0.113.1',
  enforceRateLimit: vi.fn(async () => mocks.limited),
}));

import { BlobNotFoundError } from '@vercel/blob';
import sharp from 'sharp';
import { GET } from '@/app/api/music/home-tracks/cover/route';

let JPEG: Uint8Array;
let BIG_PNG: Uint8Array;

beforeAll(async () => {
  JPEG = new Uint8Array(
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#e11d48' } })
      .jpeg()
      .toBuffer(),
  );
  BIG_PNG = new Uint8Array(
    await sharp({ create: { width: 1600, height: 1200, channels: 4, background: '#2563eb' } })
      .png()
      .toBuffer(),
  );
});

async function decoded(res: Response) {
  return sharp(Buffer.from(await res.arrayBuffer())).metadata();
}

function req(query: string) {
  return new Request(`https://solco.example/api/music/home-tracks/cover?${query}`);
}

function streamOf(data: Uint8Array, headers: Record<string, string> = {}) {
  return {
    statusCode: 200,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    }),
    headers: new Headers(headers),
    blob: { contentType: 'text/html', size: data.length },
  };
}

/** Un MP3 con tag ID3v2.3 e una copertina JPEG (frame APIC). */
function mp3WithCover(): Uint8Array {
  const enc = (text: string) => [...text].map((char) => char.charCodeAt(0));
  const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
  const apic = [0, ...enc('image/jpeg'), 0, 3, 0, ...JPEG];
  const frame = [...enc('APIC'), ...be32(apic.length), 0, 0, ...apic];
  return Uint8Array.from([
    ...enc('ID3'),
    3,
    0,
    0,
    ...syncsafe(frame.length),
    ...frame,
    ...new Array(64).fill(0),
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token = 'tok_test';
  mocks.limited = null;
});

describe('GET /api/music/home-tracks/cover', () => {
  it('immagine privata: ricodificata in JPEG, in cache CDN, mai eseguibile', async () => {
    mocks.get.mockResolvedValue(streamOf(JPEG, { 'content-length': String(JPEG.length) }));
    const res = await GET(req('p=Rock%2FCover.jpg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect((await decoded(res)).format).toBe('jpeg');
    expect(mocks.get).toHaveBeenCalledWith(
      'Rock/Cover.jpg',
      expect.objectContaining({ access: 'private', token: 'tok_test' }),
    );
  });

  it('immagine grande: ridotta a 512 px (niente originali da molti MB per una miniatura)', async () => {
    mocks.get.mockResolvedValue(streamOf(BIG_PNG));
    const res = await GET(req('p=Rock%2Fcover.png&pub=1'));
    expect(res.status).toBe(200);
    const meta = await decoded(res);
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
    expect(mocks.get.mock.calls[0]?.[1]).toMatchObject({ access: 'public' });
  });

  it('nomi con ? # spazi: ogni cartella codificata, mai query o frammento dello storage', async () => {
    mocks.get.mockResolvedValue(streamOf(JPEG));
    await GET(req(`p=${encodeURIComponent('Pop anni 80/Che cosa? #1.jpg')}`));
    expect(mocks.get.mock.calls[0]?.[0]).toBe('Pop%20anni%2080/Che%20cosa%3F%20%231.jpg');
  });

  it('dati che non sono un’immagine (es. HTML con estensione .jpg): nessuna copertina', async () => {
    mocks.get.mockResolvedValue(streamOf(new TextEncoder().encode('<html>ciao</html>')));
    expect((await GET(req('p=finta.jpg'))).status).toBe(404);
  });

  it('copertina incorporata in un MP3: solo una lettura Range del tag', async () => {
    const file = mp3WithCover();
    mocks.get.mockImplementation(
      async (_path: string, options: { headers?: { range?: string } }) => {
        const match = /bytes=(\d+)-(\d+)/.exec(options.headers?.range ?? '');
        const start = Number(match?.[1] ?? 0);
        const end = Number(match?.[2] ?? file.length - 1);
        return streamOf(file.subarray(start, end + 1), {
          'content-range': `bytes ${start}-${Math.min(end, file.length - 1)}/${file.length}`,
        });
      },
    );
    const res = await GET(req('p=Jazz%2FTre.mp3&pub=1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect((await decoded(res)).width).toBe(64);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get.mock.calls[0]?.[1]).toMatchObject({
      access: 'public',
      headers: { range: 'bytes=0-65535' },
    });
  });

  it('MP3 senza copertina: 404 in cache (la Home mostra l’iniziale)', async () => {
    mocks.get.mockResolvedValue(
      streamOf(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]), { 'content-range': 'bytes 0-3/4' }),
    );
    const res = await GET(req('p=senza.mp3'));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600');
  });

  it('percorsi non ammessi: upload degli utenti, SVG, audio senza copertina leggibile, niente p', async () => {
    for (const query of [
      'p=public-uploads%2Fcover.jpg',
      'p=public-uploads%2Fbrano.mp3',
      'p=logo.svg',
      'p=brano.wav',
      'p=..%2Fsegreto.txt',
      'p=x%2F..%2Fpublic-uploads%2Fcover.jpg',
      'p=a%5C..%5Cb.jpg',
      '',
    ]) {
      const res = await GET(req(query));
      expect(res.status, query).toBe(404);
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('storage non configurato: 404; oltre il limite: 429 senza leggere lo store', async () => {
    mocks.token = undefined;
    expect((await GET(req('p=a.jpg'))).status).toBe(404);
    mocks.token = 'tok_test';
    mocks.limited = new Response(null, { status: 429 });
    expect((await GET(req('p=a.jpg'))).status).toBe(429);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('errore temporaneo dello storage: 404 mai in cache; file inesistente: 404 in cache', async () => {
    mocks.get.mockRejectedValue(new Error('blob down'));
    const down = await GET(req('p=a.jpg'));
    expect(down.status).toBe(404);
    expect(down.headers.get('cache-control')).toBe('no-store');
    expect((await GET(req('p=a.mp3'))).headers.get('cache-control')).toBe('no-store');
    mocks.get.mockRejectedValue(new BlobNotFoundError());
    const gone = await GET(req('p=a.jpg'));
    expect(gone.status).toBe(404);
    expect(gone.headers.get('cache-control')).toContain('s-maxage=3600');
  });
});
