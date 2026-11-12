// @polsia:user-owned — controllo quotidiano nel browser (scripts/monitor/browser-check.ts):
// elenco delle pagine, valutazione di ciò che il browser osserva, riepilogo e un giro completo
// con un Playwright finto (nessuna rete, nessun browser vero).
// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BrowserDeps,
  BUDGET_EXHAUSTED_MESSAGE,
  CSP_EVAL_WARNING,
  CSP_INIT_SCRIPT,
  checkVisit,
  describeNavigationError,
  describePageError,
  evaluateVisit,
  limitList,
  MAX_CONSOLE_WARNINGS,
  MIN_TEXT_LENGTH,
  MONITOR_UA_SUFFIX,
  main,
  mergeAttempts,
  normalizeBaseUrl,
  PAGE_PROBE_SCRIPT,
  type PageProbe,
  PUBLIC_PAGES,
  type PwBrowser,
  type PwChromium,
  type PwConsoleMessage,
  type PwContextOptions,
  type PwPage,
  pageErrorOwner,
  plannedVisits,
  renderAnnotations,
  runVisits,
  sanitize,
  screenshotPath,
  slug,
  summarizeBrowserResults,
  urlOwner,
  userAgentFor,
  type VisitObservation,
  type VisitResult,
  type VisitVerdict,
  withTimeout,
} from '../../scripts/monitor/browser-check';
import { PUBLIC_PAGES as SITE_CHECK_PAGES } from '../../scripts/monitor/check-site';

const BASE = 'https://solcomusic.vercel.app';

const PROBE_OK: PageProbe = {
  hasVisibleMain: true,
  textLength: 1500,
  errorScreen: null,
  scrollWidth: 1280,
  viewportWidth: 1280,
  overflowing: [],
};

function observation(overrides: Partial<VisitObservation> = {}): VisitObservation {
  return {
    pageUrl: `${BASE}/`,
    httpStatus: 200,
    navigationError: null,
    pageErrors: [],
    console: [],
    csp: [],
    probe: PROBE_OK,
    probeTimedOut: false,
    ...overrides,
  };
}

function result(overrides: Partial<VisitResult> = {}): VisitResult {
  return {
    path: '/',
    label: 'Home',
    viewport: 'desktop',
    status: 'ok',
    failures: [],
    warnings: [],
    ignoredHosts: [],
    ignoredCount: 0,
    ms: 3200,
    attempts: 1,
    screenshot: null,
    timedOut: false,
    ...overrides,
  };
}

const OWN_STACK =
  'Error: boom\n    at a (https://solcomusic.vercel.app/_next/static/chunks/app.js:1:200)\n' +
  '    at b (https://solcomusic.vercel.app/_next/static/chunks/main.js:3:10)';
const EXTERNAL_STACK =
  'TypeError: x is undefined\n    at w (https://www.tiktok.com/embed/v2/player.js:1:99)';

describe('pages', () => {
  it('match the page list of check-site.ts', () => {
    expect(PUBLIC_PAGES.map((page) => page.path)).toEqual(
      SITE_CHECK_PAGES.map((page) => page.path),
    );
  });

  it('visit every page on desktop and the home also on a phone, right after', () => {
    const visits = plannedVisits();
    expect(visits).toHaveLength(PUBLIC_PAGES.length + 1);
    expect(visits.slice(0, 2)).toEqual([
      { path: '/', label: 'Home', viewport: 'desktop' },
      { path: '/', label: 'Home', viewport: 'mobile' },
    ]);
    expect(visits.filter((visit) => visit.viewport === 'mobile')).toHaveLength(1);
  });

  it('turn paths into safe screenshot names', () => {
    expect(slug('/')).toBe('home');
    expect(slug('/generi/techno')).toBe('generi-techno');
    expect(slug('/Piani?x=1#top')).toBe('piani');
    expect(slug('/../../etc/passwd')).toBe('etc-passwd');
    expect(slug('/a'.repeat(100))).toHaveLength(80);
    expect(screenshotPath({ path: '/', viewport: 'mobile' })).toBe(
      'monitor-screenshots/home-mobile.png',
    );
  });
});

