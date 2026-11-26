// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));

import { POST } from '@/app/api/admin/instagram-finder/route';
import {
  briefKeywords,
  captionMentions,
  findInstagramCreators,
  heuristicScore,
  normalizeHashtag,
  suggestInstagramCreatorsWithoutApi,
} from '@/lib/business/instagram-finder.server';
import { classifyGraphError, instagramGraphConfig } from '@/lib/business/instagram-graph.server';
import { InstagramFinderRequestSchema } from '@/lib/contracts/instagram-finder';

const admin = { id: 'admin-1', role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true };
const TOKEN = 'EAAtesttoken1234567890';
const config = { token: TOKEN, igUserId: '17841400000000000', version: 'v23.0' };
const now = new Date('2026-11-23T12:00:00Z');

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function request(body: unknown) {
  return new Request('https://solco.test/api/admin/instagram-finder', {
    method: 'POST',
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function profile(username: string, followers: number, bio: string, likes: number) {
  return {
    business_discovery: {
      username,
      name: username.toUpperCase(),
      biography: bio,
      website: 'https://example.com',
      profile_picture_url: 'https://scontent.cdninstagram.com/a.jpg',
      followers_count: followers,
      media_count: 120,
      media: {
        data: [
          {
            id: '1',
            like_count: likes,
            comments_count: 10,
            timestamp: '2026-11-20T10:00:00+0000',
            caption: 'new lofi beat',
          },
          { id: '2', like_count: likes, comments_count: 10, timestamp: '2026-11-10T10:00:00+0000' },
        ],
      },
    },
  };
}

/** Graph API finta: hashtag → post con menzioni → profili Business (uno personale = non trovato). */
function fakeGraph(overrides: Record<string, Response> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe('graph.facebook.com');
    expect(url.searchParams.has('access_token')).toBe(false);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const path = url.pathname;
    for (const [key, response] of Object.entries(overrides))
      if (path.includes(key)) return response;
    if (path.endsWith('/ig_hashtag_search')) return json(200, { data: [{ id: '178000' }] });
    if (path.endsWith('/178000/top_media')) {
      return json(200, {
        data: [
          {
            id: 'm1',
            caption: 'beat w/ @lofi.anna and @mario_beats',
            permalink: 'https://www.instagram.com/p/AAA/',
            like_count: 900,
            comments_count: 40,
          },
          {
            id: 'm2',
            caption: 'prod. @lofi.anna. #lofi',
            permalink: 'https://www.instagram.com/p/BBB/',
            like_count: 300,
            comments_count: 5,
          },
        ],
      });
    }
    if (path.endsWith('/178000/recent_media')) {
      return json(200, {
        data: [
          { id: 'm3', caption: 'ciao @privato_x', permalink: 'https://www.instagram.com/p/CCC/' },
        ],
      });
    }
    const fields = url.searchParams.get('fields') ?? '';
    if (fields.includes('username(lofi.anna)'))
      return json(200, profile('lofi.anna', 20_000, 'Lofi producer from Milan', 800));
    if (fields.includes('username(mario_beats)'))
      return json(200, profile('mario_beats', 500_000, 'rapper', 1_000));
    if (fields.includes('username(manual.one)'))
      return json(200, profile('manual.one', 8_000, 'lofi beats', 50));
    return json(400, { error: { code: 110, message: 'Cannot find User' } });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.enforceRateLimit.mockResolvedValue(null);
});

describe('helper puri', () => {
  it('normalizza hashtag, estrae menzioni e parole chiave', () => {
    expect(normalizeHashtag('#LoFiBeats')).toBe('lofibeats');
    expect(normalizeHashtag('lo fi')).toBeNull();
    expect(captionMentions('w/ @Anna.Lo. e mail a@b.com, @x_y')).toEqual(['anna.lo', 'x_y']);
    expect(briefKeywords('Producer lo-fi italiani, 5k follower')).toEqual([
      'producer',
      'italiani',
      'follower',
    ]);
  });

  it('classifica gli errori di Meta', () => {
    expect(classifyGraphError(190, null, 'expired')).toBe('auth');
    expect(classifyGraphError(10, null, 'perm')).toBe('permission');
    expect(classifyGraphError(4, null, 'too many')).toBe('rate_limited');
    expect(classifyGraphError(24, null, 'Reached the maximum of 30 unique hashtags')).toBe(
      'hashtag_limit',
    );
    expect(classifyGraphError(110, null, 'x')).toBe('not_found');
  });

  it('punteggio: pertinenza, engagement e attività', () => {
    const fresh = {
      followers: 10_000,
      avgLikes: 500,
      avgComments: 0,
      engagementRate: 0.05,
      lastPostAt: '2026-11-20T00:00:00Z',
      keywordHits: 4,
    };
    expect(heuristicScore(fresh, 4, now)).toBe(100);
    expect(heuristicScore({ ...fresh, keywordHits: 0, lastPostAt: null }, 4, now)).toBe(30);
  });

  it('config: token e ID numerico obbligatori, versione validata', () => {
    expect(instagramGraphConfig({})).toBeNull();
    expect(
      instagramGraphConfig({ INSTAGRAM_ACCESS_TOKEN: 't', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'abc' }),
    ).toBeNull();
    expect(
      instagramGraphConfig({
        INSTAGRAM_ACCESS_TOKEN: 't',
        INSTAGRAM_BUSINESS_ACCOUNT_ID: '17841400000000000',
        INSTAGRAM_GRAPH_VERSION: '../evil',
      })?.version,
    ).toBe('v23.0');
  });

  it('la richiesta accetta @username e rifiuta min > max', () => {
    expect(
      InstagramFinderRequestSchema.parse({ brief: 'lofi', usernames: ['@anna.lo'] }).usernames,
    ).toEqual(['anna.lo']);
    expect(
      InstagramFinderRequestSchema.safeParse({ brief: 'lofi', minFollowers: 10, maxFollowers: 1 })
        .success,
    ).toBe(false);
    expect(
      InstagramFinderRequestSchema.safeParse({ brief: 'lofi', usernames: ['a b'] }).success,
    ).toBe(false);
  });
});

describe('findInstagramCreators', () => {
  it('trova i creator menzionati, legge i dati reali, filtra per follower e salta gli account personali', async () => {
    const fetchImpl = fakeGraph();
    const outcome = await findInstagramCreators(
      InstagramFinderRequestSchema.parse({
        brief: 'lofi producer',
        hashtags: ['#lofi'],
        usernames: ['manual.one'],
        maxFollowers: 100_000,
      }),
      config,
      {}, // nessun provider AI: piano e ordine senza AI
      fetchImpl,
      now,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { result } = outcome;
    expect(result.hashtags[0]).toBe('lofi');
    expect(result.creators.map((c) => c.username)).toEqual(['lofi.anna', 'manual.one']);
    expect(result.creators[0]).toMatchObject({ followers: 20_000, foundVia: ['#lofi'] });
    expect(result.creators[0]?.engagementRate).toBeCloseTo(810 / 20_000);
    expect(result.creators[1]?.foundVia).toEqual(['manuale']);
    // mario_beats oltre il massimo; privato_x non è Business/Creator.
    expect(result.skipped).toBe(1);
    expect(result.aiRanked).toBe(false);
    expect(result.posts[0]?.permalink).toBe('https://www.instagram.com/p/AAA/');
  });

  it('token rifiutato senza username: errore auth con il messaggio di Meta, senza il token', async () => {
    const fetchImpl = fakeGraph({
      ig_hashtag_search: json(400, { error: { code: 190, message: `Bad token ${TOKEN}` } }),
    });
    const outcome = await findInstagramCreators(
      InstagramFinderRequestSchema.parse({ brief: 'lofi' }),
      config,
      {},
      fetchImpl,
      now,
    );
    expect(outcome).toMatchObject({ ok: false, error: 'auth' });
    if (!outcome.ok) expect(outcome.detail).not.toContain(TOKEN);
  });

  it('usa il riordino dell’AI quando la Riserva risponde', async () => {
    const graph = fakeGraph();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).hostname === 'graph.facebook.com') return graph(input, init);
      const ranking = String(init?.body).includes('ranking');
      const content = ranking
        ? JSON.stringify({
            ranking: [
              { username: 'manual.one', score: 100, reason: 'Perfetto' },
              { username: 'lofi.anna', score: 5, reason: 'Fuori target' },
            ],
          })
        : JSON.stringify({ hashtags: ['lofi'], keywords: ['lofi'], summary: 'Producer lofi' });
      return json(200, { model: 'x', choices: [{ message: { content } }] });
    }) as unknown as typeof fetch;
    const outcome = await findInstagramCreators(
      InstagramFinderRequestSchema.parse({ brief: 'producer lofi', usernames: ['manual.one'] }),
      config,
      { MWAPI_API_KEY: 'k' },
      fetchImpl,
      now,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.aiRanked).toBe(true);
    expect(outcome.result.summary).toBe('Producer lofi');
    expect(outcome.result.creators[0]).toMatchObject({
      username: 'manual.one',
      reason: 'Perfetto',
    });
  });
});

