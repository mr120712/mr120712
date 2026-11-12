// @polsia:user-owned — ServiceWorkerRegistration: production only, never throws, and updates that
// never interrupt playback (SKIP_WAITING when hidden or on the next navigation, one reload at most).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isMediaActive,
  ServiceWorkerRegistration,
  SKIP_WAITING_MESSAGE,
  startServiceWorker,
  UPDATE_CHECK_INTERVAL_MS,
  unregisterStaleServiceWorker,
} from '@/components/custom/service-worker-registration';

const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));

class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  postMessage = vi.fn();

  constructor(state: ServiceWorkerState = 'installed') {
    super();
    this.state = state;
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  update = vi.fn(async () => undefined);
}

class FakeContainer extends EventTarget {
  controller: object | null = null;
  registration = new FakeRegistration();
  register = vi.fn(async (_url: string, _options?: RegistrationOptions) => this.registration);
}

let visibility: DocumentVisibilityState = 'visible';

function installContainer(container: unknown) {
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  });
}

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

function setPlaybackState(state: MediaSessionPlaybackState | undefined) {
  Object.defineProperty(window.navigator, 'mediaSession', {
    configurable: true,
    value: state === undefined ? undefined : { playbackState: state },
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** An update already installed and waiting, with an older worker controlling the page. */
function containerWithWaitingUpdate() {
  const container = new FakeContainer();
  container.controller = {};
  container.registration.waiting = new FakeWorker('installed');
  installContainer(container);
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubEnv('NODE_ENV', 'production');
  visibility = 'visible';
  route.pathname = '/';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  Reflect.deleteProperty(document, 'readyState');
  Reflect.deleteProperty(window.navigator, 'serviceWorker');
  Reflect.deleteProperty(window.navigator, 'mediaSession');
  Reflect.deleteProperty(document, 'visibilityState');
  document.body.innerHTML = '';
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ServiceWorkerRegistration component', () => {
  async function render() {
    const container = document.createElement('div');
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(<ServiceWorkerRegistration />);
    });
    await flush();
    return {
      container,
      rerender: async () => {
        await act(async () => root?.render(<ServiceWorkerRegistration />));
        await flush();
      },
      unmount: async () => act(async () => root?.unmount()),
    };
  }

  it('registers /sw.js with scope / in production and renders nothing', async () => {
    const sw = new FakeContainer();
    installContainer(sw);
    const view = await render();
    expect(sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });

  it.each(['development', 'test'])('does nothing outside production (%s)', async (env) => {
    vi.stubEnv('NODE_ENV', env);
    const sw = new FakeContainer();
    installContainer(sw);
    const view = await render();
    expect(sw.register).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('does nothing when the browser has no Service Worker support', async () => {
    const view = await render();
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });

  it('never throws when registration is rejected or the API itself throws', async () => {
    const rejecting = new FakeContainer();
    rejecting.register.mockRejectedValue(new DOMException('blocked', 'SecurityError'));
    installContainer(rejecting);
    const first = await render();
    expect(rejecting.register).toHaveBeenCalledTimes(1);
    await first.unmount();

    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    const second = await render();
    expect(second.container.innerHTML).toBe('');
    await second.unmount();
  });

  it('applies a waiting update on the next client navigation', async () => {
    const sw = containerWithWaitingUpdate();
    const view = await render();
    const waiting = sw.registration.waiting;
    expect(waiting?.postMessage).not.toHaveBeenCalled();

    route.pathname = '/library';
    await view.rerender();
    expect(waiting?.postMessage).toHaveBeenCalledWith(SKIP_WAITING_MESSAGE);
    await view.unmount();
  });
});

describe('startServiceWorker registration timing', () => {
  function setReadyState(state: DocumentReadyState) {
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => state });
  }

  it('registers right away when the page has already loaded', async () => {
    setReadyState('complete');
    const sw = new FakeContainer();
    installContainer(sw);
    const handle = startServiceWorker();
    await flush();
    expect(sw.register).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('waits for window load before registering, so install does not compete with the first visit', async () => {
    setReadyState('interactive');
    const sw = new FakeContainer();
    installContainer(sw);
    const handle = startServiceWorker();
    await flush();
    expect(sw.register).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('load'));
    window.dispatchEvent(new Event('load'));
    await flush();
    expect(sw.register).toHaveBeenCalledTimes(1);
    expect(sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    handle.dispose();
  });

  it('never registers when disposed before load', async () => {
    setReadyState('loading');
    const sw = new FakeContainer();
    installContainer(sw);
    const handle = startServiceWorker();
    handle.dispose();
    window.dispatchEvent(new Event('load'));
    await flush();
    expect(sw.register).not.toHaveBeenCalled();
  });
});

describe('outside production: removes a leftover /sw.js', () => {
  type FakeWorkerRef = { scriptURL: string } | null;

  function fakeRegistration(workers: {
    active?: FakeWorkerRef;
    waiting?: FakeWorkerRef;
    installing?: FakeWorkerRef;
  }) {
    return {
      active: workers.active ?? null,
      waiting: workers.waiting ?? null,
      installing: workers.installing ?? null,
      unregister: vi.fn(async () => true),
    };
  }

  function setup() {
    const own = fakeRegistration({ active: { scriptURL: 'http://localhost:3000/sw.js' } });
    const ownWaiting = fakeRegistration({ waiting: { scriptURL: 'http://localhost:3000/sw.js' } });
    const foreign = fakeRegistration({ active: { scriptURL: 'http://localhost:3000/push.js' } });
    const container = new FakeContainer();
    const getRegistrations = vi.fn(async () => [own, ownWaiting, foreign]);
    Object.assign(container, { getRegistrations });
    installContainer(container);
    const cacheNames = ['solco-shell-v1', 'solco-static-v1', 'solco-local-music-v1', 'other'];
    const cacheStorage = {
      keys: vi.fn(async () => cacheNames),
      delete: vi.fn(async (_name: string) => true),
    };
    vi.stubGlobal('caches', cacheStorage);
    return { own, ownWaiting, foreign, container, getRegistrations, cacheStorage };
  }

  it.each(['development', 'test'])(
    'unregisters only the Solco worker and deletes only its caches (%s)',
    async (env) => {
      vi.stubEnv('NODE_ENV', env);
      const { own, ownWaiting, foreign, container, cacheStorage } = setup();

      const handle = startServiceWorker();
      await flush();

      expect(container.register).not.toHaveBeenCalled();
      expect(own.unregister).toHaveBeenCalledTimes(1);
      expect(ownWaiting.unregister).toHaveBeenCalledTimes(1);
      expect(foreign.unregister).not.toHaveBeenCalled();
      expect(cacheStorage.delete.mock.calls.map(([name]) => name).sort()).toEqual([
        'solco-shell-v1',
        'solco-static-v1',
      ]);
      handle.dispose();
    },
  );

  it('leaves the caches alone when no Solco worker was registered', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { getRegistrations, cacheStorage } = setup();
    getRegistrations.mockResolvedValue([]);
    await unregisterStaleServiceWorker();
    expect(cacheStorage.keys).not.toHaveBeenCalled();
  });

  it('does not touch existing registrations in production', async () => {
    const { own, getRegistrations, container } = setup();
    const handle = startServiceWorker();
    await flush();
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(own.unregister).not.toHaveBeenCalled();
    expect(container.register).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('never throws, even when the Service Worker API fails', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { getRegistrations } = setup();
    getRegistrations.mockRejectedValue(new DOMException('denied', 'SecurityError'));
    await expect(unregisterStaleServiceWorker()).resolves.toBeUndefined();

    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    await expect(unregisterStaleServiceWorker()).resolves.toBeUndefined();
    expect(() => startServiceWorker()).not.toThrow();
  });
});

describe('startServiceWorker update flow', () => {
  it('waits while the page is visible, then posts SKIP_WAITING once it is hidden', async () => {
    const sw = containerWithWaitingUpdate();
    const reload = vi.fn();
    const handle = startServiceWorker({ reload });
    await flush();
    const waiting = sw.registration.waiting;
    expect(waiting?.postMessage).not.toHaveBeenCalled();

    setVisibility('hidden');
    expect(waiting?.postMessage).toHaveBeenCalledTimes(1);
    expect(waiting?.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    sw.dispatchEvent(new Event('controllerchange'));
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('applies right away when the update is found while the page is already hidden', async () => {
    visibility = 'hidden';
    const sw = containerWithWaitingUpdate();
    const handle = startServiceWorker({ reload: vi.fn() });
    await flush();
    expect(sw.registration.waiting?.postMessage).toHaveBeenCalledWith(SKIP_WAITING_MESSAGE);
    handle.dispose();
  });

  it('never reloads while music is playing in an <audio> element', async () => {
    const sw = containerWithWaitingUpdate();
    const reload = vi.fn();
    const handle = startServiceWorker({ reload });
    await flush();

    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'paused', { configurable: true, value: false });
    document.body.append(audio);

    setVisibility('hidden');
    sw.dispatchEvent(new Event('controllerchange'));
    expect(sw.registration.waiting?.postMessage).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    handle.dispose();
  });

  it.each<MediaSessionPlaybackState>(['playing', 'paused'])(
    'never reloads while the system media controls are %s (lock screen, Android notification)',
    async (state) => {
      setPlaybackState(state);
      const sw = containerWithWaitingUpdate();
      const reload = vi.fn();
      const handle = startServiceWorker({ reload });
      await flush();

      handle.onNavigation();
      sw.dispatchEvent(new Event('controllerchange'));
      expect(sw.registration.waiting?.postMessage).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      handle.dispose();
    },
  );

  it('reloads once after a navigation-triggered update when nothing is playing', async () => {
    setPlaybackState('none');
    const sw = containerWithWaitingUpdate();
    const reload = vi.fn();
    const handle = startServiceWorker({ reload });
    await flush();

    handle.onNavigation();
    handle.onNavigation();
    expect(sw.registration.waiting?.postMessage).toHaveBeenCalledTimes(1);
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('does not reload a visible page when the update was applied while it was hidden', async () => {
    const sw = containerWithWaitingUpdate();
    const reload = vi.fn();
    const handle = startServiceWorker({ reload });
    await flush();

    setVisibility('hidden');
    setVisibility('visible');
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('ignores the first install and updates activated by another tab', async () => {
    const sw = new FakeContainer();
    installContainer(sw);
    const reload = vi.fn();
    const handle = startServiceWorker({ reload });
    await flush();

    // First install: no previous controller, clients.claim() fires controllerchange.
    sw.controller = {};
    sw.dispatchEvent(new Event('controllerchange'));
    handle.onNavigation();
    setVisibility('hidden');
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('detects an update installed later through updatefound / statechange', async () => {
    const sw = new FakeContainer();
    sw.controller = {};
    installContainer(sw);
    const handle = startServiceWorker({ reload: vi.fn() });
    await flush();

    const worker = new FakeWorker('installing');
    sw.registration.installing = worker;
    sw.registration.dispatchEvent(new Event('updatefound'));
    handle.onNavigation();
    expect(worker.postMessage).not.toHaveBeenCalled();

    worker.state = 'installed';
    sw.registration.installing = null;
    sw.registration.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    handle.onNavigation();
    expect(worker.postMessage).toHaveBeenCalledWith(SKIP_WAITING_MESSAGE);
    handle.dispose();
  });

  it('checks for a new sw.js at most once an hour when the app comes back to the foreground', async () => {
    const sw = new FakeContainer();
    installContainer(sw);
    let clock = 1_000_000;
    const handle = startServiceWorker({ now: () => clock });
    await flush();

    setVisibility('hidden');
    setVisibility('visible');
    expect(sw.registration.update).not.toHaveBeenCalled();

    clock += UPDATE_CHECK_INTERVAL_MS;
    setVisibility('hidden');
    setVisibility('visible');
    setVisibility('hidden');
    setVisibility('visible');
    expect(sw.registration.update).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('stops listening after dispose', async () => {
    const sw = containerWithWaitingUpdate();
    const reload = vi.fn();
    const handle = startServiceWorker({ reload });
    await flush();
    handle.dispose();

    setVisibility('hidden');
    handle.onNavigation();
    sw.dispatchEvent(new Event('controllerchange'));
    expect(sw.registration.waiting?.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('never throws when posting the message fails', async () => {
    const sw = containerWithWaitingUpdate();
    sw.registration.waiting?.postMessage.mockImplementation(() => {
      throw new DOMException('gone', 'InvalidStateError');
    });
    const handle = startServiceWorker({ reload: vi.fn() });
    await flush();
    expect(() => setVisibility('hidden')).not.toThrow();
    expect(() => handle.onNavigation()).not.toThrow();
    handle.dispose();
  });
});

describe('isMediaActive', () => {
  it('is false with no media and no active media session', () => {
    setPlaybackState('none');
    expect(isMediaActive()).toBe(false);
  });

  it('ignores paused or ended <audio> elements', () => {
    const ended = document.createElement('audio');
    Object.defineProperty(ended, 'paused', { configurable: true, value: false });
    Object.defineProperty(ended, 'ended', { configurable: true, value: true });
    document.body.append(document.createElement('audio'), ended);
    expect(isMediaActive()).toBe(false);
  });
});
