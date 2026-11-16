// @polsia:user-owned — monitoraggio esterno (scripts/monitor/check-site.ts): il controllo
// sintetico del monitor cieco (Attack Challenge Mode di Vercel acceso), la sua soglia di 6 giri
// nella macchina a stati, i promemoria, il ritorno a funzionare, e il caricamento dello script
// con il type stripping di Node, come lo esegue il workflow.
// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AlertDecision,
  alertThreshold,
  type CheckResult,
  type CheckStatus,
  decideAlerts,
  describeDuration,
  FIREWALL_BLIND_ALERT_AFTER,
  FIREWALL_BLIND_ID,
  FIREWALL_CHALLENGE_DETAIL,
  FIREWALL_DECISIVE,
  FIREWALL_SENTINELS,
  firewallBlindResult,
  labelForId,
  type MonitorReport,
  PUBLIC_PAGES,
  renderMarkdown,
} from '../../scripts/monitor/check-site';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-11-14T17:23:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

function row(id: string, status: CheckStatus, critical = false): CheckResult {
  return { id, label: labelForId(id), critical, status, detail: 'dettaglio', ms: 100 };
}

function challenged(id: string, critical = false): CheckResult {
  return {
    ...row(id, 'warn', critical),
    detail: FIREWALL_CHALLENGE_DETAIL,
    firewallChallenged: true,
  };
}

/** Le righe HTTP di un giro (senza response_time): tutte fermate, o tutte con risposte vere. */
const HTTP_IDS = [
  'site_health',
  ...PUBLIC_PAGES.map((page) => `page:${page.path}`),
  'security_headers',
  'seo_files',
  'google_signin',
  'signup_route',
  'catalog_radio',
  'catalog_podcasts',
  'catalog_audius',
  'internal_status',
];
const CRITICAL = new Set(['site_health', 'page:/', 'google_signin', 'signup_route']);
const acmRun = (): CheckResult[] => HTTP_IDS.map((id) => challenged(id, CRITICAL.has(id)));
const healthyRun = (): CheckResult[] => HTTP_IDS.map((id) => row(id, 'ok', CRITICAL.has(id)));

/** Come main(): la riga del monitor cieco dipende dallo stato del giro precedente. */
function runs(sequence: CheckResult[][], start: unknown = null): AlertDecision[] {
  let state: unknown = start;
  return sequence.map((checks, hour) => {
    const now = at(hour);
    const decision = decideAlerts(state, [firewallBlindResult(checks, state, now), ...checks], now);
    state = JSON.parse(JSON.stringify(decision.state));
    return decision;
  });
}

const blindAlerts = (decisions: AlertDecision[]) =>
  decisions.flatMap((decision, hour) =>
    decision.alerts
      .filter((alert) => alert.id === FIREWALL_BLIND_ID)
      .map((alert) => [hour, alert.kind]),
  );

