// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAudiusTrending: vi.fn(),
  listJamendoTracks: vi.fn(),
  readYouTubeApiKey: vi.fn(() => ''),
  searchPodcasts: vi.fn(),
  listStations: vi.fn(),
  searchYouTubeMusic: vi.fn(),
  storedYouTubeSearch: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
// The real YouTube budget wrapper runs; only its limiter is faked.
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('@/lib/business/ai-music-search.server', () => ({
  anthropicApiKey: (env: Record<string, string | undefined> = process.env) =>
    env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPHIC_API_KEY?.trim() || undefined,
}));
vi.mock('@/lib/music/audius-source.server', () => ({ getAudiusTrending: mocks.getAudiusTrending }));
vi.mock('@/lib/music/jamendo.server', () => ({ listJamendoTracks: mocks.listJamendoTracks }));
vi.mock('@/lib/music/music-api.server', () => ({ readYouTubeApiKey: mocks.readYouTubeApiKey }));
vi.mock('@/lib/music/podcasts.server', () => ({ searchPodcasts: mocks.searchPodcasts }));
vi.mock('@/lib/music/radio-browser.server', () => ({ listStations: mocks.listStations }));
vi.mock('@/lib/music/youtube-search.server', () => ({
  searchYouTubeMusic: mocks.searchYouTubeMusic,
}));
vi.mock('@/lib/music/youtube-search-store.server', () => ({
  storedYouTubeSearch: mocks.storedYouTubeSearch,
}));

import { MONITOR_CHECK_IDS, MonitorCheckResultSchema } from '@/lib/contracts/monitoring';
import {
  type CheckDeps,
  defaultCheckDeps,
  type MonitorDb,
  runCheck,
  runChecks,
  safeDetail,
} from '@/lib/monitoring/checks.server';
import { YOUTUBE_BUDGET_EXHAUSTED } from '@/lib/music/youtube-budget.server';

const NOW = new Date('2026-11-11T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** Fake secrets: none of these values may ever appear in a detail string. */
const SECRETS = {
  BETTER_AUTH_SECRET: 'fake-better-auth-secret-0123456789abcdef',
  GOOGLE_SIGNIN_CLIENT_SECRET: 'GOCSPX-fake-google-client-secret',
  NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID: '1234567890-fakeclient.apps.googleusercontent.com',
  YOUTUBE_DATA_API_KEY: 'AIzaFakeYouTubeKey0123456789abcdef',
  ANTHROPIC_API_KEY: ['sk', 'ant', 'api03', 'fake-anthropic-key-0123456789'].join('-'),
  // Built at runtime: a literal key-shaped string would trip secret scanners.
  STRIPE_SECRET_KEY: ['sk', 'live', 'FAKE0'.repeat(5)].join('_'),
  RESEND_API_KEY: 're_fake_resend_key_0123456789',
  JAMENDO_CLIENT_ID: 'jamendo-fake-client-id-42',
  DATABASE_URL: 'postgresql://solco:sup3r-s3cret-pass@db.internal.test:5432/solco',
  CRON_SECRET: 'fake-cron-secret-0123456789abcdef',
};
const SECRET_VALUES = Object.values(SECRETS);

const ENV = {
  ...SECRETS,
  BETTER_AUTH_URL: 'https://solcomusic.vercel.app',
  NEXT_PUBLIC_APP_URL: 'https://solcomusic.vercel.app',
  EMAIL_FROM: 'Solco <noreply@solco.test>',
};

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function googleRedirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

const okRoutes: Record<string, FetchHandler> = {
  'accounts.google.com': () =>
    googleRedirect('https://accounts.google.com/v3/signin/identifier?dsh=S1&flowName=GeneralOAuth'),
  'www.googleapis.com': () => Response.json({ items: [{ id: 'video-1' }] }),
  'api.anthropic.com': () => Response.json({ data: [{ id: 'model' }] }),
  'api.stripe.com': () => Response.json({ available: [] }),
};

function makeFetch(routes: Partial<Record<string, FetchHandler>> = {}) {
  const table = { ...okRoutes, ...routes };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handler = table[new URL(url).hostname];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler(url, init);
  });
}