describe('helpers', () => {
  it('strip query strings and fragments from every URL (public logs)', () => {
    expect(sanitize('GET https://cdn.example.com/a.mp3?token=SECRET&sig=1#t failed.')).toBe(
      'GET https://cdn.example.com/a.mp3 failed.',
    );
    expect(sanitize('wss://live.example.com/socket?key=abc')).toBe('wss://live.example.com/socket');
    expect(sanitize('a\n\n  b')).toBe('a b');
    expect(sanitize('x'.repeat(500), 20)).toHaveLength(20);
  });

  it('tell Solco URLs from other sites', () => {
    expect(urlOwner(`${BASE}/favicon.ico`, BASE)).toBe('own');
    expect(urlOwner('https://i.ytimg.com/vi/x.jpg', BASE)).toBe('external');
    expect(urlOwner('', BASE)).toBeNull();
    expect(urlOwner('chrome-extension://abc/x.js', BASE)).toBeNull();
  });

  it('cap lists with a "… e altri N" line after de-duplicating', () => {
    expect(limitList(['a', 'a', 'b'], 5)).toEqual(['a', 'b']);
    expect(limitList(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b', '… e altri 2']);
  });

  it('build a normal Chrome user agent signed by the monitor', () => {
    const desktop = userAgentFor('desktop', '153.0.8010.12');
    const mobile = userAgentFor('mobile', '153.0.8010.12');
    expect(desktop).toContain('Chrome/153.0.0.0 Safari');
    expect(desktop).not.toContain('Mobile');
    expect(mobile).toContain('Android');
    expect(mobile).toContain('Mobile Safari');
    expect(desktop.endsWith(MONITOR_UA_SUFFIX)).toBe(true);
    expect(mobile.endsWith(MONITOR_UA_SUFFIX)).toBe(true);
  });

  it('accept only http(s) base URLs and keep the origin', () => {
    expect(normalizeBaseUrl(undefined)).toBe(BASE);
    expect(normalizeBaseUrl(' https://example.com/x/ ')).toBe('https://example.com');
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrow();
  });

  it('describe navigation errors without echoing Playwright messages', () => {
    expect(describeNavigationError('page.goto: Timeout 30000ms exceeded.')).toContain('30 s');
    expect(describeNavigationError('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x')).toBe(
      'La pagina non si è caricata (errore di rete ERR_NAME_NOT_RESOLVED)',
    );
    expect(describeNavigationError('something odd at /home/runner')).toBe(
      'La pagina non si è caricata (errore di navigazione)',
    );
  });

  it('attribute page errors by their stack frames only', () => {
    expect(pageErrorOwner({ message: 'boom', stack: OWN_STACK }, BASE)).toBe('own');
    expect(pageErrorOwner({ message: 'x', stack: EXTERNAL_STACK }, BASE)).toBe('external');
    expect(pageErrorOwner({ message: 'no stack', stack: '' }, BASE)).toBe('own');
    // A URL in the message (React links to react.dev) does not make the error external.
    expect(
      pageErrorOwner(
        {
          message: 'Minified React error #418; visit https://react.dev/errors/418',
          stack: 'Error: Minified React error #418; visit https://react.dev/errors/418',
        },
        BASE,
      ),
    ).toBe('own');
  });

  it('shorten React errors and flag hydration mismatches', () => {
    expect(
      describePageError(
        'Minified React error #418; visit https://react.dev/errors/418 for the full message',
      ),
    ).toEqual({ text: 'React #418 (https://react.dev/errors/418)', hydration: true });
    expect(describePageError('Minified React error #310; visit …').hydration).toBe(false);
    expect(describePageError('Hydration failed because the server HTML…').hydration).toBe(true);
    expect(describePageError('x is not a function')).toEqual({
      text: 'x is not a function',
      hydration: false,
    });
  });

  it('time out slow promises', async () => {
    await expect(withTimeout(new Promise(() => {}), 5, 'lento')).rejects.toThrow('lento');
    await expect(withTimeout(Promise.resolve(7), 1000, 'lento')).resolves.toBe(7);
  });

  it('ship browser scripts that parse as plain JavaScript', () => {
    expect(() => new Function(CSP_INIT_SCRIPT)).not.toThrow();
    expect(() => new Function(`return ${PAGE_PROBE_SCRIPT}`)).not.toThrow();
  });
});

describe('evaluateVisit', () => {
  it('passes a clean page', () => {
    const verdict = evaluateVisit('desktop', observation(), BASE);
    expect(verdict).toEqual({
      status: 'ok',
      failures: [],
      warnings: [],
      ignoredHosts: [],
      ignoredCount: 0,
    });
  });

  it('fails on navigation errors and HTTP errors, ignoring the probe', () => {
    const timeout = evaluateVisit(
      'desktop',
      observation({ navigationError: 'page.goto: Timeout 30000ms exceeded.', probe: null }),
      BASE,
    );
    expect(timeout.status).toBe('fail');
    expect(timeout.failures).toHaveLength(1);
    const notFound = evaluateVisit(
      'desktop',
      observation({
        pageUrl: `${BASE}/terms`,
        httpStatus: 500,
        console: [
          {
            type: 'error',
            text: 'Failed to load resource: the server responded with a status of 500 ()',
            url: `${BASE}/terms`,
          },
        ],
      }),
      BASE,
    );
    // The document's own HTTP error is reported once, not again as a console warning.
    expect(notFound).toMatchObject({
      status: 'fail',
      failures: ['La pagina risponde HTTP 500'],
      warnings: [],
    });
  });

  it('fails on uncaught errors of Solco, warns on third-party scripts and hydration', () => {
    const own = evaluateVisit(
      'desktop',
      observation({ pageErrors: [{ message: 'boom', stack: OWN_STACK }] }),
      BASE,
    );
    expect(own.status).toBe('fail');
    expect(own.failures).toEqual(['Errore JavaScript non gestito: boom']);

    const external = evaluateVisit(
      'desktop',
      observation({ pageErrors: [{ message: 'x is undefined', stack: EXTERNAL_STACK }] }),
      BASE,
    );
    expect(external.status).toBe('warn');
    expect(external.warnings[0]).toContain('script esterno');

    const hydration = evaluateVisit(
      'desktop',
      observation({
        pageErrors: [
          {
            message: 'Minified React error #418; visit https://react.dev/errors/418',
            stack: OWN_STACK,
          },
        ],
      }),
      BASE,
    );
    expect(hydration.status).toBe('warn');
    expect(hydration.warnings[0]).toContain('React #418');
  });

  it('fails on enforced CSP violations, warns on report-only ones, without duplicates', () => {
    const verdict = evaluateVisit(
      'desktop',
      observation({
        csp: [
          {
            blockedURI: 'https://evil.example/x.js?token=1',
            directive: 'script-src-elem',
            disposition: 'enforce',
            sourceFile: '',
          },
          { blockedURI: 'inline', directive: 'style-src', disposition: 'report', sourceFile: '' },
        ],
        console: [
          {
            type: 'error',
            text: "Refused to load the script 'https://evil.example/x.js' because it violates the following Content Security Policy directive: \"script-src 'self'\".",
            url: `${BASE}/`,
          },
          {
            type: 'error',
            text: "[Report Only] Applying inline style violates the following Content Security Policy directive 'style-src 'self''.",
            url: `${BASE}/`,
          },
        ],
      }),
      BASE,
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.failures).toEqual([
      'La CSP ha bloccato https://evil.example/x.js (script-src-elem)',
    ]);
    expect(verdict.warnings).toEqual([
      'CSP in prova (solo report) bloccherebbe inline (style-src)',
    ]);
  });

  it('falls back to console CSP messages when no violation event was recorded', () => {
    const verdict = evaluateVisit(
      'desktop',
      observation({
        console: [
          {
            type: 'error',
            text: 'Refused to execute inline script because it violates the following Content Security Policy directive: "script-src \'self\'".',
            url: `${BASE}/radio`,
          },
        ],
      }),
      BASE,
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.failures[0]).toMatch(/^Violazione CSP: Refused to execute inline script/);
  });

  it('never fails on embedded third-party content refusing to be framed or its own CSP', () => {
    const verdict = evaluateVisit(
      'desktop',
      observation({
        console: [
          {
            type: 'error',
            text: "Refused to display 'https://www.youtube.com/' in a frame because it set 'X-Frame-Options' to 'sameorigin'.",
            url: `${BASE}/`,
          },
          {
            type: 'error',
            text: "Refused to frame 'https://x.example/' because an ancestor violates the following Content Security Policy directive: \"frame-ancestors 'self'\".",
            url: '',
          },
          {
            type: 'error',
            text: "Refused to load the image 'data:x' because it violates the following Content Security Policy directive: \"img-src 'self'\".",
            url: 'https://www.tiktok.com/embed/v2/123',
          },
          {
            type: 'warning',
            text: "The Content Security Policy directive 'upgrade-insecure-requests' is ignored when delivered in a report-only policy.",
            url: `${BASE}/`,
          },
        ],
      }),
      BASE,
    );
    expect(verdict.status).toBe('warn');
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings).toHaveLength(4);
  });

  it('only warns when the CSP blocks eval (a library testing whether eval is allowed)', () => {
    const event = evaluateVisit(
      'desktop',
      observation({
        csp: [
          { blockedURI: 'eval', directive: 'script-src', disposition: 'enforce', sourceFile: '' },
          {
            blockedURI: 'wasm-eval',
            directive: 'script-src',
            disposition: 'enforce',
            sourceFile: '',
          },
        ],
        console: [
          {
            type: 'error',
            text: "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self' 'nonce-x' 'strict-dynamic'\".",
            url: `${BASE}/_next/static/chunks/app.js`,
          },
        ],
      }),
      BASE,
    );
    expect(event).toMatchObject({ status: 'warn', failures: [], warnings: [CSP_EVAL_WARNING] });

    // Console message only (no securitypolicyviolation event recorded).
    const consoleOnly = evaluateVisit(
      'desktop',
      observation({
        console: [
          {
            type: 'error',
            text: "Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\".",
            url: `${BASE}/`,
          },
        ],
      }),
      BASE,
    );
    expect(consoleOnly).toMatchObject({ status: 'warn', warnings: [CSP_EVAL_WARNING] });

    // An eval warning does not hide a real block reported only in the console, even when the
    // policy itself lists 'unsafe-eval'.
    const realBlock = evaluateVisit(
      'desktop',
      observation({
        csp: [
          { blockedURI: 'eval', directive: 'script-src', disposition: 'enforce', sourceFile: '' },
        ],
        console: [
          {
            type: 'error',
            text: "Refused to load the script 'https://evil.example/x.js' because it violates the following Content Security Policy directive: \"script-src 'self' 'unsafe-eval'\".",
            url: `${BASE}/`,
          },
        ],
      }),
      BASE,
    );
    expect(realBlock.status).toBe('fail');
    expect(realBlock.failures[0]).toMatch(/^Violazione CSP: Refused to load the script/);
    expect(realBlock.warnings).toEqual([CSP_EVAL_WARNING]);

    // Code that really breaks still throws an uncaught EvalError.
    const broken = evaluateVisit(
      'desktop',
      observation({
        csp: [
          { blockedURI: 'eval', directive: 'script-src', disposition: 'enforce', sourceFile: '' },
        ],
        pageErrors: [
          {
            message: "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not…",
            stack: OWN_STACK,
          },
        ],
      }),
      BASE,
    );
    expect(broken.status).toBe('fail');
  });

  it('turns same-origin load failures (favicon 404) into a warning with the path only', () => {
    const verdict = evaluateVisit(
      'desktop',
      observation({
        console: [
          {
            type: 'error',
            text: 'Failed to load resource: the server responded with a status of 404 ()',
            url: `${BASE}/favicon.ico?v=2`,
          },
        ],
      }),
      BASE,
    );
    expect(verdict.status).toBe('warn');
    expect(verdict.warnings).toEqual(['Risorsa non caricata (HTTP 404): /favicon.ico']);
  });

  it('only counts load failures of other sites (radio logos, thumbnails)', () => {
    const verdict = evaluateVisit(
      'desktop',
      observation({
        console: [
          {
            type: 'error',
            text: 'Failed to load resource: net::ERR_NAME_NOT_RESOLVED',
            url: 'https://radio.example/logo.png',
          },
          {
            type: 'error',
            text: 'Failed to load resource: the server responded with a status of 404 ()',
            url: 'https://i.ytimg.com/vi/a/mqdefault.jpg',
          },
          {
            type: 'error',
            text: 'Failed to load resource: the server responded with a status of 404 ()',
            url: 'https://i.ytimg.com/vi/b/mqdefault.jpg',
          },
        ],
      }),
      BASE,
    );
    expect(verdict.status).toBe('ok');
    expect(verdict.ignoredCount).toBe(3);
    expect(verdict.ignoredHosts).toEqual(['i.ytimg.com', 'radio.example']);
  });

  it('lists console errors as de-duplicated warnings, at most five per page', () => {
    const errors = Array.from({ length: 8 }, (_, index) => ({
      type: 'error',
      text: `errore ${index % 7}`,
      url: `${BASE}/_next/static/chunks/app.js`,
    }));
    const verdict = evaluateVisit(
      'desktop',
      observation({
        console: [...errors, { type: 'log', text: 'ignored', url: '' }],
      }),
      BASE,
    );
    expect(verdict.status).toBe('warn');
    expect(verdict.warnings).toHaveLength(MAX_CONSOLE_WARNINGS + 1);
    expect(verdict.warnings.at(-1)).toBe('… e altri 2');
    expect(verdict.warnings[0]).toBe('Errore in console: errore 0');
  });

  it('checks that the main content is visible and no error screen is shown', () => {
    const empty = evaluateVisit(
      'desktop',
      observation({ probe: { ...PROBE_OK, hasVisibleMain: false, textLength: 80 } }),
      BASE,
    );
    expect(empty.status).toBe('fail');
    expect(empty.failures).toEqual([
      'Contenuto principale non visibile (nessun <main> visibile, 80 caratteri di testo fuori ' +
        'da intestazione, menu e piè di pagina)',
    ]);
    const atThreshold = { ...PROBE_OK, hasVisibleMain: false, textLength: MIN_TEXT_LENGTH };
    expect(evaluateVisit('desktop', observation({ probe: atThreshold }), BASE).status).toBe('fail');

    const noMainButText = evaluateVisit(
      'desktop',
      observation({ probe: { ...PROBE_OK, hasVisibleMain: false, textLength: 539 } }),
      BASE,
    );
    expect(noMainButText.status).toBe('ok');

    const crashed = evaluateVisit(
      'desktop',
      observation({ probe: { ...PROBE_OK, errorScreen: 'Something went wrong' } }),
      BASE,
    );
    expect(crashed.failures).toEqual([
      'La pagina mostra la schermata di errore ("Something went wrong")',
    ]);

    const unreadable = evaluateVisit('desktop', observation({ probe: null }), BASE);
    expect(unreadable.failures).toEqual(['Impossibile leggere il contenuto della pagina']);

    const frozen = evaluateVisit(
      'desktop',
      observation({ probe: null, probeTimedOut: true }),
      BASE,
    );
    expect(frozen.failures).toEqual(['La pagina non risponde (JavaScript bloccato?)']);
  });

  it('warns about horizontal scrolling on the phone only', () => {
    const probe = { ...PROBE_OK, scrollWidth: 412, viewportWidth: 390, overflowing: ['div.hero'] };
    const mobile = evaluateVisit('mobile', observation({ probe }), BASE);
    expect(mobile.status).toBe('warn');
    expect(mobile.warnings[0]).toBe(
      'Scorrimento orizzontale sul telefono: pagina larga 412px su 390px; sporgono: div.hero',
    );
    expect(evaluateVisit('desktop', observation({ probe }), BASE).status).toBe('ok');
    const subpixel = { ...PROBE_OK, scrollWidth: 391, viewportWidth: 390 };
    expect(evaluateVisit('mobile', observation({ probe: subpixel }), BASE).status).toBe('ok');
  });
});

describe('mergeAttempts', () => {
  const failed: VisitVerdict = {
    status: 'fail',
    failures: ['La pagina risponde HTTP 504'],
    warnings: [],
    ignoredHosts: [],
    ignoredCount: 0,
  };
  const passed: VisitVerdict = { ...failed, status: 'ok', failures: [] };

  it('keeps the second failure when the retry fails too', () => {
    const second = { ...failed, failures: ['Errore JavaScript non gestito: boom'] };
    expect(mergeAttempts(failed, second)).toBe(second);
  });

  it('downgrades a transient failure to a warning that names it', () => {
    const merged = mergeAttempts(failed, passed);
    expect(merged.status).toBe('warn');
    expect(merged.warnings).toEqual([
      'Errore solo al primo tentativo: La pagina risponde HTTP 504',
    ]);
  });
});

describe('summarizeBrowserResults', () => {
  const meta = {
    baseUrl: BASE,
    startedAt: new Date('2026-11-11T05:47:00.000Z'),
    finishedAt: new Date('2026-11-11T05:48:12.400Z'),
    browserVersion: '153.0.8010.12',
  };

  it('exits 0 when every page works', () => {
    const summary = summarizeBrowserResults(
      [result(), result({ viewport: 'mobile', attempts: 2 })],
      meta,
    );
    expect(summary).toMatchObject({ status: 'ok', exitCode: 0, failed: 0, warned: 0, passed: 2 });
    expect(summary.markdown).toContain('**✅ Tutte le 2 pagine funzionano nel browser**');
    expect(summary.markdown).toContain('11/11/2026, 06:48');
    expect(summary.markdown).toContain('in 72,4 s');
    expect(summary.markdown).toContain(
      '| ✅ | Home (/) | telefono | Tutto a posto (al secondo tentativo) | 3200 |',
    );
    expect(summary.text).toContain('Esito: Tutte le 2 pagine funzionano nel browser');
  });

  it('exits 0 with warnings only', () => {
    const summary = summarizeBrowserResults(
      [result({ status: 'warn', warnings: ['Risorsa non caricata (HTTP 404): /favicon.ico'] })],
      meta,
    );
    expect(summary).toMatchObject({ status: 'warn', exitCode: 0, warned: 1 });
    expect(summary.markdown).toContain('⚠️ Nessun errore nel browser; 1 pagina con avvisi');
    expect(summary.markdown).toContain('### Avvisi\n\n- ⚠️ **Home (/) · computer**');
  });

  it('exits 1 and lists failures, screenshots and ignored external errors', () => {
    const summary = summarizeBrowserResults(
      [
        result({
          path: '/radio',
          label: 'Radio',
          status: 'fail',
          failures: [
            'Errore JavaScript non gestito: a | b',
            'La CSP ha bloccato inline (script-src)',
          ],
          warnings: ['Errore in console: <img>'],
          attempts: 2,
          screenshot: 'monitor-screenshots/radio-desktop.png',
          ignoredCount: 3,
          ignoredHosts: ['i.ytimg.com'],
        }),
        result({ ignoredCount: 1, ignoredHosts: ['radio.example', 'i.ytimg.com'] }),
      ],
      meta,
    );
    expect(summary).toMatchObject({ status: 'fail', exitCode: 1, failed: 1, passed: 1 });
    expect(summary.markdown).toContain('**❌ 1 pagina su 2 ha errori nel browser**');
    expect(summary.markdown).toContain(
      '| ❌ | Radio (/radio) | computer | Errore JavaScript non gestito: a \\| b (+1) | 3200 |',
    );
    expect(summary.markdown).toContain(
      '- ❌ **Radio (/radio) · computer** (errore anche al secondo tentativo)',
    );
    expect(summary.markdown).toContain('  - ⚠️ Errore in console: &lt;img>');
    expect(summary.markdown).toContain('`monitor-screenshots/radio-desktop.png`');
    expect(summary.markdown).toContain(
      'Ignorati 4 errori di caricamento di immagini o file di altri siti (i.ytimg.com, radio.example)',
    );
    expect(summary.text).toContain('[ERRORE] Radio (/radio) · computer');
    expect(summary.text).toContain('Screenshot: monitor-screenshots/radio-desktop.png');
    expect(summary.text).toContain('Esito: 1 pagina su 2 ha errori nel browser');
  });

  it('renders one GitHub error annotation per failing page', () => {
    const annotations = renderAnnotations([
      result({ status: 'fail', failures: ['a: b', 'c'] }),
      result({ status: 'warn', warnings: ['w'] }),
    ]);
    expect(annotations).toBe('::error title=Solco nel browser%3A Home (/) · computer::a: b; c\n');
  });
});

// ---------- Playwright finto ----------

type FakePageScript = {
  status?: number;
  gotoError?: string;
  /** goto never settles (an HTML stream that never ends). */
  hang?: boolean;
  /** evaluate never settles (JavaScript stuck in a loop). */
  frozen?: boolean;
  pageErrors?: { message: string; stack: string }[];
  console?: { type: string; text: string; url: string }[];
  csp?: unknown[];
  probe?: Partial<PageProbe>;
};

type FakeBrowserOptions = {
  /** newContext rejects (and isConnected turns false) from this context index on. */
  crashAtContext?: number;
};

type FakeLog = {
  contexts: PwContextOptions[];
  initScripts: string[];
  gotos: string[];
  screenshots: string[];
  closed: number;
  launches: { headless: boolean; channel?: string }[];
};

function fakeBrowser(
  script: (url: string, visitIndex: number) => FakePageScript,
  options: FakeBrowserOptions = {},
): {
  browser: PwBrowser;
  log: FakeLog;
} {
  const log: FakeLog = {
    contexts: [],
    initScripts: [],
    gotos: [],
    screenshots: [],
    closed: 0,
    launches: [],
  };
  let visitIndex = 0;
  let connected = true;
  const browser: PwBrowser = {
    version: () => '153.0.8010.12',
    close: async () => {},
    isConnected: () => connected,
    newContext: async (contextOptions) => {
      if (options.crashAtContext !== undefined && log.contexts.length >= options.crashAtContext) {
        connected = false;
        throw new Error(
          'browser.newContext: Target page, context or browser has been closed\nCall log:\n  - x',
        );
      }
      log.contexts.push(contextOptions);
      return {
        addInitScript: async (source) => {
          log.initScripts.push(source);
        },
        close: async () => {
          log.closed += 1;
        },
        newPage: async () => {
          const listeners: {
            pageerror: ((error: Error) => void)[];
            console: ((message: PwConsoleMessage) => void)[];
          } = { pageerror: [], console: [] };
          let current: FakePageScript = {};
          const page = {
            on: (event: 'pageerror' | 'console', listener: never) => {
              listeners[event].push(listener);
            },
            goto: async (url: string) => {
              log.gotos.push(url);
              current = script(url, visitIndex);
              visitIndex += 1;
              if (current.hang) await new Promise(() => {});
              if (current.gotoError) throw new Error(current.gotoError);
              for (const error of current.pageErrors ?? []) {
                const thrown = new Error(error.message);
                thrown.stack = error.stack;
                for (const listener of listeners.pageerror) listener(thrown);
              }
              for (const entry of current.console ?? []) {
                const message: PwConsoleMessage = {
                  type: () => entry.type,
                  text: () => entry.text,
                  location: () => ({ url: entry.url }),
                };
                for (const listener of listeners.console) listener(message);
              }
              return { status: () => current.status ?? 200 };
            },
            waitForTimeout: async () => {},
            evaluate: async (expression: string) => {
              if (current.frozen) await new Promise(() => {});
              if (expression === PAGE_PROBE_SCRIPT) return { ...PROBE_OK, ...current.probe };
              return current.csp ?? [];
            },
            screenshot: async (options: { path: string }) => {
              log.screenshots.push(options.path);
            },
          };
          return page as unknown as PwPage;
        },
      };
    },
  };
  return { browser, log };
}

function deps(browser: PwBrowser, overrides: Partial<BrowserDeps> = {}): BrowserDeps {
  return {
    baseUrl: BASE,
    browser,
    browserVersion: '153.0.8010.12',
    sleep: async () => {},
    clock: () => 0,
    settleMs: 0,
    retryDelayMs: 0,
    navigationTimeoutMs: 30_000,
    visitTimeoutMs: 5_000,
    runBudgetMs: 600_000,
    prepareScreenshot: async (relative) => `/tmp/fake/${relative}`,
    ...overrides,
  };
}

describe('checkVisit', () => {
  it('opens a fresh Italian context with the viewport and the CSP recorder', async () => {
    const { browser, log } = fakeBrowser(() => ({}));
    const visit = await checkVisit(deps(browser), { path: '/', label: 'Home', viewport: 'mobile' });
    expect(visit).toMatchObject({ status: 'ok', attempts: 1, screenshot: null });
    expect(log.gotos).toEqual([`${BASE}/`]);
    expect(log.initScripts).toEqual([CSP_INIT_SCRIPT]);
    expect(log.contexts[0]).toMatchObject({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: 'it-IT',
      timezoneId: 'Europe/Rome',
    });
    expect(log.closed).toBe(1);
  });

  it('reads page errors, console messages and CSP events from the browser', async () => {
    const { browser } = fakeBrowser(() => ({
      pageErrors: [{ message: 'boom', stack: OWN_STACK }],
      console: [
        { type: 'error', text: 'oops', url: `${BASE}/x.js` },
        { type: 'info', text: 'hello', url: '' },
      ],
      csp: [{ blockedURI: 'inline', directive: 'script-src', disposition: 'enforce' }],
    }));
    const visit = await checkVisit(deps(browser), {
      path: '/radio',
      label: 'Radio',
      viewport: 'desktop',
    });
    expect(visit.status).toBe('fail');
    expect(visit.failures).toEqual([
      'Errore JavaScript non gestito: boom',
      'La CSP ha bloccato inline (script-src)',
    ]);
    expect(visit.warnings).toEqual(['Errore in console: oops']);
  });

  it('retries a failing page once and keeps a transient failure as a warning', async () => {
    const { browser, log } = fakeBrowser((_, index) =>
      index === 0 ? { gotoError: 'page.goto: net::ERR_CONNECTION_RESET' } : {},
    );
    const visit = await checkVisit(deps(browser), {
      path: '/',
      label: 'Home',
      viewport: 'desktop',
    });
    expect(visit.status).toBe('warn');
    expect(visit.attempts).toBe(2);
    expect(visit.warnings[0]).toContain('ERR_CONNECTION_RESET');
    expect(log.screenshots).toEqual([]);
    expect(log.closed).toBe(2);
  });

  it('takes a screenshot when the page fails twice', async () => {
    const { browser, log } = fakeBrowser(() => ({ status: 500 }));
    const visit = await checkVisit(deps(browser), {
      path: '/generi/techno',
      label: 'Genere Techno',
      viewport: 'desktop',
    });
    expect(visit).toMatchObject({
      status: 'fail',
      attempts: 2,
      failures: ['La pagina risponde HTTP 500'],
      screenshot: 'monitor-screenshots/generi-techno-desktop.png',
    });
    expect(log.screenshots).toEqual(['/tmp/fake/monitor-screenshots/generi-techno-desktop.png']);
  });

  it('fails a visit that hangs instead of waiting forever', async () => {
    const { browser } = fakeBrowser(() => ({}));
    const hanging: PwBrowser = {
      ...browser,
      newContext: async (options) => {
        const context = await browser.newContext(options);
        return {
          ...context,
          newPage: async () => {
            const page = await context.newPage();
            return { ...page, on: page.on, goto: () => new Promise(() => {}) } as PwPage;
          },
        };
      },
    };
    const visit = await checkVisit(deps(hanging, { visitTimeoutMs: 10 }), {
      path: '/',
      label: 'Home',
      viewport: 'desktop',
    });
    expect(visit.status).toBe('fail');
    expect(visit.failures[0]).toContain('La visita non è finita');
    expect(visit.timedOut).toBe(true);
  });

  describe('with fake timers', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports a page whose JavaScript never answers', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { browser, log } = fakeBrowser(() => ({ frozen: true }));
      const pending = checkVisit(deps(browser, { visitTimeoutMs: 300_000 }), {
        path: '/radio',
        label: 'Radio',
        viewport: 'desktop',
      });
      await vi.advanceTimersByTimeAsync(120_000);
      const visit = await pending;
      expect(visit).toMatchObject({
        status: 'fail',
        attempts: 2,
        timedOut: true,
        failures: ['La pagina non risponde (JavaScript bloccato?)'],
      });
      expect(log.gotos).toHaveLength(2);
    });
  });

  it('does not retry when the rest of the run budget cannot fit another attempt', async () => {
    const { browser, log } = fakeBrowser(() => ({ status: 503 }));
    const visit = await checkVisit(
      deps(browser, { clock: () => 1_000 }),
      { path: '/', label: 'Home', viewport: 'desktop' },
      { deadline: 1_000 + 30_000 },
    );
    expect(visit).toMatchObject({ status: 'fail', attempts: 1, timedOut: false });
    expect(log.gotos).toHaveLength(1);
    // A screenshot is still taken of the failing page.
    expect(log.screenshots).toHaveLength(1);
  });

  it('does not retry when retries are switched off (whole site slow)', async () => {
    const { browser, log } = fakeBrowser(() => ({ gotoError: 'page.goto: Timeout 30000ms' }));
    const visit = await checkVisit(
      deps(browser),
      { path: '/', label: 'Home', viewport: 'desktop' },
      { allowRetry: false },
    );
    expect(visit).toMatchObject({ status: 'fail', attempts: 1, timedOut: true });
    expect(log.gotos).toHaveLength(1);
  });
});

