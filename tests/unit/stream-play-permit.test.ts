// @polsia:user-owned — il permesso del player (POST /api/music/plays) verifica soltanto: un
// ascolto Free si registra solo nella route di stream, quando l'audio parte davvero.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PlayRow = { userId: string; qualifiedId: string; month: string; createdAt: Date };
type StartsWith = { qualifiedId: { startsWith: string } };

const mocks = vi.hoisted(() => ({
  user: vi.fn(async () => ({ id: 'free-user' }) as { id: string } | null),
  premium: vi.fn(async () => false),
  plays: [] as PlayRow[],
  create: vi.fn(),
  transaction: vi.fn(),
  check: vi.fn(),
  streamTrack: vi.fn(),
  probe: vi.fn(async () => true),
  episode: vi.fn(async () => 'https://cdn.example.com/episode.mp3' as string | null),
  jamendoOn: false,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.user }));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => true }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: async () => null,
  getRateLimitIdentity: () => null,
}));
vi.mock('@/lib/music/jamendo-license', () => ({ jamendoEnabled: () => mocks.jamendoOn }));
vi.mock('@/lib/music/audio-probe.server', () => ({ probeAudioUrl: mocks.probe }));
vi.mock('@/lib/music/podcasts.server', () => ({ resolveEpisodeAudio: mocks.episode }));
vi.mock('@/lib/music/audius-playback.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/audius-playback.server')>()),
  createAudiusPlaybackService: () => ({
    configured: true,
    check: mocks.check,
    streamTrack: mocks.streamTrack,
  }),
}));
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
    $transaction(run: (transaction: unknown) => Promise<unknown>, options?: unknown) {
      return mocks.transaction(run, options, this);
    },
  },
}));

import { GET as audiusPlayback } from '@/app/api/music/audius/tracks/[trackId]/playback/route';
import { GET as audiusStream } from '@/app/api/music/audius/tracks/[trackId]/stream/route';
import { POST as playsRoute } from '@/app/api/music/plays/route';
import { GET as podcastStream } from '@/app/api/music/podcasts/[podcastId]/episodes/[episodeKey]/stream/route';
import { FREE_MONTHLY_PLAYS, REPLAY_WINDOW_MS, romeMonth } from '@/lib/business/play-quota';
import { consumePlay, PLAY_RECORD_ATTEMPTS } from '@/lib/business/play-quota.server';
import { checkStreamPlay } from '@/lib/music/stream-play.server';

const permit = (qualifiedId: string) =>
  playsRoute(
    new Request('https://solco.test/api/music/plays', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qualifiedId }),
    }),
  );
const audius = (kind: 'playback' | 'stream', trackId: string) =>
  (kind === 'playback' ? audiusPlayback : audiusStream)(
    new Request(`https://solco.test/api/music/audius/tracks/${trackId}/${kind}`),
    { params: Promise.resolve({ trackId }) },
  );
const podcast = () =>
  podcastStream(
    new Request('https://solco.test/api/music/podcasts/123/episodes/episode-1/stream'),
    { params: Promise.resolve({ podcastId: '123', episodeKey: 'episode-1' }) },
  );
const audio = () =>
  new Response(Uint8Array.from([1, 2]), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg', 'content-length': '2' },
  });

function fillMonthlyQuota(userId = 'free-user') {
  for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
    mocks.plays.push({
      userId,
      qualifiedId: `audius:other-${i}`,
      month: romeMonth(new Date()),
      createdAt: new Date(Date.now() - 2 * REPLAY_WINDOW_MS),
    });
  }
}

beforeEach(() => {
  mocks.plays.length = 0;
  mocks.create.mockClear();
  mocks.transaction
    .mockReset()
    .mockImplementation(
      (run: (transaction: unknown) => Promise<unknown>, _options: unknown, client: unknown) =>
        run(client),
    );
  mocks.jamendoOn = false;
  mocks.user.mockReset().mockResolvedValue({ id: 'free-user' });
  mocks.premium.mockReset().mockResolvedValue(false);
  mocks.check.mockReset().mockResolvedValue({ allowed: true });
  mocks.streamTrack.mockReset().mockImplementation(async () => audio());
  mocks.probe.mockReset().mockResolvedValue(true);
  mocks.episode.mockReset().mockResolvedValue('https://cdn.example.com/episode.mp3');
});

