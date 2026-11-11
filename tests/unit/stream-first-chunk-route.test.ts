// @polsia:user-owned — stream Audius: il primo blocco (Range che inizia prima di 384 KiB, anche la
// ripresa di un precaricamento interrotto) si precarica senza contare l'ascolto; la continuazione
// oltre il blocco, un seek oltre il blocco o una richiesta senza Range lo contano.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PlayRow = { userId: string; qualifiedId: string; month: string; createdAt: Date };
type StartsWith = { qualifiedId: { startsWith: string } };

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  streamTrack: vi.fn(),
  user: vi.fn(async () => ({ id: 'free-user' }) as { id: string } | null),
  premium: vi.fn(async () => false),
  plays: [] as PlayRow[],
  create: vi.fn(),
  identity: vi.fn((): string | null => null),
  enforceRateLimit: vi.fn(async (): Promise<Response | null> => null),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.user }));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  getRateLimitIdentity: mocks.identity,
  enforceRateLimit: mocks.enforceRateLimit,
}));
// In-memory MusicPlay table, read and written by the real play-quota code.
vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction(run: (transaction: unknown) => Promise<unknown>) {
      return run(this);
    },
    musicPlay: {
      count: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; month: string; NOT?: StartsWith | StartsWith[] };
        }) => {
          const excluded = where.NOT ? [where.NOT].flat() : [];
          return mocks.plays.filter(
            (row) =>
              row.userId === where.userId &&
              row.month === where.month &&
              !excluded.some((rule) => row.qualifiedId.startsWith(rule.qualifiedId.startsWith)),
          ).length;
        },
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; qualifiedId: string; createdAt: { gt: Date } };
        }) =>
          mocks.plays.find(
            (row) =>
              row.userId === where.userId &&
              row.qualifiedId === where.qualifiedId &&
              row.createdAt > where.createdAt.gt,
          ) ?? null,
      ),
      create: mocks.create.mockImplementation(async ({ data }: { data: PlayRow }) => {
        mocks.plays.push(data);
        return data;
      }),
    },
  },
}));
vi.mock('@/lib/music/audius-playback.server', () => ({
  createAudiusPlaybackService: () => ({
    configured: true,
    check: mocks.check,
    streamTrack: mocks.streamTrack,
  }),
  playbackFailureStatus: (reason: string) =>
    reason === 'rate_limited'
      ? 429
      : ['gated', 'access_denied', 'not_streamable', 'license_not_allowed'].includes(reason)
        ? 403
        : 503,
}));

import { GET } from '@/app/api/music/audius/tracks/[trackId]/stream/route';
import { FREE_MONTHLY_PLAYS, REPLAY_WINDOW_MS, romeMonth } from '@/lib/business/play-quota';
import { FIRST_CHUNK_BYTES } from '@/lib/music/stream-first-chunk';

const LONG_TRACK = 5_000_000;
const CHUNK_END = FIRST_CHUNK_BYTES - 1;

const requestFor = (range?: string) =>
  GET(
    new Request('https://solco.test/api/music/audius/tracks/track-71/stream', {
      headers: range ? { range } : undefined,
    }),
    { params: Promise.resolve({ trackId: 'track-71' }) },
  );

const byteAt = (offset: number) => offset % 251;

type Delivery = { delivered: number; cancelled: boolean };

/** The bytes [start, end] of a fake file, delivered in 64 KiB pieces like a network body. */
function fileBody(start: number, end: number) {
  const delivery: Delivery = { delivered: 0, cancelled: false };
  let offset = start;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset > end) {
        controller.close();
        return;
      }
      const size = Math.min(65_536, end - offset + 1);
      const piece = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) piece[i] = byteAt(offset + i);
      offset += size;
      delivery.delivered += size;
      controller.enqueue(piece);
    },
    cancel() {
      delivery.cancelled = true;
    },
  });
  return { body, delivery };
}

type UpstreamMode = 'ranges' | 'ignore_range' | 'overshoot';

