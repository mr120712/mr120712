// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PlayRow = { userId: string; qualifiedId: string; month: string; createdAt: Date };
type StartsWith = { qualifiedId: { startsWith: string } };

const mocks = vi.hoisted(() => ({
  configured: true,
  check: vi.fn(),
  streamTrack: vi.fn(),
  user: vi.fn(async () => ({ id: 'free-user' }) as { id: string } | null),
  premium: vi.fn(async () => false),
  plays: [] as PlayRow[],
  create: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.user }));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
// In-memory MusicPlay table, read and written by the real play-quota code.
vi.mock('@/lib/db', () => ({
  prisma: {
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
    configured: mocks.configured,
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

const requestFor = (range?: string) =>
  GET(
    new Request('https://solco.test/api/music/audius/tracks/track-71/stream', {
      headers: range ? { range } : undefined,
    }),
    { params: Promise.resolve({ trackId: 'track-71' }) },
  );

function audioResponse(init: { status?: number; contentType?: string; range?: string } = {}) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2]));
      controller.close();
    },
    cancel,
  });
  const headers: Record<string, string> = {
    'content-type': init.contentType ?? 'audio/mpeg',
    'content-length': '2',
  };
  if (init.range) headers['content-range'] = init.range;
  return { response: new Response(body, { status: init.status ?? 200, headers }), cancel };
}

const audiusRows = () => mocks.plays.filter((row) => row.qualifiedId === 'audius:track-71');

beforeEach(() => {
  mocks.configured = true;
  mocks.plays.length = 0;
  mocks.create.mockClear();
  mocks.user.mockReset().mockResolvedValue({ id: 'free-user' });
  mocks.premium.mockReset().mockResolvedValue(false);
  mocks.check.mockReset().mockResolvedValue({ allowed: true });
  mocks.streamTrack
    .mockReset()
    .mockImplementation(async () => audioResponse({ status: 206, range: 'bytes 0-1/10' }).response);
});

describe('stream Audius pubblico', () => {
  it('inoltra solo byte audio dopo una nuova conferma Audius e rispetta Range', async () => {
    const response = await requestFor('bytes=0-1');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('content-range')).toBe('bytes 0-1/10');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2]);
    expect(mocks.check).toHaveBeenCalledWith('track-71');
    expect(mocks.streamTrack).toHaveBeenCalledWith('track-71', 'bytes=0-1');
  });

  it('non richiede byte quando Audius non autorizza la riproduzione', async () => {
    mocks.check.mockResolvedValueOnce({ allowed: false, reason: 'gated' });
    const response = await requestFor();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'gated' });
    expect(response.headers.get('accept-ranges')).toBeNull();
    expect(mocks.streamTrack).not.toHaveBeenCalled();
  });

  it('scarta una risposta upstream che non è audio', async () => {
    const upstream = audioResponse({ contentType: 'text/html' });
    mocks.streamTrack.mockResolvedValueOnce(upstream.response);
    const response = await requestFor();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'stream_unavailable' });
    expect(upstream.cancel).toHaveBeenCalled();
  });
});

describe('quota Free sullo stream Audius: conta solo un brano partito davvero', () => {
  it('upstream fallito, non audio o con stato inatteso: nessun ascolto registrato', async () => {
    mocks.streamTrack.mockRejectedValueOnce(new Error('Audius 503'));
    expect((await requestFor()).status).toBe(502);

    mocks.streamTrack.mockResolvedValueOnce(audioResponse({ contentType: 'text/html' }).response);
    expect((await requestFor()).status).toBe(502);

    mocks.streamTrack.mockResolvedValueOnce(audioResponse({ status: 203 }).response);
    expect((await requestFor()).status).toBe(502);

    mocks.streamTrack.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect((await requestFor()).status).toBe(502);

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });

  it('brano non riproducibile (licenza o stato Audius): nessun ascolto registrato', async () => {
    mocks.check.mockResolvedValueOnce({ allowed: false, reason: 'license_not_allowed' });
    const response = await requestFor();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'license_not_allowed' });
    expect(mocks.streamTrack).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });

  it('audio partito: esattamente un ascolto, e i Range dello stesso brano non contano di nuovo', async () => {
    const first = await requestFor('bytes=0-1');
    expect(first.status).toBe(206);
    expect(audiusRows()).toHaveLength(1);
    expect(audiusRows()[0]).toMatchObject({ userId: 'free-user', month: romeMonth(new Date()) });

    // Seek/resume within REPLAY_WINDOW_MS: served, not counted again.
    const seek = await requestFor('bytes=0-1');
    expect(seek.status).toBe(206);
    expect(audiusRows()).toHaveLength(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(REPLAY_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('un ascolto precedente fallito non impedisce di contare quello che parte', async () => {
    mocks.streamTrack.mockRejectedValueOnce(new Error('Audius 503'));
    expect((await requestFor()).status).toBe(502);
    expect(audiusRows()).toHaveLength(0);

    expect((await requestFor()).status).toBe(206);
    expect(audiusRows()).toHaveLength(1);
  });

  it('quota esaurita: stessa risposta di prima, prima di qualsiasi chiamata ad Audius', async () => {
    const month = romeMonth(new Date());
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      mocks.plays.push({
        userId: 'free-user',
        qualifiedId: `audius:other-${i}`,
        month,
        createdAt: new Date(Date.now() - 2 * REPLAY_WINDOW_MS),
      });
    }
    const blocked = await requestFor();

    expect(blocked.status).toBe(402);
    expect(blocked.headers.get('cache-control')).toContain('no-store');
    expect(await blocked.json()).toEqual({
      allowed: false,
      reason: 'monthly_limit',
      used: FREE_MONTHLY_PLAYS,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.streamTrack).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(FREE_MONTHLY_PLAYS);
  });

  it('ospite: accesso richiesto, senza chiamate ad Audius', async () => {
    mocks.user.mockResolvedValueOnce(null);
    const response = await requestFor();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ allowed: false, reason: 'login_required' });
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });

  it('se il limite si esaurisce mentre arriva l’audio, scarta i byte e nega', async () => {
    const month = romeMonth(new Date());
    const upstream = audioResponse();
    mocks.streamTrack.mockImplementationOnce(async () => {
      // Another device uses the last free plays while Audius answers.
      for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
        mocks.plays.push({
          userId: 'free-user',
          qualifiedId: `audius:other-${i}`,
          month,
          createdAt: new Date(Date.now() - 2 * REPLAY_WINDOW_MS),
        });
      }
      return upstream.response;
    });
    const response = await requestFor();

    expect(response.status).toBe(402);
    expect(upstream.cancel).toHaveBeenCalled();
    expect(audiusRows()).toHaveLength(0);
  });

  it('Premium: illimitato, nessun ascolto registrato', async () => {
    mocks.premium.mockResolvedValue(true);
    const response = await requestFor();

    expect(response.status).toBe(206);
    expect(mocks.plays).toHaveLength(0);
  });
});
