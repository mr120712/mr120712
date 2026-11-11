// @polsia:user-owned — pagina /admin/monitoraggio: stati di caricamento/errore/vuoto, esito dei
// controlli, "Controlla ora", storico accessibile e voce nel menu amministrazione.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  pathname: '/admin/monitoraggio',
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));

import { AdminNav } from '@/components/custom/dashboard/admin-nav';
import { MonitoringDashboard } from '@/components/custom/monitoring/monitoring-dashboard';
import {
  formatRelative,
  historyEntryLabel,
} from '@/components/custom/monitoring/monitoring-format';
import {
  type AdminMonitoring,
  AdminMonitoringSchema,
  AdminMonitorRunResponseSchema,
  MONITOR_CHECK_IDS,
  type MonitorCheckId,
  type MonitorCheckResult,
  type MonitorRun,
  type MonitorRunSummary,
} from '@/lib/contracts/monitoring';
import { MONITOR_CHECKS } from '@/lib/monitoring/catalog';

// 10:30 UTC = 11:30 in Rome (CET in November).
const NOW = new Date('2026-11-11T10:30:00.000Z');
const ENDPOINT = '/api/admin/monitoring';

function minutesAgo(minutes: number) {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function makeRun(
  overrides: Partial<Record<MonitorCheckId, Partial<MonitorCheckResult>>> = {},
  run: Partial<MonitorRun> = {},
): MonitorRun {
  const results = MONITOR_CHECK_IDS.map((id) => ({
    id,
    status: 'ok' as const,
    detail: `Dettaglio ${id}`,
    ms: 120,
    ...overrides[id],
  }));
  const failing = results.filter((result) => result.status === 'fail');
  const status = failing.some((result) => MONITOR_CHECKS[result.id].critical)
    ? 'down'
    : failing.length > 0
      ? 'degraded'
      : 'ok';
  return {
    id: 'run-latest',
    startedAt: minutesAgo(5),
    durationMs: 2300,
    status,
    trigger: 'cron',
    results,
    ...run,
  };
}

function summary(run: MonitorRun): MonitorRunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    status: run.status,
    trigger: run.trigger,
    failing: run.results.filter((result) => result.status === 'fail').map((result) => result.id),
  };
}

function monitoring(latest: MonitorRun | null, extra: Partial<AdminMonitoring> = {}) {
  return {
    latest,
    history: latest ? [summary(latest)] : [],
    heartbeats: [
      {
        name: 'cleanup',
        at: minutesAgo(6 * 60),
        detail: 'Rimossi: 3 dati YouTube, 0 brani risolti',
      },
      { name: 'monitor', at: minutesAgo(5), detail: null },
    ],
    ...extra,
  } satisfies AdminMonitoring;
}

type FetchInit = { method?: string; schema?: { parse: (value: unknown) => unknown } };

/** Answers like the real apiFetch: the contract schema parses the fixture. */
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