describe('firewallBlindResult (la regola)', () => {
  it('fallisce quando la verifica di Vercel ferma tutto, con soglia di 6 giri e messaggio in italiano', () => {
    const result = firewallBlindResult(acmRun(), null, T0);
    expect(result).toMatchObject({
      id: 'firewall_blind',
      label: 'Visibilità del monitor (firewall di Vercel)',
      critical: false,
      status: 'fail',
      alertAfter: 6,
      ms: null,
    });
    expect(FIREWALL_BLIND_ALERT_AFTER).toBe(6);
    expect(result.detail).toBe(
      'Il monitor non può verificare il sito da meno di un’ora (dal 14/11/2026, 18:23): la ' +
        'protezione anti-attacco di Vercel (Attack Challenge Mode) ferma anche /health e ' +
        '/api/status. Un guasto vero non manderebbe email. Per spegnerla: Vercel → Firewall → ' +
        'Attack Challenge Mode, o aspetta che scada.',
    );
  });

  it('prende la durata dallo stato (failingSince della riga) e resta entro i 300 caratteri del riepilogo', () => {
    const state = (failingSince: string) => ({
      version: 1,
      checks: { firewall_blind: { failingSince, consecutive: 9, lastAlertAt: null } },
    });
    const five = firewallBlindResult(acmRun(), state(T0.toISOString()), at(5));
    expect(five.detail).toContain('da 5 ore (dal 14/11/2026, 18:23)');
    const long = firewallBlindResult(acmRun(), state('2026-07-01T00:00:00.000Z'), at(5));
    expect(long.detail).toContain('da 136 giorni e 22 ore (dal 01/07/2026, 02:00)');
    expect(long.detail.length).toBeLessThanOrEqual(300);
    // Uno stato datato nel futuro (corrotto) non produce durate negative.
    const future = firewallBlindResult(acmRun(), state('2099-01-01T00:00:00.000Z'), T0);
    expect(future.detail).toContain('da meno di un’ora (dal 14/11/2026, 18:23)');
  });

  it('un giro solo in parte fermato non lo fa scattare se /api/status ha una risposta vera', () => {
    expect(FIREWALL_DECISIVE).toBe('internal_status');
    const pagesOnly = HTTP_IDS.map((id) =>
      id.startsWith('page:') ? challenged(id, CRITICAL.has(id)) : row(id, 'ok', CRITICAL.has(id)),
    );
    // Fermi solo i controlli delle pagine: tanti quante le pagine pubbliche dell'elenco.
    expect(firewallBlindResult(pagesOnly, null, T0)).toMatchObject({
      status: 'ok',
      detail: `Il firewall di Vercel ferma ${PUBLIC_PAGES.length} controlli, ma non /health e /api/status: un guasto vero resta visibile`,
    });
    // /health fermato, /api/status risponde (anche con un errore): app giù o database spento si
    // vedono comunque da /api/status.
    for (const status of ['ok', 'fail'] as const) {
      const statusFree = acmRun().map((result) =>
        result.id === 'internal_status' ? row('internal_status', status) : result,
      );
      expect(firewallBlindResult(statusFree, null, T0), status).toMatchObject({
        status: 'ok',
        detail: `Il firewall di Vercel ferma ${HTTP_IDS.length - 1} controlli, ma non /api/status: un guasto vero resta visibile`,
      });
    }
    expect(firewallBlindResult(healthyRun(), null, T0)).toMatchObject({
      status: 'ok',
      detail: 'Il firewall di Vercel non ferma il monitor',
    });
    expect(firewallBlindResult([], null, T0).status).toBe('ok');
  });

  it('scatta quando /api/status è fermato anche se /health risponde: /health non vede il database', () => {
    const message =
      'Il monitor non può verificare database e accesso da meno di un’ora (dal 14/11/2026, ' +
      '18:23): la protezione anti-attacco di Vercel (Attack Challenge Mode) ferma /api/status. ' +
      'Un loro guasto non manderebbe email. Per spegnerla: Vercel → Firewall → Attack Challenge ' +
      'Mode, o aspetta che scada.';
    // /health risponde "healthy" (o anche un errore: quello avvisa da sé), /api/status è fermato.
    for (const health of ['ok', 'fail'] as const) {
      const healthFree = acmRun().map((result) =>
        result.id === 'site_health' ? row('site_health', health, true) : result,
      );
      expect(firewallBlindResult(healthFree, null, T0), health).toMatchObject({
        status: 'fail',
        alertAfter: 6,
        detail: message,
      });
    }
    // Basta /api/status fermato, anche con tutto il resto libero (una regola solo su /api/*).
    const onlyStatus = healthyRun().map((result) =>
      result.id === 'internal_status' ? challenged('internal_status') : result,
    );
    expect(firewallBlindResult(onlyStatus, null, T0)).toMatchObject({
      status: 'fail',
      detail: message,
    });
    const long = firewallBlindResult(
      onlyStatus,
      {
        version: 1,
        checks: {
          firewall_blind: {
            failingSince: '2026-07-01T00:00:00.000Z',
            consecutive: 9,
            lastAlertAt: null,
          },
        },
      },
      at(5),
    );
    expect(long.detail).toContain('database e accesso da 136 giorni e 22 ore (dal 01/07/2026');
    expect(long.detail.length).toBeLessThanOrEqual(300);
  });

  it('scatta anche se un’altra riga non è stata fermata (errore di rete passeggero su una pagina)', () => {
    expect(FIREWALL_SENTINELS).toEqual(['site_health', 'internal_status']);
    const noisy = acmRun().map((result) =>
      result.id === 'page:/radio' ? row('page:/radio', 'fail') : result,
    );
    expect(firewallBlindResult(noisy, null, T0).status).toBe('fail');
    // Solo la verifica del firewall di Vercel conta: la schermata UAM di Solco no.
    const uam = acmRun().map(({ firewallChallenged: _firewall, ...result }) => ({
      ...result,
      detail: 'Schermata anti-bot (UAM) attiva: pagina non verificata',
    }));
    expect(firewallBlindResult(uam, null, T0).status).toBe('ok');
  });
});

