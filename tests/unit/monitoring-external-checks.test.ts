// @polsia:user-owned — monitoraggio esterno (scripts/monitor/check-site.ts): i singoli controlli
// con un fetch finto (nessuna rete), i nuovi tentativi, l'ordine dei risultati e main() completo.
// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_PATHS,
  type CheckOutcome,
  type CheckResult,
  checkCatalogAudius,
  checkCatalogPodcasts,
  checkCatalogRadio,
  checkGoogleSignIn,
  checkInternalStatus,
  checkPage,
  checkSecurityHeaders,
  checkSeoFiles,
  checkSignupRoute,
  checkSiteHealth,
  createDeps,
  evaluateGoogleAuthUrl,
  evaluateGoogleRedirect,
  evaluateSecurityHeaders,
  FIREWALL_CHALLENGE_DETAIL,
  gateOutcome,
  type MonitorDeps,
  main,
  mapLimit,
  PUBLIC_PAGES,
  type PublicStatusBody,
  parsePublicStatus,
  refreshPending,
  responseTimeResult,
  runAllChecks,
  runCheck,
  STATUS_REREAD_DELAY_MS,
  USER_AGENT,
} from '../../scripts/monitor/check-site';

const BASE = 'https://solco.test';
/** Five minutes after the checkedAt of the healthy /api/status: no re-read by default. */
const NOW = new Date('2026-11-11T10:05:00.000Z');
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

type Call = {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null | undefined;
};
type Handler = (call: Call) => Response | Promise<Response>;

const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': 'frame-ancestors https://polsia.com https://www.polsia.com;',
};

function html(body = '<html><body><main>Solco</main></body></html>', status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS },
  });
}

function googleUrl(overrides: Record<string, string | null> = {}): string {
  const url = new URL(GOOGLE_AUTH);
  const params: Record<string, string | null> = {
    response_type: 'code',
    client_id: '123.apps.googleusercontent.com',
    state: 'abc',
    scope: 'openid email profile',
    redirect_uri: `${BASE}/api/auth/oauth2/callback/google`,
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.href;
}

function redirect(location: string | null, status = 302): Response {
  return new Response(null, { status, headers: location ? { location } : {} });
}

/** Every route of a healthy Solco, keyed "<METHOD> <path>" (or full URL for other hosts). */
function healthySite(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...Object.fromEntries(PUBLIC_PAGES.map((page) => [`GET ${page.path}`, () => html()])),
    'GET /health': () => Response.json({ status: 'healthy' }),
    'GET /robots.txt': () => new Response('User-agent: *\nAllow: /'),
    'GET /sitemap.xml': () =>
      new Response('<urlset/>', { headers: { 'content-type': 'application/xml' } }),
    'POST /api/auth/sign-in/oauth2': () => Response.json({ url: googleUrl(), redirect: true }),
    [`GET ${GOOGLE_AUTH}`]: () =>
      redirect('https://accounts.google.com/v3/signin/identifier?opparams=%253F&client_id=123'),
    'POST /api/auth/sign-up/email': () =>
      Response.json({ code: 'VALIDATION_ERROR', message: 'invalid' }, { status: 400 }),
    'GET /api/music/radio': () =>
      Response.json({ outcome: 'results', stations: [{ id: 'a' }, { id: 'b' }] }),
    'GET /api/music/podcasts': () => Response.json({ outcome: 'results', podcasts: [{ id: '1' }] }),
    'GET /api/music/trending': () =>
      Response.json({
        outcome: 'results',
        tracks: [{ id: 't' }],
        albums: [],
        sourceStatus: { id: 'audius', active: true },
      }),
    'GET /api/status': () =>
      Response.json({
        status: 'ok',
        checkedAt: '2026-11-11T10:00:00.000Z',
        stale: false,
        failing: [],
        warnings: [],
      }),
    ...overrides,
  };
}

function fakeFetch(handlers: Record<string, Handler>, calls: Call[]) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const call: Call = {
      method,
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
      redirect: init.redirect,
      signal: init.signal,
    };
    calls.push(call);
    const key =
      url.origin === BASE ? `${method} ${url.pathname}` : `${method} ${url.origin}${url.pathname}`;
    const handler = handlers[key];
    return handler ? handler(call) : new Response('Not Found', { status: 404 });
  };
}

function setup(
  handlers: Record<string, Handler> = healthySite(),
  extra: Partial<MonitorDeps> = {},
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let tick = 0;
  const deps = createDeps(BASE, {
    fetch: fakeFetch(handlers, calls),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    clock: () => {
      tick += 25;
      return tick;
    },
    now: () => NOW,
    ...extra,
  });
  return { deps, calls, sleeps };
}

const failWith = (detail: string): CheckOutcome => ({ status: 'fail', detail });