describe('senza la revisione di Meta (Public Content Access)', () => {
  it('hashtag negati: usa gli username suggeriti dall’AI e tiene solo quelli reali Business/Creator', async () => {
    const graph = fakeGraph({
      ig_hashtag_search: json(400, {
        error: { code: 10, message: 'Application does not have permission for this action' },
      }),
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).hostname === 'graph.facebook.com') return graph(input, init);
      const body = String(init?.body);
      const content = body.includes('usernames')
        ? JSON.stringify({ usernames: ['@lofi.anna', 'inventato_123', 'non valido!'] })
        : body.includes('ranking')
          ? '{}'
          : JSON.stringify({ hashtags: ['lofi'], keywords: ['lofi'], summary: 'Lofi' });
      return json(200, { model: 'x', choices: [{ message: { content } }] });
    }) as unknown as typeof fetch;
    const outcome = await findInstagramCreators(
      InstagramFinderRequestSchema.parse({ brief: 'producer lofi' }),
      config,
      { MWAPI_API_KEY: 'k' },
      fetchImpl,
      now,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.creators.map((c) => c.username)).toEqual(['lofi.anna']);
    expect(outcome.result.creators[0]?.foundVia).toEqual(['suggerito AI']);
    expect(outcome.result.skipped).toBe(1);
    expect(outcome.result.warnings.join(' ')).toContain('Ricerca per hashtag non disponibile');
  });

  it('INSTAGRAM_HASHTAG_SEARCH=off non chiama Hashtag Search', async () => {
    const fetchImpl = fakeGraph();
    const outcome = await findInstagramCreators(
      InstagramFinderRequestSchema.parse({ brief: 'lofi', usernames: ['manual.one'] }),
      config,
      { INSTAGRAM_HASHTAG_SEARCH: 'off' },
      fetchImpl,
      now,
    );
    expect(outcome.ok).toBe(true);
    const paths = fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths.some((path) => path.includes('ig_hashtag_search'))).toBe(false);
    if (outcome.ok) expect(outcome.result.creators.map((c) => c.username)).toEqual(['manual.one']);
  });
});