describe('describeDuration', () => {
  it('scrive la durata per difetto, in italiano', () => {
    expect(describeDuration(0)).toBe('meno di un’ora');
    expect(describeDuration(59 * 60 * 1000)).toBe('meno di un’ora');
    expect(describeDuration(HOUR)).toBe('un’ora');
    expect(describeDuration(5.9 * HOUR)).toBe('5 ore');
    expect(describeDuration(47 * HOUR)).toBe('47 ore');
    expect(describeDuration(48 * HOUR)).toBe('2 giorni');
    expect(describeDuration(49 * HOUR)).toBe('2 giorni e un’ora');
    expect(describeDuration(75 * HOUR)).toBe('3 giorni e 3 ore');
    expect(describeDuration(-HOUR)).toBe('meno di un’ora');
    expect(describeDuration(Number.NaN)).toBe('meno di un’ora');
  });
});

describe('alertThreshold', () => {
  it('usa alertAfter quando è un intero valido, altrimenti la regola di critical', () => {
    expect(alertThreshold({ critical: true })).toBe(1);
    expect(alertThreshold({ critical: false })).toBe(2);
    expect(alertThreshold({ critical: true, alertAfter: 6 })).toBe(6);
    expect(alertThreshold({ critical: false, alertAfter: 6 })).toBe(6);
    for (const bad of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(alertThreshold({ critical: false, alertAfter: bad }), String(bad)).toBe(2);
    }
    expect(alertThreshold({ critical: false, alertAfter: 10 ** 9 })).toBe(1_000);
  });
});

