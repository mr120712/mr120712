// @polsia:user-owned
// @vitest-environment node
//
// «Skynet», la parte pura (src/lib/skynet/signals.ts): quali segnali sono problemi, quando un
// problema è confermato, quando si apre, si aggiorna, si ricorda e si chiude un incidente, e quando
// una modifica del firewall merita un avviso. Niente falsi allarmi per un singolo sbalzo.
import { describe, expect, it } from 'vitest';
import {
  CALM_TO_RESOLVE,
  decide,
  detectProblems,
  durationText,
  EMPTY_MEMORY,
  fallbackReport,
  REMIND_AFTER_MS,
  type SkynetMemory,
  type SkynetSignals,
} from '@/lib/skynet/signals';

const T0 = new Date('2026-11-17T21:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function signals(
  overrides: {
    vercel?: Partial<SkynetSignals['vercel']>;
    site?: Partial<SkynetSignals['site']>;
  } = {},
): SkynetSignals {
  return {
    at: T0.toISOString(),
    vercel: {
      configured: true,
      reachable: true,
      anomalies: 0,
      firewallEnabled: true,
      firewallVersion: 14,
      aiBotsActive: true,
      skynetRulesActive: 3,
      attackMode: false,
      ...overrides.vercel,
    },
    site: {
      healthOk: true,
      healthStatus: 200,
      healthMs: 120,
      internal: 'ok',
      internalFailing: [],
      ...overrides.site,
    },
  };
}

/** Più giri di fila con gli stessi segnali: la memoria passa da un giro al successivo. */
function rounds(memory: SkynetMemory, s: SkynetSignals, from: number, count: number) {
  const steps = [];
  let current = memory;
  for (let i = 0; i < count; i += 1) {
    const step = decide(current, detectProblems(s), s, at(from + i));
    steps.push(step);
    current = step.memory;
  }
  return { steps, memory: current };
}

describe('detectProblems', () => {
  it('un sito sano con il firewall al completo non ha problemi', () => {
    expect(detectProblems(signals())).toEqual([]);
  });

  it('riconosce attacco, firewall spento, regole mancanti, blocco AI spento', () => {
    const keys = detectProblems(
      signals({
        vercel: { anomalies: 2, firewallEnabled: false, aiBotsActive: false, skynetRulesActive: 1 },
      }),
    ).map((p) => [p.key, p.severity]);
    expect(keys).toEqual([
      ['ddos', 'critical'],
      ['firewall-off', 'critical'],
      ['ai-bots-off', 'warning'],
      ['skynet-rules', 'warning'],
    ]);
  });

  it('sito giù, lento, controlli interni in errore, Vercel non leggibile', () => {
    expect(
      detectProblems(signals({ site: { healthOk: false, healthStatus: 503 } }))[0],
    ).toMatchObject({ key: 'site-down', detail: '/health risponde HTTP 503' });
    expect(
      detectProblems(signals({ site: { healthOk: false, healthStatus: null, healthMs: null } }))[0],
    ).toMatchObject({ detail: '/health non risponde (rete o tempo scaduto)' });
    expect(detectProblems(signals({ site: { healthMs: 5200 } }))[0]).toMatchObject({
      key: 'site-slow',
      detail: '/health risponde in 5,2 s',
    });
    expect(
      detectProblems(signals({ site: { internal: 'down', internalFailing: ['database'] } }))[0],
    ).toMatchObject({ key: 'internal-down', detail: 'Non funzionano: database' });
    expect(detectProblems(signals({ vercel: { reachable: false } })).map((p) => p.key)).toEqual([
      'vercel-blind',
    ]);
  });

  it('senza token su Vercel (null) non inventa problemi del firewall', () => {
    const s = signals({
      vercel: {
        configured: false,
        reachable: null,
        anomalies: null,
        firewallEnabled: null,
        aiBotsActive: null,
        skynetRulesActive: null,
      },
    });
    expect(detectProblems(s)).toEqual([]);
  });

  it('i controlli interni «con avvisi» (degraded) non sono un incidente', () => {
    expect(detectProblems(signals({ site: { internal: 'degraded' } }))).toEqual([]);
  });
});