describe('runCheck', () => {
  it('retries a failure once after 5 seconds and reports the second attempt', async () => {
    const { deps, sleeps } = setup();
    const attempt = vi
      .fn<() => Promise<CheckOutcome>>()
      .mockResolvedValueOnce(failWith('HTTP 502'))
      .mockResolvedValueOnce({ status: 'ok', detail: 'Il sito risponde' });
    const result = await runCheck(deps, 'site_health', true, attempt);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([5_000]);
    expect(result).toEqual({
      id: 'site_health',
      label: 'Sito raggiungibile (/health)',
      critical: true,
      status: 'ok',
      detail: 'Il sito risponde (al secondo tentativo)',
      ms: 25,
    });
  });

  it('declares a failure only after the retry fails too, and never retries a warning', async () => {
    const { deps, sleeps } = setup();
    const failing = vi.fn(async () => failWith('HTTP 500'));
    const result = await runCheck(deps, 'seo_files', false, failing);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'fail', detail: 'HTTP 500', critical: false });
    expect(sleeps).toEqual([5_000]);

    const warning = vi.fn(async (): Promise<CheckOutcome> => ({ status: 'warn', detail: 'lento' }));
    await runCheck(deps, 'signup_route', true, warning);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('turns thrown errors into short Italian details without upstream text', async () => {
    const { deps } = setup();
    const network = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND solco.test' },
    });
    const cases: Array<[unknown, string]> = [
      [network, 'Errore di rete (ENOTFOUND)'],
      [
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        'Nessuna risposta entro 15 s',
      ],
      [new DOMException('aborted', 'AbortError'), 'Nessuna risposta entro 15 s'],
      [new Error('<html>secret upstream body</html>'), 'Errore di rete'],
      ['a string', 'Errore di rete'],
    ];
    for (const [error, detail] of cases) {
      const result = await runCheck(deps, 'site_health', true, async () => {
        throw error;
      });
      expect(result).toMatchObject({ status: 'fail', detail });
    }
  });

  it('clips long details to 200 characters on one line', async () => {
    const { deps } = setup();
    const result = await runCheck(deps, 'seo_files', false, async () =>
      failWith(`riga\n${'x'.repeat(400)}`),
    );
    expect(result.detail.length).toBeLessThanOrEqual(200);
    expect(result.detail).not.toContain('\n');
  });
});

