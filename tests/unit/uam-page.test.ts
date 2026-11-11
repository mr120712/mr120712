import { webcrypto } from 'node:crypto';
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { hasLeadingZeroBits, verifySolution } from '@/lib/security/uam';
import {
  renderUamPage,
  serializeUamData,
  UAM_TRIES_KEY,
  UAM_VERIFY_PATH,
  UAM_VERIFY_TIMEOUT_MS,
  uamPageCsp,
} from '@/lib/security/uam-page';

const NONCE = 'q83vEjRWeJq83vEjRWeJqw==';
const CHALLENGE = `c1.1762850000.8.${'A'.repeat(22)}.${'B'.repeat(43)}`;

function render(overrides: Partial<Parameters<typeof renderUamPage>[0]> = {}) {
  return renderUamPage({
    nonce: NONCE,
    challenge: CHALLENGE,
    difficulty: 8,
    mode: 'first-visit',
    ...overrides,
  });
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while ((byte & mask) === 0) {
      bits++;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(
    await webcrypto.subtle.digest('SHA-256', new NodeTextEncoder().encode(text)),
  );
}

describe('uamPageCsp', () => {
  it('is the exact strict policy for the interstitial', () => {
    expect(uamPageCsp('abc123')).toBe(
      "default-src 'none'; script-src 'nonce-abc123'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it('rejects a nonce that could inject directives or markup', () => {
    expect(() => uamPageCsp("abc'; script-src *")).toThrow(TypeError);
    expect(() => uamPageCsp('')).toThrow(TypeError);
    expect(() => render({ nonce: 'abcdefgh" onload="x' })).toThrow(TypeError);
  });
});

describe('renderUamPage — document', () => {
  it('is a standalone HTML5 document in Italian, noindex, branded', () => {
    const html = render();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    const doc = parse(html);
    expect(doc.documentElement.getAttribute('lang')).toBe('it');
    expect(doc.title).toBe('Solco');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex,nofollow',
    );
    expect(doc.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain(
      'width=device-width',
    );
    expect(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000000');
    expect(doc.querySelector('meta[charset]')).not.toBeNull();
    expect(doc.querySelector('h1')?.textContent).toBe('Stiamo preparando Solco…');
    expect(doc.querySelector('.wordmark')?.textContent).toBe('Solco');
    expect(doc.querySelectorAll('.eq span')).toHaveLength(5);
    expect(doc.querySelector('main noscript')?.textContent).toContain(
      'Per entrare in Solco serve JavaScript.',
    );
  });

  it('loads nothing external: inline style only, no src/stylesheet, data: favicon', () => {
    const html = render();
    const doc = parse(html);
    expect(doc.querySelectorAll('style').length).toBeGreaterThan(0);
    expect(doc.querySelectorAll('[src]')).toHaveLength(0);
    expect(doc.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0);
    for (const link of doc.querySelectorAll('link')) {
      expect(link.getAttribute('href')?.startsWith('data:')).toBe(true);
    }
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import|url\(/);
  });

  it('has exactly one nonce-d executable script and one JSON data block', () => {
    const doc = parse(render());
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts).toHaveLength(2);
    const data = doc.getElementById('uam-data');
    expect(data?.getAttribute('type')).toBe('application/json');
    const executable = scripts.filter((s) => {
      const type = s.getAttribute('type');
      return !type || type === 'text/javascript' || type === 'module';
    });
    expect(executable).toHaveLength(1);
    expect(executable[0]?.getAttribute('nonce')).toBe(NONCE);
    expect(executable[0]?.textContent?.length).toBeGreaterThan(100);
    expect(JSON.parse(data?.textContent ?? '')).toEqual({
      challenge: CHALLENGE,
      difficulty: 8,
      mode: 'first-visit',
    });
  });

  it('cannot be broken out of by a hostile challenge', () => {
    const evil = '</script><script>alert(1)</script><!--&\u2028';
    const html = render({ challenge: evil });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).not.toContain('<!--&');
    const doc = parse(html);
    expect(doc.querySelectorAll('script')).toHaveLength(2);
    const data = JSON.parse(doc.getElementById('uam-data')?.textContent ?? '');
    expect(data.challenge).toBe(evil);
  });

  it('serializeUamData escapes <, >, & and line separators but round-trips', () => {
    const value = { a: '<b>&</b>\u2028\u2029' };
    const out = serializeUamData(value);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual(value);
  });

  it('normalises mode and clamps difficulty in the data block', () => {
    const read = (html: string) =>
      JSON.parse(parse(html).getElementById('uam-data')?.textContent ?? '');
    expect(read(render({ difficulty: 99 })).difficulty).toBe(32);
    expect(read(render({ difficulty: 0 })).difficulty).toBe(1);
    expect(read(render({ difficulty: 14.7 })).difficulty).toBe(14);
    expect(read(render({ mode: 'nope' as never })).mode).toBe('first-visit');
  });

  it('uses different copy in attack mode', () => {
    const firstVisit = parse(render());
    const attack = parse(render({ mode: 'attack', difficulty: 18 }));
    expect(firstVisit.querySelector('.small')?.textContent).toBe(
      'Controllo di sicurezza al primo ingresso da questa rete: ci vuole un attimo.',
    );
    expect(attack.querySelector('.small')?.textContent).toBe(
      'Tanto traffico in questo momento: verifichiamo che tu sia una persona.',
    );
    expect(firstVisit.querySelector('.eyebrow')).toBeNull();
    expect(attack.querySelector('.eyebrow')?.textContent).toBe('Traffico elevato');
    expect(attack.documentElement.dataset.mode).toBe('attack');
  });

  it('is accessible: live status, labelled progressbar, decorative visuals hidden', () => {
    const doc = parse(render());
    const status = doc.getElementById('uam-status');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    const bar = doc.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('0');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('100');
    expect(bar?.getAttribute('aria-label')).toBeTruthy();
    expect(doc.querySelector('.eq')?.getAttribute('aria-hidden')).toBe('true');
    expect(doc.querySelector('.groove')?.getAttribute('aria-hidden')).toBe('true');
    expect(doc.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(doc.querySelector('main')).not.toBeNull();
  });

  it('stops every animation under prefers-reduced-motion', () => {
    const css = parse(render()).querySelector('style')?.textContent ?? '';
    expect(css).toContain('@keyframes eq');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced.length).toBeGreaterThan(40);
    expect(reduced).toMatch(/\.eq span \{ animation: none;/);
    expect(reduced).toMatch(/\.groove::after \{ animation: none;/);
    expect(reduced).toMatch(/\.fill \{ transition: none;/);
  });
});

// ---------------------------------------------------------------------------
// The inline solver, executed for real against the rendered DOM with stubs.
// ---------------------------------------------------------------------------

type FakeResponse = { status: number; body?: unknown } | 'reject' | 'hang';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

function runSolver(
  html: string,
  options: {
    response?: FakeResponse;
    storage?: unknown;
    crypto?: unknown;
    navigator?: unknown;
    /** Pass `null` to run as a browser without AbortController. */
    abortController?: typeof AbortController | null;
  } = {},
) {
  const doc = parse(html);
  const script = doc.querySelector('script[nonce]')?.textContent ?? '';
  const response = options.response ?? { status: 200, body: { ok: true } };
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    if (response === 'reject') return Promise.reject(new TypeError('network down'));
    if (response === 'hang') {
      // Never answers; only an abort on the request's signal settles it.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    }
    return Promise.resolve({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    });
  });
  const location = { reload: vi.fn() };
  const storage = options.storage === undefined ? memoryStorage() : options.storage;
  // Real timers, except the verify timeout, which fires after 10 ms.
  const timerDelays: number[] = [];
  const fastTimeout = (callback: () => void, ms?: number) => {
    timerDelays.push(ms ?? 0);
    return setTimeout(callback, ms === UAM_VERIFY_TIMEOUT_MS ? 10 : ms);
  };
  const startedAt = Date.now();
  // The solver only reads bare globals; shadow them with stubs.
  const run = new Function(
    'document',
    'crypto',
    'fetch',
    'location',
    'sessionStorage',
    'navigator',
    'TextEncoder',
    'setTimeout',
    'AbortController',
    script,
  );
  run(
    doc,
    options.crypto === undefined ? webcrypto : options.crypto,
    fetchMock,
    location,
    storage,
    options.navigator ?? { cookieEnabled: true },
    NodeTextEncoder,
    fastTimeout,
    options.abortController === undefined ? AbortController : options.abortController,
  );
  return { doc, fetchMock, location, storage, startedAt, timerDelays };
}

const MSG_SLOW = 'Il controllo sta richiedendo troppo tempo su questo dispositivo o rete. Riprova.';

const statusText = (doc: Document) => doc.getElementById('uam-status')?.textContent;

describe('inline solver', () => {
  it('finds a valid proof of work at difficulty 8, posts it and reloads', async () => {
    const { doc, fetchMock, location, storage, startedAt } = runSolver(render());
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(590);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(UAM_VERIFY_PATH);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(['challenge', 'solution']);
    expect(body.challenge).toBe(CHALLENGE);
    expect(body.solution).toMatch(/^\d{1,12}$/);
    expect(leadingZeroBits(await sha256(`${CHALLENGE}:${body.solution}`))).toBeGreaterThanOrEqual(
      8,
    );

    expect(statusText(doc)).toBe('Fatto! Entriamo…');
    expect(doc.getElementById('uam-progress')?.getAttribute('aria-valuenow')).toBe('100');
    expect(doc.documentElement.dataset.state).toBe('done');
    const tries = JSON.parse(
      (storage as ReturnType<typeof memoryStorage>).getItem(UAM_TRIES_KEY) ?? '',
    );
    expect(tries.n).toBe(1);
  });

  it('returns the smallest solution for the challenge it was given', async () => {
    const challenge = `c1.1762850001.8.${'C'.repeat(22)}.${'D'.repeat(43)}`;
    const { fetchMock, location } = runSolver(render({ challenge }));
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalled(), { timeout: 5000 });
    const solution = Number(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body)).solution);
    for (let n = 0; n < solution; n++) {
      expect(leadingZeroBits(await sha256(`${challenge}:${n}`))).toBeLessThan(8);
    }
  });

  it('agrees with the server at a non-byte-aligned difficulty (11 bits)', async () => {
    const challenge = `c1.1762850002.11.${'E'.repeat(22)}.${'F'.repeat(43)}`;
    const { fetchMock, location } = runSolver(render({ challenge, difficulty: 11 }));
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1].body));
    expect(body.challenge).toBe(challenge);
    // Checked by the server's own math (src/lib/security/uam.ts), not the test's.
    expect(await verifySolution(challenge, body.solution, 11)).toBe(true);
    const solution = Number(body.solution);
    for (let n = 0; n < solution; n++) {
      expect(hasLeadingZeroBits(await sha256(`${challenge}:${n}`), 11)).toBe(false);
    }
  }, 20_000);

  it('stops after 3 reloads within 2 minutes and offers "Riprova"', async () => {
    const storage = memoryStorage({
      [UAM_TRIES_KEY]: JSON.stringify({ n: 3, t: Date.now() - 30_000 }),
    });
    const { doc, fetchMock, location } = runSolver(render(), { storage });
    await vi.waitFor(() => expect(doc.documentElement.dataset.state).toBe('error'));
    expect(statusText(doc)).toBe(
      'Non riusciamo a completare il controllo. Attiva i cookie e riprova.',
    );
    expect(doc.documentElement.dataset.retry).toBe('on');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();

    (doc.getElementById('uam-retry') as HTMLButtonElement).click();
    expect(storage.getItem(UAM_TRIES_KEY)).toBeNull();
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('counts tries again from 1 once the 2-minute window has passed', async () => {
    const storage = memoryStorage({
      [UAM_TRIES_KEY]: JSON.stringify({ n: 9, t: Date.now() - 121_000 }),
    });
    const { fetchMock, location } = runSolver(render(), { storage });
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalled(), { timeout: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem(UAM_TRIES_KEY) ?? '').n).toBe(1);
  });

  it('still solves when sessionStorage throws', async () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const { fetchMock, location } = runSolver(render(), { storage: broken });
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalled(), { timeout: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks to enable cookies when the browser reports them disabled', async () => {
    const { doc, fetchMock } = runSolver(render(), { navigator: { cookieEnabled: false } });
    await vi.waitFor(() => expect(doc.documentElement.dataset.state).toBe('error'));
    expect(statusText(doc)).toContain('Attiva i cookie');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks to update the browser without crypto.subtle', async () => {
    const { doc, fetchMock, location } = runSolver(render(), { crypto: {} });
    await vi.waitFor(() => expect(doc.documentElement.dataset.state).toBe('error'));
    expect(statusText(doc)).toBe('Aggiorna il browser per entrare in Solco.');
    expect(doc.getElementById('uam-title')?.textContent).toBe('Browser non supportato');
    expect(doc.documentElement.dataset.retry).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();
  });

  it.each(['expired', 'invalid'])('reloads for a fresh challenge on 400 %s', async (error) => {
    const { doc, location, storage } = runSolver(render(), {
      response: { status: 400, body: { error } },
    });
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(doc.documentElement.dataset.state).not.toBe('error');
    const tries = JSON.parse(
      (storage as ReturnType<typeof memoryStorage>).getItem(UAM_TRIES_KEY) ?? '',
    );
    expect(tries).toMatchObject({ n: 1, x: 1 });
  });

  it('stops a slow solve-then-expired loop even when each cycle outlasts 2 minutes', async () => {
    // Two stale challenges in the last 10 minutes, the views far apart.
    const storage = memoryStorage({
      [UAM_TRIES_KEY]: JSON.stringify({
        n: 1,
        t: Date.now() - 300_000,
        x: 2,
        xt: Date.now() - 170_000,
      }),
    });
    const { doc, fetchMock, location } = runSolver(render(), { storage });
    await vi.waitFor(() => expect(doc.documentElement.dataset.state).toBe('error'));
    expect(statusText(doc)).toBe(MSG_SLOW);
    expect(statusText(doc)).not.toContain('cookie');
    expect(doc.documentElement.dataset.retry).toBe('on');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();

    (doc.getElementById('uam-retry') as HTMLButtonElement).click();
    expect(storage.getItem(UAM_TRIES_KEY)).toBeNull();
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('forgets stale challenges after 10 minutes and after a successful check', async () => {
    const old = memoryStorage({
      [UAM_TRIES_KEY]: JSON.stringify({
        n: 1,
        t: Date.now() - 700_000,
        x: 5,
        xt: Date.now() - 601_000,
      }),
    });
    const first = runSolver(render(), { storage: old });
    await vi.waitFor(() => expect(first.location.reload).toHaveBeenCalled(), { timeout: 5000 });
    expect(first.fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(old.getItem(UAM_TRIES_KEY) ?? '')).toEqual({ n: 1, t: expect.any(Number) });

    const recent = memoryStorage({
      [UAM_TRIES_KEY]: JSON.stringify({
        n: 1,
        t: Date.now() - 20_000,
        x: 1,
        xt: Date.now() - 20_000,
      }),
    });
    const second = runSolver(render(), { storage: recent });
    await vi.waitFor(() => expect(second.location.reload).toHaveBeenCalled(), { timeout: 5000 });
    expect(JSON.parse(recent.getItem(UAM_TRIES_KEY) ?? '')).toEqual({
      n: 2,
      t: expect.any(Number),
    });
  });

  it.each([
    ['with AbortController', undefined],
    ['without AbortController', null],
  ] as const)('gives up on a verify request that never answers (%s)', async (_label, ctrl) => {
    const { doc, fetchMock, location, timerDelays } = runSolver(render(), {
      response: 'hang',
      abortController: ctrl,
    });
    await vi.waitFor(() => expect(doc.documentElement.dataset.state).toBe('error'), {
      timeout: 5000,
    });
    expect(timerDelays).toContain(UAM_VERIFY_TIMEOUT_MS);
    expect(UAM_VERIFY_TIMEOUT_MS).toBe(20_000);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    if (ctrl === null) {
      expect(init.signal).toBeUndefined();
    } else {
      expect(init.signal?.aborted).toBe(true);
    }
    expect(statusText(doc)).toBe('Qualcosa non ha funzionato. Riprova tra un attimo.');
    expect(doc.getElementById('uam-title')?.textContent).toBe('Controllo non completato');
    expect(doc.documentElement.dataset.retry).toBe('on');
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('reloads when the gate was switched off meanwhile (503 disabled)', async () => {
    const { location } = runSolver(render(), {
      response: { status: 503, body: { error: 'disabled' } },
    });
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it.each<[string, FakeResponse]>([
    ['wrong solution', { status: 400, body: { error: 'wrong_solution' } }],
    ['cross-origin refusal', { status: 403, body: { error: 'forbidden' } }],
    ['server error', { status: 500 }],
    ['network failure', 'reject'],
  ])('shows an error with "Riprova" on %s', async (_label, response) => {
    const { doc, location } = runSolver(render(), { response });
    await vi.waitFor(() => expect(doc.documentElement.dataset.state).toBe('error'), {
      timeout: 5000,
    });
    expect(statusText(doc)).toBe('Qualcosa non ha funzionato. Riprova tra un attimo.');
    expect(doc.getElementById('uam-title')?.textContent).toBe('Controllo non completato');
    expect(doc.documentElement.dataset.retry).toBe('on');
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('rejects a tampered data block instead of hashing garbage', async () => {
    const html = render().replace(/("difficulty":)8/, '$1"8"');
    const { doc, fetchMock } = runSolver(html);
    await vi.waitFor(() => expect(doc.documentElement.dataset.state).toBe('error'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
