// @polsia:user-owned — pagina /admin/iscritti: caricamento, schede dei numeri, grafico degli
// ultimi 30 giorni con tabella accessibile, errore con "Riprova", stato vuoto, "Aggiorna", voce
// "Iscritti" nel menu amministrazione e scheda nella panoramica /admin.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  pathname: '/admin/iscritti',
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: null }) }));

import AdminPage from '@/app/(dashboard)/admin/page';
import { SignupsDashboard } from '@/components/custom/admin/signups-dashboard';
import { AdminNav } from '@/components/custom/dashboard/admin-nav';
import { signupDayKeys } from '@/lib/admin/signups';
import { type AdminSignups, AdminSignupsSchema } from '@/lib/contracts/admin-signups';

// 14:30 UTC = 15:30 a Roma (ora solare a novembre).
const NOW = new Date('2026-11-14T14:30:00.000Z');
const ENDPOINT = '/api/admin/signups';

function stats(
  counts: Record<string, number> = { '2026-10-16': 1, '2026-11-08': 6, '2026-11-14': 2 },
  extra: Partial<AdminSignups> = {},
): AdminSignups {
  return {
    generatedAt: NOW.toISOString(),
    timeZone: 'Europe/Rome',
    totals: {
      total: 12345,
      last24h: 2,
      last7d: 8,
      last30d: 9,
      verified: 8000,
      banned: 0,
      admins: 1,
    },
    daily: signupDayKeys(NOW).map((day) => ({ day, count: counts[day] ?? 0 })),
    ...extra,
  };
}

type FetchInit = { schema?: { parse: (value: unknown) => unknown } };

/** Risponde come il vero apiFetch: lo schema del contratto valida i dati di prova. */
function respond(value: unknown) {
  return async (_path: string, init?: FetchInit) =>
    init?.schema ? init.schema.parse(value) : value;
}

function apiError(status: number, body: Record<string, unknown>) {
  return new Error(`apiFetch ${ENDPOINT} failed (${status})`, { cause: body });
}

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(node: React.ReactNode = <SignupsDashboard />) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => root.render(node));
  await flush();
  return container;
}

function buttonByText(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    element.textContent?.includes(text),
  );
  if (!button) throw new Error(`Pulsante "${text}" non trovato.`);
  return button;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await flush();
}

function tile(container: HTMLElement, label: string) {
  const term = [...container.querySelectorAll('dt')].find((dt) => dt.textContent === label);
  const card = term?.closest('.app-ui-metric');
  if (!card) throw new Error(`Scheda "${label}" non trovata.`);
  return {
    value: card.querySelector('dd')?.textContent,
    detail: card.querySelector('.app-ui-metric-detail')?.textContent,
  };
}

function dayTable(container: HTMLElement) {
  const table = container.querySelector<HTMLTableElement>('figure table');
  if (!table) throw new Error('Tabella dei giorni non trovata.');
  return table;
}

function srRows(container: HTMLElement) {
  return [...dayTable(container).querySelectorAll('tbody tr')].map((row) => [
    row.querySelector('th')?.textContent,
    row.querySelector('td')?.textContent,
  ]);
}