describe('site checks', () => {
  it('site_health wants 200 and status "healthy"', async () => {
    expect(await checkSiteHealth(setup().deps)).toEqual({
      status: 'ok',
      detail: 'Il sito risponde',
    });
    const down = setup(healthySite({ 'GET /health': () => new Response('boom', { status: 500 }) }));
    expect(await checkSiteHealth(down.deps)).toEqual(failWith('/health risponde HTTP 500'));
    const odd = setup(healthySite({ 'GET /health': () => Response.json({ status: 'starting' }) }));
    expect(await checkSiteHealth(odd.deps)).toEqual(failWith('/health non risponde "healthy"'));
    const text = setup(healthySite({ 'GET /health': () => new Response('ok') }));
    expect((await checkSiteHealth(text.deps)).status).toBe('fail');
  });

  it('a page must answer 200 with HTML and without "Application error"', async () => {
    expect(await checkPage(setup().deps, '/radio')).toEqual({
      status: 'ok',
      detail: 'Pagina caricata',
    });
    const cases: Array<[Handler, string]> = [
      [
        () => html('<h2>Application error: a client-side exception has occurred</h2>'),
        'La pagina mostra "Application error"',
      ],
      [() => html('errore', 500), 'HTTP 500'],
      [() => redirect('/login?next=%2Fradio', 307), 'Reindirizza altrove (HTTP 307 verso /login)'],
      [
        () => redirect('https://evil.example/x'),
        'Reindirizza altrove (HTTP 302 verso evil.example)',
      ],
      [() => Response.json({ ok: true }), 'Non è una pagina HTML (application/json)'],
      [
        () => new Response('<html></html>', { headers: { 'content-type': '' } }),
        'Non è una pagina HTML (tipo mancante)',
      ],
    ];
    for (const [handler, detail] of cases) {
      const { deps } = setup(healthySite({ 'GET /radio': handler }));
      expect(await checkPage(deps, '/radio')).toEqual(failWith(detail));
    }
  });

  /** The UAM loading screen (src/lib/security/uam-gate.ts): 200 first-visit, 503 attack. */
  function uamChallenge(status: 200 | 503): Response {
    return new Response('<html><body>Verifica in corso…</body></html>', {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-solco-gate': 'challenge',
        ...(status === 503 ? { 'retry-after': '5' } : {}),
      },
    });
  }

  it('only warns when the UAM loading screen answers instead of the page (200 or 503)', async () => {
    const uam = {
      status: 'warn',
      detail: 'Schermata anti-bot (UAM) attiva: pagina non verificata',
    };
    for (const status of [200, 503] as const) {
      const { deps, calls, sleeps } = setup(
        healthySite({
          'GET /': () => uamChallenge(status),
          'GET /radio': () => uamChallenge(status),
        }),
      );
      expect(await checkPage(deps, '/radio'), String(status)).toEqual(uam);
      expect(await checkSecurityHeaders(deps), String(status)).toEqual(uam);
      // Not a failure: no retry, no email, and the home timing is not measured.
      const home = await runCheck(deps, 'page:/', true, () => checkPage(deps, '/'));
      expect(home).toMatchObject({ status: 'warn', critical: true });
      expect(sleeps).toEqual([]);
      expect(calls).toHaveLength(3);
      expect(responseTimeResult(home)).toMatchObject({
        status: 'warn',
        detail: 'Non misurata: la home non è stata verificata',
        ms: null,
      });
    }
  });

  it('Attack Challenge Mode di Vercel acceso: avviso, mai un allarme, niente secondo tentativo', async () => {
    const challenged = () =>
      new Response('<html>Vercel Security Checkpoint</html>', {
        status: 429,
        headers: { 'content-type': 'text/html', 'x-vercel-mitigated': 'challenge' },
      });
    const { deps, sleeps } = setup(
      healthySite({ 'GET /': challenged, 'GET /radio': challenged, 'GET /health': challenged }),
    );
    for (const [id, check] of [
      ['page:/radio', () => checkPage(deps, '/radio')],
      ['security_headers', () => checkSecurityHeaders(deps)],
      ['site_health', () => checkSiteHealth(deps)],
    ] as const) {
      const result = await runCheck(deps, id, true, check);
      expect(result, id).toMatchObject({ status: 'warn', detail: FIREWALL_CHALLENGE_DETAIL });
    }
    expect(sleeps).toEqual([]);
    expect(gateOutcome(new Headers({ 'x-vercel-mitigated': 'challenge' }))?.status).toBe('warn');
  });

  it('names the Vercel firewall when it really blocks the monitor (a failure)', async () => {
    expect(gateOutcome(new Headers({ 'x-vercel-mitigated': 'deny' }))).toEqual(
      failWith(
        'Il firewall di Vercel ferma il monitor (x-vercel-mitigated: deny): pagina non verificata',
      ),
    );
    expect(gateOutcome(new Headers({ 'x-vercel-mitigated': '<b>deny</b>' }))?.detail).toBe(
      'Il firewall di Vercel ferma il monitor (x-vercel-mitigated: blocco): pagina non verificata',
    );
    expect(gateOutcome(new Headers(SECURITY_HEADERS))).toBeNull();
  });

  it('security headers: HSTS, nosniff, Referrer-Policy and frame protection', async () => {
    expect((await checkSecurityHeaders(setup().deps)).status).toBe('ok');
    // CSP frame-ancestors alone is enough frame protection.
    const cspOnly = new Headers({ ...SECURITY_HEADERS, 'x-frame-options': '' });
    expect(evaluateSecurityHeaders(cspOnly).status).toBe('ok');
    const xfoOnly = new Headers({
      ...SECURITY_HEADERS,
      'content-security-policy': "default-src 'self'",
    });
    expect(evaluateSecurityHeaders(xfoOnly).status).toBe('ok');
    expect(evaluateSecurityHeaders(new Headers())).toEqual(
      failWith(
        'Mancano: Strict-Transport-Security, X-Content-Type-Options: nosniff, Referrer-Policy, protezione dai frame (X-Frame-Options o frame-ancestors)',
      ),
    );
    const weak = new Headers({
      ...SECURITY_HEADERS,
      'strict-transport-security': 'max-age=0',
      'x-content-type-options': 'sniff',
      'x-frame-options': 'ALLOWALL',
      'content-security-policy': "default-src 'self'; script-src 'self'",
    });
    expect(evaluateSecurityHeaders(weak).detail).toBe(
      'Mancano: Strict-Transport-Security, X-Content-Type-Options: nosniff, protezione dai frame (X-Frame-Options o frame-ancestors)',
    );
    // A strict script-src CSP is not required (not active yet).
    expect(evaluateSecurityHeaders(new Headers(SECURITY_HEADERS)).status).toBe('ok');
  });

  it('seo_files needs both robots.txt and sitemap.xml', async () => {
    expect((await checkSeoFiles(setup().deps)).status).toBe('ok');
    const { deps } = setup(
      healthySite({ 'GET /sitemap.xml': () => new Response('', { status: 500 }) }),
    );
    expect(await checkSeoFiles(deps)).toEqual(failWith('sitemap.xml HTTP 500'));
  });
});

