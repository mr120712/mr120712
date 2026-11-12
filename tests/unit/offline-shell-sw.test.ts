// @vitest-environment node
// @polsia:user-owned — public/sw.js loaded into a fake ServiceWorkerGlobalScope (stubbed self,
// caches and fetch). node, not jsdom: real Request/Response/Headers and a file: import.meta.url.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://solco.test';
const SW_SOURCE = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf-8');
const SHELL = 'solco-shell-v1';
const STATIC = 'solco-static-v1';

type RequestLike = { url: string; method: string; mode: string; headers: Headers };
type CacheKey = RequestLike | string;

function keyOf(input: CacheKey): string {
  return typeof input === 'string' ? new URL(input, ORIGIN).href : input.url;
}

class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(input: CacheKey) {
    return this.entries.get(keyOf(input))?.clone();
  }

  async put(input: CacheKey, response: Response) {
    if (response.bodyUsed) throw new TypeError('Response body is already used');
    const key = keyOf(input);
    // Like Cache.put: replacing an entry moves it to the end of the insertion order.
    this.entries.delete(key);
    this.entries.set(key, response);
  }

  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }

  async delete(input: CacheKey) {
    return this.entries.delete(keyOf(input));
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();

  async open(name: string) {
    const existing = this.stores.get(name);
    if (existing) return existing;
    const created = new FakeCache();
    this.stores.set(name, created);
    return created;
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }

  paths(name: string) {
    return [...(this.stores.get(name)?.entries.keys() ?? [])].map((url) => url.replace(ORIGIN, ''));
  }
}

/** A same-origin network response, as fetch() returns it in a browser (type "basic"). */
function basic(
  body: string,
  init: ResponseInit & { redirected?: boolean; contentType?: string } = {},
): Response {
  const { redirected = false, contentType = 'text/html; charset=utf-8', ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has('content-type')) headers.set('content-type', contentType);
  const response = new Response(body, { status: 200, ...rest, headers });
  Object.defineProperty(response, 'type', { value: 'basic' });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}

function req(
  path: string,
  options: { mode?: string; method?: string; headers?: Record<string, string> } = {},
): RequestLike {
  return {
    url: new URL(path, ORIGIN).href,
    method: options.method ?? 'GET',
    mode: options.mode ?? 'cors',
    headers: new Headers(options.headers),
  };
}

const nav = (path: string) => req(path, { mode: 'navigate' });

type FetchImpl = (input: RequestLike | string) => Promise<Response>;

function urlOf(input: RequestLike | string | Request): string {
  return typeof input === 'string' ? new URL(input, ORIGIN).href : input.url;
}

function pathOf(input: RequestLike | string | Request): string {
  const url = new URL(urlOf(input));
  return `${url.pathname}${url.search}`;
}

function loadServiceWorker(fetchImpl: FetchImpl = async () => basic('ok')) {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    location: new URL('/sw.js', ORIGIN),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
    navigator: { onLine: true },
  };
  const caches = new FakeCacheStorage();
  const fetch = vi.fn(fetchImpl);
  new Function('self', 'caches', 'fetch', SW_SOURCE)(self, caches, fetch);

  function extendable(type: string, extra: Record<string, unknown> = {}) {
    const lifetime: Promise<unknown>[] = [];
    const event = { ...extra, waitUntil: (promise: Promise<unknown>) => lifetime.push(promise) };
    listeners.get(type)?.(event);
    return Promise.all(lifetime);
  }

  function dispatchFetch(request: RequestLike) {
    let responded: Promise<Response> | undefined;
    const lifetime: Promise<unknown>[] = [];
    listeners.get('fetch')?.({
      request,
      respondWith: (response: Promise<Response> | Response) => {
        responded = Promise.resolve(response);
      },
      waitUntil: (promise: Promise<unknown>) => lifetime.push(promise),
    });
    return { responded, settled: () => Promise.all(lifetime) };
  }

  return {
    self,
    caches,
    fetch,
    install: () => extendable('install'),
    activate: () => extendable('activate'),
    message: (data: unknown) => extendable('message', { data }),
    dispatchFetch,
  };
}

