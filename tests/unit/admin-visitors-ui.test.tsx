// @polsia:user-owned — pagina /admin/visitatori: caricamento, schede dei numeri, grafico degli
// ultimi 30 giorni con tabella accessibile, pagine più viste, Paesi con il nome in italiano,
// provenienze (o l'avviso quando mancano), dispositivi, nota sul metodo, errore con "Riprova",
// stato vuoto, "Aggiorna", voce "Visitatori" nel menu amministrazione e scheda nella panoramica.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  pathname: '/admin/visitatori',
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: null }) }));

import AdminPage from '@/app/(dashboard)/admin/page';
import VisitorsAdminPage from '@/app/(dashboard)/admin/visitatori/page';
import { countryName, VisitorsDashboard } from '@/components/custom/admin/visitors-dashboard';
import { AdminNav } from '@/components/custom/dashboard/admin-nav';
import { visitorDayKeys } from '@/lib/admin/visitors';
import { type AdminVisitors, AdminVisitorsSchema } from '@/lib/contracts/admin-visitors';

// 14:30 UTC = 15:30 a Roma (ora solare a novembre).
const NOW = new Date('2026-11-14T14:30:00.000Z');
const ENDPOINT = '/api/admin/visitors';

function stats(extra: Partial<AdminVisitors> = {}): AdminVisitors {
  const keys = visitorDayKeys(NOW);
  const perDay: Record<string, [number, number]> = {
    '2026-10-16': [1, 1],
    '2026-11-08': [6, 15],
    '2026-11-14': [2, 3],
  };
  const daily = keys.map((day) => ({
    day,
    visitors: perDay[day]?.[0] ?? 0,
    views: perDay[day]?.[1] ?? 0,
  }));
  return {
    generatedAt: NOW.toISOString(),
    timeZone: 'Europe/Rome',
    retentionDays: 90,
    today: { visitors: 2, views: 3 },
    last7d: { visitors: 8, views: 18 },
    last30d: { visitors: 9, views: 19 },
    daily,
    pages: [
      { path: '/', visitors: 9, views: 12 },
      { path: '/search', visitors: 4, views: 5 },
      { path: '/playlist/*', visitors: 1, views: 2 },
    ],
    countries: [
      { country: 'IT', visitors: 7 },
      { country: 'DE', visitors: 1 },
      { country: '', visitors: 1 },
    ],
    referrers: [{ host: 'www.google.com', visitors: 3 }],
    devices: [
      { device: 'mobile', visitors: 6 },
      { device: 'desktop', visitors: 3 },
    ],
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

async function mount(node: React.ReactNode = <VisitorsDashboard />) {
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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.pathname = '/admin/visitatori';
  mocks.apiFetch.mockReset().mockImplementation(respond(stats()));
});

afterEach(async () => {
  for (const { root } of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('/admin/visitatori', () => {
  it('la pagina monta la scheda e legge solo /api/admin/visitors con il contratto', async () => {
    const container = await mount(<VisitorsAdminPage />);
    expect(container.querySelector('h1')?.textContent).toBe('Visitatori');
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mocks.apiFetch.mock.calls[0] as [string, FetchInit];
    expect(path).toBe(ENDPOINT);
    expect(init.schema).toBe(AdminVisitorsSchema);
  });

  it('mostra le schede dei numeri e il contatore per visitatore', async () => {
    const container = await mount();
    expect(tile(container, 'Oggi')).toEqual({
      value: '2',
      detail: '3 pagine aperte · giornata in corso',
    });
    expect(tile(container, 'Ultimi 7 giorni')).toEqual({ value: '8', detail: '18 pagine aperte' });
    expect(tile(container, 'Ultimi 30 giorni')).toEqual({ value: '9', detail: '19 pagine aperte' });
    expect(tile(container, 'Pagine per visitatore').value).toBe('2,1');
    expect(container.textContent).toContain('Aggiornato alle 15:30');
  });

  it('il grafico ha 30 barre (oggi a righe), il riepilogo e la tabella accessibile', async () => {
    const container = await mount();
    const bars = container.querySelectorAll('[data-day]');
    expect(bars).toHaveLength(30);
    expect(container.querySelector('[data-day="2026-11-14"]')?.hasAttribute('data-today')).toBe(
      true,
    );
    expect(container.querySelector('[data-day="2026-11-08"]')?.getAttribute('title')).toContain(
      '6 visitatori · 15 pagine aperte',
    );
    expect(container.textContent).toContain('9 visitatori in 30 giorni');
    expect(container.textContent).toContain('Il giorno con più visitatori');

    const table = container.querySelector<HTMLTableElement>('table.sr-only');
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(30);
    await click(buttonByText(container, 'Mostra i numeri per giorno'));
    expect(container.querySelector('table.sr-only')).toBeNull();
    expect(buttonByText(container, 'Nascondi i numeri per giorno')).not.toBeNull();
  });

  it('elenca pagine, Paesi con il nome in italiano, provenienze e dispositivi', async () => {
    const container = await mount();
    const text = container.textContent ?? '';
    expect(text).toContain('Home (/)');
    expect(text).toContain('/search');
    expect(text).toContain('/playlist/*');
    expect(text).toContain('Italia');
    expect(text).toContain('Germania');
    expect(text).toContain('Paese sconosciuto');
    expect(text).toContain('www.google.com');
    expect(text).toContain('Telefono');
    expect(text).toContain('Computer');
    expect(text).toContain('si cancellano dopo 90 giorni');
    expect(countryName('FR')).toBe('Francia');
    expect(countryName('')).toBe('Paese sconosciuto');
  });

  it('senza provenienze mostra l’avviso degli accessi diretti', async () => {
    mocks.apiFetch.mockImplementation(respond(stats({ referrers: [] })));
    const container = await mount();
    expect(container.textContent).toContain('Nessun sito di provenienza negli ultimi 30 giorni');
  });

  it('stato vuoto quando non c’è ancora nessuna visita', async () => {
    mocks.apiFetch.mockImplementation(
      respond(
        stats({
          today: { visitors: 0, views: 0 },
          last7d: { visitors: 0, views: 0 },
          last30d: { visitors: 0, views: 0 },
          daily: visitorDayKeys(NOW).map((day) => ({ day, visitors: 0, views: 0 })),
          pages: [],
          countries: [],
          referrers: [],
          devices: [],
        }),
      ),
    );
    const container = await mount();
    expect(container.textContent).toContain('Ancora nessuna visita registrata');
    expect(container.querySelectorAll('[data-day]')).toHaveLength(0);
  });

  it('errore con il messaggio del server e "Riprova"; "Aggiorna" ricarica', async () => {
    mocks.apiFetch.mockRejectedValueOnce(
      apiError(500, { error: 'visitors_unavailable', message: 'Database non raggiungibile.' }),
    );
    const container = await mount();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Non riesco a mostrare i dati sui visitatori.');
    expect(alert?.textContent).toContain('Database non raggiungibile.');

    mocks.apiFetch.mockImplementation(respond(stats()));
    await click(buttonByText(container, 'Riprova'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(tile(container, 'Oggi').value).toBe('2');

    await click(buttonByText(container, 'Aggiorna'));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
  });

  it('403: spiega che serve un amministratore con email verificata', async () => {
    mocks.apiFetch.mockRejectedValueOnce(apiError(403, { error: 'forbidden' }));
    const container = await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Serve un account amministratore con email verificata.',
    );
  });

  it('il menu amministrazione ha la voce "Visitatori" attiva sulla pagina', async () => {
    const container = await mount(<AdminNav />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/visitatori"]');
    expect(link?.textContent).toBe('Visitatori');
    expect(link?.getAttribute('aria-current')).toBe('page');
  });

  it('la panoramica /admin ha la scheda "Visitatori" con il collegamento', async () => {
    mocks.pathname = '/admin';
    const container = await mount(<AdminPage />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/visitatori"]');
    const card = link?.closest('article');
    expect(card?.querySelector('h2')?.textContent).toBe('Visitatori');
    expect(card?.textContent).toContain('nessun indirizzo IP');
  });
});
