// @polsia:user-owned — contatore iscritti sulla landing pubblica: richiesta dopo il montaggio,
// scheletro finché non arrivano i numeri, numero nel formato della lingua scelta, "+N" solo se
// N > 0 (singolare per 1), niente contatore se la richiesta fallisce o il totale è 0 (resta solo lo
// spazio vuoto e invisibile dello scheletro, per non far saltare la pagina), conteggio animato solo
// senza movimento ridotto e una sola frase per i lettori di schermo.
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

type LandingModule = typeof import('@/components/custom/landing-page');
// Modulo ricaricato a ogni test: la lingua scelta durante una visita resta in memoria al suo interno.
let LandingPage: LandingModule['LandingPage'];

const UPDATED_AT = '2026-11-14T14:30:00.000Z';
const fetchMock = vi.fn();
const requestFrame = vi.fn((callback: FrameRequestCallback) => {
  frames.push(callback);
  return frames.length;
});
const cancelFrame = vi.fn();
let frames: FrameRequestCallback[] = [];
let reduceMotion = true;

const roots: Array<ReturnType<typeof createRoot>> = [];
let container: HTMLDivElement;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function stats(total: number, last7Days: number) {
  return jsonResponse({ total, last7Days, updatedAt: UPDATED_AT });
}

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<LandingPage />));
  return container;
}

/** Lascia arrivare la risposta finta (fetch → json → parse → stato). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function card() {
  return container.querySelector<HTMLElement>('p[data-state]');
}

/** Nessun contatore: solo lo spazio dello scheletro, vuoto, invisibile e nascosto ai lettori. */
function expectEmptySpace() {
  const element = card();
  expect(element?.dataset.state).toBe('hidden');
  expect(element?.getAttribute('aria-hidden')).toBe('true');
  expect(element?.childElementCount).toBe(0);
  expect(element?.textContent).toBe('');
  // Lo stesso elemento dello scheletro: l'altezza minima riservata resta, il contenuto no.
  expect(element?.previousElementSibling?.querySelector('a[href="/signup"]')).toBeTruthy();
}

function readyCard() {
  const element = card();
  if (!element || element.dataset.state !== 'ready') throw new Error('contatore non pronto');
  return element;
}

/** Testo per i lettori di schermo: il primo figlio, l'unico non nascosto con aria-hidden. */
function spokenPhrase() {
  return readyCard().firstElementChild?.textContent ?? '';
}

/** Valore animato visibile (accanto al valore finale invisibile che tiene la larghezza). */
function visibleNumber() {
  return readyCard().querySelector('strong')?.lastElementChild?.textContent ?? '';
}

