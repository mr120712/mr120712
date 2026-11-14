// @polsia:user-owned — copertine delle schede di anteprima social (og-card.server): solo immagini
// vere e piccole, lettura interrotta oltre 2 MB anche senza Content-Length, "bombe" di pixel
// rifiutate prima della decodifica, scheda finale in JPEG.
// @vitest-environment node
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { loadOgCover, MAX_OG_COVER_BYTES, renderOgCardJpeg } from '@/lib/og-card.server';

let JPEG: Uint8Array;
let PNG: Uint8Array;
let WEBP: Uint8Array;
let BOMB: Uint8Array;
let HUGE_PNG: Uint8Array;

/** Un JPEG di pochi byte che nell'intestazione dichiara `size`×`size` pixel. */
async function pixelBomb(size: number) {
  const small = new Uint8Array(
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#7c3aed' } })
      .jpeg()
      .toBuffer(),
  );
  for (let index = 0; index < small.length - 9; index += 1) {
    // SOF0/SOF2: FF C0|C2, lunghezza (2), precisione (1), altezza (2), larghezza (2).
    if (small[index] === 0xff && (small[index + 1] === 0xc0 || small[index + 1] === 0xc2)) {
      small[index + 5] = size >> 8;
      small[index + 6] = size & 0xff;
      small[index + 7] = size >> 8;
      small[index + 8] = size & 0xff;
      return small;
    }
  }
  throw new Error('SOF non trovato');
}