describe('google_signin', () => {
  it('posts to /api/auth/sign-in/oauth2 with Origin, then follows Google without redirects', async () => {
    const { deps, calls } = setup();
    expect(await checkGoogleSignIn(deps)).toEqual({
      status: 'ok',
      detail: 'Google mostra la sua pagina di accesso',
    });
    expect(calls).toHaveLength(2);
    const [post, google] = calls;
    expect(post?.method).toBe('POST');
    expect(post?.url.href).toBe(`${BASE}/api/auth/sign-in/oauth2`);
    expect(post?.headers.get('origin')).toBe(BASE);
    expect(post?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(post?.body ?? 'null')).toEqual({ providerId: 'google', callbackURL: '/' });
    expect(google?.url.origin + (google?.url.pathname ?? '')).toBe(GOOGLE_AUTH);
    expect(google?.redirect).toBe('manual');
  });

  it('fails when Google redirects to its OAuth error page', async () => {
    const { deps } = setup(
      healthySite({
        [`GET ${GOOGLE_AUTH}`]: () =>
          redirect(
            'https://accounts.google.com/signin/oauth/error?authError=Cg9pbnZhbGlk&client_id=1',
          ),
      }),
    );
    expect(await checkGoogleSignIn(deps)).toEqual(
      failWith('Google rifiuta la richiesta di accesso (client Google o redirect_uri non validi)'),
    );
  });

  it('fails when Solco does not start the flow or builds a wrong URL', async () => {
    const cases: Array<[Handler, string]> = [
      [() => new Response('', { status: 500 }), 'Solco non avvia l’accesso con Google (HTTP 500)'],
      [() => Response.json({ redirect: true }), 'Solco non restituisce l’indirizzo di Google'],
      [() => new Response('<html>'), 'Solco non restituisce l’indirizzo di Google'],
      [
        () => Response.json({ url: googleUrl({ redirect_uri: '/api/auth/callback/google' }) }),
        `redirect_uri sbagliato: /api/auth/callback/google invece di ${BASE}/api/auth/oauth2/callback/google`,
      ],
      [
        () => Response.json({ url: googleUrl({ client_id: null }) }),
        'Manca client_id nella richiesta a Google',
      ],
      [
        () => Response.json({ url: 'https://evil.example/o/oauth2/v2/auth?client_id=1' }),
        'L’accesso porta a un sito inatteso (evil.example)',
      ],
    ];
    for (const [handler, detail] of cases) {
      const { deps, calls } = setup(healthySite({ 'POST /api/auth/sign-in/oauth2': handler }));
      expect(await checkGoogleSignIn(deps)).toEqual(failWith(detail));
      expect(calls.some((call) => call.url.hostname !== 'solco.test')).toBe(false);
    }
  });

  it('evaluates Google answers', () => {
    const request = googleUrl();
    expect(evaluateGoogleRedirect(200, null, request, BASE)).toEqual(
      failWith('Google risponde in modo inatteso (HTTP 200)'),
    );
    expect(evaluateGoogleRedirect(302, null, request, BASE)).toEqual(
      failWith('Google non indica la pagina di accesso'),
    );
    expect(evaluateGoogleRedirect(302, '/signin/oauth/error/v2?x=1', request, BASE).status).toBe(
      'fail',
    );
    expect(
      evaluateGoogleRedirect(
        302,
        `${BASE}/api/auth/oauth2/callback/google?error=invalid_scope`,
        request,
        BASE,
      ),
    ).toEqual(failWith('Google rifiuta la richiesta di accesso (invalid_scope)'));
    expect(evaluateGoogleRedirect(302, '/v3/signin/identifier?dsh=1', request, BASE).status).toBe(
      'ok',
    );
    expect(evaluateGoogleAuthUrl('not a url', BASE)).toBe(
      'Solco restituisce un indirizzo di Google non valido',
    );
    expect(evaluateGoogleAuthUrl(googleUrl(), BASE)).toBeNull();
  });
});

describe('signup_route', () => {
  it('posts an empty body with Origin and expects a validation error', async () => {
    const { deps, calls } = setup();
    expect(await checkSignupRoute(deps)).toEqual({
      status: 'ok',
      detail: 'Il modulo risponde e controlla i dati (HTTP 400)',
    });
    expect(calls[0]?.url.pathname).toBe('/api/auth/sign-up/email');
    expect(calls[0]?.body).toBe('{}');
    expect(calls[0]?.headers.get('origin')).toBe(BASE);
  });

  it('fails on 5xx or any other answer, and only warns when rate limited', async () => {
    const cases: Array<[number, CheckOutcome]> = [
      [500, failWith('Errore del server (HTTP 500)')],
      [503, failWith('Errore del server (HTTP 503)')],
      [200, failWith('Risposta inattesa (HTTP 200, attesa 400)')],
      [403, failWith('Risposta inattesa (HTTP 403, attesa 400)')],
      [429, { status: 'warn', detail: 'Troppe richieste (HTTP 429): riprovo al prossimo giro' }],
    ];
    for (const [status, outcome] of cases) {
      const { deps } = setup(
        healthySite({ 'POST /api/auth/sign-up/email': () => new Response('{}', { status }) }),
      );
      expect(await checkSignupRoute(deps)).toEqual(outcome);
    }
  });
});