describe('runVisits', () => {
  const visits = plannedVisits();

  it('stops retrying after two visits in a row time out', async () => {
    const { browser, log } = fakeBrowser(() => ({
      gotoError: 'page.goto: Timeout 30000ms exceeded.',
    }));
    const results = await runVisits(deps(browser), visits, 0);
    expect(results).toHaveLength(visits.length);
    expect(results.map((item) => item.attempts)).toEqual([
      2,
      2,
      ...Array.from({ length: visits.length - 2 }, () => 1),
    ]);
    expect(log.gotos).toHaveLength(visits.length + 2);
  });

  it('starts retrying again after a page loads', async () => {
    const { browser, log } = fakeBrowser((url, index) =>
      url.endsWith('/generi') ? {} : index < 7 ? { gotoError: 'page.goto: Timeout 30000ms' } : {},
    );
    const results = await runVisits(deps(browser), visits.slice(0, 5), 0);
    // '/' desktop and mobile time out twice each, '/search' once (no retry), '/generi' loads,
    // then '/generi/techno' is retried again and loads at the second attempt.
    expect(results.map((item) => [item.path, item.status, item.attempts])).toEqual([
      ['/', 'fail', 2],
      ['/', 'fail', 2],
      ['/search', 'fail', 1],
      ['/generi', 'ok', 1],
      ['/generi/techno', 'warn', 2],
    ]);
    expect(log.gotos).toHaveLength(8);
  });

  it('marks the remaining pages as not checked once the run budget is used up', async () => {
    let now = 0;
    const { browser } = fakeBrowser(() => {
      now += 400;
      return {};
    });
    const results = await runVisits(
      deps(browser, { clock: () => now, runBudgetMs: 1_000 }),
      visits,
      0,
    );
    expect(results).toHaveLength(visits.length);
    expect(results.slice(0, 3).map((item) => item.status)).toEqual(['ok', 'ok', 'ok']);
    expect(results.slice(3).every((item) => item.status === 'fail')).toBe(true);
    expect(results[3]?.failures).toEqual([BUDGET_EXHAUSTED_MESSAGE]);
    expect(results[3]?.attempts).toBe(0);
  });

  it('keeps the results collected so far when the browser crashes', async () => {
    const { browser, log } = fakeBrowser(() => ({}), { crashAtContext: 3 });
    const results = await runVisits(deps(browser), visits, 0);
    expect(results).toHaveLength(visits.length);
    expect(log.gotos).toHaveLength(3);
    expect(results.slice(0, 3).map((item) => item.status)).toEqual(['ok', 'ok', 'ok']);
    expect(results[3]?.failures).toEqual([
      'Il browser si è chiuso durante il controllo: browser.newContext: Target page, context ' +
        'or browser has been closed',
    ]);
    expect(results.slice(4).map((item) => item.failures[0])).toEqual(
      Array.from(
        { length: visits.length - 4 },
        () => 'Non controllata: il browser si è chiuso durante il controllo',
      ),
    );
  });

  it('marks only the broken visit when the browser is still connected', async () => {
    const { browser } = fakeBrowser(() => ({}));
    let calls = 0;
    const flaky: PwBrowser = {
      ...browser,
      newContext: async (options) => {
        calls += 1;
        if (calls === 2) throw new Error('unexpected');
        return browser.newContext(options);
      },
    };
    const results = await runVisits(deps(flaky), visits.slice(0, 3), 0);
    expect(results.map((item) => item.status)).toEqual(['ok', 'fail', 'ok']);
    expect(results[1]?.failures).toEqual([
      'Il controllo di questa pagina si è interrotto: unexpected',
    ]);
  });
});