describe('senza Instagram collegato (solo AI)', () => {
  it('suggerimenti non verificati, username validi e unici, ordinati per punteggio, mai Meta', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).hostname).not.toBe('graph.facebook.com');
      const content = JSON.stringify({
        summary: 'Producer lofi',
        creators: [
          { username: '@Lofi.Girl', name: 'Lofi Girl', score: 95, reason: 'Molto noto' },
          { username: 'lofi.girl', score: 10, reason: 'doppione' },
          { username: 'non valido!', score: 99, reason: 'x' },
          { username: 'chillhop', score: 80, reason: 'Etichetta lofi' },
        ],
      });
      return json(200, { model: 'x', choices: [{ message: { content } }] });
    }) as unknown as typeof fetch;
    const outcome = await suggestInstagramCreatorsWithoutApi(
      InstagramFinderRequestSchema.parse({ brief: 'producer lofi', usernames: ['mio.amico'] }),
      { MWAPI_API_KEY: 'k' },
      fetchImpl,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.mode).toBe('ai_only');
    expect(outcome.result.creators.map((c) => c.username)).toEqual([
      'lofi.girl',
      'chillhop',
      'mio.amico',
    ]);
    expect(outcome.result.creators.every((c) => !c.verified && c.followers === 0)).toBe(true);
    expect(outcome.result.creators[2]?.foundVia).toEqual(['manuale']);
  });

  it('AI non disponibile: errore', async () => {
    const outcome = await suggestInstagramCreatorsWithoutApi(
      InstagramFinderRequestSchema.parse({ brief: 'producer lofi' }),
      {},
      vi.fn() as unknown as typeof fetch,
    );
    expect(outcome).toMatchObject({ ok: false, error: 'failed' });
  });
});

describe('POST /api/admin/instagram-finder', () => {
  it('nega origine estranea, anonimi e non admin prima di Meta', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(request({ brief: 'lofi' }))).status).toBe(403);
    mocks.getSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user: { ...admin, role: 'user' } });
    expect((await POST(request({ brief: 'lofi' }))).status).toBe(401);
    expect((await POST(request({ brief: 'lofi' }))).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('senza Instagram e senza AI: errore chiaro, nessuna chiamata a Meta', async () => {
    vi.stubEnv('INSTAGRAM_ACCESS_TOKEN', '');
    vi.stubEnv('MWAPI_API_KEY', '');
    vi.stubEnv('MWAPI_API_KEY_2', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await POST(request({ brief: 'lofi' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'failed' });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('admin.instagram-finder', 'user:admin-1');
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(
      false,
    );
    fetchSpy.mockRestore();
  });

  it('richiesta non valida: 400', async () => {
    expect((await POST(request({ brief: 'x' }))).status).toBe(400);
  });
});