describe('catalog checks', () => {
  it('call the same public routes as the app, with a fixed small query', async () => {
    const { deps, calls } = setup();
    expect(await checkCatalogRadio(deps)).toEqual({ status: 'ok', detail: '2 stazioni' });
    expect(await checkCatalogPodcasts(deps)).toEqual({
      status: 'ok',
      detail: '1 podcast in evidenza',
    });
    expect(await checkCatalogAudius(deps)).toEqual({
      status: 'ok',
      detail: '1 brano e 0 album di tendenza',
    });
    expect(calls.map((call) => `${call.url.pathname}${call.url.search}`)).toEqual([
      CATALOG_PATHS.radio,
      CATALOG_PATHS.podcasts,
      CATALOG_PATHS.audius,
    ]);
    expect(CATALOG_PATHS.radio).toBe('/api/music/radio?limit=16&country=IT');
  });

  it('fail on empty lists, upstream outages, bad JSON and HTTP errors', async () => {
    const check = async (
      route: string,
      handler: Handler,
      run: (deps: MonitorDeps) => Promise<CheckOutcome>,
    ) => run(setup(healthySite({ [route]: handler })).deps);
    expect(
      await check(
        'GET /api/music/radio',
        () => Response.json({ outcome: 'unavailable', stations: [] }),
        checkCatalogRadio,
      ),
    ).toEqual(failWith('Radio Browser non risponde'));
    expect(
      await check(
        'GET /api/music/radio',
        () => Response.json({ outcome: 'no_results', stations: [] }),
        checkCatalogRadio,
      ),
    ).toEqual(failWith('Nessuna stazione trovata'));
    expect(
      await check(
        'GET /api/music/radio',
        () => new Response('{"error":"rate_limited"}', { status: 429 }),
        checkCatalogRadio,
      ),
    ).toEqual(failWith('HTTP 429'));
    expect(
      await check('GET /api/music/podcasts', () => new Response('<html>'), checkCatalogPodcasts),
    ).toEqual(failWith('Risposta non valida'));
    expect(
      await check(
        'GET /api/music/podcasts',
        () => Response.json({ outcome: 'unavailable', podcasts: [] }),
        checkCatalogPodcasts,
      ),
    ).toEqual(failWith('La directory podcast non risponde'));
    expect(
      await check(
        'GET /api/music/trending',
        () =>
          Response.json({
            outcome: 'unavailable',
            tracks: [],
            albums: [],
            sourceStatus: { active: true },
          }),
        checkCatalogAudius,
      ),
    ).toEqual(failWith('Audius non risponde'));
  });

  it('only warns when Audius is not configured on the server (as on the live site today)', async () => {
    const { deps } = setup(
      healthySite({
        'GET /api/music/trending': () =>
          Response.json({
            outcome: 'unavailable',
            tracks: [],
            albums: [],
            sourceStatus: {
              id: 'audius',
              active: false,
              searchOutcome: 'unavailable',
              unavailableReason: 'not_configured',
              blockers: ['credential_missing'],
            },
          }),
      }),
    );
    expect(await checkCatalogAudius(deps)).toEqual({
      status: 'warn',
      detail: 'Audius non è configurato sul server (manca AUDIUS_API_KEY): sezione vuota',
    });
  });
});

