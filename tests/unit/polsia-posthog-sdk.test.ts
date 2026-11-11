// @polsia:user-owned
// The real posthog-js in jsdom, with the framework options: what the SDK sends, and where.
import type { CaptureResult } from 'posthog-js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { posthogOptions } from '@/lib/polsia-posthog';

const HOST = 'https://ingest.example.com';

// posthog-js keeps the `fetch` it finds when it first loads, so one stub is installed before
// any import and each test chooses what the network does.
const requests: string[] = [];
let network: () => Promise<Response> = async () => new Response('{}', { status: 200 });
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string | URL) => {
    requests.push(String(url));
    return network();
  }),
);
afterAll(() => vi.unstubAllGlobals());
// Node 25 and later define their own `localStorage`, empty without `--localstorage-file`, which
// hides jsdom's; the platform runs app tests on such a Node. Use jsdom's, as a browser has it.
vi.stubGlobal(
  'localStorage',
  (globalThis as { jsdom?: { window: Window } }).jsdom?.window.localStorage,
);

let instance = 0;

beforeEach(() => {
  requests.length = 0;
  network = async () => new Response('{}', { status: 200 });
  localStorage.clear();
  window.history.replaceState({}, '', '/shop/orders/7f3c9a?session=x#top');
});

/** A fresh named instance, as the tracker starts it; `sent` holds what passed the filter. */
async function start() {
  const sent: CaptureResult[] = [];
  const { default: posthog } = await import('posthog-js');
  const options = posthogOptions({ host: HOST, appId: '4242' });
  instance += 1;
  const client = posthog.init(
    'phc_customerApps123',
    {
      ...options,
      before_send: (event) => {
        const out = options.before_send(event);
        if (out) sent.push(out);
        return out;
      },
    },
    `test${instance}`,
  );
  return { client, sent };
}

describe('posthog-js with the framework options', () => {
  it('captures nothing by itself: the tracker sends every page view', async () => {
    const { sent } = await start();
    window.history.pushState({}, '', '/pricing');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toEqual([]);
  });

  it('sends the full load, then the navigation, scrubbed and tagged with the app', async () => {
    const { client, sent } = await start();
    client.capture('$pageview');
    window.history.pushState({}, '', '/pricing?utm_source=news#plans');
    client.capture('$pageview');

    expect(sent.map((e) => e.properties.polsia_load)).toEqual(['full', 'navigation']);
    expect(sent.map((e) => e.properties.$current_url)).toEqual([
      'http://localhost:3000/shop/orders/[token]',
      'http://localhost:3000/pricing',
    ]);
    expect(sent.every((e) => e.properties.app_id === '4242')).toBe(true);
    expect(sent[1]?.properties.utm_source).toBe('news');
    // Time on the previous page of the tab, with that page's path masked like the others.
    expect(sent[0]?.properties.$prev_pageview_duration).toBeUndefined();
    expect(sent[1]?.properties.$prev_pageview_duration).toEqual(expect.any(Number));
    expect(sent[1]?.properties.$prev_pageview_pathname).toBe('/shop/orders/[token]');
    expect(sent.every((e) => e.properties.polsia_policy === 1)).toBe(true);
    expect(sent.every((e) => e.properties.$process_person_profile === false)).toBe(true);
  });

  it('talks only to the ingestion origin: no flags call, no remote config, no script', async () => {
    const { client } = await start();
    client.capture('$pageview');
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 5000 });

    expect(requests.every((url) => url.startsWith(`${HOST}/e/`))).toBe(true);
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  it('stores the visitor id in this origin only: no cookie a sibling app could read', async () => {
    const { client } = await start();
    client.capture('$pageview');

    expect(document.cookie).not.toMatch(/ph_/);
    expect(JSON.stringify({ ...localStorage })).toContain(client.get_distinct_id());
  });

  it('keeps capturing, without an error, while the ingestion host is blocked', async () => {
    network = async () => {
      throw new TypeError('Failed to fetch');
    };
    const { client, sent } = await start();
    client.capture('$pageview');
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 5000 });
    client.capture('$pageview');

    expect(sent).toHaveLength(2);
  });
});