async function seed(caches: FakeCacheStorage, name: string, path: string, body: string) {
  const cache = await caches.open(name);
  await cache.put(new URL(path, ORIGIN).href, basic(body));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('sw.js — routing: what is never intercepted', () => {
  it.each([
    ['API GET', req('/api/music/search?q=x')],
    ['API navigation', nav('/api/library')],
    ['health check', req('/health')],
    ['the worker script itself', req('/sw.js')],
    ['login page', nav('/login')],
    ['signup page', nav('/signup')],
    ['account page', nav('/profile')],
    ['checkout return', nav('/checkout/success?session_id=cs_1')],
    ['PayPal return', nav('/piani/paypal')],
    ['admin area', nav('/admin/monitoraggio')],
    ['member dashboard', nav('/dashboard')],
    ['invite link', nav('/invito/ABC123')],
    ['asset links', req('/.well-known/assetlinks.json')],
    ['audio range request', req('/brani/locale.mp3', { headers: { Range: 'bytes=0-' } })],
    [
      'range request on a static path',
      req('/_next/static/media/a.mp3', { headers: { range: 'bytes=100-200' } }),
    ],
    ['cross-origin static file', req('https://cdn.example.com/_next/static/chunks/a.js')],
    ['cross-origin navigation', nav('https://other.example.com/')],
    ['POST navigation', req('/library', { mode: 'navigate', method: 'POST' })],
    ['POST to a static path', req('/_next/static/chunks/a.js', { method: 'POST' })],
    ['RSC client navigation', req('/library?_rsc=abc', { headers: { RSC: '1' } })],
    ['file download navigation', nav('/solco.apk')],
    ['iOS profile download', nav('/ios/solco.mobileconfig')],
    ['plain same-origin GET', req('/music-captions.vtt')],
  ])('%s', (_label, request) => {
    const sw = loadServiceWorker();
    const { responded } = sw.dispatchFetch(request);
    expect(responded).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('does not mistake /profiles/… for the /profile account page', () => {
    const sw = loadServiceWorker();
    expect(sw.dispatchFetch(nav('/profiles/abc')).responded).toBeDefined();
  });
});

describe('sw.js — install', () => {
  const offlineHtml = `<!doctype html><html><head>
    <link rel="stylesheet" href="/_next/static/css/app-1a2b.css" data-precedence="next"/>
    <script src="/_next/static/chunks/webpack-9f.js" async=""></script></head>
    <body><script>self.__next_f.push([1,"I[1,[\\"static/chunks/app/offline/page-77.js\\"],\\"x\\"]"])</script>
    </body></html>`;

  it('pre-caches /offline, /library, the manifest and icons, plus the CSS/JS /offline needs', async () => {
    const sw = loadServiceWorker(async (input) => {
      const path = pathOf(input);
      if (path === '/offline') return basic(offlineHtml);
      if (path.startsWith('/_next/static/')) {
        return basic('/* asset */', { contentType: 'text/css' });
      }
      return basic(`body of ${path}`);
    });

    await sw.install();

    // Assets live next to the HTML that cites them, in the shell cache the 200-entry trim
    // never touches: the offline page stays a consistent, styled snapshot.
    expect(sw.caches.paths(SHELL).sort()).toEqual(
      [
        '/offline',
        '/library',
        '/manifest.webmanifest',
        '/icon.svg',
        '/apple-touch-icon.png',
        '/solco-icon-512.png',
        // Self-hosted fonts (latin subsets): offline pages keep the brand fonts.
        '/fonts/inter/inter-400-normal-latin.woff2',
        '/fonts/inter/inter-500-normal-latin.woff2',
        '/fonts/inter/inter-600-normal-latin.woff2',
        '/fonts/inter/inter-700-normal-latin.woff2',
        '/fonts/instrument-serif/instrument-serif-400-normal-latin.woff2',
        '/fonts/space-grotesk/space-grotesk-400-normal-latin.woff2',
        '/fonts/space-grotesk/space-grotesk-500-normal-latin.woff2',
        '/fonts/space-grotesk/space-grotesk-600-normal-latin.woff2',
        '/fonts/space-grotesk/space-grotesk-700-normal-latin.woff2',
        '/_next/static/chunks/app/offline/page-77.js',
        '/_next/static/chunks/webpack-9f.js',
        '/_next/static/css/app-1a2b.css',
      ].sort(),
    );
    expect(sw.caches.paths(STATIC)).toEqual([]);
    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const css = sw.dispatchFetch(req('/_next/static/css/app-1a2b.css')).responded;
    expect(await (await css)?.text()).toBe('/* asset */');
    // A precached font is served offline from the shell cache by the static handler.
    const font = await sw.dispatchFetch(req('/fonts/inter/inter-400-normal-latin.woff2')).responded;
    expect(await font?.text()).toBe('body of /fonts/inter/inter-400-normal-latin.woff2');
    const offline = await (await sw.caches.open(SHELL)).match('/offline');
    expect(await offline?.text()).toBe(offlineHtml);
    // Never skipWaiting on install: the page decides when to switch (SKIP_WAITING message).
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('bypasses the HTTP cache for the pre-cache requests', async () => {
    const sw = loadServiceWorker(async () => basic('ok'));
    await sw.install();
    const offlineCall = sw.fetch.mock.calls.find(([input]) => pathOf(input) === '/offline');
    expect((offlineCall?.[0] as unknown as Request).cache).toBe('reload');
  });

  it('fails (and is retried later by the browser) when /offline cannot be fetched', async () => {
    const sw = loadServiceWorker(async (input) => {
      if (pathOf(input) === '/offline') throw new TypeError('Failed to fetch');
      return basic('ok');
    });
    await expect(sw.install()).rejects.toThrow();
  });

  it('fails when /offline answers with an error page', async () => {
    const sw = loadServiceWorker(async (input) =>
      pathOf(input) === '/offline' ? basic('boom', { status: 500 }) : basic('ok'),
    );
    await expect(sw.install()).rejects.toThrow();
  });

  it('still installs when the optional /library and icons fail, without caching redirects', async () => {
    const sw = loadServiceWorker(async (input) => {
      const path = pathOf(input);
      if (path === '/offline') return basic('<html>offline</html>');
      if (path === '/library') return basic('<html>login</html>', { redirected: true });
      throw new TypeError('Failed to fetch');
    });
    await expect(sw.install()).resolves.toBeDefined();
    expect(sw.caches.paths(SHELL)).toEqual(['/offline']);
  });
});

describe('sw.js — activate and updates', () => {
  it('deletes only older Solco shell/static caches, keeps the current ones and foreign caches', async () => {
    const sw = loadServiceWorker();
    for (const name of [
      'solco-shell-v0',
      'solco-static-v0',
      SHELL,
      STATIC,
      'solco-local-music-v1',
      'another-feature',
    ]) {
      await sw.caches.open(name);
    }

    await sw.activate();

    expect((await sw.caches.keys()).sort()).toEqual(
      [SHELL, STATIC, 'another-feature', 'solco-local-music-v1'].sort(),
    );
    expect(sw.self.clients.claim).toHaveBeenCalledTimes(1);
  });

  it.each([[{ type: 'SKIP_WAITING' }], ['SKIP_WAITING']])(
    'activates the waiting version on a SKIP_WAITING message (%j)',
    async (data) => {
      const sw = loadServiceWorker();
      await sw.message(data);
      expect(sw.self.skipWaiting).toHaveBeenCalledTimes(1);
    },
  );

  it.each([[{ type: 'OTHER' }], [null], [42]])('ignores other messages (%j)', async (data) => {
    const sw = loadServiceWorker();
    await sw.message(data);
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
  });
});

describe('sw.js — navigations: network first', () => {
  it('serves the network response and stores a copy of "/" and "/library" only', async () => {
    const sw = loadServiceWorker(async (input) => basic(`fresh ${pathOf(input)}`));

    for (const path of ['/', '/library?tab=playlist', '/search?q=jazz', '/radio']) {
      const { responded, settled } = sw.dispatchFetch(nav(path));
      expect(await (await responded)?.text()).toBe(`fresh ${path}`);
      await settled();
    }

    expect(sw.caches.paths(SHELL).sort()).toEqual(['/', '/library']);
    const library = await (await sw.caches.open(SHELL)).match('/library');
    expect(await library?.text()).toBe('fresh /library?tab=playlist');
  });

  it.each([
    ['a redirect', basic('<html>login</html>', { redirected: true })],
    ['a server error', basic('<html>500</html>', { status: 500 })],
    ['the anti-bot challenge', basic('<html>verify</html>', { headers: { 'X-Solco-Gate': 'c' } })],
    ['a non-HTML body', basic('{}', { contentType: 'application/json' })],
  ])('passes %s through without caching it', async (_label, response) => {
    const sw = loadServiceWorker(async () => response);
    const { responded, settled } = sw.dispatchFetch(nav('/'));
    expect(await responded).toBe(response);
    await settled();
    expect(sw.caches.paths(SHELL)).toEqual([]);
  });

  it('offline: serves the saved copy of the same page', async () => {
    const sw = loadServiceWorker(async () => {
      throw new TypeError('Failed to fetch');
    });
    await seed(sw.caches, SHELL, '/', 'saved home');
    await seed(sw.caches, SHELL, '/library', 'saved library');
    await seed(sw.caches, SHELL, '/offline', 'offline page');

    const { responded } = sw.dispatchFetch(nav('/?utm=x'));
    expect(await (await responded)?.text()).toBe('saved home');
  });

  it('offline: falls back to the saved Library, then /offline, then a built-in page', async () => {
    const sw = loadServiceWorker(async () => {
      throw new TypeError('Failed to fetch');
    });
    await seed(sw.caches, SHELL, '/offline', 'offline page');
    expect(await (await sw.dispatchFetch(nav('/search')).responded)?.text()).toBe('offline page');

    await seed(sw.caches, SHELL, '/library', 'saved library');
    expect(await (await sw.dispatchFetch(nav('/search')).responded)?.text()).toBe('saved library');

    await sw.caches.delete(SHELL);
    const builtIn = await sw.dispatchFetch(nav('/podcasts')).responded;
    expect(builtIn?.status).toBe(200);
    expect(builtIn?.headers.get('content-type')).toContain('text/html');
    expect(builtIn?.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = (await builtIn?.text()) ?? '';
    expect(html).toContain('Sei offline');
    expect(html).toContain('Riprova');
    expect(html).not.toContain('<script');
  });

  it('gives the network 4 seconds, then serves the fallback chain', async () => {
    vi.useFakeTimers();
    let resolveNetwork: (response: Response) => void = () => {};
    const sw = loadServiceWorker(
      () =>
        new Promise<Response>((resolve) => {
          resolveNetwork = resolve;
        }),
    );
    await seed(sw.caches, SHELL, '/library', 'saved library');

    const { responded, settled } = sw.dispatchFetch(nav('/library'));
    let result: Response | undefined;
    void responded?.then((response) => {
      result = response;
    });

    await vi.advanceTimersByTimeAsync(3999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result?.text()).toBe('saved library');

    // The slow network answer still refreshes the saved shell in the background.
    resolveNetwork(basic('late library'));
    await settled();
    const saved = await (await sw.caches.open(SHELL)).match('/library');
    expect(await saved?.text()).toBe('late library');
  });

  it('online but slow: after 4 s another page keeps waiting for the network, not the Library', async () => {
    vi.useFakeTimers();
    const sw = loadServiceWorker(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(basic('premi')), 6000)),
    );
    await seed(sw.caches, SHELL, '/library', 'saved library');
    await seed(sw.caches, SHELL, '/offline', 'offline page');

    const { responded } = sw.dispatchFetch(nav('/premi'));
    let result: Response | undefined;
    void responded?.then((response) => {
      result = response;
    });
    await vi.advanceTimersByTimeAsync(4500);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result?.text()).toBe('premi');
  });

  it('online but stuck: uses the fallback chain after 10 s', async () => {
    vi.useFakeTimers();
    const sw = loadServiceWorker(() => new Promise<Response>(() => {}));
    await seed(sw.caches, SHELL, '/library', 'saved library');

    const { responded } = sw.dispatchFetch(nav('/premi'));
    let result: Response | undefined;
    void responded?.then((response) => {
      result = response;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result?.text()).toBe('saved library');
  });

  it('waits past 4 s for a shell page that has no saved copy yet', async () => {
    vi.useFakeTimers();
    const sw = loadServiceWorker(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(basic('home')), 7000)),
    );
    await seed(sw.caches, SHELL, '/library', 'saved library');

    const { responded } = sw.dispatchFetch(nav('/'));
    await vi.advanceTimersByTimeAsync(7000);
    expect(await (await responded)?.text()).toBe('home');
  });

  it('after 4 s serves the fallback chain right away when the device reports it is offline', async () => {
    vi.useFakeTimers();
    const sw = loadServiceWorker(() => new Promise<Response>(() => {}));
    sw.self.navigator.onLine = false;
    await seed(sw.caches, SHELL, '/offline', 'offline page');

    const { responded } = sw.dispatchFetch(nav('/premi'));
    let result: Response | undefined;
    void responded?.then((response) => {
      result = response;
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result?.text()).toBe('offline page');
  });

  it('prefers a network answer that arrives before the timeout over the saved copy', async () => {
    vi.useFakeTimers();
    const sw = loadServiceWorker(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(basic('fresh')), 3000)),
    );
    await seed(sw.caches, SHELL, '/', 'saved home');

    const { responded } = sw.dispatchFetch(nav('/'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await (await responded)?.text()).toBe('fresh');
  });
});

describe('sw.js — static files: cache first', () => {
  it('fetches once, then serves hashed Next files, fonts, brand and icons from the cache', async () => {
    const sw = loadServiceWorker(async (input) => basic(`asset ${pathOf(input)}`));
    const paths = [
      '/_next/static/chunks/main-abc.js',
      '/fonts/inter/inter-400-normal-latin.woff2',
      '/brand/spotify/primary-logo-white.svg',
      '/solco-icon-512.png',
    ];

    for (const path of paths) {
      const first = sw.dispatchFetch(req(path));
      expect(await (await first.responded)?.text()).toBe(`asset ${path}`);
      await first.settled();
    }
    expect(sw.fetch).toHaveBeenCalledTimes(paths.length);

    for (const path of paths) {
      const second = sw.dispatchFetch(req(path));
      expect(await (await second.responded)?.text()).toBe(`asset ${path}`);
    }
    expect(sw.fetch).toHaveBeenCalledTimes(paths.length);
  });

  it('serves pre-cached icons offline', async () => {
    const sw = loadServiceWorker(async () => {
      throw new TypeError('Failed to fetch');
    });
    await seed(sw.caches, SHELL, '/icon.svg', '<svg/>');
    expect(await (await sw.dispatchFetch(req('/icon.svg')).responded)?.text()).toBe('<svg/>');
  });

  it('does not cache failed responses', async () => {
    const sw = loadServiceWorker(async () => basic('missing', { status: 404 }));
    const { responded, settled } = sw.dispatchFetch(req('/_next/static/chunks/gone.js'));
    expect((await responded)?.status).toBe(404);
    await settled();
    expect(sw.caches.paths(STATIC)).toEqual([]);
  });

  it('keeps at most 200 entries, dropping the oldest first', async () => {
    const sw = loadServiceWorker(async (input) => basic(pathOf(input)));
    for (let i = 0; i < 205; i++) {
      const { responded, settled } = sw.dispatchFetch(req(`/_next/static/chunks/c${i}.js`));
      await responded;
      await settled();
    }
    const stored = sw.caches.paths(STATIC);
    expect(stored).toHaveLength(200);
    expect(stored[0]).toBe('/_next/static/chunks/c5.js');
    expect(stored).not.toContain('/_next/static/chunks/c4.js');
    expect(stored.at(-1)).toBe('/_next/static/chunks/c204.js');
  });

  it('evicts the least recently used file: a chunk used on every page outlives newer ones', async () => {
    let online = true;
    const sw = loadServiceWorker(async (input) => {
      if (!online) throw new TypeError('Failed to fetch');
      return basic(pathOf(input), { contentType: 'text/javascript' });
    });
    const stable = '/_next/static/chunks/framework-stable.js';
    const load = async (path: string) => {
      const { responded, settled } = sw.dispatchFetch(req(path));
      await responded;
      await settled();
    };

    // Inserted first and only ever served from the cache afterwards: with insertion-order
    // trimming it would be the first entry dropped once 200 newer chunks arrive.
    await load(stable);
    for (let i = 0; i < 190; i++) {
      await load(`/_next/static/chunks/deploy-${i}.js`);
      if (i % 10 === 9) await load(stable);
    }
    for (let i = 190; i < 340; i++) await load(`/_next/static/chunks/deploy-${i}.js`);

    const stableFetches = sw.fetch.mock.calls.filter(([input]) => pathOf(input) === stable);
    expect(stableFetches).toHaveLength(1);
    expect(sw.caches.paths(STATIC)).toHaveLength(200);
    expect(sw.caches.paths(STATIC)).toContain(stable);
    expect(sw.caches.paths(STATIC)).not.toContain('/_next/static/chunks/deploy-0.js');
    online = false;
    expect(await (await sw.dispatchFetch(req(stable)).responded)?.text()).toBe(stable);
  });

  it('manifest: network first, saved copy when offline', async () => {
    let online = true;
    const sw = loadServiceWorker(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return basic('{"name":"Solco"}', { contentType: 'application/manifest+json' });
    });
    const first = sw.dispatchFetch(req('/manifest.webmanifest'));
    expect(await (await first.responded)?.text()).toBe('{"name":"Solco"}');
    await first.settled();

    online = false;
    const second = sw.dispatchFetch(req('/manifest.webmanifest'));
    expect(await (await second.responded)?.text()).toBe('{"name":"Solco"}');
  });
});

describe('sw.js — saved shell pages keep their CSS and JS', () => {
  const libraryHtml = (chunk: string) => `<!doctype html><html><head>
    <link rel="stylesheet" href="/_next/static/css/app-1.css"/>
    <script src="/_next/static/chunks/${chunk}" async=""></script></head>
    <body><div id="library"></div></body></html>`;

  it('pins the files the saved /library cites, so it still hydrates offline after 200+ new chunks', async () => {
    let online = true;
    const sw = loadServiceWorker(async (input) => {
      if (!online) throw new TypeError('Failed to fetch');
      const path = pathOf(input);
      if (path === '/library') return basic(libraryHtml('library-a.js'));
      return basic(`asset ${path}`, { contentType: 'text/javascript' });
    });

    // The page loads its chunks through the worker while the HTML is saved and pinned.
    const page = sw.dispatchFetch(nav('/library'));
    await (await page.responded)?.text();
    await sw.dispatchFetch(req('/_next/static/chunks/library-a.js')).settled();
    await page.settled();
    expect(sw.caches.paths(SHELL).sort()).toEqual(
      ['/library', '/_next/static/chunks/library-a.js', '/_next/static/css/app-1.css'].sort(),
    );

    for (let i = 0; i < 210; i++) {
      const { responded, settled } = sw.dispatchFetch(req(`/_next/static/chunks/other-${i}.js`));
      await responded;
      await settled();
    }
    expect(sw.caches.paths(STATIC)).not.toContain('/_next/static/chunks/library-a.js');

    online = false;
    const html = await (await sw.dispatchFetch(nav('/library')).responded)?.text();
    expect(html).toBe(libraryHtml('library-a.js'));
    const chunk = await sw.dispatchFetch(req('/_next/static/chunks/library-a.js')).responded;
    expect(await chunk?.text()).toBe('asset /_next/static/chunks/library-a.js');
    const css = await sw.dispatchFetch(req('/_next/static/css/app-1.css')).responded;
    expect(await css?.text()).toBe('asset /_next/static/css/app-1.css');
  });

  it('copies pinned files from the static cache instead of downloading them again', async () => {
    const sw = loadServiceWorker(async (input) => {
      const path = pathOf(input);
      if (path === '/') return basic(libraryHtml('home-a.js'));
      return basic(`asset ${path}`, { contentType: 'text/javascript' });
    });
    await seed(sw.caches, STATIC, '/_next/static/chunks/home-a.js', 'from static cache');
    await seed(sw.caches, STATIC, '/_next/static/css/app-1.css', 'css from static cache');

    const { responded, settled } = sw.dispatchFetch(nav('/'));
    await (await responded)?.text();
    await settled();

    expect(sw.fetch).toHaveBeenCalledTimes(1);
    const pinned = await (await sw.caches.open(SHELL)).match('/_next/static/chunks/home-a.js');
    expect(await pinned?.text()).toBe('from static cache');
  });

  it('drops pinned files no saved page cites any more, keeping those /offline still needs', async () => {
    let chunk = 'library-a.js';
    const sw = loadServiceWorker(async (input) => {
      const path = pathOf(input);
      if (path === '/library') return basic(libraryHtml(chunk));
      return basic(`asset ${path}`, { contentType: 'text/javascript' });
    });
    await seed(
      sw.caches,
      SHELL,
      '/offline',
      '<link rel="stylesheet" href="/_next/static/css/app-1.css"/>',
    );
    await seed(sw.caches, SHELL, '/icon.svg', '<svg/>');

    const first = sw.dispatchFetch(nav('/library'));
    await (await first.responded)?.text();
    await first.settled();
    expect(sw.caches.paths(SHELL)).toContain('/_next/static/chunks/library-a.js');

    chunk = 'library-b.js';
    const second = sw.dispatchFetch(nav('/library'));
    await (await second.responded)?.text();
    await second.settled();

    expect(sw.caches.paths(SHELL).sort()).toEqual(
      [
        '/offline',
        '/icon.svg',
        '/library',
        '/_next/static/chunks/library-b.js',
        '/_next/static/css/app-1.css',
      ].sort(),
    );
  });
});

describe('vercel.json — /sw.js headers', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf-8'));

  it('never caches the worker script and allows the root scope', () => {
    const entry = vercel.headers.find((h: { source: string }) => h.source === '/sw.js');
    expect(entry.headers).toEqual([
      { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
      { key: 'Service-Worker-Allowed', value: '/' },
    ]);
  });

  it('keeps the existing headers and crons', () => {
    expect(vercel.headers.map((h: { source: string }) => h.source)).toContain('/apple-music');
    expect(vercel.crons).toEqual([
      { path: '/api/cron/cleanup', schedule: '17 3 * * *' },
      { path: '/api/cron/health', schedule: '41 5 * * *' },
    ]);
  });
});