describe('monitor cieco nella macchina a stati', () => {
  it('nessuna email nei primi 5 giri, la prima al sesto giro di fila', () => {
    const decisions = runs(Array.from({ length: 6 }, acmRun));
    for (const [hour, decision] of decisions.slice(0, 5).entries()) {
      expect(decision.alerts, String(hour)).toEqual([]);
      expect(decision.ongoing).toEqual([
        expect.objectContaining({
          id: FIREWALL_BLIND_ID,
          alerted: false,
          alertAfter: 6,
          consecutive: hour + 1,
          failingSince: T0.toISOString(),
        }),
      ]);
    }
    expect(decisions[5]?.alerts).toEqual([
      expect.objectContaining({
        id: FIREWALL_BLIND_ID,
        kind: 'new',
        critical: false,
        consecutive: 6,
        failingSince: T0.toISOString(),
        detail: expect.stringContaining('da 5 ore (dal 14/11/2026, 18:23)'),
      }),
    ]);
    // Le singole righe fermate restano avvisi: niente stato, niente email.
    expect(Object.keys(decisions[5]?.state.checks ?? {})).toEqual([FIREWALL_BLIND_ID]);
  });

  it('poi segue il promemoria giornaliero come gli altri controlli', () => {
    const decisions = runs(Array.from({ length: 60 }, acmRun));
    expect(blindAlerts(decisions)).toEqual([
      [5, 'new'],
      [29, 'reminder'],
      [53, 'reminder'],
    ]);
    expect(decisions[6]?.ongoing).toEqual([
      expect.objectContaining({ id: FIREWALL_BLIND_ID, alerted: true }),
    ]);
    expect(decisions[29]?.alerts[0]?.detail).toContain('da 29 ore');
    expect(decisions[53]?.alerts[0]?.detail).toContain('da 2 giorni e 5 ore');
  });

  it('il promemoria viaggia con l’email di un altro problema, come gli altri (dopo 12 ore)', () => {
    const sequence = Array.from({ length: 18 }, acmRun);
    // Al giro 18 la home dà un errore di rete (critico, email subito) mentre il blocco continua.
    sequence.push(
      acmRun().map((result) => (result.id === 'page:/' ? row('page:/', 'fail', true) : result)),
    );
    sequence.push(healthyRun());
    const decisions = runs(sequence);
    expect(decisions[17]?.alerts).toEqual([]);
    expect(decisions[18]?.alerts).toEqual([
      expect.objectContaining({ id: 'page:/', kind: 'new' }),
      expect.objectContaining({ id: FIREWALL_BLIND_ID, kind: 'reminder' }),
    ]);
    expect(decisions[18]?.state.checks.firewall_blind?.lastAlertAt).toBe(at(18).toISOString());
    // Al giro 19 arrivano risposte vere: il monitor vede di nuovo, quindi torna a funzionare.
    expect(decisions[19]?.recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: FIREWALL_BLIND_ID, wasAlerted: true }),
      ]),
    );
  });

  it('torna a funzionare al primo giro con risposte vere; un nuovo blocco poco dopo non manda un’altra email', () => {
    const decisions = runs([
      ...Array.from({ length: 7 }, acmRun),
      healthyRun(),
      ...Array.from({ length: 6 }, acmRun),
    ]);
    expect(decisions[7]?.recovered).toEqual([
      {
        id: FIREWALL_BLIND_ID,
        label: 'Visibilità del monitor (firewall di Vercel)',
        failingSince: T0.toISOString(),
        wasAlerted: true,
      },
    ]);
    expect(decisions[7]?.alerts).toEqual([]);
    expect(decisions[7]?.state.checks).toEqual({});
    expect(decisions[7]?.state.recent).toEqual({
      firewall_blind: { lastAlertAt: at(5).toISOString(), recoveredAt: at(7).toISOString() },
    });
    // Di nuovo cieco entro 6 ore: già segnalato, nessuna nuova email (come un controllo che va e viene).
    expect(blindAlerts(decisions)).toEqual([[5, 'new']]);
    expect(decisions[8]?.ongoing).toEqual([
      expect.objectContaining({ id: FIREWALL_BLIND_ID, alerted: true, consecutive: 1 }),
    ]);
    expect(decisions[8]?.ongoing[0]?.failingSince).toBe(at(8).toISOString());
  });

  it('un blocco più corto della soglia non manda email e azzera il conto', () => {
    const decisions = runs([
      ...Array.from({ length: 5 }, acmRun),
      healthyRun(),
      ...Array.from({ length: 5 }, acmRun),
    ]);
    expect(decisions.flatMap((decision) => decision.alerts)).toEqual([]);
    expect(decisions[5]?.recovered).toEqual([
      expect.objectContaining({ id: FIREWALL_BLIND_ID, wasAlerted: false }),
    ]);
    expect(decisions[10]?.state.checks.firewall_blind?.consecutive).toBe(5);
  });

  it('un giro solo in parte fermato, con /api/status che risponde, non entra mai nello stato', () => {
    const partial = () =>
      acmRun().map((result) =>
        result.id === 'internal_status' ? row('internal_status', 'ok') : result,
      );
    const decisions = runs(Array.from({ length: 10 }, partial));
    for (const decision of decisions) {
      expect(decision.alerts).toEqual([]);
      expect(decision.state.checks).toEqual({});
    }
  });

  it('/health risponde ma /api/* è fermato (regola solo sulle API): email al sesto giro', () => {
    const apiOnly = () =>
      healthyRun().map((result) =>
        result.id.startsWith('catalog_') ||
        ['google_signin', 'signup_route', 'internal_status'].includes(result.id)
          ? challenged(result.id, CRITICAL.has(result.id))
          : result,
      );
    const decisions = runs(Array.from({ length: 8 }, apiOnly));
    expect(blindAlerts(decisions)).toEqual([[5, 'new']]);
    expect(decisions[5]?.alerts[0]?.detail).toContain(
      'Il monitor non può verificare database e accesso da 5 ore (dal 14/11/2026, 18:23)',
    );
    expect(decisions[4]?.ongoing).toEqual([
      expect.objectContaining({ id: FIREWALL_BLIND_ID, alerted: false, consecutive: 5 }),
    ]);
    expect(Object.keys(decisions[7]?.state.checks ?? {})).toEqual([FIREWALL_BLIND_ID]);
  });

  it('nel riepilogo dice quanti giri mancano alla prima email', () => {
    const decisions = runs(Array.from({ length: 3 }, acmRun));
    const results = [firewallBlindResult(acmRun(), decisions[1]?.state, at(2)), ...acmRun()];
    const report: MonitorReport = {
      baseUrl: 'https://solcomusic.vercel.app',
      startedAt: at(2),
      finishedAt: at(2),
      results,
      decision: decisions[2] as AlertDecision,
      notes: [],
    };
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('3 controlli di fila: email solo se continua per altri 3 controlli');
    expect(markdown).toContain(
      '| ❌ | Visibilità del monitor (firewall di Vercel) | Il monitor non può verificare il sito da 2 ore',
    );
    expect(markdown).toContain(
      '**❌ Problemi già segnalati o in attesa di conferma nei prossimi controlli**',
    );
    // Un controllo normale al primo errore mantiene la nota di sempre.
    const plain = decideAlerts(null, [row('seo_files', 'fail')], T0);
    expect(
      renderMarkdown({ ...report, results: [row('seo_files', 'fail')], decision: plain }),
    ).toContain('primo errore: email solo se si ripete al prossimo controllo');
  });
});