describe('internal status (/api/status)', () => {
  const statusBody = (body: Record<string, unknown>) => () =>
    Response.json({
      status: 'ok',
      checkedAt: '2026-11-11T10:00:00.000Z',
      stale: false,
      failing: [],
      warnings: [],
      ...body,
    });

  it('treats a 404 (route not deployed yet) as a failure of internal_status, not a crash', async () => {
    const { deps, sleeps, calls } = setup(
      healthySite({ 'GET /api/status': () => html('Not found', 404) }),
    );
    const results = await checkInternalStatus(deps);
    expect(results).toEqual([
      {
        id: 'internal_status',
        label: 'Controlli interni (/api/status)',
        critical: false,
        status: 'fail',
        detail: '/api/status non esiste (HTTP 404)',
        ms: 25,
      },
    ]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([5_000]);
  });

  it('fails internal_status on 503 or an unusable body', async () => {
    const cases: Array<[Handler, string]> = [
      [
        () =>
          Response.json(
            { status: 'unknown', checkedAt: null, stale: true, failing: [], warnings: [] },
            { status: 503 },
          ),
        'Il server non riesce a leggere lo stato (HTTP 503)',
      ],
      [() => html('<html>Vercel</html>'), 'Risposta di /api/status non valida'],
      [statusBody({ status: 'great' }), 'Risposta di /api/status non valida'],
      [statusBody({ failing: ['database; DROP'] }), 'Risposta di /api/status non valida'],
      [statusBody({ warnings: 'email' }), 'Risposta di /api/status non valida'],
      [statusBody({ stale: 'no' }), 'Risposta di /api/status non valida'],
      [statusBody({ status: 'unknown', checkedAt: null }), 'Nessun controllo interno disponibile'],
    ];
    for (const [handler, detail] of cases) {
      const { deps } = setup(healthySite({ 'GET /api/status': handler }));
      const results = await checkInternalStatus(deps);
      expect(results.map((result) => [result.id, result.status, result.detail])).toEqual([
        ['internal_status', 'fail', detail],
      ]);
    }
  });

  it('turns each failing id into internal:<id> and lists warnings without alerting', async () => {
    const { deps } = setup(
      healthySite({
        'GET /api/status': statusBody({
          status: 'down',
          failing: ['database', 'youtube_quota', 'database'],
          warnings: ['jamendo', 'youtube_quota'],
        }),
      }),
    );
    const results = await checkInternalStatus(deps);
    expect(results.map((result) => [result.id, result.status, result.critical, result.ms])).toEqual(
      [
        ['internal_status', 'ok', false, 25],
        ['internal:database', 'fail', true, null],
        ['internal:youtube_quota', 'fail', false, null],
        ['internal:jamendo', 'warn', false, null],
      ],
    );
    expect(results[0]?.detail).toBe('Solco non è utilizzabile: 2 da sistemare (11/11/2026, 11:00)');
    expect(results[1]?.label).toBe('Database (controllo interno)');
  });

  it('marks unknown ids critical only when the server says "down"', async () => {
    const down = setup(
      healthySite({ 'GET /api/status': statusBody({ status: 'down', failing: ['new_check'] }) }),
    );
    expect((await checkInternalStatus(down.deps))[1]).toMatchObject({
      id: 'internal:new_check',
      critical: true,
    });
    const degraded = setup(
      healthySite({
        'GET /api/status': statusBody({ status: 'degraded', failing: ['new_check'] }),
      }),
    );
    expect((await checkInternalStatus(degraded.deps))[1]).toMatchObject({ critical: false });
  });

  it('raises a critical failure when "down" comes without a critical id', async () => {
    const { deps } = setup(
      healthySite({ 'GET /api/status': statusBody({ status: 'down', failing: ['stripe'] }) }),
    );
    const [summary, stripe] = await checkInternalStatus(deps);
    expect(summary).toMatchObject({ id: 'internal_status', status: 'fail', critical: true });
    expect(stripe).toMatchObject({ id: 'internal:stripe', status: 'fail', critical: false });
  });

  it('waits up to 35 s for /api/status (cold start and database waking up)', async () => {
    const { deps, calls } = setup(
      healthySite({
        'GET /api/status': () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
      }),
    );
    expect(deps.timeoutMs).toBe(15_000);
    const [summary] = await checkInternalStatus(deps);
    expect(summary).toMatchObject({ status: 'fail', detail: 'Nessuna risposta entro 35 s' });
    expect(calls).toHaveLength(2);
  });

  it('only warns when the latest internal run is stale', async () => {
    const { deps } = setup(healthySite({ 'GET /api/status': statusBody({ stale: true }) }));
    const [summary] = await checkInternalStatus(deps);
    expect(summary).toMatchObject({ status: 'warn' });
    expect(summary?.detail).toContain('più di 2 ore fa');
  });

  describe('second read after a refresh', () => {
    const OLD = '2026-11-11T09:10:00.000Z'; // 55 minutes before NOW: /api/status refreshes
    const FRESH = '2026-11-11T10:05:10.000Z';

    /** Answers the given bodies in order (the last one repeats), counting the requests. */
    function sequence(...bodies: Array<Handler>): Handler {
      let index = 0;
      return (call) => {
        const handler = bodies[Math.min(index, bodies.length - 1)] as Handler;
        index += 1;
        return handler(call);
      };
    }

    it('reads again once the new run had time to finish, past the shared cache', async () => {
      const { deps, calls, sleeps } = setup(
        healthySite({
          'GET /api/status': sequence(
            statusBody({ checkedAt: OLD }),
            statusBody({ status: 'degraded', checkedAt: FRESH, failing: ['radio'] }),
          ),
        }),
      );
      const results = await checkInternalStatus(deps);
      expect(sleeps).toEqual([STATUS_REREAD_DELAY_MS]);
      expect(STATUS_REREAD_DELAY_MS).toBe(25_000);
      expect(calls.map((call) => call.url.pathname)).toEqual(['/api/status', '/api/status']);
      expect(calls[0]?.url.search).toBe('');
      expect(calls[1]?.url.searchParams.get('fresh')).toBe(String(NOW.getTime()));
      expect(calls[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(results.map((result) => [result.id, result.status, result.critical])).toEqual([
        ['internal_status', 'ok', false],
        ['internal:radio', 'fail', false],
      ]);
      expect(results[0]?.detail).toBe('Qualcosa non funziona: 1 da sistemare (11/11/2026, 11:05)');
      expect(results[0]?.ms).toBe(25);
    });

    it('also reads again when no run exists yet (the first one is starting)', async () => {
      const unknown = statusBody({ status: 'unknown', checkedAt: null });
      const { deps, sleeps } = setup(
        healthySite({
          'GET /api/status': sequence(unknown, unknown, statusBody({ checkedAt: FRESH })),
        }),
      );
      const [summary, ...rest] = await checkInternalStatus(deps);
      // "unknown" fails internal_status: the usual retry first, then the read after the refresh.
      expect(sleeps).toEqual([5_000, STATUS_REREAD_DELAY_MS]);
      expect(summary).toMatchObject({ id: 'internal_status', status: 'ok', critical: false });
      expect(rest).toEqual([]);
    });

    it('keeps the first answer when the second read fails or brings nothing newer', async () => {
      const second: Handler[] = [
        statusBody({ checkedAt: OLD, failing: ['email'] }),
        () => Response.json({ status: 'unknown' }, { status: 503 }),
        () => html('<html>Vercel</html>'),
        () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
      ];
      for (const handler of second) {
        const { deps, calls, sleeps } = setup(
          healthySite({
            'GET /api/status': sequence(
              statusBody({ checkedAt: OLD, failing: ['radio'] }),
              handler,
            ),
          }),
        );
        const results = await checkInternalStatus(deps);
        // One extra request, never a retry of it: the first answer stands.
        expect(calls).toHaveLength(2);
        expect(sleeps).toEqual([STATUS_REREAD_DELAY_MS]);
        expect(results.map((result) => [result.id, result.status])).toEqual([
          ['internal_status', 'ok'],
          ['internal:radio', 'fail'],
        ]);
        expect(results[0]?.detail).toContain('(11/11/2026, 10:10)');
      }
    });

    it('does not read again for a run younger than 50 minutes or a failed first read', async () => {
      const young = setup(
        healthySite({ 'GET /api/status': statusBody({ checkedAt: '2026-11-11T09:16:00.000Z' }) }),
      );
      await checkInternalStatus(young.deps);
      expect(young.calls).toHaveLength(1);
      expect(young.sleeps).toEqual([]);

      const broken = setup(healthySite({ 'GET /api/status': () => html('Not found', 404) }));
      await checkInternalStatus(broken.deps);
      expect(broken.calls).toHaveLength(2);
      expect(broken.sleeps).toEqual([5_000]);
    });

    it('refreshPending mirrors the 50-minute refresh of /api/status', () => {
      const body = (checkedAt: string | null): PublicStatusBody => ({
        status: 'ok',
        checkedAt,
        stale: false,
        failing: [],
        warnings: [],
      });
      expect(refreshPending(body(null), NOW)).toBe(true);
      expect(refreshPending(body('2026-11-11T09:14:59.000Z'), NOW)).toBe(true);
      expect(refreshPending(body('2026-11-11T09:15:00.000Z'), NOW)).toBe(false);
      expect(refreshPending(body('2026-11-11T10:04:00.000Z'), NOW)).toBe(false);
    });
  });

  it('parsePublicStatus accepts exactly the public contract shape', () => {
    expect(
      parsePublicStatus({
        status: 'degraded',
        checkedAt: '2026-11-11T10:00:00.000Z',
        stale: false,
        failing: ['radio'],
        warnings: [],
      }),
    ).toEqual({
      status: 'degraded',
      checkedAt: '2026-11-11T10:00:00.000Z',
      stale: false,
      failing: ['radio'],
      warnings: [],
    });
    expect(parsePublicStatus(null)).toBeNull();
    expect(parsePublicStatus([])).toBeNull();
    expect(
      parsePublicStatus({
        status: 'ok',
        checkedAt: 'ieri',
        stale: false,
        failing: [],
        warnings: [],
      }),
    ).toBeNull();
  });
});

describe('response_time', () => {
  const home = (status: CheckResult['status'], ms: number | null): CheckResult => ({
    id: 'page:/',
    label: 'Pagina Home (/)',
    critical: true,
    status,
    detail: '',
    ms,
  });

  it('only ever warns', () => {
    expect(responseTimeResult(home('ok', 1234))).toMatchObject({
      id: 'response_time',
      status: 'ok',
      detail: 'Home caricata in 1,2 s',
      ms: 1234,
      critical: false,
    });
    expect(responseTimeResult(home('ok', 4000)).status).toBe('ok');
    expect(responseTimeResult(home('ok', 4500))).toMatchObject({
      status: 'warn',
      detail: 'Home lenta: 4,5 s (soglia 4 s)',
    });
    expect(responseTimeResult(home('fail', 20000))).toMatchObject({
      status: 'warn',
      detail: 'Non misurata: la home non risponde',
      ms: null,
    });
    expect(responseTimeResult(undefined).status).toBe('warn');
  });
});

describe('runAllChecks', () => {
  it('runs every check against a healthy site, in display order, at most 4 requests at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const calls: Call[] = [];
    const inner = fakeFetch(healthySite(), calls);
    const { deps } = setup(healthySite(), {
      fetch: async (input, init) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((done) => setTimeout(done, 1));
        try {
          return await inner(input, init);
        } finally {
          inFlight -= 1;
        }
      },
    });
    const results = await runAllChecks(deps);
    expect(results.filter((result) => result.status !== 'ok')).toEqual([]);
    expect(results.map((result) => result.id)).toEqual([
      'site_health',
      ...PUBLIC_PAGES.map((page) => `page:${page.path}`),
      'security_headers',
      'response_time',
      'seo_files',
      'google_signin',
      'signup_route',
      'catalog_radio',
      'catalog_podcasts',
      'catalog_audius',
      'internal_status',
    ]);
    expect(results.filter((result) => result.critical).map((result) => result.id)).toEqual([
      'site_health',
      'page:/',
      'google_signin',
      'signup_route',
    ]);
    expect(peak).toBeLessThanOrEqual(4);
    for (const call of calls) {
      expect(call.headers.get('user-agent')).toBe(USER_AGENT);
      expect(call.redirect).toBe('manual');
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    // Never the unused social endpoint, never a real sign-up.
    expect(calls.some((call) => call.url.pathname.includes('/sign-in/social'))).toBe(false);
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual(
      expect.arrayContaining(['{}']),
    );
  });

  it('keeps going when the network is down everywhere', async () => {
    const { deps } = setup(healthySite(), {
      fetch: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
    });
    const results = await runAllChecks(deps);
    expect(results.find((result) => result.id === 'site_health')).toMatchObject({
      status: 'fail',
      detail: 'Errore di rete (ECONNREFUSED)',
    });
    expect(results.find((result) => result.id === 'response_time')?.status).toBe('warn');
    expect(results.find((result) => result.id === 'internal_status')?.status).toBe('fail');
  });
});

describe('mapLimit', () => {
  it('keeps the input order', async () => {
    const output = await mapLimit([30, 10, 20, 0], 2, async (wait) => {
      await new Promise((done) => setTimeout(done, wait));
      return wait * 2;
    });
    expect(output).toEqual([60, 20, 40, 0]);
    expect(await mapLimit([], 4, async (value: number) => value)).toEqual([]);
  });
});

describe('main', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'solco-monitor-main-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(handlers: Record<string, Handler>, extraEnv: Record<string, string> = {}) {
    const calls: Call[] = [];
    const code = await main(
      {
        BASE_URL: `${BASE}/`,
        STATE_FILE: join(dir, 'state.json'),
        GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
        ...extraEnv,
      },
      { fetch: fakeFetch(handlers, calls), sleep: async () => {}, now: () => NOW },
    );
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    return { code, state };
  }

  it('exits 0 and writes an empty state when everything works', async () => {
    const { code, state } = await run(healthySite());
    expect(code).toBe(0);
    expect(state).toEqual({ version: 1, checks: {} });
    const summary = await readFile(join(dir, 'summary.md'), 'utf8');
    expect(summary).toContain('**✅ Tutto funziona**');
    expect(summary).toContain('Nessuno stato precedente: questo è il primo controllo.');
  });

  it('exits 1 only on the run that sends an alert (non-critical: second run), then 0 until recovery', async () => {
    const broken = healthySite({ 'GET /api/status': () => html('Not found', 404) });
    const first = await run(broken);
    expect(first.code).toBe(0);
    expect(first.state.checks.internal_status).toMatchObject({ consecutive: 1, lastAlertAt: null });

    const second = await run(broken, { GITHUB_ACTIONS: 'true' });
    expect(second.code).toBe(1);
    expect(second.state.checks.internal_status).toMatchObject({ consecutive: 2 });
    expect(process.stdout.write).toHaveBeenCalledWith(
      '::error title=Solco%3A Controlli interni (/api/status)::/api/status non esiste (HTTP 404)\n',
    );

    const third = await run(broken);
    expect(third.code).toBe(0);

    const healed = await run(healthySite());
    expect(healed.code).toBe(0);
    expect(healed.state.checks).toEqual({});
    const summary = await readFile(join(dir, 'summary.md'), 'utf8');
    expect(summary.match(/## Monitoraggio Solco/g)).toHaveLength(4);
    expect(summary).toMatch(
      /### Tornati a funzionare\n\n- ✅ \*\*Controlli interni \(\/api\/status\)\*\*/,
    );
  });

  it('exits 1 on the first run when a critical check fails', async () => {
    const { code, state } = await run(
      healthySite({ 'GET /health': () => new Response('down', { status: 502 }) }),
    );
    expect(code).toBe(1);
    expect(Object.keys(state.checks)).toEqual(['site_health']);
  });

  it('rejects a BASE_URL that is not http(s) (the CLI turns it into exit 2)', async () => {
    await expect(
      main({ BASE_URL: 'ftp://solco.test', STATE_FILE: join(dir, 's.json') }),
    ).rejects.toThrow('BASE_URL deve essere un indirizzo http(s)');
  });
});
