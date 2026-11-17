// @polsia:user-owned
// @vitest-environment node
//
// «Skynet»: con il cancello anti-bot acceso (UAM_MODE=first-visit) il monitor orario
// (scripts/monitor/check-site.ts) supera la schermata come un browser: legge la sfida dalla pagina
// vera (renderUamPage), risolve la prova di lavoro e chiede il via libera a /api/uam/verify. La
// soluzione è controllata con verifySolution del server, non con una copia: se il protocollo
// cambia da una parte sola, questi test se ne accorgono.
import { describe, expect, it } from 'vitest';
import { verifySolution } from '@/lib/security/uam';
import { renderUamPage } from '@/lib/security/uam-page';
import {
  checkGoogleSignIn,
  checkPage,
  checkSecurityHeaders,
  createDeps,
  extractUamChallenge,
  solveUamChallenge,
  type TlsProbeResult,
  USER_AGENT,
} from '../../scripts/monitor/check-site';

const BASE = 'https://solco.test';
const NOW = new Date('2026-11-17T10:05:00.000Z');
const CHALLENGE = 'v1.1794912300000.c2ZmZmZmZmZm.sig-di-prova';
const DIFFICULTY = 12;
const CLEARANCE = 'via-libera-di-prova';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

type Call = { method: string; url: URL; headers: Headers; body: string | null };

function uamPage(): Response {
  const html = renderUamPage({
    nonce: 'bm9uY2UtZGktcHJvdmEhIQ==',
    challenge: CHALLENGE,
    difficulty: DIFFICULTY,
    mode: 'first-visit',
  });
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-solco-gate': 'challenge' },
  });
}

function realPage(): Response {
  return new Response('<html><body><main>Solco</main></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS },
  });
}

/** Il sito con il cancello acceso: senza il cookie giusto ogni pagina è la schermata anti-bot. */
function gatedSite(verify: (call: Call) => Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
    };
    calls.push(call);
    if (url.origin !== BASE) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://accounts.google.com/v3/signin/identifier?client_id=123' },
      });
    }
    if (call.method === 'POST' && url.pathname === '/api/uam/verify') return verify(call);
    if (call.method === 'POST' && url.pathname === '/api/auth/sign-in/oauth2') {
      const target = new URL(GOOGLE_AUTH);
      target.searchParams.set('response_type', 'code');
      target.searchParams.set('client_id', '123.apps.googleusercontent.com');
      target.searchParams.set('state', 'abc');
      target.searchParams.set('scope', 'openid email profile');
      target.searchParams.set('redirect_uri', `${BASE}/api/auth/oauth2/callback/google`);
      return Response.json({ url: target.href, redirect: true });
    }
    const cleared = (call.headers.get('cookie') ?? '').includes(`solco_uam=${CLEARANCE}`);
    return cleared ? realPage() : uamPage();
  };
  const deps = createDeps(BASE, {
    fetch: fetchFn,
    sleep: async () => {},
    clock: () => 0,
    now: () => NOW,
    tlsProbe: async (): Promise<TlsProbeResult> => ({ ok: false, code: 'ECONNREFUSED' }),
    resolveCaa: async () => [],
  });
  return { deps, calls };
}

/** /api/uam/verify come il server: stessa origine e soluzione valida, altrimenti rifiuto. */
async function honestVerify(call: Call): Promise<Response> {
  const body = JSON.parse(call.body ?? '{}') as { challenge?: string; solution?: string };
  if (call.headers.get('origin') !== BASE)
    return Response.json({ error: 'forbidden_origin' }, { status: 403 });
  if (
    body.challenge !== CHALLENGE ||
    !(await verifySolution(CHALLENGE, String(body.solution), DIFFICULTY))
  ) {
    return Response.json({ error: 'invalid' }, { status: 400 });
  }
  return Response.json(
    { ok: true },
    {
      headers: {
        'set-cookie': `solco_uam=${CLEARANCE}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
      },
    },
  );
}

describe('monitor e cancello anti-bot (UAM)', () => {
  it('legge sfida e difficoltà dalla schermata vera del sito', async () => {
    expect(extractUamChallenge(await uamPage().text())).toEqual({
      challenge: CHALLENGE,
      difficulty: DIFFICULTY,
    });
    expect(extractUamChallenge('<html><body>Verifica in corso…</body></html>')).toBeNull();
    expect(
      extractUamChallenge('<script type="application/json" id="uam-data">{"challenge":1}</script>'),
    ).toBeNull();
  });

  it('la prova di lavoro del monitor è accettata dal verificatore del server', async () => {
    const solution = solveUamChallenge(CHALLENGE, DIFFICULTY);
    expect(solution).toMatch(/^\d{1,12}$/);
    expect(await verifySolution(CHALLENGE, solution ?? '', DIFFICULTY)).toBe(true);
    expect(solveUamChallenge(CHALLENGE, 32, 50)).toBeNull();
  });

  it('supera il cancello e verifica la pagina vera (sfida, via libera, nuova richiesta)', async () => {
    const { deps, calls } = gatedSite(honestVerify);
    expect(await checkPage(deps, '/radio')).toEqual({ status: 'ok', detail: 'Pagina caricata' });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /radio',
      'POST /api/uam/verify',
      'GET /radio',
    ]);
    const verify = calls[1];
    expect(verify?.headers.get('origin')).toBe(BASE);
    expect(verify?.headers.get('user-agent')).toBe(USER_AGENT);
    expect(calls[2]?.headers.get('cookie')).toBe(`solco_uam=${CLEARANCE}`);
    // Il via libera vale per il resto del giro: le intestazioni di sicurezza della home si leggono.
    expect((await checkSecurityHeaders(deps)).status).toBe('ok');
    expect(calls.filter((c) => c.url.pathname === '/api/uam/verify')).toHaveLength(1);
  });

  it('pagine controllate in parallelo: un solo via libera per giro', async () => {
    const { deps, calls } = gatedSite(honestVerify);
    const outcomes = await Promise.all(
      ['/radio', '/podcasts', '/generi'].map((p) => checkPage(deps, p)),
    );
    expect(outcomes.map((o) => o.status)).toEqual(['ok', 'ok', 'ok']);
    expect(calls.filter((c) => c.url.pathname === '/api/uam/verify')).toHaveLength(1);
  });

  it('via libera rifiutato: resta un avviso, senza ritentare a ogni pagina', async () => {
    const { deps, calls } = gatedSite(async () =>
      Response.json({ error: 'invalid' }, { status: 400 }),
    );
    const warn = {
      status: 'warn',
      detail: 'Schermata anti-bot (UAM) attiva: pagina non verificata',
    };
    expect(await checkPage(deps, '/radio')).toEqual(warn);
    expect(await checkPage(deps, '/podcasts')).toEqual(warn);
    expect(calls.filter((c) => c.url.pathname === '/api/uam/verify')).toHaveLength(1);
  });

  it('il cookie del via libera non esce mai verso altri domini (Google)', async () => {
    const { deps, calls } = gatedSite(honestVerify);
    await checkPage(deps, '/radio');
    await checkGoogleSignIn(deps);
    const google = calls.filter((c) => c.url.origin !== BASE);
    expect(google.length).toBeGreaterThan(0);
    for (const call of google) expect(call.headers.get('cookie')).toBeNull();
    const own = calls.filter((c) => c.url.origin === BASE && c.method === 'POST');
    expect(own.some((c) => c.url.pathname === '/api/auth/sign-in/oauth2')).toBe(true);
  });
});