function bar(container: HTMLElement, day: string) {
  const element = container.querySelector<HTMLElement>(`[data-day="${day}"]`);
  if (!element) throw new Error(`Barra ${day} non trovata.`);
  return element;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.apiFetch.mockReset();
  mocks.pathname = '/admin/iscritti';
});

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pagina iscritti: dati', () => {
  it('mostra il caricamento e poi le sei schede con i numeri e le finestre in ora italiana', async () => {
    let release: () => void = () => undefined;
    mocks.apiFetch.mockImplementationOnce(
      (_path: string, init: FetchInit) =>
        new Promise((resolve) => {
          release = () => resolve(init.schema?.parse(stats()));
        }),
    );
    const container = await mount();
    expect(container.textContent).toContain('Caricamento dei dati sugli iscritti…');
    expect(buttonByText(container, 'Aggiorna').getAttribute('aria-disabled')).toBe('true');
    expect(mocks.apiFetch).toHaveBeenCalledWith(ENDPOINT, { schema: AdminSignupsSchema });

    await act(async () => release());
    await flush();

    expect(container.textContent).not.toContain('Caricamento dei dati');
    expect(container.querySelector('h1')?.textContent).toBe('Iscritti');
    expect(tile(container, 'Totale iscritti')).toEqual({
      value: '12.345',
      detail: 'di cui 1 amministratore',
    });
    expect(tile(container, 'Ultime 24 ore')).toEqual({
      value: '2',
      detail: 'dal 13 nov alle 15:30',
    });
    expect(tile(container, 'Ultimi 7 giorni')).toEqual({
      value: '8',
      detail: 'dal 7 nov alle 15:30',
    });
    // Il 15 ottobre era ancora ora legale (+2): stesso istante, 16:30 a Roma.
    expect(tile(container, 'Ultimi 30 giorni')).toEqual({
      value: '9',
      detail: 'dal 15 ott alle 16:30',
    });
    expect(tile(container, 'Verificati')).toEqual({
      value: '8000',
      detail: 'Email o telefono · 64,8% del totale',
    });
    expect(tile(container, 'Bloccati')).toEqual({ value: '0', detail: 'Nessun blocco in corso' });

    const updated = container.querySelector('time');
    expect(updated?.textContent).toBe('15:30');
    expect(updated?.getAttribute('datetime')).toBe(NOW.toISOString());
    expect(container.textContent).toContain('Aggiornato alle 15:30');
  });

  it('disegna 30 barre con oggi a righe e una tabella per i lettori di schermo', async () => {
    mocks.apiFetch.mockImplementation(respond(stats()));
    const container = await mount();

    const bars = container.querySelectorAll('[data-day]');
    expect(bars).toHaveLength(30);
    expect(bars[0]?.getAttribute('data-day')).toBe('2026-10-16');
    expect(bars[29]?.getAttribute('data-day')).toBe('2026-11-14');
    expect(bar(container, '2026-11-14').hasAttribute('data-today')).toBe(true);
    expect(bar(container, '2026-11-13').hasAttribute('data-today')).toBe(false);
    expect(bar(container, '2026-11-13').hasAttribute('data-zero')).toBe(true);
    expect(bar(container, '2026-11-08').querySelector('span')?.style.height).toBe('100%');
    expect(bar(container, '2026-11-13').querySelector('span')?.style.height).toBe('0%');
    // Il disegno è decorativo: i numeri stanno nella tabella e nel riepilogo.
    expect(container.querySelector('[data-day]')?.closest('[aria-hidden="true"]')).not.toBeNull();

    const axis = [...container.querySelectorAll('figure [aria-hidden="true"] span')].map(
      (span) => span.textContent,
    );
    expect(axis).toContain('16 ott');
    expect(axis).toContain('Oggi');

    expect(container.querySelector('figcaption')?.textContent).toBe(
      '9 iscrizioni in 30 giorni. Il giorno con più iscrizioni: domenica 8 novembre (6).',
    );
    expect(dayTable(container).classList.contains('sr-only')).toBe(true);
    expect(dayTable(container).querySelector('caption')?.textContent).toBe(
      'Iscrizioni per giorno, dal più vecchio a oggi',
    );
    const rows = srRows(container);
    expect(rows).toHaveLength(30);
    expect(rows[0]).toEqual(['venerdì 16 ottobre', '1']);
    expect(rows).toContainEqual(['domenica 25 ottobre', '0']);
    expect(rows).toContainEqual(['domenica 8 novembre', '6']);
    expect(rows[29]).toEqual(['sabato 14 novembre (oggi, in corso)', '2']);
  });

  it('"Mostra i numeri per giorno" rende visibile la tabella anche a chi non usa il mouse', async () => {
    mocks.apiFetch.mockImplementation(respond(stats()));
    const container = await mount();
    const toggle = buttonByText(container, 'Mostra i numeri per giorno');
    // Il pulsante è raggiungibile: non sta nella parte decorativa nascosta ai lettori di schermo.
    expect(toggle.closest('[aria-hidden="true"]')).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(dayTable(container).id);

    await click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(dayTable(container).classList.contains('sr-only')).toBe(false);
    expect(srRows(container)).toHaveLength(30);
    expect(srRows(container)).toContainEqual(['domenica 8 novembre', '6']);

    await click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(dayTable(container).classList.contains('sr-only')).toBe(true);
  });

  it('dice quando non ci sono iscrizioni negli ultimi 30 giorni', async () => {
    mocks.apiFetch.mockImplementation(respond(stats({})));
    const container = await mount();
    expect(container.querySelector('figcaption')?.textContent).toBe(
      'Nessuna nuova iscrizione negli ultimi 30 giorni.',
    );
    expect(srRows(container).every(([, count]) => count === '0')).toBe(true);
  });

  it('mostra lo stato vuoto quando non c’è ancora nessun account', async () => {
    const empty = stats({});
    empty.totals = { ...empty.totals, total: 0, verified: 0, admins: 0, last30d: 0 };
    empty.totals.last24h = 0;
    empty.totals.last7d = 0;
    mocks.apiFetch.mockImplementation(respond(empty));
    const container = await mount();
    expect(container.textContent).toContain('Ancora nessun iscritto');
    expect(container.querySelector('dt')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });
});