describe('permesso del player: verifica senza consumare ascolti', () => {
  it('permesso e poi licenza diversa su /playback e /stream: nessun ascolto registrato', async () => {
    mocks.check.mockResolvedValue({ allowed: false, reason: 'license_not_allowed' });

    const allowed = await permit('audius:arr-track');
    expect(allowed.status).toBe(200);
    // Same body as before: the play this start would be, and the monthly limit.
    expect(await allowed.json()).toEqual({ allowed: true, used: 1, limit: FREE_MONTHLY_PLAYS });

    const verdict = await audius('playback', 'arr-track');
    expect(verdict.status).toBe(403);
    expect(await verdict.json()).toEqual({ allowed: false, reason: 'license_not_allowed' });
    const stream = await audius('stream', 'arr-track');
    expect(stream.status).toBe(403);

    expect(mocks.streamTrack).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });

  it('permesso e poi stream Audius fallito: nessun ascolto registrato', async () => {
    expect((await permit('audius:down-track')).status).toBe(200);
    mocks.streamTrack.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    expect((await audius('stream', 'down-track')).status).toBe(502);
    mocks.streamTrack.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await audius('stream', 'down-track')).status).toBe(502);

    expect(mocks.plays).toHaveLength(0);
  });

  it('permesso e poi episodio podcast senza audio: nessun ascolto registrato', async () => {
    expect((await permit('podcast:123~episode-1')).status).toBe(200);
    mocks.probe.mockResolvedValueOnce(false);
    expect((await podcast()).status).toBe(502);
    // The probe really runs: the permit no longer writes a row that would skip it as a replay.
    expect(mocks.probe).toHaveBeenCalledTimes(1);

    expect(mocks.plays).toHaveLength(0);
  });

  it('l’audio parte: lo stream registra esattamente un ascolto', async () => {
    expect((await permit('audius:ok-track')).status).toBe(200);
    expect(mocks.plays).toHaveLength(0);
    expect((await audius('stream', 'ok-track')).status).toBe(200);
    expect(mocks.plays.map((row) => row.qualifiedId)).toEqual(['audius:ok-track']);

    // Pause/resume (new permit + Range request) within the replay window: still one play.
    expect(await (await permit('audius:ok-track')).json()).toMatchObject({ allowed: true });
    expect((await audius('stream', 'ok-track')).status).toBe(200);
    expect(mocks.plays).toHaveLength(1);
  });

  it('quota esaurita o ospite: stesse risposte 402/401 di prima', async () => {
    fillMonthlyQuota();
    const blocked = await permit('audius:new-track');
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toEqual({
      allowed: false,
      reason: 'monthly_limit',
      used: FREE_MONTHLY_PLAYS,
      limit: FREE_MONTHLY_PLAYS,
    });

    mocks.user.mockResolvedValueOnce(null);
    const guest = await permit('audius:new-track');
    expect(guest.status).toBe(401);
    expect(await guest.json()).toMatchObject({ allowed: false, reason: 'login_required' });
    expect(mocks.plays).toHaveLength(FREE_MONTHLY_PLAYS);
  });

  it('Jamendo spento con quota esaurita: permesso 200 senza ascolto', async () => {
    fillMonthlyQuota();
    const response = await permit('jamendo:1532771');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      allowed: true,
      used: FREE_MONTHLY_PLAYS,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(mocks.plays).toHaveLength(FREE_MONTHLY_PLAYS);
  });
});

describe('registro degli ascolti in conflitto: si fallisce chiusi', () => {
  const writeConflict = () =>
    Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), {
      code: 'P2034',
    });

  it('conflitti oltre i tentativi: 503 senza audio e nessun ascolto registrato', async () => {
    const cancelled = vi.fn();
    mocks.streamTrack.mockImplementation(
      async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );
    mocks.transaction.mockRejectedValue(writeConflict());

    const response = await audius('stream', 'busy-track');
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).not.toMatch(/^audio\//);
    expect(await response.json()).toEqual({ error: 'stream_unavailable' });
    expect(mocks.transaction).toHaveBeenCalledTimes(PLAY_RECORD_ATTEMPTS);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());

    mocks.transaction.mockClear();
    expect((await podcast()).status).toBe(503);
    expect(mocks.transaction).toHaveBeenCalledTimes(PLAY_RECORD_ATTEMPTS);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });

  it('un conflitto risolto al nuovo tentativo: l’audio parte e conta una volta', async () => {
    mocks.transaction.mockRejectedValueOnce(writeConflict());

    expect((await audius('stream', 'retry-track')).status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.transaction.mock.calls[1]?.[1]).toEqual({ isolationLevel: 'Serializable' });
    expect(mocks.plays.map((row) => row.qualifiedId)).toEqual(['audius:retry-track']);
  });
});

describe('checkStreamPlay e consumePlay prendono la stessa decisione', () => {
  const ids = [
    'audius:same-track',
    'podcast:123~episode-1',
    'radio:station-71',
    'youtube:dQw4w9WgXcQ',
    'jamendo:1532771',
  ];
  const states = [
    { name: 'Free sotto il limite', setup: () => undefined },
    { name: 'Free al limite', setup: () => fillMonthlyQuota() },
    {
      name: 'ripresa entro la finestra',
      setup: () => {
        fillMonthlyQuota();
        for (const qualifiedId of ids) {
          mocks.plays.push({
            userId: 'free-user',
            qualifiedId,
            month: romeMonth(new Date()),
            createdAt: new Date(),
          });
        }
      },
    },
    { name: 'Premium', setup: () => mocks.premium.mockResolvedValue(true) },
    { name: 'ospite', setup: () => mocks.user.mockResolvedValue(null) },
  ];

  for (const jamendoOn of [false, true]) {
    for (const state of states) {
      it(`${state.name}, Jamendo ${jamendoOn ? 'acceso' : 'spento'}`, async () => {
        for (const qualifiedId of ids) {
          mocks.plays.length = 0;
          mocks.jamendoOn = jamendoOn;
          mocks.user.mockReset().mockResolvedValue({ id: 'free-user' });
          mocks.premium.mockReset().mockResolvedValue(false);
          state.setup();
          const now = new Date();

          const checked = await checkStreamPlay(qualifiedId, now);
          expect(mocks.create).not.toHaveBeenCalled();
          const consumed = await consumePlay(checked.user, qualifiedId, now);
          expect(consumed, qualifiedId).toEqual(checked.decision);
          mocks.create.mockClear();
        }
      });
    }
  }

  it('Jamendo spento non conta né blocca; acceso conta come Audius', async () => {
    fillMonthlyQuota();
    expect((await checkStreamPlay('jamendo:1532771')).decision).toMatchObject({
      allowed: true,
      counted: false,
    });
    mocks.jamendoOn = true;
    expect((await checkStreamPlay('jamendo:1532771')).decision).toMatchObject({
      allowed: false,
      reason: 'monthly_limit',
    });
  });
});