/**
 * Audius serving a file of `total` bytes: honours Range like its content nodes ('ranges'),
 * ignores it and sends the whole file with 200 ('ignore_range'), or answers 206 with more bytes
 * than asked ('overshoot').
 */
function serveFile(total: number, mode: UpstreamMode = 'ranges') {
  const deliveries: Delivery[] = [];
  mocks.streamTrack.mockImplementation(async (_trackId: string, range: string | null) => {
    const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    if (!match || mode === 'ignore_range') {
      const { body, delivery } = fileBody(0, total - 1);
      deliveries.push(delivery);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(total) },
      });
    }
    const start = Number(match[1]);
    const asked = match[2] ? Number(match[2]) : total - 1;
    const end = mode === 'overshoot' ? total - 1 : Math.min(asked, total - 1);
    const { body, delivery } = fileBody(start, end);
    deliveries.push(delivery);
    return new Response(body, {
      status: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${total}`,
      },
    });
  });
  return deliveries;
}

async function bodyBytes(response: Response) {
  return new Uint8Array(await response.arrayBuffer());
}

function isFileSlice(bytes: Uint8Array, start: number) {
  return bytes.every((value, index) => value === byteAt(start + index));
}

const audiusRows = () => mocks.plays.filter((row) => row.qualifiedId === 'audius:track-71');

function fillMonthlyQuota() {
  for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
    mocks.plays.push({
      userId: 'free-user',
      qualifiedId: `audius:other-${i}`,
      month: romeMonth(new Date()),
      createdAt: new Date(Date.now() - 2 * REPLAY_WINDOW_MS),
    });
  }
}

beforeEach(() => {
  mocks.plays.length = 0;
  mocks.create.mockClear();
  mocks.user.mockReset().mockResolvedValue({ id: 'free-user' });
  mocks.premium.mockReset().mockResolvedValue(false);
  mocks.check.mockReset().mockResolvedValue({ allowed: true });
  mocks.identity.mockReset().mockReturnValue(null);
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  mocks.streamTrack.mockReset();
  serveFile(LONG_TRACK);
});

describe('primo blocco (Range da 0): precaricabile senza contare l’ascolto', () => {
  it('bytes=0-: 206 limitato al primo blocco con Content-Range corretto, nessun ascolto', async () => {
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(206);
    expect(mocks.streamTrack).toHaveBeenCalledWith('track-71', `bytes=0-${CHUNK_END}`);
    expect(response.headers.get('content-range')).toBe(`bytes 0-${CHUNK_END}/${LONG_TRACK}`);
    expect(response.headers.get('content-length')).toBe(String(FIRST_CHUNK_BYTES));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const bytes = await bodyBytes(response);
    expect(bytes.byteLength).toBe(FIRST_CHUNK_BYTES);
    expect(isFileSlice(bytes, 0)).toBe(true);

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });

  it('sonda Safari bytes=0-1 e poi bytes=0-<fine>: due byte, poi il blocco, nessun ascolto', async () => {
    const probe = await requestFor('bytes=0-1');
    expect(probe.status).toBe(206);
    expect(mocks.streamTrack).toHaveBeenLastCalledWith('track-71', 'bytes=0-1');
    expect(probe.headers.get('content-range')).toBe(`bytes 0-1/${LONG_TRACK}`);
    expect(probe.headers.get('content-length')).toBe('2');
    expect([...(await bodyBytes(probe))]).toEqual([0, 1]);

    const whole = await requestFor(`bytes=0-${LONG_TRACK - 1}`);
    expect(whole.status).toBe(206);
    expect(mocks.streamTrack).toHaveBeenLastCalledWith('track-71', `bytes=0-${CHUNK_END}`);
    expect(whole.headers.get('content-range')).toBe(`bytes 0-${CHUNK_END}/${LONG_TRACK}`);
    expect((await bodyBytes(whole)).byteLength).toBe(FIRST_CHUNK_BYTES);

    expect(mocks.plays).toHaveLength(0);
  });

  it('una fine enorme chiesta dal client viene limitata al primo blocco', async () => {
    for (const range of ['bytes=0-999999999', 'bytes=0-99999999999999999999999']) {
      const response = await requestFor(range);
      expect(response.status).toBe(206);
      expect(mocks.streamTrack).toHaveBeenLastCalledWith('track-71', `bytes=0-${CHUNK_END}`);
      expect(response.headers.get('content-range')).toBe(`bytes 0-${CHUNK_END}/${LONG_TRACK}`);
      expect((await bodyBytes(response)).byteLength).toBe(FIRST_CHUNK_BYTES);
    }
    expect(mocks.plays).toHaveLength(0);
  });

  it('Audius manda più del richiesto: il server taglia comunque al primo blocco', async () => {
    const deliveries = serveFile(LONG_TRACK, 'overshoot');
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-${CHUNK_END}/${LONG_TRACK}`);
    const bytes = await bodyBytes(response);
    expect(bytes.byteLength).toBe(FIRST_CHUNK_BYTES);
    expect(isFileSlice(bytes, 0)).toBe(true);
    // The rest of the track is never pulled from Audius.
    expect(deliveries[0]?.cancelled).toBe(true);
    expect(deliveries[0]?.delivered).toBeLessThan(LONG_TRACK);
    expect(mocks.plays).toHaveLength(0);
  });

  it('ripetere il primo blocco non conta mai, ma resta limitato', async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await requestFor('bytes=0-');
      expect(response.headers.get('content-length')).toBe(String(FIRST_CHUNK_BYTES));
      await response.body?.cancel();
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('ripresa di un precaricamento interrotto (bytes=200000-): resto del blocco, nessun ascolto', async () => {
    const preload = await requestFor('bytes=0-');
    await preload.body?.cancel(); // connection cut on a flaky phone network

    const resumed = await requestFor('bytes=200000-');
    expect(resumed.status).toBe(206);
    expect(mocks.streamTrack).toHaveBeenLastCalledWith('track-71', `bytes=200000-${CHUNK_END}`);
    expect(resumed.headers.get('content-range')).toBe(`bytes 200000-${CHUNK_END}/${LONG_TRACK}`);
    expect(resumed.headers.get('content-length')).toBe(String(FIRST_CHUNK_BYTES - 200_000));
    expect(resumed.headers.get('accept-ranges')).toBe('bytes');
    expect(resumed.headers.get('cache-control')).toContain('no-store');
    const bytes = await bodyBytes(resumed);
    expect(bytes.byteLength).toBe(FIRST_CHUNK_BYTES - 200_000);
    expect(isFileSlice(bytes, 200_000)).toBe(true);

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });

  it('inizio dentro il blocco con fine enorme o bytes=1-: limitato al blocco, nessun ascolto', async () => {
    for (const [range, start] of [
      ['bytes=1-', 1],
      ['bytes=200000-999999999', 200_000],
      ['bytes=200000-99999999999999999999999', 200_000],
    ] as const) {
      const response = await requestFor(range);
      expect(response.status, range).toBe(206);
      expect(mocks.streamTrack).toHaveBeenLastCalledWith('track-71', `bytes=${start}-${CHUNK_END}`);
      expect(response.headers.get('content-range')).toBe(
        `bytes ${start}-${CHUNK_END}/${LONG_TRACK}`,
      );
      expect((await bodyBytes(response)).byteLength).toBe(FIRST_CHUNK_BYTES - start);
    }
    expect(mocks.plays).toHaveLength(0);
  });

  it('bytes=393215-: l’ultimo byte del blocco, nessun ascolto', async () => {
    const response = await requestFor(`bytes=${CHUNK_END}-`);

    expect(response.status).toBe(206);
    expect(mocks.streamTrack).toHaveBeenLastCalledWith(
      'track-71',
      `bytes=${CHUNK_END}-${CHUNK_END}`,
    );
    expect(response.headers.get('content-range')).toBe(
      `bytes ${CHUNK_END}-${CHUNK_END}/${LONG_TRACK}`,
    );
    expect(response.headers.get('content-length')).toBe('1');
    expect([...(await bodyBytes(response))]).toEqual([byteAt(CHUNK_END)]);
    expect(mocks.plays).toHaveLength(0);
  });

  it('Premium: stesso blocco limitato, nessun ascolto', async () => {
    mocks.premium.mockResolvedValue(true);
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-${CHUNK_END}/${LONG_TRACK}`);
    expect(mocks.plays).toHaveLength(0);
  });
});

describe('oltre il primo blocco: l’ascolto si conta come prima', () => {
  it('continuazione dopo il blocco: conta una volta, le richieste successive no', async () => {
    const first = await requestFor('bytes=0-');
    expect(first.status).toBe(206);
    await first.body?.cancel();
    expect(audiusRows()).toHaveLength(0);

    const continuation = await requestFor(`bytes=${FIRST_CHUNK_BYTES}-`);
    expect(continuation.status).toBe(206);
    expect(mocks.streamTrack).toHaveBeenLastCalledWith('track-71', `bytes=${FIRST_CHUNK_BYTES}-`);
    expect(continuation.headers.get('content-range')).toBe(
      `bytes ${FIRST_CHUNK_BYTES}-${LONG_TRACK - 1}/${LONG_TRACK}`,
    );
    await continuation.body?.cancel();
    expect(audiusRows()).toHaveLength(1);
    expect(audiusRows()[0]).toMatchObject({ userId: 'free-user', month: romeMonth(new Date()) });

    // Further continuation, a seek and a restart from 0 inside the replay window: no new play.
    for (const range of ['bytes=1000000-', 'bytes=4000000-4999999', 'bytes=0-']) {
      const response = await requestFor(range);
      expect(response.status).toBe(206);
      await response.body?.cancel();
    }
    expect(audiusRows()).toHaveLength(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('seek come prima richiesta (inizio > 0): conta l’ascolto', async () => {
    const response = await requestFor('bytes=2500000-');

    expect(response.status).toBe(206);
    expect(mocks.streamTrack).toHaveBeenCalledWith('track-71', 'bytes=2500000-');
    expect(response.headers.get('content-range')).toBe(
      `bytes 2500000-${LONG_TRACK - 1}/${LONG_TRACK}`,
    );
    await response.body?.cancel();
    expect(audiusRows()).toHaveLength(1);
  });

  it('bytes=393216- (primo byte dopo il blocco): conta una volta', async () => {
    const response = await requestFor(`bytes=${FIRST_CHUNK_BYTES}-`);

    expect(response.status).toBe(206);
    expect(mocks.streamTrack).toHaveBeenLastCalledWith('track-71', `bytes=${FIRST_CHUNK_BYTES}-`);
    const bytes = await bodyBytes(response);
    expect(bytes.byteLength).toBe(LONG_TRACK - FIRST_CHUNK_BYTES);
    expect(isFileSlice(bytes, FIRST_CHUNK_BYTES)).toBe(true);
    expect(audiusRows()).toHaveLength(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('suffisso, più intervalli o intervallo invalido passano dal percorso contato', async () => {
    for (const range of ['bytes=-1000', 'bytes=0-1, 393216-', 'bytes=500-100']) {
      mocks.plays.length = 0;
      const response = await requestFor(range);
      await response.body?.cancel();
      expect(mocks.streamTrack).toHaveBeenLastCalledWith('track-71', range);
      expect(audiusRows(), range).toHaveLength(1);
    }
  });

  it('continuazione a quota esaurita: rifiutata, nessun byte audio', async () => {
    const first = await requestFor('bytes=0-');
    await first.body?.cancel();
    fillMonthlyQuota();
    mocks.streamTrack.mockClear();

    const continuation = await requestFor(`bytes=${FIRST_CHUNK_BYTES}-`);
    expect(continuation.status).toBe(402);
    expect(continuation.headers.get('content-type')).not.toMatch(/^audio\//);
    expect(mocks.streamTrack).not.toHaveBeenCalled();
    expect(audiusRows()).toHaveLength(0);
  });

  it('richiesta senza Range: comportamento di prima (corpo intero, contato)', async () => {
    const response = await requestFor();

    expect(response.status).toBe(200);
    expect(mocks.streamTrack).toHaveBeenCalledWith('track-71', null);
    expect(response.headers.get('content-length')).toBe(String(LONG_TRACK));
    expect(response.headers.get('content-range')).toBeNull();
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await bodyBytes(response)).byteLength).toBe(LONG_TRACK);
    expect(audiusRows()).toHaveLength(1);
  });
});

describe('file che sta tutto nel primo blocco: contato subito', () => {
  it('brano breve: 206 intero e un ascolto alla prima richiesta', async () => {
    serveFile(100_000);
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-99999/100000');
    expect(response.headers.get('content-length')).toBe('100000');
    expect((await bodyBytes(response)).byteLength).toBe(100_000);
    expect(audiusRows()).toHaveLength(1);

    // Same track again within the replay window: not counted twice.
    await (await requestFor('bytes=0-')).body?.cancel();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('anche la sonda Safari conta: altrimenti il brano breve sarebbe gratis per intero', async () => {
    serveFile(100_000);
    const probe = await requestFor('bytes=0-1');

    expect(probe.status).toBe(206);
    expect(probe.headers.get('content-range')).toBe('bytes 0-1/100000');
    expect(audiusRows()).toHaveLength(1);
  });

  it('confine: esattamente il blocco conta, un byte in più no', async () => {
    serveFile(FIRST_CHUNK_BYTES);
    await (await requestFor('bytes=0-')).body?.cancel();
    expect(audiusRows()).toHaveLength(1);

    mocks.plays.length = 0;
    serveFile(FIRST_CHUNK_BYTES + 1);
    const response = await requestFor('bytes=0-');
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-${CHUNK_END}/${FIRST_CHUNK_BYTES + 1}`,
    );
    await response.body?.cancel();
    expect(audiusRows()).toHaveLength(0);
  });

  it('se il limite si esaurisce mentre arriva l’audio: niente byte, 402, nessun ascolto', async () => {
    const deliveries: Delivery[] = [];
    mocks.streamTrack.mockImplementationOnce(async () => {
      fillMonthlyQuota(); // another device used the last free plays meanwhile
      const { body, delivery } = fileBody(0, 99_999);
      deliveries.push(delivery);
      return new Response(body, {
        status: 206,
        headers: {
          'content-type': 'audio/mpeg',
          'content-range': 'bytes 0-99999/100000',
          'content-length': '100000',
        },
      });
    });
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(402);
    expect(deliveries[0]?.cancelled).toBe(true);
    expect(audiusRows()).toHaveLength(0);
  });
});

