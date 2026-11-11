// @polsia:user-owned — monitoraggio esterno (scripts/monitor/check-site.ts): decisione degli
// avvisi, stato tra i giri, etichette dei controlli interni, elenco delle pagine, riepilogo.
// @vitest-environment node
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MONITOR_CHECK_IDS } from '@/lib/contracts/monitoring';
import { MONITOR_CHECKS } from '@/lib/monitoring/catalog';
import { findGenre } from '@/lib/music/genre-catalog';
import { navItems } from '@/lib/nav';
import {
  type AlertDecision,
  type CheckResult,
  type CheckStatus,
  decideAlerts,
  INTERNAL_CHECKS,
  labelForId,
  type MonitorReport,
  type MonitorState,
  normalizeBaseUrl,
  normalizeState,
  overallLine,
  PUBLIC_PAGES,
  REALERT_MS,
  REALERT_SLACK_MS,
  readStateFile,
  renderAnnotations,
  renderMarkdown,
  renderText,
  writeStateFile,
} from '../../scripts/monitor/check-site';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-11-11T10:23:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

function row(id: string, status: CheckStatus, critical = false, detail = 'dettaglio'): CheckResult {
  return { id, label: labelForId(id), critical, status, detail, ms: 100 };
}

/** Runs decideAlerts over successive hourly runs, threading the state like the workflow cache. */
function runs(sequence: CheckResult[][], start: unknown = null): AlertDecision[] {
  let state: unknown = start;
  return sequence.map((results, index) => {
    const decision = decideAlerts(state, results, at(index));
    state = JSON.parse(JSON.stringify(decision.state));
    return decision;
  });
}

describe('internal check labels', () => {
  it('cover exactly MONITOR_CHECK_IDS with the catalog labels and critical flags', () => {
    expect(Object.keys(INTERNAL_CHECKS).sort()).toEqual([...MONITOR_CHECK_IDS].sort());
    for (const id of MONITOR_CHECK_IDS) {
      expect(INTERNAL_CHECKS[id], id).toEqual({
        label: MONITOR_CHECKS[id].label,
        critical: MONITOR_CHECKS[id].critical,
      });
    }
  });

  it('labels internal, page and site ids in Italian', () => {
    expect(labelForId('internal:database')).toBe('Database (controllo interno)');
    expect(labelForId('internal:new_check')).toBe('new_check (controllo interno)');
    expect(labelForId('page:/')).toBe('Pagina Home (/)');
    expect(labelForId('page:/radio')).toBe('Pagina Radio (/radio)');
    expect(labelForId('google_signin')).toBe('Accesso con Google');
    expect(labelForId('unknown_id')).toBe('unknown_id');
  });
});

function appRoutes(): Set<string> {
  const root = join(process.cwd(), 'src', 'app');
  const routes = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'page.tsx') {
        const segments = relative(root, dir)
          .split(sep)
          .filter((segment) => segment && !segment.startsWith('('));
        routes.add(`/${segments.join('/')}`);
      }
    }
  };
  walk(root);
  return routes;
}