beforeAll(async () => {
  const base = sharp({ create: { width: 64, height: 64, channels: 3, background: '#7c3aed' } });
  JPEG = new Uint8Array(await base.clone().jpeg().toBuffer());
  PNG = new Uint8Array(await base.clone().png().toBuffer());
  WEBP = new Uint8Array(await base.clone().webp().toBuffer());
  // 12000×12000 = 144 Mpx: sotto il limite predefinito di sharp (268 Mpx), sopra il nostro.
  BOMB = await pixelBomb(12_000);
  // Valido e leggero (circa 80 KB) ma 25 Mpx: senza limite di pixel sharp lo decodificherebbe.
  HUGE_PNG = new Uint8Array(
    await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#7c3aed' } })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
});

function imageResponse(body: BodyInit | null, type = 'image/jpeg', extra: HeadersInit = {}) {
  return new Response(body, { headers: { 'content-type': type, ...extra } });
}

async function decoded(dataUrl: string | null) {
  expect(dataUrl?.startsWith('data:image/jpeg;base64,')).toBe(true);
  const bytes = Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64');
  return sharp(bytes).metadata();
}

describe('loadOgCover', () => {
  it('JPEG, PNG e WebP diventano un JPEG ritagliato al riquadro', async () => {
    for (const [bytes, type] of [
      [JPEG, 'image/jpeg'],
      [PNG, 'image/png'],
      [WEBP, 'image/webp'],
    ] as const) {
      const cover = await loadOgCover('https://node.example/c.jpg', 200, {
        fetcher: async () => imageResponse(bytes, type),
      });
      const meta = await decoded(cover);
      expect(meta.format).toBe('jpeg');
      expect([meta.width, meta.height]).toEqual([200, 200]);
    }
  });

  it('rifiuta tipi non immagine, risposte non riuscite e file dichiarati troppo grandi', async () => {
    const cases: Array<() => Response> = [
      () => imageResponse(JPEG, 'text/html'),
      () => imageResponse(JPEG, 'image/svg+xml'),
      () => imageResponse(JPEG, 'image/gif'),
      () => new Response(JPEG, { status: 404, headers: { 'content-type': 'image/jpeg' } }),
      () => imageResponse(JPEG, 'image/jpeg', { 'content-length': String(MAX_OG_COVER_BYTES + 1) }),
      () => imageResponse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    ];
    for (const response of cases) {
      expect(
        await loadOgCover('https://node.example/c.jpg', 200, { fetcher: async () => response() }),
      ).toBeNull();
    }
    // Un errore di rete (o un indirizzo rifiutato da ssrfSafeFetch) non lancia mai.
    expect(
      await loadOgCover('https://node.example/c.jpg', 200, {
        fetcher: async () => {
          throw new Error('blocked private address');
        },
      }),
    ).toBeNull();
  });

  it('interrompe la lettura oltre 2 MB anche senza Content-Length (corpo a pezzi)', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0xff);
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = imageResponse(endless);
    expect(response.headers.get('content-length')).toBeNull();
    const cover = await loadOgCover('https://node.example/c.jpg', 200, {
      fetcher: async () => response,
    });
    expect(cover).toBeNull();
    expect(cancelled).toBe(true);
    // Mai molto oltre il tetto: si smette di leggere al primo pezzo che lo supera.
    expect(pulled).toBeLessThanOrEqual(MAX_OG_COVER_BYTES + 3 * chunk.byteLength);
  });

  it('un corpo che non arriva mai si ferma alla scadenza', async () => {
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const started = Date.now();
    const cover = await loadOgCover('https://node.example/c.jpg', 200, {
      fetcher: async () => imageResponse(stalled),
      timeoutMs: 150,
    });
    expect(cover).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rifiuta un JPEG piccolo che dichiara dimensioni enormi, senza decodificarlo', async () => {
    expect(BOMB.byteLength).toBeLessThan(2_000);
    const started = Date.now();
    const cover = await loadOgCover('https://node.example/bomb.jpg', 418, {
      fetcher: async () => imageResponse(BOMB),
    });
    expect(cover).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rifiuta anche un’immagine valida e piccola da scaricare ma oltre ~16 megapixel', async () => {
    expect(HUGE_PNG.byteLength).toBeLessThan(MAX_OG_COVER_BYTES);
    const cover = await loadOgCover('https://node.example/huge.png', 418, {
      fetcher: async () => imageResponse(HUGE_PNG, 'image/png'),
    });
    expect(cover).toBeNull();
  });

  it('blur sfoca la copertina dopo il ritaglio (quiz: nessuna scritta leggibile)', async () => {
    // Strisce bianche e nere di 8 px: nitide hanno un contrasto altissimo.
    const size = 256;
    const raw = Buffer.alloc(size * size * 3);
    for (let pixel = 0; pixel < size * size; pixel += 1) {
      raw.fill(Math.floor((pixel % size) / 8) % 2 === 0 ? 0 : 255, pixel * 3, pixel * 3 + 3);
    }
    const stripes = new Uint8Array(
      await sharp(raw, { raw: { width: size, height: size, channels: 3 } })
        .png()
        .toBuffer(),
    );
    const load = (blur?: number) =>
      loadOgCover('https://node.example/c.png', 200, {
        fetcher: async () => imageResponse(stripes, 'image/png'),
        ...(blur === undefined ? {} : { blur }),
      });
    const contrast = async (dataUrl: string | null) => {
      const bytes = Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64');
      return (await sharp(bytes).greyscale().stats()).channels[0]?.stdev ?? 0;
    };
    const plain = await contrast(await load());
    expect(plain).toBeGreaterThan(100);
    const blurred = await load(28);
    expect((await decoded(blurred)).width).toBe(200);
    expect(await contrast(blurred)).toBeLessThan(plain / 3);
    // Valori senza senso: nessuna sfocatura (0, negativi, NaN) o limitata (enorme), mai un errore.
    for (const value of [0, -5, Number.NaN]) {
      expect(await contrast(await load(value)), String(value)).toBeGreaterThan(100);
    }
    expect(await contrast(await load(1e9))).toBeLessThan(plain / 3);
  });
});

describe('renderOgCardJpeg', () => {
  it('disegna la scheda 1200×630 in JPEG', async () => {
    const jpeg = await renderOgCardJpeg({
      type: 'div',
      key: null,
      props: {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          background: '#000',
          color: '#fff',
        },
        children: 'Solco',
      },
    } as unknown as Parameters<typeof renderOgCardJpeg>[0]);
    expect([...jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const meta = await sharp(jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1200, 630]);
    // 4:4:4: il testo resta nitido (nessun sottocampionamento del colore).
    expect(meta.chromaSubsampling).toBe('4:4:4');
  });
});