describe('main', () => {
  it('checks every planned page, writes the summary and exits 1 on a failing page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browser-check-'));
    const summaryFile = join(dir, 'summary.md');
    const { browser, log } = fakeBrowser((url) =>
      url.endsWith('/privacy') ? { status: 404 } : {},
    );
    const chromium: PwChromium = {
      launch: async (options) => {
        log.launches.push(options);
        return browser;
      },
    };
    const stdout = process.stdout.write;
    let printed = '';
    process.stdout.write = ((chunk: string) => {
      printed += chunk;
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await main(
        {
          BASE_URL: `${BASE}/`,
          CHROME_CHANNEL: 'chrome',
          GITHUB_STEP_SUMMARY: summaryFile,
          GITHUB_ACTIONS: 'true',
        },
        chromium,
        { sleep: async () => {}, prepareScreenshot: async () => null },
      );
    } finally {
      process.stdout.write = stdout;
    }
    expect(code).toBe(1);
    expect(log.launches).toEqual([{ headless: true, channel: 'chrome' }]);
    // All planned visits, plus the retry of /privacy.
    expect(log.gotos).toHaveLength(plannedVisits().length + 1);
    const markdown = await readFile(summaryFile, 'utf8');
    expect(markdown).toContain(
      `**❌ 1 pagina su ${plannedVisits().length} ha errori nel browser**`,
    );
    expect(markdown).toContain('La pagina risponde HTTP 404');
    expect(printed).toContain('[ERRORE] Privacy (/privacy) · computer');
    expect(printed).toContain('::error title=Solco nel browser%3A Privacy (/privacy) · computer');
  });

  it('still writes the summary and exits 1 when pages hang past the run budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browser-check-'));
    const summaryFile = join(dir, 'summary.md');
    const { browser, log } = fakeBrowser(() => ({ hang: true }));
    const chromium: PwChromium = { launch: async () => browser };
    const stdout = process.stdout.write;
    let printed = '';
    process.stdout.write = ((chunk: string) => {
      printed += chunk;
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await main({ GITHUB_STEP_SUMMARY: summaryFile }, chromium, {
        sleep: async () => {},
        prepareScreenshot: async () => null,
        visitTimeoutMs: 20,
        runBudgetMs: 50,
      });
    } finally {
      process.stdout.write = stdout;
    }
    expect(code).toBe(1);
    // No retries (the budget cannot fit one) and the later pages are never opened.
    expect(log.gotos.length).toBeGreaterThanOrEqual(1);
    expect(log.gotos.length).toBeLessThan(plannedVisits().length);
    const markdown = await readFile(summaryFile, 'utf8');
    expect(markdown).toContain(
      `**❌ ${plannedVisits().length} pagine su ${plannedVisits().length} hanno errori`,
    );
    expect(markdown).toContain('La visita non è finita');
    expect(markdown).toContain(BUDGET_EXHAUSTED_MESSAGE);
    expect(printed).toContain(BUDGET_EXHAUSTED_MESSAGE);
  });

  it('exits 0 when every page works and launches without a channel by default', async () => {
    const { browser, log } = fakeBrowser(() => ({}));
    const chromium: PwChromium = {
      launch: async (options) => {
        log.launches.push(options);
        return browser;
      },
    };
    const stdout = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let code: number;
    try {
      code = await main({}, chromium, { sleep: async () => {} });
    } finally {
      process.stdout.write = stdout;
    }
    expect(code).toBe(0);
    expect(log.launches).toEqual([{ headless: true }]);
    expect(log.gotos[0]).toBe(`${BASE}/`);
  });
});