describe('pagina iscritti: errori e aggiornamento', () => {
  it('mostra l’errore in pagina e riprova con "Riprova"', async () => {
    mocks.apiFetch.mockRejectedValueOnce(
      apiError(500, {
        error: 'signups_unavailable',
        message: 'I dati sugli iscritti non sono disponibili in questo momento. Riprova tra poco.',
      }),
    );
    const container = await mount();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Non riesco a mostrare i dati sugli iscritti.');
    expect(alert?.textContent).toContain(
      'I dati sugli iscritti non sono disponibili in questo momento. Riprova tra poco.',
    );
    expect(container.querySelector('dt')).toBeNull();

    mocks.apiFetch.mockImplementation(respond(stats()));
    await click(buttonByText(container, 'Riprova'));

    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(tile(container, 'Totale iscritti').value).toBe('12.345');
  });

  it('annuncia anche un secondo tentativo fallito con lo stesso messaggio', async () => {
    const failure = apiError(500, { error: 'signups_unavailable' });
    mocks.apiFetch.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    const container = await mount();
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    const status = container.querySelector('output');
    expect(status?.textContent).toBe('');

    await click(buttonByText(container, 'Riprova'));

    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    // Il riquadro di errore non cambia, quindi l'esito arriva dalla regione di stato.
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(alert?.textContent);
    expect(status?.textContent).toBe('Aggiornamento non riuscito.');
  });

  it('traduce i codici di errore e i problemi di rete', async () => {
    mocks.apiFetch.mockRejectedValueOnce(apiError(403, { error: 'forbidden' }));
    const container = await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Serve un account amministratore con email verificata.',
    );

    mocks.apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await click(buttonByText(container, 'Riprova'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Connessione non riuscita: controlla la rete e riprova.',
    );
  });

  it('"Aggiorna" ricarica i dati, annuncia l’orario e ignora i clic durante il caricamento', async () => {
    mocks.apiFetch.mockImplementationOnce(respond(stats()));
    const container = await mount();

    let release: () => void = () => undefined;
    const later = { ...stats(), generatedAt: '2026-11-14T14:35:00.000Z' };
    mocks.apiFetch.mockImplementationOnce(
      (_path: string, init: FetchInit) =>
        new Promise((resolve) => {
          release = () => resolve(init.schema?.parse(later));
        }),
    );
    await click(buttonByText(container, 'Aggiorna'));
    expect(buttonByText(container, 'Aggiornamento…').getAttribute('aria-disabled')).toBe('true');
    // I numeri precedenti restano visibili mentre arrivano quelli nuovi.
    expect(tile(container, 'Totale iscritti').value).toBe('12.345');
    await click(buttonByText(container, 'Aggiornamento…'));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);

    await act(async () => release());
    await flush();
    expect(container.querySelector('output')?.textContent).toBe('Dati aggiornati alle 15:35.');
    expect(container.querySelector('time')?.textContent).toBe('15:35');
  });

  it('se l’aggiornamento fallisce tiene i numeri precedenti e lo dice', async () => {
    mocks.apiFetch.mockImplementationOnce(respond(stats()));
    const container = await mount();
    mocks.apiFetch.mockRejectedValueOnce(apiError(503, { error: 'session_unavailable' }));
    await click(buttonByText(container, 'Aggiorna'));

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Aggiornamento non riuscito.');
    expect(alert?.textContent).toContain('Non riesco a verificare la sessione');
    expect(alert?.textContent).toContain('I numeri qui sotto sono quelli dell’ultima lettura.');
    expect(tile(container, 'Totale iscritti').value).toBe('12.345');
    expect(container.textContent).toContain('Aggiornato alle 15:30');
    expect(container.querySelector('output')?.textContent).toBe('Aggiornamento non riuscito.');
  });
});

describe('raggiungibilità', () => {
  it('il menu amministrazione ha la voce "Iscritti" attiva sulla pagina', async () => {
    const container = await mount(<AdminNav />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/iscritti"]');
    expect(link?.textContent).toBe('Iscritti');
    expect(link?.getAttribute('aria-current')).toBe('page');
    expect(link?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('la panoramica /admin ha la scheda "Iscritti" con il collegamento', async () => {
    mocks.pathname = '/admin';
    const container = await mount(<AdminPage />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/iscritti"]');
    expect(link?.textContent).toContain('Apri iscritti');
    const card = link?.closest('article');
    expect(card?.querySelector('h2')?.textContent).toBe('Iscritti');
    expect(card?.textContent).toContain('nessun dato personale');
  });
});