describe('public page list', () => {
  const paths = PUBLIC_PAGES.map((page) => page.path);

  it('includes the pages the spec requires, with only the home critical', () => {
    for (const path of ['/', '/search', '/radio', '/podcasts', '/flashcards', '/privacy']) {
      expect(paths).toContain(path);
    }
    expect(paths).toContain('/login');
    expect(paths).toContain('/signup');
    expect(PUBLIC_PAGES.filter((page) => page.critical).map((page) => page.path)).toEqual(['/']);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('covers every public navigation entry', () => {
    const internal = navItems.filter((entry) => !entry.requiresAuth && entry.href.startsWith('/'));
    expect(internal.length).toBeGreaterThan(5);
    for (const item of internal) {
      expect(paths, item.href).toContain(item.href);
    }
  });

  it('only lists pages that exist in src/app (dynamic genres must exist in the catalog)', () => {
    const routes = appRoutes();
    for (const path of paths) {
      const genre = /^\/generi\/([a-z0-9-]+)$/.exec(path);
      if (genre?.[1]) {
        expect(routes.has('/generi/[slug]')).toBe(true);
        expect(findGenre(genre[1]), path).not.toBeNull();
      } else {
        expect(routes.has(path), path).toBe(true);
      }
    }
  });
});

describe('decideAlerts', () => {
  it('alerts a critical check on its first failing run', () => {
    const [decision] = runs([[row('site_health', 'fail', true)]]);
    expect(decision?.alerts).toEqual([
      expect.objectContaining({ id: 'site_health', kind: 'new', critical: true, consecutive: 1 }),
    ]);
    expect(decision?.ongoing).toEqual([]);
    expect(decision?.state.checks.site_health).toEqual({
      failingSince: T0.toISOString(),
      consecutive: 1,
      lastAlertAt: T0.toISOString(),
    });
  });

  it('waits for a second consecutive failure before alerting a non-critical check', () => {
    const [first, second] = runs([
      [row('catalog_radio', 'fail')],
      [row('catalog_radio', 'fail', false, 'HTTP 500')],
    ]);
    expect(first?.alerts).toEqual([]);
    expect(first?.ongoing).toEqual([
      expect.objectContaining({ id: 'catalog_radio', alerted: false, consecutive: 1 }),
    ]);
    expect(first?.state.checks.catalog_radio?.lastAlertAt).toBeNull();
    expect(second?.alerts).toEqual([
      expect.objectContaining({
        id: 'catalog_radio',
        kind: 'new',
        consecutive: 2,
        detail: 'HTTP 500',
        failingSince: T0.toISOString(),
      }),
    ]);
    expect(second?.state.checks.catalog_radio).toEqual({
      failingSince: T0.toISOString(),
      consecutive: 2,
      lastAlertAt: at(1).toISOString(),
    });
  });

  it('resets the count when a non-critical check passes in between (no alert for blips)', () => {
    const decisions = runs([
      [row('catalog_radio', 'fail')],
      [row('catalog_radio', 'ok')],
      [row('catalog_radio', 'fail')],
    ]);
    expect(decisions.flatMap((decision) => decision.alerts)).toEqual([]);
    expect(decisions[1]?.recovered).toEqual([
      expect.objectContaining({ id: 'catalog_radio', wasAlerted: false }),
    ]);
    expect(decisions[2]?.state.checks.catalog_radio?.consecutive).toBe(1);
  });

  it('keeps an alerted failure quiet until 24 hours later, then reminds once a day', () => {
    const failing = [row('google_signin', 'fail', true)];
    const decisions = runs(Array.from({ length: 50 }, () => failing));
    const alertHours = decisions.flatMap((decision, hour) =>
      decision.alerts.map((alert) => [hour, alert.kind]),
    );
    expect(alertHours).toEqual([
      [0, 'new'],
      [24, 'reminder'],
      [48, 'reminder'],
    ]);
    expect(decisions[23]?.ongoing).toEqual([
      expect.objectContaining({ id: 'google_signin', alerted: true, consecutive: 24 }),
    ]);
    expect(decisions[49]?.state.checks.google_signin).toEqual({
      failingSince: T0.toISOString(),
      consecutive: 50,
      lastAlertAt: at(48).toISOString(),
    });
  });

  it('tolerates late scheduled runs at the 24 h boundary', () => {
    const previous: MonitorState = {
      version: 1,
      checks: {
        signup_route: {
          failingSince: T0.toISOString(),
          consecutive: 5,
          lastAlertAt: T0.toISOString(),
        },
      },
    };
    const results = [row('signup_route', 'fail', true)];
    const justBefore = new Date(T0.getTime() + REALERT_MS - REALERT_SLACK_MS - 60_000);
    const onTime = new Date(T0.getTime() + REALERT_MS - REALERT_SLACK_MS);
    expect(decideAlerts(previous, results, justBefore).alerts).toEqual([]);
    expect(decideAlerts(previous, results, onTime).alerts).toEqual([
      expect.objectContaining({ kind: 'reminder' }),
    ]);
    expect(decideAlerts(previous, results, at(12)).alerts).toEqual([]);
  });

  it('removes recovered checks from the state and lists them (warn counts as recovered)', () => {
    const previous: MonitorState = {
      version: 1,
      checks: {
        'page:/radio': { failingSince: T0.toISOString(), consecutive: 3, lastAlertAt: null },
        catalog_audius: {
          failingSince: T0.toISOString(),
          consecutive: 2,
          lastAlertAt: T0.toISOString(),
        },
        signup_route: {
          failingSince: T0.toISOString(),
          consecutive: 1,
          lastAlertAt: T0.toISOString(),
        },
      },
    };
    const decision = decideAlerts(
      previous,
      [row('page:/radio', 'ok'), row('catalog_audius', 'warn'), row('signup_route', 'fail', true)],
      at(1),
    );
    expect(decision.recovered).toEqual([
      {
        id: 'page:/radio',
        label: 'Pagina Radio (/radio)',
        failingSince: T0.toISOString(),
        wasAlerted: false,
      },
      {
        id: 'catalog_audius',
        label: 'Catalogo Audius',
        failingSince: T0.toISOString(),
        wasAlerted: true,
      },
    ]);
    expect(Object.keys(decision.state.checks)).toEqual(['signup_route']);
    expect(decision.alerts).toEqual([]);
    expect(decision.ongoing).toEqual([expect.objectContaining({ id: 'signup_route' })]);
  });

  it('starts from scratch when the previous state is missing, older or corrupt', () => {
    const results = [row('site_health', 'fail', true), row('seo_files', 'fail')];
    const corrupt: unknown[] = [
      null,
      undefined,
      'garbage',
      42,
      [],
      {},
      { version: 0, checks: {} },
      { version: 2, checks: {} },
      { version: '1', checks: {} },
      { version: 1, checks: [] },
      { version: 1, checks: null },
      // version-0 shape: different field names
      { checks: { site_health: { failing: true, since: 'ieri' } } },
    ];
    for (const previous of corrupt) {
      const decision = decideAlerts(previous, results, T0);
      expect(
        decision.alerts.map((alert) => alert.id),
        JSON.stringify(previous),
      ).toEqual(['site_health']);
      expect(decision.ongoing.map((item) => item.id)).toEqual(['seo_files']);
      expect(decision.state.checks.seo_files?.consecutive).toBe(1);
    }
  });

  it('drops invalid entries of an otherwise valid state, keeping the valid ones', () => {
    const valid = { failingSince: T0.toISOString(), consecutive: 1, lastAlertAt: null };
    const checks = {
      seo_files: valid,
      catalog_radio: { ...valid, consecutive: 0 },
      catalog_podcasts: { ...valid, consecutive: 1.5 },
      security_headers: { ...valid, failingSince: 'non è una data' },
      signup_route: { ...valid, lastAlertAt: 'mai' },
      site_health: { ...valid, consecutive: '3' },
      'page:/': 'non un oggetto',
      'Not An Id!': valid,
    };
    // JSON.parse makes "__proto__" an own key, as a hostile state file would.
    const raw: unknown = JSON.parse(
      `{"version":1,"checks":{"__proto__":${JSON.stringify(valid)},${JSON.stringify(checks).slice(1)}}`,
    );
    const normalized = normalizeState(raw);
    expect(Object.keys(normalized.checks)).toEqual(['seo_files']);
    expect(Object.getPrototypeOf(normalized.checks)).toBe(Object.prototype);
    const decision = decideAlerts(
      raw,
      [row('seo_files', 'fail'), row('catalog_radio', 'fail')],
      at(1),
    );
    expect(decision.alerts.map((alert) => alert.id)).toEqual(['seo_files']);
    expect(decision.state.checks.catalog_radio?.consecutive).toBe(1);
  });

  it('recovers internal ids only when /api/status answered, otherwise keeps them unknown', () => {
    const entry = { failingSince: T0.toISOString(), consecutive: 4, lastAlertAt: T0.toISOString() };
    const previous: MonitorState = {
      version: 1,
      checks: { 'internal:database': entry, 'internal:stripe': entry, 'page:/old': entry },
    };
    const answered = decideAlerts(
      previous,
      [row('internal_status', 'ok'), row('internal:stripe', 'fail')],
      at(1),
    );
    expect(answered.recovered.map((item) => item.id)).toEqual(['internal:database']);
    expect(answered.recovered[0]?.label).toBe('Database (controllo interno)');
    expect(Object.keys(answered.state.checks)).toEqual(['internal:stripe']);

    const unreachable = decideAlerts(previous, [row('internal_status', 'fail')], at(1));
    expect(unreachable.recovered).toEqual([]);
    expect(unreachable.state.checks['internal:database']).toEqual(entry);
    expect(unreachable.state.checks['internal:stripe']).toEqual(entry);
    // A check that no longer exists is forgotten, not reported as recovered.
    expect(unreachable.state.checks['page:/old']).toBeUndefined();
  });

  it('counts a duplicated id once and ignores ids that cannot be stored', () => {
    const decision = decideAlerts(
      null,
      [
        row('site_health', 'fail', true),
        row('site_health', 'fail', true),
        row('Bad Id', 'fail', true),
      ],
      T0,
    );
    expect(decision.alerts.map((alert) => alert.id)).toEqual(['site_health']);
    expect(Object.keys(decision.state.checks)).toEqual(['site_health']);
  });

  it('sends one email, not one per failure, for a critical check that flaps', () => {
    const decisions = runs(
      Array.from({ length: 8 }, (_, hour) => [row('page:/', hour % 2 === 0 ? 'fail' : 'ok', true)]),
    );
    expect(decisions.filter((decision) => decision.alerts.length > 0)).toHaveLength(1);
    expect(decisions[0]?.alerts).toEqual([expect.objectContaining({ id: 'page:/', kind: 'new' })]);
    expect(decisions[1]?.recovered).toEqual([
      expect.objectContaining({ id: 'page:/', wasAlerted: true }),
    ]);
    expect(decisions[1]?.state.recent).toEqual({
      'page:/': { lastAlertAt: T0.toISOString(), recoveredAt: at(1).toISOString() },
    });
    // A re-failure is listed as already reported, with the original alert clock.
    expect(decisions[6]?.ongoing).toEqual([
      expect.objectContaining({ id: 'page:/', alerted: true, consecutive: 1 }),
    ]);
    expect(decisions[6]?.state.checks['page:/']?.lastAlertAt).toBe(T0.toISOString());
    expect(decisions[6]?.state.recent).toBeUndefined();
  });

  it('still reminds once a day while a check keeps flapping', () => {
    const decisions = runs(
      Array.from({ length: 50 }, (_, hour) => [
        row('page:/', hour % 2 === 0 ? 'fail' : 'ok', true),
      ]),
    );
    const alertHours = decisions.flatMap((decision, hour) =>
      decision.alerts.map((alert) => [hour, alert.kind]),
    );
    expect(alertHours).toEqual([
      [0, 'new'],
      [24, 'reminder'],
      [48, 'reminder'],
    ]);
  });

  it('treats a failure after 6 hours of recovery as a new problem, and forgets old recoveries', () => {
    const sequence = [
      [row('signup_route', 'fail', true)],
      ...Array.from({ length: 6 }, () => [row('signup_route', 'ok', true)]),
      [row('signup_route', 'fail', true)],
    ];
    const decisions = runs(sequence);
    const remembered = {
      signup_route: { lastAlertAt: T0.toISOString(), recoveredAt: at(1).toISOString() },
    };
    expect(decisions[6]?.state.recent).toEqual(remembered);
    // Recovered at hour 1: at hour 7 the 6-hour window is over.
    expect(decisions[7]?.alerts).toEqual([
      expect.objectContaining({ id: 'signup_route', kind: 'new' }),
    ]);
    const stillOk = decideAlerts(decisions[6]?.state, [row('signup_route', 'ok', true)], at(7));
    expect(stillOk.state).toEqual({ version: 1, checks: {} });
  });

  it('keeps the alert clock of a non-critical check that recovers briefly', () => {
    const decisions = runs([
      [row('catalog_radio', 'fail')],
      [row('catalog_radio', 'fail')],
      [row('catalog_radio', 'ok')],
      [row('catalog_radio', 'fail')],
      [row('catalog_radio', 'fail')],
    ]);
    expect(decisions.map((decision) => decision.alerts.length)).toEqual([0, 1, 0, 0, 0]);
    expect(decisions[3]?.ongoing).toEqual([
      expect.objectContaining({ id: 'catalog_radio', alerted: true, consecutive: 1 }),
    ]);
  });

  it('reminds at once when the last alert is dated in the future (corrupt state)', () => {
    const previous: MonitorState = {
      version: 1,
      checks: {
        google_signin: {
          failingSince: T0.toISOString(),
          consecutive: 3,
          lastAlertAt: '2099-01-01T00:00:00.000Z',
        },
      },
    };
    const decision = decideAlerts(previous, [row('google_signin', 'fail', true)], at(1));
    expect(decision.alerts).toEqual([
      expect.objectContaining({ id: 'google_signin', kind: 'reminder' }),
    ]);
    expect(decision.state.checks.google_signin?.lastAlertAt).toBe(at(1).toISOString());
    // A recovery dated in the future is ignored, not kept forever.
    const future = decideAlerts(
      {
        version: 1,
        checks: {},
        recent: {
          site_health: {
            lastAlertAt: T0.toISOString(),
            recoveredAt: '2099-01-01T00:00:00.000Z',
          },
        },
      },
      [row('site_health', 'fail', true)],
      at(1),
    );
    expect(future.alerts).toEqual([expect.objectContaining({ id: 'site_health', kind: 'new' })]);
    expect(future.state.recent).toBeUndefined();
  });

  it('sends the daily reminders of a full outage in one email', () => {
    const outage = [row('site_health', 'fail', true), row('seo_files', 'fail')];
    const decisions = runs(Array.from({ length: 50 }, () => outage));
    const alertHours = decisions.flatMap((decision, hour) =>
      decision.alerts.map((alert) => [hour, alert.id, alert.kind]),
    );
    expect(alertHours).toEqual([
      [0, 'site_health', 'new'],
      [1, 'seo_files', 'new'],
      [24, 'site_health', 'reminder'],
      [24, 'seo_files', 'reminder'],
      [48, 'site_health', 'reminder'],
      [48, 'seo_files', 'reminder'],
    ]);
    expect(decisions[24]?.ongoing).toEqual([]);
    expect(decisions[24]?.state.checks.seo_files?.lastAlertAt).toBe(at(24).toISOString());
    // A reminder less than 12 hours old does not ride along.
    expect(decisions[1]?.ongoing).toEqual([
      expect.objectContaining({ id: 'site_health', alerted: true }),
    ]);
  });

  it('validates the recent map like the checks', () => {
    const valid = { lastAlertAt: T0.toISOString(), recoveredAt: at(1).toISOString() };
    const raw: unknown = JSON.parse(
      `{"version":1,"checks":{},"recent":{"__proto__":${JSON.stringify(valid)},${JSON.stringify({
        seo_files: valid,
        catalog_radio: { ...valid, recoveredAt: 'ieri' },
        signup_route: { lastAlertAt: null, recoveredAt: valid.recoveredAt },
        'Not An Id!': valid,
        site_health: 'non un oggetto',
      }).slice(1)}}`,
    );
    const normalized = normalizeState(raw);
    expect(normalized.recent).toEqual({ seo_files: valid });
    expect(Object.getPrototypeOf(normalized.recent)).toBe(Object.prototype);
    expect(normalizeState({ version: 1, checks: {}, recent: [] }).recent).toBeUndefined();
  });

  it('never alerts on warnings', () => {
    const decisions = runs(
      Array.from({ length: 3 }, () => [
        row('response_time', 'warn'),
        row('internal:jamendo', 'warn'),
      ]),
    );
    for (const decision of decisions) {
      expect(decision.alerts).toEqual([]);
      expect(decision.state.checks).toEqual({});
    }
  });
});

describe('state file', () => {
  it('round-trips through disk and explains a missing or corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'solco-monitor-'));
    const path = join(dir, 'nested', 'state.json');
    expect(await readStateFile(path)).toEqual({
      raw: null,
      note: 'Nessuno stato precedente: questo è il primo controllo.',
    });
    const decision = decideAlerts(null, [row('seo_files', 'fail')], T0);
    await writeStateFile(path, decision.state);
    const read = await readStateFile(path);
    expect(read.note).toBeNull();
    expect(read.raw).toEqual(decision.state);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      checks: { seo_files: { failingSince: T0.toISOString(), consecutive: 1, lastAlertAt: null } },
    });

    await writeFile(path, '{"version":1,"checks":', 'utf8');
    expect(await readStateFile(path)).toEqual({
      raw: null,
      note: 'Stato precedente non valido: si riparte da zero.',
    });
    await writeFile(path, '{"version":7}', 'utf8');
    expect((await readStateFile(path)).note).toBe(
      'Stato precedente in un formato diverso: si riparte da zero.',
    );
  });
});