describe('un guasto in corso quando si accende la verifica di Vercel', () => {
  const OUTAGE = at(-3).toISOString();
  const kept = { failingSince: OUTAGE, consecutive: 3, lastAlertAt: OUTAGE };
  /** Stato prima dell'Attack Challenge Mode: sito e database giù da 3 giri, già segnalati. */
  const outageState = () => ({
    version: 1,
    checks: { site_health: { ...kept }, 'internal:database': { ...kept } },
  });
  /** Giro con risposte vere e il guasto ancora in corso: /health 502, database spento. */
  const outageRun = (): CheckResult[] => [
    ...healthyRun().map((result) =>
      result.id === 'site_health' ? row('site_health', 'fail', true) : result,
    ),
    { ...row('internal:database', 'fail', true), ms: null },
  ];

  it('le righe fermate non tornano a funzionare: lo stato resta com’era, internal:* compresi', () => {
    const [decision] = runs([acmRun()], outageState());
    expect(decision?.recovered).toEqual([]);
    expect(decision?.alerts).toEqual([]);
    expect(decision?.state.checks).toEqual({
      firewall_blind: { failingSince: T0.toISOString(), consecutive: 1, lastAlertAt: null },
      site_health: kept,
      'internal:database': kept,
    });
    expect(decision?.state.recent).toBeUndefined();
    // Anche da sola: /api/status fermato non dice niente dei controlli interni.
    const alone = decideAlerts(outageState(), [challenged('internal_status')], T0);
    expect(alone.recovered).toEqual([]);
    expect(alone.state.checks['internal:database']).toEqual(kept);
    // Una risposta vera di /api/status, invece, li fa tornare a funzionare come sempre.
    const answered = decideAlerts(outageState(), [row('internal_status', 'ok')], T0);
    expect(answered.recovered.map((item) => item.id)).toEqual(['internal:database']);
  });

  it('più lungo della finestra di 6 ore: nessuna email "nuova" quando le risposte tornano, poi guarisce con la data giusta', () => {
    const decisions = runs(
      [...Array.from({ length: 8 }, acmRun), outageRun(), healthyRun()],
      outageState(),
    );
    for (const [hour, decision] of decisions.slice(0, 8).entries()) {
      expect(decision.recovered, String(hour)).toEqual([]);
      expect(decision.state.checks.site_health, String(hour)).toEqual(kept);
      expect(decision.state.checks['internal:database'], String(hour)).toEqual(kept);
    }
    // Durante il blocco avvisa solo il monitor cieco.
    expect(decisions.flatMap((decision) => decision.alerts.map((alert) => alert.id))).toEqual([
      FIREWALL_BLIND_ID,
    ]);
    // Al giro 8 le risposte tornano e il guasto c'è ancora: già segnalato, nessuna email.
    const back = decisions[8];
    expect(back?.alerts).toEqual([]);
    expect(back?.recovered).toEqual([
      expect.objectContaining({ id: FIREWALL_BLIND_ID, wasAlerted: true }),
    ]);
    expect(back?.ongoing).toEqual([
      expect.objectContaining({
        id: 'site_health',
        alerted: true,
        consecutive: 4,
        failingSince: OUTAGE,
      }),
      expect.objectContaining({
        id: 'internal:database',
        alerted: true,
        consecutive: 4,
        failingSince: OUTAGE,
      }),
    ]);
    // Al giro 9 il sito è di nuovo su: tornati a funzionare, con l'inizio vero del guasto.
    expect(decisions[9]?.recovered).toEqual([
      expect.objectContaining({ id: 'site_health', failingSince: OUTAGE, wasAlerted: true }),
      expect.objectContaining({ id: 'internal:database', failingSince: OUTAGE, wasAlerted: true }),
    ]);
    expect(decisions[9]?.alerts).toEqual([]);
    expect(decisions[9]?.state.checks).toEqual({});
  });
});

describe('caricamento come nel workflow (node con type stripping)', () => {
  const script = join(process.cwd(), 'scripts', 'monitor', 'check-site.ts');
  const strip = (
    nodeModule as { stripTypeScriptTypes?: (code: string, options?: object) => string }
  ).stripTypeScriptTypes;

  it.skipIf(!strip)('contiene solo TypeScript cancellabile', () => {
    expect(() => strip?.(readFileSync(script, 'utf8'), { mode: 'strip' })).not.toThrow();
  });

  it.skipIf(!strip)(
    'si importa con node --experimental-strip-types senza avviare i controlli',
    () => {
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--no-warnings',
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(script)});` +
            'process.stdout.write([typeof m.main, typeof m.firewallBlindResult, m.FIREWALL_BLIND_ID].join(","));',
        ],
        {
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, BASE_URL: 'http://127.0.0.1:9' },
        },
      );
      expect(child.stderr).toBe('');
      expect(child.status).toBe(0);
      expect(child.stdout).toBe('function,function,firewall_blind');
    },
  );
});
