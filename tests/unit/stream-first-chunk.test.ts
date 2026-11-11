// @polsia:user-owned — primo blocco gratuito dello stream Audius: parsing del Range, piano di
// inoltro dalla risposta di Audius e limite dei byte inoltrati.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  FIRST_CHUNK_BYTES,
  firstChunkUpstreamEnd,
  limitBody,
  parseStreamRange,
  planFirstChunk,
} from '@/lib/music/stream-first-chunk';

function streamOf(chunks: number[][]) {
  const cancel = vi.fn();
  let index = 0;
  const pulled = { count: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (!chunk) {
        controller.close();
        return;
      }
      pulled.count += 1;
      controller.enqueue(Uint8Array.from(chunk));
    },
    cancel,
  });
  return { body, cancel, pulled };
}

async function readAll(body: ReadableStream<Uint8Array>) {
  return [...new Uint8Array(await new Response(body).arrayBuffer())];
}

describe('FIRST_CHUNK_BYTES', () => {
  it('vale 384 KiB, circa 20 s a 160 kbps', () => {
    expect(FIRST_CHUNK_BYTES).toBe(393_216);
    expect(FIRST_CHUNK_BYTES).toBe(384 * 1024);
    expect((FIRST_CHUNK_BYTES * 8) / 160_000).toBeCloseTo(19.66, 1);
  });
});

describe('parseStreamRange', () => {
  it('senza header: richiesta completa', () => {
    expect(parseStreamRange(null)).toEqual({ kind: 'none' });
  });

  it('un intervallo che parte da 0 è il primo blocco', () => {
    expect(parseStreamRange('bytes=0-')).toEqual({ kind: 'first_chunk', start: 0, end: null });
    expect(parseStreamRange('bytes=0-1')).toEqual({ kind: 'first_chunk', start: 0, end: 1 });
    expect(parseStreamRange('bytes=0-0')).toEqual({ kind: 'first_chunk', start: 0, end: 0 });
    expect(parseStreamRange('bytes=0-999999999')).toEqual({
      kind: 'first_chunk',
      start: 0,
      end: 999_999_999,
    });
    expect(parseStreamRange('Bytes = 00 - 5 ')).toEqual({ kind: 'first_chunk', start: 0, end: 5 });
  });

  it('un intervallo che inizia dentro il blocco (ripresa di un precaricamento) è gratuito', () => {
    expect(parseStreamRange('bytes=1-')).toEqual({ kind: 'first_chunk', start: 1, end: null });
    expect(parseStreamRange('bytes=180000-')).toEqual({
      kind: 'first_chunk',
      start: 180_000,
      end: null,
    });
    expect(parseStreamRange('bytes=500-1000')).toEqual({
      kind: 'first_chunk',
      start: 500,
      end: 1000,
    });
    expect(parseStreamRange('bytes=500-500')).toEqual({
      kind: 'first_chunk',
      start: 500,
      end: 500,
    });
    expect(parseStreamRange(`bytes=${FIRST_CHUNK_BYTES - 1}-`)).toEqual({
      kind: 'first_chunk',
      start: FIRST_CHUNK_BYTES - 1,
      end: null,
    });
  });

  it('una fine enorme vale come intervallo aperto', () => {
    expect(parseStreamRange('bytes=0-99999999999999999999999')).toEqual({
      kind: 'first_chunk',
      start: 0,
      end: null,
    });
    expect(parseStreamRange('bytes=200000-99999999999999999999999')).toEqual({
      kind: 'first_chunk',
      start: 200_000,
      end: null,
    });
  });

  it('inizio oltre il blocco, suffisso, più intervalli o header strani restano contati', () => {
    for (const header of [
      `bytes=${FIRST_CHUNK_BYTES}-`,
      `bytes=${FIRST_CHUNK_BYTES}-${FIRST_CHUNK_BYTES + 10}`,
      'bytes=2500000-',
      'bytes=99999999999999999999999-',
      // Last byte before the first one: an invalid range, as before.
      'bytes=500-100',
      'bytes=-500',
      'bytes=0-1, 393216-',
      'bytes=0-1,bytes=0-1',
      'bytes=0-, bytes=0-',
      'items=0-5',
      'bytes=0-abc',
      'bytes=',
      '',
    ]) {
      expect(parseStreamRange(header), header).toEqual({ kind: 'forward', header });
    }
  });
});

