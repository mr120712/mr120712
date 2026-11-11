// @polsia:user-owned — podcast, Jamendo e radio: un ascolto Free conta solo se l'audio risponde.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PlayRow = { userId: string; qualifiedId: string; month: string; createdAt: Date };
type StartsWith = { qualifiedId: { startsWith: string } };

const mocks = vi.hoisted(() => ({
  user: vi.fn(async () => ({ id: 'free-user' }) as { id: string } | null),
  premium: vi.fn(async () => false),
  plays: [] as PlayRow[],
  create: vi.fn(),
  probe: vi.fn(async () => true),
  episode: vi.fn(async () => 'https://cdn.example.com/episode.mp3' as string | null),
  jamendo: vi.fn(async () => 'https://prod-1.storage.jamendo.com/track.mp3' as string | null),
  station: vi.fn(async () => 'https://radio.example.com/live' as string | null),
  // Radio is quota-exempt or not depending on play-quota: both policies are exercised below.
  radioCounts: true,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.user }));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/business/play-quota', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/business/play-quota')>();
  return {
    ...actual,
    countsTowardFreeQuota: (qualifiedId: string) =>
      qualifiedId.startsWith('radio:')
        ? mocks.radioCounts
        : actual.countsTowardFreeQuota(qualifiedId),
  };
});
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
vi.mock('@/lib/music/audio-probe.server', () => ({ probeAudioUrl: mocks.probe }));
vi.mock('@/lib/music/podcasts.server', () => ({ resolveEpisodeAudio: mocks.episode }));
vi.mock('@/lib/music/jamendo.server', () => ({ resolveJamendoAudio: mocks.jamendo }));
vi.mock('@/lib/music/jamendo-license', () => ({ jamendoEnabled: () => true }));
vi.mock('@/lib/music/radio-browser.server', () => ({ resolveStationStream: mocks.station }));

import { GET as jamendoStream } from '@/app/api/music/jamendo/[trackId]/stream/route';
import { GET as podcastStream } from '@/app/api/music/podcasts/[podcastId]/episodes/[episodeKey]/stream/route';
import { GET as radioStream } from '@/app/api/music/radio/[stationId]/stream/route';
import { FREE_MONTHLY_PLAYS, REPLAY_WINDOW_MS, romeMonth } from '@/lib/business/play-quota';

const routes = [
  {
    name: 'podcast',
    qualifiedId: 'podcast:123~episode-1',
    url: 'https://cdn.example.com/episode.mp3',
    resolver: mocks.episode,
    live: false,
    call: () =>
      podcastStream(
        new Request('https://solco.test/api/music/podcasts/123/episodes/episode-1/stream'),
        {
          params: Promise.resolve({ podcastId: '123', episodeKey: 'episode-1' }),
        },
      ),
  },
  {
    name: 'jamendo',
    qualifiedId: 'jamendo:1532771',
    url: 'https://prod-1.storage.jamendo.com/track.mp3',
    resolver: mocks.jamendo,
    live: false,
    call: () =>
      jamendoStream(new Request('https://solco.test/api/music/jamendo/1532771/stream'), {
        params: Promise.resolve({ trackId: '1532771' }),
      }),
  },
  {
    name: 'radio',
    qualifiedId: 'radio:station-71',
    url: 'https://radio.example.com/live',
    resolver: mocks.station,
    live: true,
    call: () =>
      radioStream(new Request('https://solco.test/api/music/radio/station-71/stream'), {
        params: Promise.resolve({ stationId: 'station-71' }),
      }),
  },
] as const;

function fillMonthlyQuota() {
  const month = romeMonth(new Date());
  for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
    mocks.plays.push({
      userId: 'free-user',
      qualifiedId: `audius:other-${i}`,
      month,
      createdAt: new Date(Date.now() - 2 * REPLAY_WINDOW_MS),
    });
  }
}

beforeEach(() => {
  mocks.plays.length = 0;
  mocks.create.mockClear();
  mocks.radioCounts = true;
  mocks.user.mockReset().mockResolvedValue({ id: 'free-user' });
  mocks.premium.mockReset().mockResolvedValue(false);
  mocks.probe.mockReset().mockResolvedValue(true);
  mocks.episode.mockReset().mockResolvedValue('https://cdn.example.com/episode.mp3');
  mocks.jamendo.mockReset().mockResolvedValue('https://prod-1.storage.jamendo.com/track.mp3');
  mocks.station.mockReset().mockResolvedValue('https://radio.example.com/live');
});

describe.each(routes)('stream $name: ascolto Free contato solo se l’audio parte', (route) => {
  const rows = () => mocks.plays.filter((row) => row.qualifiedId === route.qualifiedId);

  it('fonte che non risponde con audio: 502 e nessun ascolto registrato', async () => {
    mocks.probe.mockResolvedValueOnce(false);
    const response = await route.call();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'stream_unavailable' });
    expect(response.headers.get('location')).toBeNull();
    expect(mocks.probe).toHaveBeenCalledWith(route.url, ...(route.live ? [{ live: true }] : []));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('fonte non risolta: 404 e nessun ascolto registrato', async () => {
    route.resolver.mockResolvedValueOnce(null);
    const response = await route.call();

    expect(response.status).toBe(404);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('audio verificato: redirect ed esattamente un ascolto; la ripresa non conta di nuovo', async () => {
    const response = await route.call();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(route.url);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(rows()).toHaveLength(1);

    const replay = await route.call();
    expect(replay.status).toBe(302);
    expect(rows()).toHaveLength(1);
    // Nothing to count on a replay: no second probe either.
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });

  it('quota esaurita: stessa risposta di prima, senza toccare la fonte', async () => {
    fillMonthlyQuota();
    const response = await route.call();

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      allowed: false,
      reason: 'monthly_limit',
      used: FREE_MONTHLY_PLAYS,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(route.resolver).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(FREE_MONTHLY_PLAYS);
  });

  it('ospite: accesso richiesto (401), senza toccare la fonte', async () => {
    mocks.user.mockResolvedValueOnce(null);
    const response = await route.call();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'login_required' });
    expect(route.resolver).not.toHaveBeenCalled();
  });

  it('Premium: redirect senza verifica né ascolto registrato', async () => {
    mocks.premium.mockResolvedValue(true);
    const response = await route.call();

    expect(response.status).toBe(302);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });
});

describe('radio esente dal limite Free', () => {
  it('non conta, non verifica lo stream e non blocca oltre i 40, ma serve un account', async () => {
    mocks.radioCounts = false;
    fillMonthlyQuota();
    const response = await routes[2].call();

    expect(response.status).toBe(302);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.plays.filter((row) => row.qualifiedId.startsWith('radio:'))).toHaveLength(0);

    mocks.user.mockResolvedValueOnce(null);
    expect((await routes[2].call()).status).toBe(401);
  });
});
