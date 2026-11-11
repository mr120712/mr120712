// @polsia:user-owned
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PolsiaAnalytics } from '@/components/polsia-analytics';

const sdk = { init: vi.fn(), capture: vi.fn() };
const route = vi.hoisted(() => ({ pathname: '/' }));
// The layout test renders the shell: no request scope, and no matchMedia in jsdom.
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));

const CAPTURE = { token: 'phc_customerApps123', host: 'https://ingest.example.com', appId: '4242' };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
const pixels: string[] = [];

beforeEach(() => {
  // Node 25 and later define their own `localStorage`, empty without `--localstorage-file`, which
  // hides jsdom's; the platform runs app tests on such a Node. Use jsdom's, as a browser has it.
  vi.stubGlobal(
    'localStorage',
    (globalThis as { jsdom?: { window: Window } }).jsdom?.window.localStorage,
  );
  sdk.init.mockReset().mockImplementation(() => ({ capture: sdk.capture }));
  sdk.capture.mockReset();
  route.pathname = '/';
  pixels.length = 0;
  vi.resetModules();
  vi.doMock('posthog-js', () => ({ default: { init: sdk.init } }));
  vi.stubGlobal(
    'Image',
    class {
      set src(value: string) {
        pixels.push(value);
      }
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The tracker, loaded against the current `posthog-js` mock. */
async function loadTracker() {
  return (await import('@/components/polsia-posthog')).PolsiaPosthog;
}

/** Lets the idle callback, the dynamic import and its promise settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('PolsiaPosthog', () => {
  it('starts the SDK after first paint on its own instance and sends the full load', async () => {
    const PolsiaPosthog = await loadTracker();
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));
    await settle();

    expect(sdk.init).toHaveBeenCalledTimes(1);
    const [token, options, instance] = sdk.init.mock.calls[0] ?? [];
    expect(token).toBe('phc_customerApps123');
    expect(instance).toBe('polsia');
    expect(options).toMatchObject({
      api_host: 'https://ingest.example.com',
      capture_pageview: false,
    });
    expect(sdk.capture.mock.calls).toEqual([['$pageview']]);
  });

  it('sends one page view per pathname change, none for a re-render on the same path', async () => {
    const PolsiaPosthog = await loadTracker();
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));
    await settle();

    route.pathname = '/pricing';
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));
    route.pathname = '/about';
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));

    expect(sdk.capture).toHaveBeenCalledTimes(3);
  });

  it('sends the full load only once when the visitor navigated before the SDK started', async () => {
    const PolsiaPosthog = await loadTracker();
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));
    route.pathname = '/pricing';
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));
    await settle();
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));

    expect(sdk.capture).toHaveBeenCalledTimes(1);
  });

  it('does not start when unmounted before the browser is idle', async () => {
    const PolsiaPosthog = await loadTracker();
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));
    act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await settle();

    expect(sdk.init).not.toHaveBeenCalled();
  });

  it('keeps the page and the pixel working when the SDK cannot load', async () => {
    vi.doMock('posthog-js', () => {
      throw new Error('blocked by the network');
    });
    const Unloadable = await loadTracker();
    await act(async () =>
      root.render(
        <>
          <PolsiaAnalytics slug="acme" base="https://polsia.com" />
          <Unloadable {...CAPTURE} />
        </>,
      ),
    );
    await settle();

    expect(sdk.init).not.toHaveBeenCalled();
    expect(pixels).toHaveLength(1);
    expect(pixels[0]).toMatch(/^https:\/\/polsia\.com\/api\/beacon\/pixel\?s=acme&v=/);
  });

  it('keeps the page working when the SDK throws, on start or on a navigation', async () => {
    sdk.capture.mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const PolsiaPosthog = await loadTracker();
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));
    await settle();
    route.pathname = '/pricing';
    await act(async () => root.render(<PolsiaPosthog {...CAPTURE} />));

    expect(sdk.capture).toHaveBeenCalledTimes(2);
  });
});

describe('root layout', () => {
  async function renderShell() {
    vi.doMock('@/components/polsia-posthog', () => ({
      PolsiaPosthog: (props: object) => <i data-posthog={JSON.stringify(props)} />,
    }));
    const { default: RootLayout } = await import('@/app/layout');
    const tree = await RootLayout({ children: <main>Page</main> });
    return new DOMParser()
      .parseFromString(renderToStaticMarkup(tree), 'text/html')
      .querySelector('[data-posthog]')
      ?.getAttribute('data-posthog');
  }

  it('mounts no PostHog tracker without the deploy-injected config', async () => {
    expect(await renderShell()).toBeUndefined();
  });

  it('mounts the tracker with the injected token, origin and app id', async () => {
    vi.stubEnv('POLSIA_ANALYTICS_POSTHOG_TOKEN', CAPTURE.token);
    vi.stubEnv('POLSIA_ANALYTICS_POSTHOG_HOST', CAPTURE.host);
    vi.stubEnv('POLSIA_ANALYTICS_APP_ID', CAPTURE.appId);
    expect(JSON.parse((await renderShell()) ?? 'null')).toEqual(CAPTURE);
  });
});