describe('primo blocco: stesse protezioni di prima, prima di qualsiasi chiamata ad Audius', () => {
  it('quota esaurita: 402 anche per bytes=0- e la sonda Safari', async () => {
    fillMonthlyQuota();
    for (const range of ['bytes=0-', 'bytes=0-1']) {
      const response = await requestFor(range);
      expect(response.status).toBe(402);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toEqual({
        allowed: false,
        reason: 'monthly_limit',
        used: FREE_MONTHLY_PLAYS,
        limit: FREE_MONTHLY_PLAYS,
      });
    }
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.streamTrack).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(FREE_MONTHLY_PLAYS);
  });

  it('ospite: 401 senza byte', async () => {
    mocks.user.mockResolvedValue(null);
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ allowed: false, reason: 'login_required' });
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.streamTrack).not.toHaveBeenCalled();
  });

  it('licenza non ammessa: 403 senza byte', async () => {
    mocks.check.mockResolvedValueOnce({ allowed: false, reason: 'license_not_allowed' });
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'license_not_allowed' });
    expect(mocks.streamTrack).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });

  it('limite per IP: 429 prima della quota e di Audius', async () => {
    mocks.identity.mockReturnValue('ip:192.0.2.71');
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '30' } }),
    );
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.catalog', 'ip:192.0.2.71');
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.streamTrack).not.toHaveBeenCalled();
  });

  it('Audius fallito o non audio: 502, nessun ascolto', async () => {
    mocks.streamTrack.mockRejectedValueOnce(new Error('Audius 503'));
    expect((await requestFor('bytes=0-')).status).toBe(502);

    const cancel = vi.fn();
    mocks.streamTrack.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        status: 206,
        headers: { 'content-type': 'text/html', 'content-range': 'bytes 0-1/10' },
      }),
    );
    expect((await requestFor('bytes=0-')).status).toBe(502);
    expect(cancel).toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });
});