function makeDb() {
  const create = vi.fn(async () => ({ id: 'created' }));
  return {
    create,
    db: {
      $queryRaw: vi.fn(async () => [{ ok: 1 }]),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ user: { create } }),
      ),
      monitorHeartbeat: {
        upsert: vi.fn(async () => ({})),
        findUnique: vi.fn(async () => ({ at: new Date(NOW.getTime() - 2 * HOUR) })),
      },
    },
  };
}

type FakeDb = ReturnType<typeof makeDb>['db'];

function makeDeps(
  overrides: Omit<Partial<CheckDeps>, 'db'> & { db?: FakeDb } = {},
): Partial<CheckDeps> {
  const { db, ...rest } = overrides;
  return {
    fetch: makeFetch() as unknown as typeof fetch,
    db: (db ?? makeDb().db) as unknown as MonitorDb,
    env: { ...ENV },
    now: () => NOW,
    clock: () => 0,
    timeoutMs: 1_000,
    youtubeApiKey: () => SECRETS.YOUTUBE_DATA_API_KEY,
    youtubeSearch: async () => ({
      outcome: 'results',
      videos: [{ id: 'v1' }] as never,
    }),
    audiusTrending: async () => ({ outcome: 'results', tracks: [{ id: 't1' }] }),
    radioStations: async () => ({ outcome: 'results', stations: [{ id: 's1' }, { id: 's2' }] }),
    podcastSearch: async () => ({ outcome: 'results', podcasts: [{ id: 'p1' }] }),
    jamendoTracks: async () => ({ outcome: 'results', tracks: [{ id: 'j1' }] }),
    ...rest,
  };
}

function expectNoSecrets(details: string[]) {
  for (const detail of details) {
    for (const secret of SECRET_VALUES) expect(detail).not.toContain(secret);
    // The details are built from fixed strings: nothing even reached the mask.
    expect(detail).not.toContain('[nascosto]');
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runChecks', () => {
  it('runs every check and returns valid results in catalogue order', async () => {
    const results = await runChecks(makeDeps());
    expect(results.map((result) => result.id)).toEqual([...MONITOR_CHECK_IDS]);
    for (const result of results) {
      expect(MonitorCheckResultSchema.safeParse(result).success).toBe(true);
      expect(result.status, `${result.id}: ${result.detail}`).toBe('ok');
    }
    expectNoSecrets(results.map((result) => result.detail));
  });

  it('turns a hanging check into a failure after the hard timeout', async () => {
    const result = await runCheck(
      'audius',
      makeDeps({ timeoutMs: 20, audiusTrending: () => new Promise(() => undefined) }),
    );
    expect(result).toMatchObject({ id: 'audius', status: 'fail' });
    expect(result.detail).toMatch(/Nessuna risposta entro/);
  });

  it('never throws and never echoes an unexpected error message', async () => {
    const result = await runCheck(
      'podcasts',
      makeDeps({
        podcastSearch: async () => {
          throw new Error(`boom ${SECRETS.DATABASE_URL}`);
        },
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('Controllo non riuscito per un errore imprevisto');
  });

  it('measures each check in whole, non-negative milliseconds', async () => {
    let time = 100.4;
    const result = await runCheck(
      'radio',
      makeDeps({
        clock: () => time,
        radioStations: async () => {
          time += 42.3;
          return { outcome: 'results', stations: [{}] };
        },
      }),
    );
    expect(result.ms).toBe(42);
  });
});

describe('database', () => {
  it('is ok when SELECT 1 and the heartbeat write succeed quickly', async () => {
    const { db } = makeDb();
    const result = await runCheck('database', makeDeps({ db }));
    expect(result.status).toBe('ok');
    expect(db.monitorHeartbeat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: 'monitor' } }),
    );
  });

  it('warns when reading and writing take more than 1.5 s', async () => {
    const { db } = makeDb();
    let time = 0;
    db.$queryRaw.mockImplementation(async () => {
      time += 1_600;
      return [];
    });
    const result = await runCheck('database', makeDeps({ db, clock: () => time }));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('1600 ms');
  });

  it('fails with the Prisma code only, never the error message', async () => {
    const { db } = makeDb();
    db.$queryRaw.mockRejectedValue(
      Object.assign(new Error(`Can't reach database server at ${SECRETS.DATABASE_URL}`), {
        code: 'P1001',
      }),
    );
    const result = await runCheck('database', makeDeps({ db }));
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('Il database non risponde (codice P1001)');
  });

  it('fails when the database reads but refuses writes', async () => {
    const { db } = makeDb();
    db.monitorHeartbeat.upsert.mockRejectedValue(new Error('read-only'));
    const result = await runCheck('database', makeDeps({ db }));
    expect(result).toMatchObject({ status: 'fail' });
    expect(result.detail).toMatch(/non accetta scritture/);
  });
});