describe('firstChunkUpstreamEnd', () => {
  it('non chiede mai ad Audius oltre il primo blocco', () => {
    expect(firstChunkUpstreamEnd(null)).toBe(FIRST_CHUNK_BYTES - 1);
    expect(firstChunkUpstreamEnd(1)).toBe(1);
    expect(firstChunkUpstreamEnd(FIRST_CHUNK_BYTES - 1)).toBe(FIRST_CHUNK_BYTES - 1);
    expect(firstChunkUpstreamEnd(FIRST_CHUNK_BYTES)).toBe(FIRST_CHUNK_BYTES - 1);
    expect(firstChunkUpstreamEnd(999_999_999)).toBe(FIRST_CHUNK_BYTES - 1);
  });
});

describe('planFirstChunk', () => {
  const askedEnd = FIRST_CHUNK_BYTES - 1;

  it('206 con totale noto: inoltra fino alla fine chiesta, mai oltre', () => {
    expect(
      planFirstChunk({
        start: 0,
        askedEnd,
        status: 206,
        contentRange: `bytes 0-${askedEnd}/5000000`,
        contentLength: String(FIRST_CHUNK_BYTES),
      }),
    ).toEqual({ end: askedEnd, total: 5_000_000, skip: 0, wholeFile: false });
    // Audius sent more than asked: still capped.
    expect(
      planFirstChunk({
        start: 0,
        askedEnd,
        status: 206,
        contentRange: 'bytes 0-4999999/5000000',
        contentLength: '5000000',
      }),
    ).toEqual({ end: askedEnd, total: 5_000_000, skip: 0, wholeFile: false });
    // Safari probe.
    expect(
      planFirstChunk({
        start: 0,
        askedEnd: 1,
        status: 206,
        contentRange: 'bytes 0-1/5000000',
        contentLength: '2',
      }),
    ).toEqual({ end: 1, total: 5_000_000, skip: 0, wholeFile: false });
  });

  it('file che sta nel primo blocco: va contato', () => {
    expect(
      planFirstChunk({
        start: 0,
        askedEnd,
        status: 206,
        contentRange: 'bytes 0-99999/100000',
        contentLength: '100000',
      }),
    ).toEqual({ end: 99_999, total: 100_000, skip: 0, wholeFile: true });
    expect(
      planFirstChunk({
        start: 0,
        askedEnd,
        status: 206,
        contentRange: `bytes 0-${askedEnd}/${FIRST_CHUNK_BYTES}`,
        contentLength: String(FIRST_CHUNK_BYTES),
      }),
    ).toEqual({ end: askedEnd, total: FIRST_CHUNK_BYTES, skip: 0, wholeFile: true });
    expect(
      planFirstChunk({
        start: 0,
        askedEnd,
        status: 206,
        contentRange: `bytes 0-${askedEnd}/${FIRST_CHUNK_BYTES + 1}`,
        contentLength: String(FIRST_CHUNK_BYTES),
      }),
    ).toEqual({ end: askedEnd, total: FIRST_CHUNK_BYTES + 1, skip: 0, wholeFile: false });
  });

  it('200 senza Content-Range (Range ignorato): totale dal Content-Length', () => {
    expect(
      planFirstChunk({
        start: 0,
        askedEnd,
        status: 200,
        contentRange: null,
        contentLength: '5000000',
      }),
    ).toEqual({ end: askedEnd, total: 5_000_000, skip: 0, wholeFile: false });
    expect(
      planFirstChunk({
        start: 0,
        askedEnd: 1,
        status: 200,
        contentRange: null,
        contentLength: '100000',
      }),
    ).toEqual({ end: 1, total: 100_000, skip: 0, wholeFile: true });
  });

  it('inizio dentro il blocco: 206 dallo stesso inizio, mai oltre il blocco', () => {
    expect(
      planFirstChunk({
        start: 200_000,
        askedEnd,
        status: 206,
        contentRange: `bytes 200000-${askedEnd}/5000000`,
        contentLength: String(askedEnd - 200_000 + 1),
      }),
    ).toEqual({ end: askedEnd, total: 5_000_000, skip: 0, wholeFile: false });
    expect(
      planFirstChunk({
        start: askedEnd,
        askedEnd,
        status: 206,
        contentRange: `bytes ${askedEnd}-4999999/5000000`,
        contentLength: String(5_000_000 - askedEnd),
      }),
    ).toEqual({ end: askedEnd, total: 5_000_000, skip: 0, wholeFile: false });
  });

  it('inizio dentro il blocco e Range ignorato (200): scarta i primi byte del corpo', () => {
    expect(
      planFirstChunk({
        start: 200_000,
        askedEnd,
        status: 200,
        contentRange: null,
        contentLength: '5000000',
      }),
    ).toEqual({ end: askedEnd, total: 5_000_000, skip: 200_000, wholeFile: false });
    expect(
      planFirstChunk({
        start: 50_000,
        askedEnd,
        status: 200,
        contentRange: null,
        contentLength: '100000',
      }),
    ).toEqual({ end: 99_999, total: 100_000, skip: 50_000, wholeFile: true });
  });

  it('inizio diverso da quello chiesto o oltre la fine del file: nessun piano', () => {
    const at = (
      start: number,
      end: number,
      input: Omit<Parameters<typeof planFirstChunk>[0], 'start' | 'askedEnd'>,
    ) => planFirstChunk({ start, askedEnd: end, ...input });
    // Audius answered from another byte.
    expect(
      at(200_000, askedEnd, {
        status: 206,
        contentRange: `bytes 0-${askedEnd}/5000000`,
        contentLength: String(FIRST_CHUNK_BYTES),
      }),
    ).toBeNull();
    // Start past the end of a short file served whole.
    expect(
      at(100_000, askedEnd, { status: 200, contentRange: null, contentLength: '100000' }),
    ).toBeNull();
    // Inconsistent request: end before start.
    expect(
      at(500, 100, { status: 206, contentRange: 'bytes 500-600/5000000', contentLength: '101' }),
    ).toBeNull();
  });

  it('totale sconosciuto o risposta incoerente: nessun piano (502, nessun ascolto)', () => {
    for (const input of [
      { status: 200, contentRange: null, contentLength: null },
      { status: 200, contentRange: null, contentLength: 'abc' },
      { status: 200, contentRange: null, contentLength: '0' },
      { status: 200, contentRange: 'bytes 0-1/10', contentLength: '2' },
      { status: 206, contentRange: null, contentLength: '2' },
      { status: 206, contentRange: 'bytes 0-1/*', contentLength: '2' },
      { status: 206, contentRange: 'bytes 5-9/10', contentLength: '5' },
      { status: 206, contentRange: 'bytes 0-10/10', contentLength: '11' },
      { status: 206, contentRange: 'bytes 0-1/99999999999999999999', contentLength: '2' },
      { status: 203, contentRange: null, contentLength: '10' },
    ]) {
      expect(planFirstChunk({ start: 0, askedEnd, ...input }), JSON.stringify(input)).toBeNull();
    }
  });
});