describe('decide', () => {
  it('un attacco DDoS apre subito un incidente critico', () => {
    const step = decide(
      EMPTY_MEMORY,
      detectProblems(signals({ vercel: { anomalies: 1 } })),
      signals(),
      T0,
    );
    expect(step.decision).toMatchObject({ kind: 'incident', severity: 'critical' });
    expect(step.memory.incidentSince).toBe(T0.toISOString());
    expect(step.memory.incidentKeys).toEqual(['ddos']);
  });

  it('il sito giù deve ripetersi due giri di fila (un solo sbalzo non è un allarme)', () => {
    const down = signals({ site: { healthOk: false, healthStatus: 502 } });
    const { steps } = rounds(EMPTY_MEMORY, down, 0, 2);
    expect(steps[0]?.decision.kind).toBe('none');
    expect(steps[1]?.decision).toMatchObject({ kind: 'incident', severity: 'critical' });
    // Un giro buono in mezzo azzera il conteggio.
    const first = decide(EMPTY_MEMORY, detectProblems(down), down, at(0));
    const fine = decide(first.memory, [], signals(), at(1));
    const again = decide(fine.memory, detectProblems(down), down, at(2));
    expect(again.decision.kind).toBe('none');
  });

  it('nuovi problemi durante un incidente: aggiornamento; stessi problemi: promemoria ogni ora', () => {
    const ddos = signals({ vercel: { anomalies: 3 } });
    const opened = decide(EMPTY_MEMORY, detectProblems(ddos), ddos, at(0));
    const quiet = decide(opened.memory, detectProblems(ddos), ddos, at(30));
    expect(quiet.decision.kind).toBe('none');
    const reminder = decide(
      quiet.memory,
      detectProblems(ddos),
      ddos,
      new Date(at(0).getTime() + REMIND_AFTER_MS),
    );
    expect(reminder.decision.kind).toBe('reminder');
    const worse = signals({ vercel: { anomalies: 3, firewallEnabled: false } });
    const update = decide(reminder.memory, detectProblems(worse), worse, at(61));
    expect(update.decision).toMatchObject({ kind: 'update' });
    expect(update.memory.incidentKeys).toEqual(['ddos', 'firewall-off']);
  });

  it(`l'incidente si chiude dopo ${CALM_TO_RESOLVE} giri tranquilli, con la durata`, () => {
    const ddos = signals({ vercel: { anomalies: 1 } });
    const opened = decide(EMPTY_MEMORY, detectProblems(ddos), ddos, at(0));
    const { steps, memory } = rounds(opened.memory, signals(), 10, CALM_TO_RESOLVE);
    expect(steps.slice(0, -1).map((s) => s.decision.kind)).toEqual(
      Array(CALM_TO_RESOLVE - 1).fill('none'),
    );
    expect(steps.at(-1)?.decision).toEqual({
      kind: 'resolved',
      since: at(0).toISOString(),
      keys: ['ddos'],
    });
    expect(memory.incidentSince).toBeNull();
    const last = steps.at(-1);
    if (!last) throw new Error('nessun giro');
    expect(fallbackReport(last.decision, at(12))).toBe(
      'Tutto è tornato normale dopo 12 minuti. Nessuna azione richiesta.',
    );
  });

  it('una modifica della versione del firewall si nota, la prima lettura no', () => {
    const first = decide(EMPTY_MEMORY, [], signals(), at(0));
    expect(first.firewallChange).toBeNull();
    expect(first.memory.firewallVersion).toBe(14);
    const changed = decide(first.memory, [], signals({ vercel: { firewallVersion: 15 } }), at(1));
    expect(changed.firewallChange).toEqual({ from: 14, to: 15 });
    // Vercel non leggibile in un giro: la versione ricordata resta, nessuna «modifica».
    const blind = decide(changed.memory, [], signals({ vercel: { firewallVersion: null } }), at(2));
    expect(blind.firewallChange).toBeNull();
    expect(blind.memory.firewallVersion).toBe(15);
  });
});

describe('testi', () => {
  it('rapporto di riserva: fatti e azioni concrete, senza dire di aver agito', () => {
    const ddos = signals({ vercel: { anomalies: 2 } });
    const step = decide(EMPTY_MEMORY, detectProblems(ddos), ddos, T0);
    const text = fallbackReport(step.decision, T0);
    expect(text).toContain(
      'Possibile attacco DDoS in corso: Vercel rileva 2 anomalie di traffico.',
    );
    expect(text).toContain('Attack Challenge Mode');
    expect(text).not.toMatch(/ho (bloccato|attivato|spento)/i);
  });

  it('durate in italiano', () => {
    expect(durationText(T0.toISOString(), at(1))).toBe('1 minuto');
    expect(durationText(T0.toISOString(), at(60))).toBe('1 ora');
    expect(durationText(T0.toISOString(), at(125))).toBe('2 ore e 5 minuti');
  });
});