describe('signup_write', () => {
  /** A tiny transactional store: rows are committed only when the callback resolves. */
  function transactionalDb() {
    const committed: unknown[] = [];
    const { db } = makeDb();
    db.$transaction.mockImplementation(async (fn) => {
      const staged: unknown[] = [];
      const tx = {
        user: {
          create: vi.fn(async (args: { data: unknown }) => {
            staged.push(args.data);
            return { id: 'x' };
          }),
        },
      };
      const value = await fn(tx);
      committed.push(...staged);
      return value;
    });
    return { db, committed };
  }

  it('is ok when its own sentinel rolls the insert back, leaving no row', async () => {
    const { db, committed } = transactionalDb();
    const result = await runCheck('signup_write', makeDeps({ db }));
    expect(result.status).toBe('ok');
    expect(committed).toEqual([]);
    const tx = await db.$transaction.mock.results[0]?.value.catch(() => null);
    expect(tx).toBeNull();
  });

  it('inserts a throwaway, unverified user on the .invalid domain', async () => {
    const { db, create } = makeDb();
    await runCheck('signup_write', makeDeps({ db }));
    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.id).toMatch(/^monitor-[0-9a-f-]{36}$/);
    expect(data.email).toBe(`${data.id}@monitor.invalid`);
    expect(data.emailVerified).toBe(false);
    expect(data.createdAt).toEqual(NOW);
    expect(data.updatedAt).toEqual(NOW);
  });

  it('fails when the insert itself is rejected', async () => {
    const { db, create } = makeDb();
    create.mockRejectedValue(
      Object.assign(new Error(`relation "user" does not exist ${SECRETS.DATABASE_URL}`), {
        code: 'P2021',
      }),
    );
    const result = await runCheck('signup_write', makeDeps({ db }));
    expect(result).toMatchObject({
      status: 'fail',
      detail: 'Il database non accetta nuovi account (codice P2021)',
    });
  });

  it('fails if the transaction resolves instead of rolling back', async () => {
    const { db } = makeDb();
    db.$transaction.mockResolvedValue(undefined as never);
    const result = await runCheck('signup_write', makeDeps({ db }));
    expect(result.status).toBe('fail');
  });
});