function choose(value: string) {
  const select = container.querySelector<HTMLSelectElement>('select');
  if (!select) throw new Error('menu lingua mancante');
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.resetModules();
  ({ LandingPage } = await import('@/components/custom/landing-page'));
  fetchMock.mockReset();
  requestFrame.mockClear();
  cancelFrame.mockClear();
  frames = [];
  reduceMotion = true;
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: query === '(prefers-reduced-motion: no-preference)' ? !reduceMotion : reduceMotion,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);
  vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['it-IT']);
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('contatore iscritti sulla landing', () => {
  it('chiede i numeri dopo il montaggio e intanto mostra uno scheletro sotto i pulsanti', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/public/iscritti');
    const skeleton = card();
    expect(skeleton?.dataset.state).toBe('loading');
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    // Nessun numero finto mentre si aspetta.
    expect(skeleton?.textContent).toBe('');
    expect(skeleton?.children.length).toBeGreaterThan(0);
    // Subito dopo i pulsanti principali (registrazione e accesso).
    expect(skeleton?.previousElementSibling?.querySelector('a[href="/signup"]')).toBeTruthy();
  });

  it('numero nel formato della lingua, etichetta e nuovi; il cambio lingua non rifà la richiesta', async () => {
    fetchMock.mockReturnValue(stats(12345, 87));
    render();
    await settle();

    expect(readyCard().getAttribute('aria-hidden')).toBeNull();
    expect(spokenPhrase()).toBe('12.345 iscritti a Solco, +87 nuovi negli ultimi 7 giorni');
    expect(visibleNumber()).toBe('12.345');
    expect(readyCard().textContent).toContain('+87 nuovi negli ultimi 7 giorni');

    choose('de');
    expect(spokenPhrase()).toBe('12.345 Mitglieder bei Solco, +87 neue in den letzten 7 Tagen');
    choose('fr');
    expect(spokenPhrase()).toMatch(
      /^12[  ]345 inscrits sur Solco, \+87 nouveaux ces 7 derniers jours$/,
    );
    choose('en');
    expect(spokenPhrase()).toBe('12,345 people on Solco, +87 new in the last 7 days');
    expect(visibleNumber()).toBe('12,345');
    choose('es');
    expect(spokenPhrase()).toBe('12.345 personas en Solco, +87 en los últimos 7 días');
    choose('pt');
    expect(spokenPhrase()).toBe('12.345 pessoas no Solco, +87 nos últimos 7 dias');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('una sola frase per i lettori di schermo; la parte visibile è nascosta a loro; niente aria-live', async () => {
    fetchMock.mockReturnValue(stats(12345, 87));
    render();
    await settle();

    const [spoken, ...visual] = Array.from(readyCard().children);
    expect(spoken?.getAttribute('aria-hidden')).toBeNull();
    expect(spoken?.textContent).toBe('12.345 iscritti a Solco, +87 nuovi negli ultimi 7 giorni');
    expect(visual.length).toBeGreaterThan(0);
    for (const element of visual) expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(readyCard().hasAttribute('aria-live')).toBe(false);
    expect(readyCard().querySelector('[aria-live]')).toBeNull();
  });

  it.each([
    ['errore di rete', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['503 dal server', () => jsonResponse({ error: 'unavailable' }, 503)],
    ['forma inattesa', () => jsonResponse({ total: '12', last7Days: 0, updatedAt: UPDATED_AT })],
    [
      'campi in più',
      () => jsonResponse({ total: 12, last7Days: 0, updatedAt: UPDATED_AT, banned: 3 }),
    ],
  ])('nasconde il contatore se la richiesta fallisce (%s)', async (_name, response) => {
    fetchMock.mockImplementation(response);
    render();
    const skeleton = card();
    await settle();
    expectEmptySpace();
    expect(card()).toBe(skeleton);
    expect(container.textContent).not.toMatch(/iscritt/);
  });

  it('nasconde il contatore con 0 iscritti: mai un numero di riempimento', async () => {
    fetchMock.mockReturnValue(stats(0, 0));
    render();
    await settle();
    expectEmptySpace();
    expect(container.textContent).not.toMatch(/iscritt/);
  });

  it('"+N" solo quando N > 0', async () => {
    fetchMock.mockReturnValue(stats(40, 0));
    render();
    await settle();
    expect(spokenPhrase()).toBe('40 iscritti a Solco');
    expect(readyCard().textContent).not.toContain('+');
  });

  it('singolare per 1 iscritto e per 1 nuovo, in ogni lingua scelta', async () => {
    fetchMock.mockReturnValue(stats(1, 1));
    render();
    await settle();
    expect(spokenPhrase()).toBe('1 iscritto a Solco, +1 nuovo negli ultimi 7 giorni');
    choose('en');
    expect(spokenPhrase()).toBe('1 person on Solco, +1 new in the last 7 days');
    choose('de');
    expect(spokenPhrase()).toBe('1 Mitglied bei Solco, +1 neues in den letzten 7 Tagen');
  });

  it('movimento ridotto: numero finale subito, nessuna animazione', async () => {
    reduceMotion = true;
    fetchMock.mockReturnValue(stats(12345, 87));
    render();
    await settle();
    expect(visibleNumber()).toBe('12.345');
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('senza preferenza di movimento il numero sale da 0; i lettori di schermo hanno subito il finale', async () => {
    reduceMotion = false;
    fetchMock.mockReturnValue(stats(12345, 87));
    render();
    await settle();

    expect(visibleNumber()).toBe('0');
    expect(spokenPhrase()).toBe('12.345 iscritti a Solco, +87 nuovi negli ultimi 7 giorni');
    // Il valore finale invisibile riserva già la larghezza del numero.
    expect(readyCard().querySelector('strong')?.firstElementChild?.textContent).toBe('12.345');

    const runFrame = (time: number) => {
      const callback = frames.shift();
      if (!callback) throw new Error('nessun fotogramma in coda');
      act(() => callback(time));
    };
    runFrame(1000);
    expect(visibleNumber()).toBe('0');
    runFrame(1450);
    const halfway = Number(visibleNumber().replace(/\D/g, ''));
    expect(halfway).toBeGreaterThan(0);
    expect(halfway).toBeLessThan(12345);
    runFrame(1900);
    expect(visibleNumber()).toBe('12.345');
    expect(frames).toHaveLength(0);
  });

  it('se la landing si smonta prima della risposta la richiesta viene annullata', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal?.aborted).toBe(false);
    act(() => roots.pop()?.unmount());
    expect(init?.signal?.aborted).toBe(true);
  });
});
