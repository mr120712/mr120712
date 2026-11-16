// @polsia:user-owned — segnale di visita: un POST a /api/visits per ogni pagina aperta (con la
// provenienza solo alla prima), mai due volte lo stesso percorso, niente nell'area admin, niente se
// il browser chiede di non essere tracciato o è un'automazione.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import { VisitBeacon, visitPathFor, visitTrackingAllowed } from '@/components/custom/visit-beacon';

const roots: Array<ReturnType<typeof createRoot>> = [];
let fetchMock: ReturnType<typeof vi.fn>;

function sentBodies() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit).method,
    keepalive: (init as RequestInit).keepalive,
    body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
  }));
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<VisitBeacon />));
  return root;
}

async function navigate(root: ReturnType<typeof createRoot>, pathname: string) {
  nav.pathname = pathname;
  await act(async () => root.render(<VisitBeacon />));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  nav.pathname = '/';
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'webdriver', { configurable: true, value: false });
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'webdriver');
  Reflect.deleteProperty(navigator, 'doNotTrack');
  document.body.replaceChildren();
});

describe('visitPathFor e visitTrackingAllowed', () => {
  it('conta le pagine del sito, non l’amministrazione', () => {
    expect(visitPathFor('/')).toBe('/');
    expect(visitPathFor('/search')).toBe('/search');
    expect(visitPathFor('/admin')).toBeNull();
    expect(visitPathFor('/admin/visitatori')).toBeNull();
    expect(visitPathFor(null)).toBeNull();
    expect(visitPathFor('search')).toBeNull();
  });

  it('rispetta Do Not Track, Global Privacy Control e le automazioni', () => {
    expect(visitTrackingAllowed({ webdriver: false, doNotTrack: null })).toBe(true);
    expect(visitTrackingAllowed({ webdriver: false, doNotTrack: '0' })).toBe(true);
    expect(visitTrackingAllowed({ webdriver: false, doNotTrack: '1' })).toBe(false);
    expect(visitTrackingAllowed({ webdriver: false, globalPrivacyControl: true })).toBe(false);
    expect(visitTrackingAllowed({ webdriver: true })).toBe(false);
  });
});

describe('<VisitBeacon/>', () => {
  it('manda un POST same-origin per pagina, con keepalive, e lo stesso percorso una volta sola', async () => {
    const root = await mount();
    await navigate(root, '/');
    await navigate(root, '/search');
    await navigate(root, '/search');
    await navigate(root, '/guida');
    const sent = sentBodies();
    expect(sent.map((item) => item.body.path)).toEqual(['/', '/search', '/guida']);
    for (const item of sent) {
      expect(item.url).toBe('/api/visits');
      expect(item.method).toBe('POST');
      expect(item.keepalive).toBe(true);
      expect(Object.keys(item.body).sort()).toEqual(['path']);
    }
  });

  it('allega la provenienza solo alla prima pagina', async () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://www.google.com/',
    });
    try {
      const root = await mount();
      await navigate(root, '/search');
      const sent = sentBodies();
      expect(sent[0]?.body).toEqual({ path: '/', referrer: 'https://www.google.com/' });
      expect(sent[1]?.body).toEqual({ path: '/search' });
    } finally {
      Reflect.deleteProperty(document, 'referrer');
    }
  });

  it('non manda nulla nell’area admin, con Do Not Track o sotto automazione', async () => {
    nav.pathname = '/admin/visitatori';
    const root = await mount();
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' });
    await navigate(root, '/search');
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
    Object.defineProperty(navigator, 'webdriver', { configurable: true, value: true });
    await navigate(root, '/guida');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un errore di rete non rompe la pagina', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const root = await mount();
    await navigate(root, '/search');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