describe('Audius che ignora Range o non dice la dimensione', () => {
  it('200 senza Content-Range: taglia al blocco, totale dal Content-Length, nessun ascolto', async () => {
    const deliveries = serveFile(LONG_TRACK, 'ignore_range');
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-${CHUNK_END}/${LONG_TRACK}`);
    expect(response.headers.get('content-length')).toBe(String(FIRST_CHUNK_BYTES));
    const bytes = await bodyBytes(response);
    expect(bytes.byteLength).toBe(FIRST_CHUNK_BYTES);
    expect(isFileSlice(bytes, 0)).toBe(true);
    expect(deliveries[0]?.cancelled).toBe(true);
    expect(mocks.plays).toHaveLength(0);

    const probe = await requestFor('bytes=0-1');
    expect(probe.headers.get('content-range')).toBe(`bytes 0-1/${LONG_TRACK}`);
    expect([...(await bodyBytes(probe))]).toEqual([0, 1]);
    expect(mocks.plays).toHaveLength(0);
  });

  it('200 senza Content-Range e inizio dentro il blocco: scarta i primi byte, nessun ascolto', async () => {
    const deliveries = serveFile(LONG_TRACK, 'ignore_range');
    const response = await requestFor('bytes=200000-');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 200000-${CHUNK_END}/${LONG_TRACK}`);
    expect(response.headers.get('content-length')).toBe(String(FIRST_CHUNK_BYTES - 200_000));
    const bytes = await bodyBytes(response);
    expect(bytes.byteLength).toBe(FIRST_CHUNK_BYTES - 200_000);
    expect(isFileSlice(bytes, 200_000)).toBe(true);
    // Only the first chunk (plus the stream's one-piece read-ahead) is pulled from Audius.
    expect(deliveries[0]?.cancelled).toBe(true);
    expect(deliveries[0]?.delivered).toBeLessThanOrEqual(FIRST_CHUNK_BYTES + 65_536);
    expect(mocks.plays).toHaveLength(0);
  });

  it('200 senza Content-Range su un brano breve: contato come intero', async () => {
    serveFile(100_000, 'ignore_range');
    const response = await requestFor('bytes=0-');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-99999/100000');
    expect(audiusRows()).toHaveLength(1);
  });

  it('inizio oltre la fine di un brano breve: 502 senza audio né ascolto', async () => {
    serveFile(100_000, 'ignore_range');
    const response = await requestFor('bytes=150000-');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'stream_unavailable' });
    expect(mocks.plays).toHaveLength(0);
  });

  it('dimensione sconosciuta o intervallo sbagliato: 502 senza audio né ascolto', async () => {
    const cases: Array<Record<string, string>> = [
      // 200 without Content-Length (chunked): the size, hence the Content-Range, is unknown.
      { 'content-type': 'audio/mpeg' },
      // Unknown total.
      { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-393215/*' },
      // Not the asked range.
      { 'content-type': 'audio/mpeg', 'content-range': 'bytes 1000-393215/5000000' },
    ];
    for (const headers of cases) {
      const cancel = vi.fn();
      mocks.streamTrack.mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: headers['content-range'] ? 206 : 200,
          headers,
        }),
      );
      const response = await requestFor('bytes=0-');
      expect(response.status, JSON.stringify(headers)).toBe(502);
      expect(await response.json()).toEqual({ error: 'stream_unavailable' });
      expect(cancel).toHaveBeenCalled();
    }
    expect(mocks.plays).toHaveLength(0);
  });
});