describe('limitBody', () => {
  it('inoltra al massimo maxBytes, taglia l’ultimo pezzo e chiude la fonte', async () => {
    const source = streamOf([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10, 11, 12],
    ]);
    expect(await readAll(limitBody(source.body, 5))).toEqual([1, 2, 3, 4, 5]);
    expect(source.cancel).toHaveBeenCalled();
    // The rest of the upstream body is never read.
    expect(source.pulled.count).toBeLessThanOrEqual(3);
  });

  it('confine esatto su un pezzo: chiude subito', async () => {
    const source = streamOf([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(await readAll(limitBody(source.body, 4))).toEqual([1, 2, 3, 4]);
    expect(source.cancel).toHaveBeenCalled();
  });

  it('fonte più corta del limite: inoltra tutto', async () => {
    const source = streamOf([[1, 2], [3]]);
    expect(await readAll(limitBody(source.body, 10))).toEqual([1, 2, 3]);
    expect(source.cancel).not.toHaveBeenCalled();
  });

  it('scarta i primi byte anche a cavallo dei pezzi, poi applica il limite', async () => {
    const source = streamOf([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10, 11, 12],
    ]);
    expect(await readAll(limitBody(source.body, 4, 4))).toEqual([5, 6, 7, 8]);
    expect(source.cancel).toHaveBeenCalled();

    const exact = streamOf([[1, 2, 3], [4, 5, 6], [7]]);
    expect(await readAll(limitBody(exact.body, 10, 3))).toEqual([4, 5, 6, 7]);
  });

  it('fonte più corta dei byte da scartare: nessun byte', async () => {
    const source = streamOf([[1, 2], [3]]);
    expect(await readAll(limitBody(source.body, 10, 5))).toEqual([]);
  });

  it('il client che chiude annulla anche la fonte', async () => {
    const source = streamOf([[1], [2], [3]]);
    const limited = limitBody(source.body, 10);
    await limited.cancel('client gone');
    expect(source.cancel).toHaveBeenCalledWith('client gone');
  });

  it('un errore della fonte arriva al client', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('upstream reset'));
      },
    });
    await expect(readAll(limitBody(failing, 10))).rejects.toThrow('upstream reset');
  });
});