async function mount(node: React.ReactNode = <MonitoringDashboard />) {
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

function checkItem(container: HTMLElement, id: MonitorCheckId) {
  const item = container.querySelector<HTMLElement>(`li[data-check="${id}"]`);
  if (!item) throw new Error(`Controllo ${id} non trovato.`);
  return item;
}

function overall(container: HTMLElement) {
  const section = container.querySelector<HTMLElement>('section[data-status]');
  if (!section) throw new Error('Stato generale non trovato.');
  return section;
}

/** Text of one "Lavori automatici" line, found by its bold label. */
function jobLine(container: HTMLElement, label: string) {
  const item = [...container.querySelectorAll<HTMLLIElement>('li')].find(
    (element) =>
      element.firstElementChild?.tagName === 'STRONG' &&
      element.firstElementChild.textContent === label,
  );
  if (!item) throw new Error(`Riga "${label}" non trovata.`);
  return item.textContent ?? '';
}

function historyButtons(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      'ol[aria-label="Storico dei controlli, dal più vecchio al più recente"] button',
    ),
  ];
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.apiFetch.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.toast.warning.mockReset();
  mocks.pathname = '/admin/monitoraggio';
});

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pagina monitoraggio: stati della lettura', () => {
  it('mostra il caricamento e poi tutti i controlli nell’ordine del contratto', async () => {
    let release: () => void = () => undefined;
    mocks.apiFetch.mockImplementationOnce(
      (_path: string, init: FetchInit) =>
        new Promise((resolve) => {
          release = () => resolve(init.schema?.parse(monitoring(makeRun())));
        }),
    );
    const container = await mount();
    expect(container.textContent).toContain('Caricamento dei controlli…');
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      ENDPOINT,
      expect.objectContaining({ schema: AdminMonitoringSchema }),
    );

    await act(async () => release());
    await flush();

    expect(container.textContent).not.toContain('Caricamento dei controlli…');
    const status = overall(container);
    expect(status.dataset.status).toBe('ok');
    expect(status.textContent).toContain('Tutto funziona');
    expect(status.textContent).toContain('5 minuti fa');
    expect(status.textContent).toContain('11:25');
    expect(status.textContent).toContain('avviato dal controllo giornaliero di Vercel');
    expect(status.textContent).toContain('14 funzionano');

    const items = [...container.querySelectorAll<HTMLElement>('li[data-check]')];
    expect(items.map((item) => item.dataset.check)).toEqual([...MONITOR_CHECK_IDS]);
    for (const item of items) {
      const info = MONITOR_CHECKS[item.dataset.check as MonitorCheckId];
      expect(item.querySelector('h3')?.textContent).toBe(info.label);
      expect(item.textContent).toContain(info.help);
      expect(item.textContent).toContain('Funziona');
      expect(item.textContent).toContain('Tempo: 120 ms');
    }
    expect(checkItem(container, 'database').textContent).toContain('Essenziale');
    expect(checkItem(container, 'radio').textContent).not.toContain('Essenziale');

    expect(container.textContent).toContain(
      'Pulizia giornaliera: ultima esecuzione 6 ore fa (11 nov, 05:30)',
    );
    expect(container.textContent).toContain('Rimossi: 3 dati YouTube');
    expect(jobLine(container, 'Controllo giornaliero (Vercel):')).toContain(
      'ultima esecuzione 5 minuti fa',
    );
    expect(jobLine(container, 'Controllo giornaliero (Vercel):')).not.toContain('In ritardo');
    expect(jobLine(container, 'Controllo orario (GitHub, /api/status):')).toContain(
      'non trovato nell’ultimo controllo',
    );
    expect(container.querySelector('h1')?.textContent).toBe('Monitoraggio');
  });

  it('distingue i guasti dagli avvisi quando il sito è degradato', async () => {
    const run = makeRun({
      radio: { status: 'fail', detail: 'Radio Browser non risponde (HTTP 502)' },
      email: { status: 'warn', detail: 'Email non configurate: le email di verifica non partono' },
    });
    mocks.apiFetch.mockImplementationOnce(respond(monitoring(run)));
    const container = await mount();

    const status = overall(container);
    expect(status.dataset.status).toBe('degraded');
    expect(status.textContent).toContain('Qualcosa non funziona');
    expect(status.textContent).toContain('Non funzionano: Radio');
    expect(status.textContent).toContain('Avvisi (nessuna email): Email');
    expect(status.textContent).toContain('12 funzionano · 1 avviso · 1 non funziona');

    const radio = checkItem(container, 'radio');
    expect(radio.dataset.status).toBe('fail');
    expect(radio.textContent).toContain('Non funziona');
    expect(radio.textContent).toContain('Radio Browser non risponde (HTTP 502)');
    expect(radio.querySelector('svg')).not.toBeNull();

    const email = checkItem(container, 'email');
    expect(email.dataset.status).toBe('warn');
    expect(email.textContent).toContain('Avviso');
    expect(email.textContent).not.toContain('Non funziona');
    expect(email.textContent).toContain('le email di verifica non partono');
  });

  it('segnala Solco non utilizzabile quando un controllo essenziale fallisce', async () => {
    const run = makeRun(
      { database: { status: 'fail', detail: 'Il database non risponde' } },
      { startedAt: minutesAgo(180), trigger: 'status' },
    );
    mocks.apiFetch.mockImplementationOnce(respond(monitoring(run)));
    const container = await mount();

    const status = overall(container);
    expect(status.dataset.status).toBe('down');
    expect(status.textContent).toContain('Solco non è utilizzabile');
    expect(status.textContent).toContain('Non funzionano: Database');
    expect(status.textContent).toContain('più di 2 ore');
    expect(checkItem(container, 'database').dataset.status).toBe('fail');
    expect(container.textContent).toContain(
      'avviato dal controllo orario di GitHub tramite l’indirizzo pubblico /api/status',
    );
  });

  it('mostra lo stato vuoto quando non esiste ancora un controllo', async () => {
    mocks.apiFetch.mockImplementationOnce(
      respond({ latest: null, history: [], heartbeats: [] } satisfies AdminMonitoring),
    );
    const container = await mount();

    expect(container.textContent).toContain('Nessun controllo ancora: premi Controlla ora');
    expect(container.querySelector('li[data-check]')).toBeNull();
    expect(container.querySelector('section[data-status]')).toBeNull();
    expect(buttonByText(container, 'Controlla ora')).toBeTruthy();
  });

  it('mostra l’errore del server e riprova la lettura', async () => {
    mocks.apiFetch
      .mockRejectedValueOnce(
        apiError(503, {
          error: 'monitoring_unavailable',
          message: 'Lo storico dei controlli non è disponibile in questo momento.',
        }),
      )
      .mockImplementationOnce(respond(monitoring(makeRun())));
    const container = await mount();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'Lo storico dei controlli non è disponibile in questo momento.',
    );
    expect(container.querySelector('li[data-check]')).toBeNull();

    await click(buttonByText(container, 'Riprova'));

    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(overall(container).textContent).toContain('Tutto funziona');
  });

  it('spiega un accesso negato senza messaggio del server', async () => {
    mocks.apiFetch.mockRejectedValueOnce(apiError(403, { error: 'forbidden' }));
    const container = await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Serve un account amministratore con email verificata.',
    );
  });
});