describe('auth_config', () => {
  it('is ok with a long secret, matching https URLs and Google credentials', async () => {
    expect((await runCheck('auth_config', makeDeps())).status).toBe('ok');
  });

  it('lists only the names of missing or invalid settings', async () => {
    const result = await runCheck(
      'auth_config',
      makeDeps({
        env: {
          BETTER_AUTH_SECRET: 'short-secret',
          BETTER_AUTH_URL: 'http://solcomusic.vercel.app',
          NEXT_PUBLIC_APP_URL: 'https://solcomusic.vercel.app',
        },
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('BETTER_AUTH_SECRET');
    expect(result.detail).toContain('BETTER_AUTH_URL');
    expect(result.detail).toContain('NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID');
    expect(result.detail).toContain('GOOGLE_SIGNIN_CLIENT_SECRET');
    expect(result.detail).not.toContain('short-secret');
    expect(result.detail).not.toContain('http://');
  });

  it('fails when the auth URL and the app URL are different origins', async () => {
    const result = await runCheck(
      'auth_config',
      makeDeps({ env: { ...ENV, NEXT_PUBLIC_APP_URL: 'https://other.example' } }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('indirizzi diversi');
  });

  it('accepts http only on localhost', async () => {
    const local = {
      BETTER_AUTH_URL: 'http://localhost:3000',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    };
    expect((await runCheck('auth_config', makeDeps({ env: { ...ENV, ...local } }))).status).toBe(
      'ok',
    );
  });
});

describe('google_signin', () => {
  it('asks Google for the real authorize URL without following the redirect', async () => {
    const fetcher = makeFetch();
    const result = await runCheck('google_signin', makeDeps({ fetch: fetcher as never }));
    expect(result.status).toBe('ok');
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth' +
        `?client_id=${encodeURIComponent(SECRETS.NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent('https://solcomusic.vercel.app/api/auth/oauth2/callback/google')}` +
        '&response_type=code&scope=openid%20email%20profile',
    );
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails when Google redirects to its OAuth error page', async () => {
    const fetcher = makeFetch({
      'accounts.google.com': () =>
        googleRedirect(
          `https://accounts.google.com/signin/oauth/error?authError=${SECRETS.NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID}&client_id=${SECRETS.NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID}`,
        ),
    });
    const result = await runCheck('google_signin', makeDeps({ fetch: fetcher as never }));
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/^Google rifiuta la richiesta/);
    expectNoSecrets([result.detail]);
  });

  it('fails on a non-redirect answer, an unreachable Google or a missing client', async () => {
    const error400 = makeFetch({
      'accounts.google.com': () => new Response('bad', { status: 400 }),
    });
    expect((await runCheck('google_signin', makeDeps({ fetch: error400 as never }))).status).toBe(
      'fail',
    );
    const offline = makeFetch({
      'accounts.google.com': () => {
        throw new TypeError('fetch failed');
      },
    });
    const unreachable = await runCheck('google_signin', makeDeps({ fetch: offline as never }));
    expect(unreachable).toMatchObject({ status: 'fail', detail: 'Google non raggiungibile' });
    const missing = await runCheck(
      'google_signin',
      makeDeps({ env: { ...ENV, NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID: '' } }),
    );
    expect(missing.status).toBe('fail');
    expect(missing.detail).toMatch(/non configurato/);
  });
});

describe('youtube_quota', () => {
  function youtubeError(status: number, reason: string, detailsReason?: string) {
    return makeFetch({
      'www.googleapis.com': () =>
        Response.json(
          {
            error: {
              code: status,
              message: `API key not valid: ${SECRETS.YOUTUBE_DATA_API_KEY}`,
              errors: [{ reason, message: `echo ${SECRETS.YOUTUBE_DATA_API_KEY}` }],
              ...(detailsReason ? { details: [{ reason: detailsReason }] } : {}),
            },
          },
          { status },
        ),
    });
  }

  it('is ok on 200 and spends one unit on a fixed videos.list call', async () => {
    const fetcher = makeFetch();
    const result = await runCheck('youtube_quota', makeDeps({ fetch: fetcher as never }));
    expect(result.status).toBe('ok');
    const url = new URL((fetcher.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe('/youtube/v3/videos');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      part: 'id',
      chart: 'mostPopular',
      regionCode: 'IT',
      videoCategoryId: '10',
      maxResults: '1',
      key: SECRETS.YOUTUBE_DATA_API_KEY,
    });
  });

  it.each(['quotaExceeded', 'dailyLimitExceeded'])(
    'reports an exhausted quota (%s)',
    async (reason) => {
      const result = await runCheck(
        'youtube_quota',
        makeDeps({ fetch: youtubeError(403, reason) as never }),
      );
      expect(result).toMatchObject({
        status: 'fail',
        detail: 'Quota esaurita: si azzera alle 9:00 ora italiana',
      });
    },
  );

  it('reports an invalid key (403 keyInvalid, 400 API_KEY_INVALID)', async () => {
    for (const fetcher of [
      youtubeError(403, 'keyInvalid'),
      youtubeError(400, 'badRequest', 'API_KEY_INVALID'),
    ]) {
      const result = await runCheck('youtube_quota', makeDeps({ fetch: fetcher as never }));
      expect(result).toMatchObject({ status: 'fail', detail: 'Chiave non valida' });
    }
  });

  it('distinguishes other errors from quota and key problems', async () => {
    const forbidden = await runCheck(
      'youtube_quota',
      makeDeps({ fetch: youtubeError(403, 'accessNotConfigured') as never }),
    );
    expect(forbidden.status).toBe('fail');
    expect(forbidden.detail).not.toMatch(/Quota|Chiave non valida/);
    const server = await runCheck(
      'youtube_quota',
      makeDeps({ fetch: youtubeError(500, 'backendError') as never }),
    );
    expect(server.detail).toContain('HTTP 500');
  });

  it('fails without calling YouTube when the key is missing', async () => {
    const fetcher = makeFetch();
    const result = await runCheck(
      'youtube_quota',
      makeDeps({ fetch: fetcher as never, youtubeApiKey: () => '  ' }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/non configurata/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('youtube_search', () => {
  it('uses the shared search cache with the same call shape as the search route', async () => {
    mocks.readYouTubeApiKey.mockReturnValue(SECRETS.YOUTUBE_DATA_API_KEY);
    mocks.searchYouTubeMusic.mockResolvedValue({ outcome: 'results', videos: [{ id: 'v' }] });
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
    mocks.storedYouTubeSearch.mockImplementation(
      async (_query: string, _max: number, load: () => Promise<unknown>) => load(),
    );
    const fetcher = makeFetch();
    const result = await defaultCheckDeps().youtubeSearch(fetcher as never);
    expect(result.outcome).toBe('results');
    expect(mocks.storedYouTubeSearch).toHaveBeenCalledWith('vasco rossi', 10, expect.any(Function));
    // A cache miss is counted against the app-wide search pool (no per-person share).
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('youtube.search.global', 'global');
    expect(mocks.searchYouTubeMusic).toHaveBeenCalledWith(
      'vasco rossi',
      SECRETS.YOUTUBE_DATA_API_KEY,
      fetcher,
      10,
    );
  });

  it('does not call YouTube on a cache miss once the daily search budget is used up', async () => {
    mocks.readYouTubeApiKey.mockReturnValue(SECRETS.YOUTUBE_DATA_API_KEY);
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 3600,
      error: 'rate_limited',
      message: 'x',
    });
    mocks.storedYouTubeSearch.mockImplementation(
      async (_query: string, _max: number, load: () => Promise<unknown>) => load(),
    );
    const deps = defaultCheckDeps();
    const result = await runCheck(
      'youtube_search',
      makeDeps({ youtubeSearch: deps.youtubeSearch }),
    );
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('youtube.search.global', 'global');
    expect(mocks.searchYouTubeMusic).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'fail' });
    expect(result.detail).toMatch(/Budget giornaliero delle ricerche YouTube esaurito/);
  });

  it('maps every outcome', async () => {
    const run = (value: unknown) =>
      runCheck('youtube_search', makeDeps({ youtubeSearch: async () => value as never }));
    expect((await run({ outcome: 'results', videos: [{ id: 'a' }, { id: 'b' }] })).detail).toBe(
      'La ricerca di prova trova 2 video',
    );
    expect((await run({ outcome: 'no_results', videos: [] })).status).toBe('fail');
    expect(
      (await run({ outcome: 'unavailable', videos: [], unavailableReason: 'quota_exceeded' }))
        .detail,
    ).toMatch(/Quota esaurita/);
    expect(
      (await run({ outcome: 'unavailable', videos: [], unavailableReason: 'not_configured' }))
        .detail,
    ).toMatch(/non configurata/);
    expect(
      (await run({ outcome: 'unavailable', videos: [], unavailableReason: 'api_error' })).status,
    ).toBe('fail');
    // The app's own daily search budget, not YouTube's quota.
    expect((await run(YOUTUBE_BUDGET_EXHAUSTED)).detail).toBe(
      'Budget giornaliero delle ricerche YouTube esaurito e nessun risultato salvato',
    );
  });
});

describe('catalogue checks', () => {
  it('audius: ok with tracks, warn when not configured, fail when unavailable or empty', async () => {
    const run = (value: unknown) =>
      runCheck('audius', makeDeps({ audiusTrending: async () => value as never }));
    expect((await run({ outcome: 'results', tracks: [{}] })).status).toBe('ok');
    expect((await run({ outcome: 'inactive', tracks: [] })).status).toBe('warn');
    expect((await run({ outcome: 'unavailable', tracks: [] })).status).toBe('fail');
    expect((await run({ outcome: 'no_results', tracks: [] })).status).toBe('fail');
  });

  it('radio and podcasts: ok with at least one item, fail otherwise', async () => {
    const radio = (value: unknown) =>
      runCheck('radio', makeDeps({ radioStations: async () => value as never }));
    expect((await radio({ outcome: 'results', stations: [{}] })).status).toBe('ok');
    expect((await radio({ outcome: 'unavailable', stations: [] })).status).toBe('fail');
    expect((await radio({ outcome: 'no_results', stations: [] })).status).toBe('fail');
    const podcasts = (value: unknown) =>
      runCheck('podcasts', makeDeps({ podcastSearch: async () => value as never }));
    expect((await podcasts({ outcome: 'results', podcasts: [{}] })).status).toBe('ok');
    expect((await podcasts({ outcome: 'unavailable', podcasts: [] })).status).toBe('fail');
  });

  it('radio and podcasts use the existing helpers with small fixed queries', async () => {
    mocks.listStations.mockResolvedValue({ outcome: 'results', stations: [] });
    mocks.searchPodcasts.mockResolvedValue({ outcome: 'results', podcasts: [] });
    const fetcher = makeFetch() as never;
    await defaultCheckDeps().radioStations(fetcher);
    await defaultCheckDeps().podcastSearch(fetcher);
    expect(mocks.listStations).toHaveBeenCalledWith({ country: 'IT', limit: 5 }, fetcher);
    expect(mocks.searchPodcasts).toHaveBeenCalledWith('musica', fetcher);
  });

  it('jamendo: warn "Non configurato" without a client id, no call made', async () => {
    const jamendoTracks = vi.fn();
    const result = await runCheck(
      'jamendo',
      makeDeps({ env: { ...ENV, JAMENDO_CLIENT_ID: '' }, jamendoTracks }),
    );
    expect(result).toMatchObject({ status: 'warn', detail: 'Non configurato' });
    expect(jamendoTracks).not.toHaveBeenCalled();
    const broken = await runCheck(
      'jamendo',
      makeDeps({ jamendoTracks: async () => ({ outcome: 'unavailable', tracks: [] }) }),
    );
    expect(broken.status).toBe('fail');
  });

  it('email: ok only with both RESEND_API_KEY and EMAIL_FROM, never a network call', async () => {
    const fetcher = makeFetch();
    expect((await runCheck('email', makeDeps({ fetch: fetcher as never }))).status).toBe('ok');
    const missing = await runCheck(
      'email',
      makeDeps({ fetch: fetcher as never, env: { ...ENV, RESEND_API_KEY: '' } }),
    );
    expect(missing).toMatchObject({
      status: 'warn',
      detail: 'Email non configurate: le email di verifica non partono',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('anthropic', () => {
  it('calls the free models endpoint with the key and API version', async () => {
    const fetcher = makeFetch();
    const result = await runCheck('anthropic', makeDeps({ fetch: fetcher as never }));
    expect(result.status).toBe('ok');
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(init.headers).toMatchObject({
      'x-api-key': SECRETS.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    });
  });

  it.each([
    [401, 'fail'],
    [403, 'fail'],
    [429, 'fail'],
    [500, 'fail'],
  ] as const)('maps HTTP %i to %s', async (status, expected) => {
    const fetcher = makeFetch({
      'api.anthropic.com': () =>
        Response.json({ error: { message: `bad key ${SECRETS.ANTHROPIC_API_KEY}` } }, { status }),
    });
    const result = await runCheck('anthropic', makeDeps({ fetch: fetcher as never }));
    expect(result.status).toBe(expected);
    expectNoSecrets([result.detail]);
  });

  it('warns when missing and fails a malformed key without calling Anthropic', async () => {
    const fetcher = makeFetch();
    const missing = await runCheck(
      'anthropic',
      makeDeps({ fetch: fetcher as never, env: { ...ENV, ANTHROPIC_API_KEY: '' } }),
    );
    expect(missing.status).toBe('warn');
    const malformed = await runCheck(
      'anthropic',
      makeDeps({
        fetch: fetcher as never,
        env: { ...ENV, ANTHROPIC_API_KEY: 'sk-proj-123456789' },
      }),
    );
    expect(malformed).toMatchObject({
      status: 'fail',
      detail: 'La chiave non ha il formato giusto',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('stripe', () => {
  it.each([
    [200, 'ok', 'Chiave valida'],
    [401, 'fail', 'Chiave non valida'],
    [403, 'ok', 'Chiave valida (permessi limitati)'],
    [500, 'fail', 'Stripe ha risposto con un errore (HTTP 500)'],
  ] as const)('maps HTTP %i to %s', async (status, expected, detail) => {
    const fetcher = makeFetch({
      'api.stripe.com': () =>
        Response.json(
          { error: { message: `Invalid API Key provided: ${SECRETS.STRIPE_SECRET_KEY}` } },
          { status },
        ),
    });
    const result = await runCheck('stripe', makeDeps({ fetch: fetcher as never }));
    expect(result).toMatchObject({ status: expected, detail });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/balance');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRETS.STRIPE_SECRET_KEY}` });
  });

  it('warns when the key is missing', async () => {
    const result = await runCheck('stripe', makeDeps({ env: { ...ENV, STRIPE_SECRET_KEY: '' } }));
    expect(result.status).toBe('warn');
  });
});

describe('cron_cleanup', () => {
  it('warns when the cleanup never ran, fails past 50 hours, ok otherwise', async () => {
    const run = async (beat: { at: Date } | null) => {
      const { db } = makeDb();
      db.monitorHeartbeat.findUnique.mockResolvedValue(beat as never);
      return runCheck('cron_cleanup', makeDeps({ db }));
    };
    expect(await run(null)).toMatchObject({ status: 'warn', detail: 'Mai eseguita finora' });
    const old = await run({ at: new Date(NOW.getTime() - 51 * HOUR) });
    expect(old.status).toBe('fail');
    expect(old.detail).toMatch(/più di 50 ore fa/);
    const recent = await run({ at: new Date(NOW.getTime() - 7 * HOUR) });
    expect(recent.status).toBe('ok');
    // 03:00 UTC = 04:00 in Rome (CET in November).
    expect(recent.detail).toContain('04:00');
  });
});

describe('secrets never reach a detail', () => {
  it('stays clean when every upstream fails and echoes the secrets back', async () => {
    const echo = (status: number) => () =>
      Response.json(
        { error: { message: SECRET_VALUES.join(' '), errors: [{ reason: 'x' }] } },
        { status },
      );
    const { db, create } = makeDb();
    const dbError = Object.assign(new Error(SECRET_VALUES.join(' ')), { code: 'P1001' });
    db.$queryRaw.mockRejectedValue(dbError);
    create.mockRejectedValue(dbError);
    db.monitorHeartbeat.findUnique.mockRejectedValue(dbError);
    const thrower = async () => {
      throw new Error(SECRET_VALUES.join(' '));
    };
    const results = await runChecks(
      makeDeps({
        db,
        fetch: makeFetch({
          'accounts.google.com': () =>
            googleRedirect(
              `https://accounts.google.com/signin/oauth/error?x=${SECRET_VALUES.join(',')}`,
            ),
          'www.googleapis.com': echo(400),
          'api.anthropic.com': echo(401),
          'api.stripe.com': echo(401),
        }) as never,
        youtubeSearch: thrower,
        audiusTrending: thrower,
        radioStations: thrower,
        podcastSearch: thrower,
        jamendoTracks: thrower,
      }),
    );
    expect(results.filter((result) => result.status === 'ok').map((result) => result.id)).toEqual([
      'auth_config',
      'email',
    ]);
    expectNoSecrets(results.map((result) => result.detail));
  });

  it('safeDetail masks configured secret values and caps the length', () => {
    const detail = safeDetail(`chiave ${SECRETS.STRIPE_SECRET_KEY} e ${SECRETS.DATABASE_URL}`, ENV);
    expect(detail).toBe('chiave [nascosto] e [nascosto]');
    expect(safeDetail('x'.repeat(500), ENV)).toHaveLength(300);
    expect(safeDetail('  ', ENV)).toBe('Nessun dettaglio');
  });
});