describe('normalizeBaseUrl', () => {
  it('keeps only the origin and defaults to the live site', () => {
    expect(normalizeBaseUrl(undefined)).toBe('https://solcomusic.vercel.app');
    expect(normalizeBaseUrl('  ')).toBe('https://solcomusic.vercel.app');
    expect(normalizeBaseUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeBaseUrl('http://localhost:3000/x?y=1')).toBe('http://localhost:3000');
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrow();
    expect(() => normalizeBaseUrl('non un url')).toThrow();
  });
});

describe('summary', () => {
  function report(results: CheckResult[], previous: unknown = null): MonitorReport {
    return {
      baseUrl: 'https://solcomusic.vercel.app',
      startedAt: T0,
      finishedAt: new Date(T0.getTime() + 6_500),
      results,
      decision: decideAlerts(previous, results, T0),
      notes: [],
    };
  }

  it('renders the overall line, the table and the three sections in Italian', () => {
    const previous: MonitorState = {
      version: 1,
      checks: {
        catalog_radio: {
          failingSince: at(-5).toISOString(),
          consecutive: 5,
          lastAlertAt: at(-4).toISOString(),
        },
        seo_files: { failingSince: at(-2).toISOString(), consecutive: 2, lastAlertAt: null },
      },
    };
    const results = [
      row('site_health', 'ok'),
      row('google_signin', 'fail', true, 'Google rifiuta | la richiesta <b>'),
      row('catalog_radio', 'fail', false, 'HTTP 500'),
      row('response_time', 'warn', false, 'Home lenta: 4,5 s'),
      row('seo_files', 'ok'),
      { ...row('internal:jamendo', 'warn'), ms: null },
    ];
    const markdown = renderMarkdown(report(results, previous));
    expect(markdown).toContain('**❌ Un nuovo problema: GitHub ti manda un’email**');
    expect(markdown).toContain('| Esito | Controllo | Dettaglio | ms |');
    expect(markdown).toContain('| ✅ | Sito raggiungibile (/health) | dettaglio | 100 |');
    expect(markdown).toContain('| ⚠️ | Velocità della home | Home lenta: 4,5 s | 100 |');
    expect(markdown).toContain('| ⚠️ | Jamendo (controllo interno) | dettaglio | — |');
    // Pipes cannot break the table and HTML is not interpreted.
    expect(markdown).toContain('Google rifiuta \\| la richiesta &lt;b>');
    expect(markdown).toMatch(/### Nuovi problemi\n\n- ❌ \*\*Accesso con Google\*\* \(critico\)/);
    expect(markdown).toMatch(
      /### Ancora in corso\n\n- ❌ \*\*Catalogo radio\*\*: HTTP 500 \(guasto dal/,
    );
    expect(markdown).toContain('già segnalato (promemoria ogni 24 ore)');
    expect(markdown).toMatch(/### Tornati a funzionare\n\n- ✅ \*\*robots.txt e sitemap.xml\*\*/);
    expect(markdown).toContain('11/11/2026, 11:23');

    const text = renderText(report(results, previous));
    expect(text).toContain(
      '[ERRORE] Accesso con Google: Google rifiuta | la richiesta <b> (100 ms)',
    );
    expect(text).toContain('[AVVISO] Jamendo (controllo interno): dettaglio\n');
    expect(text).toContain('Nuovi problemi: Accesso con Google');
  });

  it('says everything works, or works with warnings, when nothing fails', () => {
    expect(overallLine(report([row('site_health', 'ok')]))).toBe('✅ Tutto funziona');
    expect(overallLine(report([row('site_health', 'ok'), row('response_time', 'warn')]))).toBe(
      '⚠️ Tutto funziona, con qualche avviso',
    );
    const quiet = renderMarkdown(report([row('site_health', 'ok')]));
    expect(quiet.match(/Nessuno\./g)).toHaveLength(3);
  });

  it('turns alerts into escaped GitHub error annotations', () => {
    const decision = decideAlerts(null, [row('page:/', 'fail', true, '50% giù\nriga 2')], T0);
    expect(renderAnnotations(decision)).toBe(
      '::error title=Solco%3A Pagina Home (/)::50%25 giù%0Ariga 2\n',
    );
    expect(renderAnnotations(decideAlerts(null, [row('seo_files', 'fail')], T0))).toBe('');
  });
});