describe('pagina monitoraggio: Controlla ora', () => {
  it('avvia un controllo, lo annuncia e lo aggiunge allo storico', async () => {
    const fresh = makeRun({}, { id: 'run-new', startedAt: NOW.toISOString(), trigger: 'admin' });
    mocks.apiFetch
      .mockImplementationOnce(respond(monitoring(makeRun())))
      .mockImplementationOnce(respond({ run: fresh }));
    const container = await mount();
    expect(historyButtons(container)).toHaveLength(1);

    await click(buttonByText(container, 'Controlla ora'));

    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      ENDPOINT,
      expect.objectContaining({ method: 'POST', schema: AdminMonitorRunResponseSchema }),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Controllo completato: Tutto funziona.');
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(container.querySelector('output[aria-live="polite"]')?.textContent).toBe(
      'Controllo completato: Tutto funziona.',
    );
    const dots = historyButtons(container);
    expect(dots).toHaveLength(2);
    expect(dots.at(-1)?.getAttribute('aria-label')).toContain('pochi secondi fa');
    expect(overall(container).textContent).toContain('avviato da un amministratore');
  });

  it('ignora un secondo clic mentre il controllo è in corso', async () => {
    let finish: () => void = () => undefined;
    mocks.apiFetch.mockImplementationOnce(respond(monitoring(makeRun()))).mockImplementationOnce(
      (_path: string, init: FetchInit) =>
        new Promise((resolve) => {
          const run = makeRun(
            { radio: { status: 'fail', detail: 'Nessuna stazione' } },
            { id: 'run-new', startedAt: NOW.toISOString(), trigger: 'admin' },
          );
          finish = () => resolve(init.schema?.parse({ run }));
        }),
    );
    const container = await mount();
    const button = buttonByText(container, 'Controlla ora');

    await click(button);
    expect(button.textContent).toContain('Controllo in corso…');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await click(button);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);

    await act(async () => finish());
    await flush();
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'Controllo completato: Qualcosa non funziona.',
    );
    expect(overall(container).dataset.status).toBe('degraded');
    expect(button.textContent).toContain('Controlla ora');
  });

  it('mostra nel toast il messaggio 429 del server', async () => {
    const message = 'Hai già avviato diversi controlli di recente. Riprova tra 7 minuti.';
    mocks.apiFetch
      .mockImplementationOnce(respond(monitoring(makeRun())))
      .mockRejectedValueOnce(
        apiError(429, { error: 'rate_limited', message, retryAfterSeconds: 420 }),
      );
    const container = await mount();

    await click(buttonByText(container, 'Controlla ora'));

    expect(mocks.toast.error).toHaveBeenCalledWith(message);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(container.querySelector('output[aria-live="polite"]')?.textContent).toContain(message);
    // The previous result stays on screen.
    expect(overall(container).textContent).toContain('Tutto funziona');
    expect(historyButtons(container)).toHaveLength(1);
  });

  it('ricarica tutto se il controllo riesce mentre la lettura era fallita', async () => {
    const fresh = makeRun({}, { id: 'run-new', startedAt: NOW.toISOString(), trigger: 'admin' });
    mocks.apiFetch
      .mockRejectedValueOnce(apiError(503, { error: 'monitoring_unavailable' }))
      .mockImplementationOnce(respond({ run: fresh }))
      .mockImplementationOnce(respond(monitoring(fresh)));
    const container = await mount();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await click(buttonByText(container, 'Controlla ora'));
    await flush();

    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
    expect(mocks.apiFetch.mock.calls[2]?.[1]).not.toHaveProperty('method');
    expect(container.textContent).toContain('Pulizia giornaliera: ultima esecuzione 6 ore fa');
  });
});

describe('pagina monitoraggio: storico e informazioni', () => {
  it('etichetta ogni barra dello storico con ora, stato e controlli guasti, la più recente a destra', async () => {
    const latest = makeRun();
    const degraded = makeRun(
      { radio: { status: 'fail' }, podcasts: { status: 'fail' } },
      { id: 'run-degraded', startedAt: minutesAgo(65), trigger: 'status' },
    );
    const down = makeRun(
      { database: { status: 'fail' } },
      { id: 'run-down', startedAt: minutesAgo(125), trigger: 'cron' },
    );
    mocks.apiFetch.mockImplementationOnce(
      respond(monitoring(latest, { history: [summary(latest), summary(degraded), summary(down)] })),
    );
    const container = await mount();

    const dots = historyButtons(container);
    expect(dots).toHaveLength(3);
    const labels = dots.map((dot) => dot.getAttribute('aria-label') ?? '');
    expect(dots.map((dot) => dot.getAttribute('title'))).toEqual(labels);

    const [oldest, middle, newest] = labels;
    expect(oldest).toContain('Solco non è utilizzabile');
    expect(oldest).toContain('non funzionavano: Database');
    expect(oldest).toContain('2 ore fa');
    expect(middle).toContain('Qualcosa non funziona');
    expect(middle).toContain('non funzionavano: Radio, Podcast');
    expect(middle).toContain('10:25');
    expect(newest).toContain('Tutto funziona');
    expect(newest).toContain('5 minuti fa');
    expect(newest).not.toContain('non funzionavano');

    // Roving focus: only the selected (newest) bar is in the tab order.
    expect(dots.map((dot) => dot.tabIndex)).toEqual([-1, -1, 0]);
    expect(dots[2]?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      dots[2]?.focus();
      dots[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.activeElement).toBe(dots[1]);
    expect(dots[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Controllo selezionato:');
    expect(container.textContent).toContain(
      'avviato dal controllo orario di GitHub tramite l’indirizzo pubblico /api/status',
    );

    await click(dots[0] as HTMLButtonElement);
    expect(dots[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Problemi in 2 degli ultimi 3 controlli.');
  });

  it('non scambia i controlli orari di GitHub per il controllo giornaliero di Vercel', async () => {
    const latest = makeRun({}, { trigger: 'status' });
    const admin = makeRun({}, { id: 'run-admin', startedAt: minutesAgo(30), trigger: 'admin' });
    const older = makeRun({}, { id: 'run-status', startedAt: minutesAgo(65), trigger: 'status' });
    mocks.apiFetch.mockImplementationOnce(
      respond(monitoring(latest, { history: [summary(latest), summary(admin), summary(older)] })),
    );
    const container = await mount();

    expect(jobLine(container, 'Controllo giornaliero (Vercel):')).toContain(
      'non trovato negli ultimi 3 controlli',
    );
    expect(jobLine(container, 'Controllo orario (GitHub, /api/status):')).toContain(
      'ultima esecuzione 5 minuti fa',
    );
  });

  it('avvisa quando il controllo giornaliero di Vercel è in ritardo', async () => {
    const latest = makeRun({}, { trigger: 'status' });
    const cron = makeRun({}, { id: 'run-cron', startedAt: minutesAgo(30 * 60), trigger: 'cron' });
    mocks.apiFetch.mockImplementationOnce(
      respond(monitoring(latest, { history: [summary(latest), summary(cron)] })),
    );
    const container = await mount();

    const daily = jobLine(container, 'Controllo giornaliero (Vercel):');
    expect(daily).toContain('ultima esecuzione 30 ore fa');
    expect(daily).toContain('In ritardo: dovrebbe partire una volta al giorno');
  });

  it('spiega gli avvisi via email con il link ai controlli su GitHub', async () => {
    mocks.apiFetch.mockImplementationOnce(respond(monitoring(makeRun())));
    const container = await mount();
    expect(container.textContent).toContain(
      'Ogni ora GitHub controlla il sito dall’esterno e ti manda un’email se qualcosa si rompe',
    );
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/mr120712/mr120712/actions/workflows/monitor.yml"]',
    );
    expect(link?.target).toBe('_blank');
    expect(link?.rel.split(' ')).toContain('noopener');
  });

  it('aggiunge Monitoraggio al menu amministrazione', async () => {
    const container = await mount(<AdminNav />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/monitoraggio"]');
    expect(link?.textContent).toBe('Monitoraggio');
    expect(link?.getAttribute('aria-current')).toBe('page');
    expect(link?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('formattazione degli orari', () => {
  it('usa il tempo relativo in italiano e tollera orologi sfasati o date non valide', () => {
    const now = NOW.getTime();
    expect(formatRelative(minutesAgo(0.2), now)).toBe('pochi secondi fa');
    expect(formatRelative(new Date(now + 90_000).toISOString(), now)).toBe('pochi secondi fa');
    expect(formatRelative(minutesAgo(30), now)).toBe('30 minuti fa');
    expect(formatRelative(minutesAgo(26 * 60), now)).toBe('26 ore fa');
    expect(formatRelative(minutesAgo(47 * 60), now)).toBe('47 ore fa');
    expect(formatRelative(minutesAgo(71 * 60), now)).toBe('2 giorni fa');
    expect(formatRelative(minutesAgo(60), now)).toBe('1 ora fa');
    expect(formatRelative(minutesAgo(48 * 60), now)).toBe('2 giorni fa');
    expect(formatRelative('non-una-data', now)).toBe('in un momento sconosciuto');
    expect(
      historyEntryLabel(
        {
          id: 'x',
          startedAt: 'non-una-data',
          durationMs: 0,
          status: 'ok',
          trigger: 'cron',
          failing: [],
        },
        now,
      ),
    ).toContain('data sconosciuta');
  });
});
