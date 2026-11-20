// @polsia:user-owned
// @vitest-environment node
//
// «Skynet», l'autodifesa (src/lib/skynet/autodefense.ts), parte pura: riaccende solo ciò che ha
// visto acceso, dopo due giri di fila, mai le regole a mano; si ferma se qualcuno continua a
// spegnere o se Vercel rifiuta; rispetta la pausa del proprietario.
import { describe, expect, it } from 'vitest';
import {
  type AutodefenseState,
  autodefenseEnabled,
  autodefenseSummary,
  DEFENSE_COOLDOWN_MS,
  DEFENSE_MAX_FAILS,
  type DefenseOutcome,
  emptyAutodefense,
  type FirewallView,
  learnBaseline,
  MAX_PAUSE_MINUTES,
  MAX_RULES_PER_RUN,
  NO_OWNER_SWITCH,
  parseAutodefense,
  parseFirewallView,
  pauseEvent,
  pauseUntil,
  pendingRestores,
  planAutodefense,
  recordAutodefense,
  restoreEvent,
  resumeEvent,
  romeTime,
  settleAutodefense,
  standDownEvent,
  stepHolds,
  TUG_MAX_RESTORES,
  targetStatus,
} from '@/lib/skynet/autodefense';

const T0 = Date.UTC(2026, 10, 20, 13, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

/** Il firewall come lo restituisce Vercel (ridotto): tutto acceso. */
function config(overrides: Record<string, unknown> = {}) {
  return {
    firewallEnabled: true,
    version: 219,
    managedRules: {
      ai_bots: { action: 'deny', active: true, updatedAt: '2026-11-17T20:58:47.239Z' },
      bot_protection: { action: 'log', active: true },
    },
    rules: [
      {
        id: 'rule_sonde',
        name: 'Skynet · sonde e scanner',
        description: 'File da hacker',
        active: true,
        valid: true,
        validationErrors: null,
        conditionGroup: [{ conditions: [{ type: 'path', op: 're', value: '\\.env' }] }],
        action: { mitigate: { action: 'deny', actionDuration: '10m', rateLimit: null } },
      },
      {
        id: 'rule_ai',
        name: 'Skynet · AI dichiarate',
        active: true,
        conditionGroup: [{ conditions: [{ type: 'user_agent', op: 're', value: 'GPTBot' }] }],
        action: { mitigate: { action: 'deny' } },
      },
      {
        id: 'rule_mano',
        name: "Admin solo dall'Italia",
        active: true,
        conditionGroup: [{ conditions: [{ type: 'path', op: 'pre', value: '/admin' }] }],
        action: { mitigate: { action: 'challenge', actionDuration: null } },
      },
    ],
    ips: [],
    ...overrides,
  };
}

function view(overrides: Record<string, unknown> = {}): FirewallView {
  const parsed = parseFirewallView(config(overrides));
  if (!parsed) throw new Error('vista non valida');
  return parsed;
}

/** Stato dopo `runs` giri in cui il firewall è stato letto così. */
function settled(runs: FirewallView[], start: AutodefenseState = emptyAutodefense(), from = 0) {
  let state = start;
  runs.forEach((seen, index) => {
    state = settleAutodefense(state, seen, NO_OWNER_SWITCH, at(from + index));
  });
  return state;
}

const rulesWith = (active: Record<string, boolean>) =>
  config().rules.map((rule) => ({ ...rule, active: active[rule.id] ?? rule.active }));

describe('autodifesa: leggere il firewall', () => {
  it('tiene solo le regole «Skynet ·» e prepara ciò che serve a riaccenderle, senza campi null', () => {
    const parsed = view();
    expect(parsed.firewallEnabled).toBe(true);
    expect(parsed.aiBots).toEqual({ active: true, action: 'deny' });
    expect(parsed.rules?.map((rule) => rule.id)).toEqual(['rule_sonde', 'rule_ai']);
    expect(parsed.rules?.[0]?.value).toEqual({
      name: 'Skynet · sonde e scanner',
      description: 'File da hacker',
      active: true,
      conditionGroup: [{ conditions: [{ type: 'path', op: 're', value: '\\.env' }] }],
      action: { mitigate: { action: 'deny', actionDuration: '10m' } },
    });
  });

  it('il blocco delle AI in «log», spento o assente vale spento', () => {
    expect(view({ managedRules: { ai_bots: { active: true, action: 'log' } } }).aiBots.active).toBe(
      false,
    );
    expect(
      view({ managedRules: { ai_bots: { active: false, action: 'deny' } } }).aiBots.active,
    ).toBe(false);
    expect(view({ managedRules: {} }).aiBots).toEqual({ active: false, action: null });
  });

  it('risposte rotte: niente vista, o elenco delle regole sconosciuto', () => {
    expect(parseFirewallView(null)).toBeNull();
    expect(parseFirewallView('errore')).toBeNull();
    expect(view({ rules: undefined }).rules).toBeNull();
    expect(view({ firewallEnabled: 'sì' }).firewallEnabled).toBeNull();
    // Una regola senza condizioni non si può rimandare a Vercel: Skynet non la tocca.
    const broken = view({ rules: [{ id: 'r1', name: 'Skynet · rotta', active: false }] });
    expect(broken.rules).toEqual([
      { id: 'r1', name: 'Skynet · rotta', active: false, value: null },
    ]);
  });
});

describe('autodifesa: cosa ha visto acceso', () => {
  it('impara firewall, azione del blocco AI e regole attive; non impara da ciò che è spento', () => {
    const seen = learnBaseline(emptyAutodefense().baseline, view());
    expect(seen).toEqual({ firewall: true, aiBots: 'deny', rules: ['rule_sonde', 'rule_ai'] });
    const never = learnBaseline(
      emptyAutodefense().baseline,
      view({
        firewallEnabled: false,
        managedRules: { ai_bots: { active: false, action: 'deny' } },
        rules: rulesWith({ rule_sonde: false, rule_ai: false }),
      }),
    );
    expect(never).toEqual({ firewall: false, aiBots: null, rules: [] });
  });

  it('ricorda ciò che era acceso anche quando viene spento; dimentica le regole cancellate', () => {
    const seen = learnBaseline(emptyAutodefense().baseline, view());
    const off = learnBaseline(
      seen,
      view({ firewallEnabled: false, rules: rulesWith({ rule_sonde: false }) }),
    );
    expect(off).toEqual(seen);
    const deleted = learnBaseline(seen, view({ rules: config().rules.slice(1) }));
    expect(deleted.rules).toEqual(['rule_ai']);
    // Senza lettura, o senza l'elenco delle regole, resta tutto com'era.
    expect(learnBaseline(seen, null)).toEqual(seen);
    expect(learnBaseline(seen, view({ rules: undefined })).rules).toEqual(seen.rules);
  });

  it('segue l’azione del blocco AI: «challenge» resta «challenge»', () => {
    const seen = learnBaseline(
      emptyAutodefense().baseline,
      view({ managedRules: { ai_bots: { active: true, action: 'challenge' } } }),
    );
    expect(seen.aiBots).toBe('challenge');
  });

  it('acceso, spento o non si sa', () => {
    const seen = learnBaseline(emptyAutodefense().baseline, view());
    const off = view({ firewallEnabled: false, rules: rulesWith({ rule_ai: false }) });
    expect(targetStatus(off, seen, 'firewall')).toBe('off');
    expect(targetStatus(off, seen, 'ai-bots')).toBe('on');
    expect(targetStatus(off, seen, 'skynet-rules')).toBe('off');
    // Mai visto acceso: Skynet non sa com'era, quindi non lo considera da ripristinare.
    const blank = emptyAutodefense().baseline;
    expect(targetStatus(off, blank, 'firewall')).toBe('unknown');
    expect(targetStatus(off, blank, 'skynet-rules')).toBe('on');
    expect(targetStatus(view({ rules: undefined }), seen, 'skynet-rules')).toBe('unknown');
  });
});

describe('autodifesa: quando agire', () => {
  const off = view({ firewallEnabled: false });
  const plan = (state: AutodefenseState, seen: FirewallView, minute: number, enabled = true) =>
    planAutodefense({ view: seen, state, owner: NO_OWNER_SWITCH, now: at(minute), enabled });

  it('aspetta due giri di fila, poi riaccende il firewall', () => {
    const first = settled([view(), off]);
    expect(first.off).toEqual({ firewall: 1 });
    expect(plan(first, off, 1).steps).toEqual([]);
    const second = settled([off], first, 2);
    expect(plan(second, off, 2).steps).toEqual([
      {
        target: 'firewall',
        label: 'il firewall di Vercel',
        ruleId: null,
        body: { action: 'firewallEnabled', id: null, value: true },
      },
    ]);
  });

  it('se torna acceso da solo il conto riparte; un giro cieco non conta né azzera', () => {
    const state = settled([view(), off, view(), off]);
    expect(state.off).toEqual({ firewall: 1 });
    const blind = settleAutodefense(settled([view(), off]), null, NO_OWNER_SWITCH, at(2));
    expect(blind.off).toEqual({ firewall: 1 });
    expect(plan(blind, off, 2).steps).toEqual([]);
  });

  it('mai visto acceso: nessun ripristino, anche dopo molti giri', () => {
    const state = settled([off, off, off, off]);
    expect(state.baseline.firewall).toBe(false);
    expect(plan(state, off, 4)).toEqual({ steps: [], standDown: [], idle: null });
  });

  it('blocco AI e regole: riaccesi com’erano, mai le regole messe a mano', () => {
    const broken = view({
      managedRules: { ai_bots: { active: false, action: 'deny' } },
      rules: rulesWith({ rule_sonde: false, rule_mano: false }),
    });
    const state = settled([
      view({ managedRules: { ai_bots: { active: true, action: 'challenge' } } }),
      broken,
      broken,
    ]);
    const steps = plan(state, broken, 2).steps;
    expect(steps.map((step) => step.body)).toEqual([
      {
        action: 'managedRules.update',
        id: 'ai_bots',
        value: { active: true, action: 'challenge' },
      },
      {
        action: 'rules.update',
        id: 'rule_sonde',
        value: {
          name: 'Skynet · sonde e scanner',
          description: 'File da hacker',
          active: true,
          conditionGroup: [{ conditions: [{ type: 'path', op: 're', value: '\\.env' }] }],
          action: { mitigate: { action: 'deny', actionDuration: '10m' } },
        },
      },
    ]);
    expect(steps[1]?.label).toBe('la regola «Skynet · sonde e scanner»');
    expect(JSON.stringify(steps)).not.toContain('rule_mano');
  });

  it('una regola «Skynet ·» nata spenta non viene accesa', () => {
    const draft = {
      id: 'rule_bozza',
      name: 'Skynet · bozza',
      active: false,
      conditionGroup: [{ conditions: [{ type: 'path', op: 'pre', value: '/x' }] }],
      action: { mitigate: { action: 'deny' } },
    };
    const seen = view({ rules: [...config().rules, draft] });
    const state = settled([seen, seen, seen]);
    expect(plan(state, seen, 3).steps).toEqual([]);
  });

  it('al massimo MAX_RULES_PER_RUN regole per giro', () => {
    const many = Array.from({ length: MAX_RULES_PER_RUN + 3 }, (_, index) => ({
      id: `rule_${index}`,
      name: `Skynet · regola ${index}`,
      active: true,
      conditionGroup: [{ conditions: [{ type: 'path', op: 'pre', value: `/${index}` }] }],
      action: { mitigate: { action: 'deny' } },
    }));
    const allOff = view({ rules: many.map((rule) => ({ ...rule, active: false })) });
    const state = settled([view({ rules: many }), allOff, allOff]);
    expect(plan(state, allOff, 2).steps).toHaveLength(MAX_RULES_PER_RUN);
  });

  it('spenta dal proprietario o in pausa: non agisce e dice perché', () => {
    const state = settled([view(), off, off]);
    expect(plan(state, off, 2, false)).toEqual({ steps: [], standDown: [], idle: 'disabled' });
    const paused = planAutodefense({
      view: off,
      state,
      owner: { pausedUntil: at(60), resumedAt: null },
      now: at(2),
      enabled: true,
    });
    expect(paused).toEqual({ steps: [], standDown: [], idle: 'paused' });
    // Pausa scaduta: torna ad agire.
    const expired = planAutodefense({
      view: off,
      state,
      owner: { pausedUntil: at(1), resumedAt: null },
      now: at(2),
      enabled: true,
    });
    expect(expired.steps).toHaveLength(1);
    // Tutto acceso: niente da dire nemmeno se è spenta.
    expect(plan(settled([view()]), view(), 1, false).idle).toBeNull();
  });
});

describe('autodifesa: dopo un tentativo', () => {
  const off = view({ firewallEnabled: false });
  const step = {
    target: 'firewall' as const,
    label: 'il firewall di Vercel',
    ruleId: null,
    body: { action: 'firewallEnabled', id: null, value: true },
  };
  const plan = (state: AutodefenseState, minute: number) =>
    planAutodefense({ view: off, state, owner: NO_OWNER_SWITCH, now: at(minute), enabled: true });

  it('riuscito: segna il ripristino e aspetta prima di riprovare sulla stessa protezione', () => {
    const before = settled([view(), off, off]);
    const done = recordAutodefense(before, [{ step, ok: true }], [], at(2));
    expect(done.restores.firewall).toEqual([at(2).toISOString()]);
    expect(done.off.firewall).toBeUndefined();
    expect(done.fails.firewall).toBeUndefined();
    // Rispento subito: due giri di conferma e il tempo di attesa (3 minuti dal tentativo).
    const again = settled([off, off], done, 3);
    expect(again.off.firewall).toBe(2);
    expect(plan(again, 4).steps).toEqual([]);
    const later = settleAutodefense(again, off, NO_OWNER_SWITCH, at(5));
    expect(DEFENSE_COOLDOWN_MS).toBe(3 * 60_000);
    expect(plan(later, 5).steps).toHaveLength(1);
  });

  it('tiro alla fune: dopo due ripristini in un’ora si ferma, e resta fermo finché è spento', () => {
    let state = settled([view(), off, off]);
    state = recordAutodefense(state, [{ step, ok: true }], [], at(2));
    state = settled([off, off, off], state, 3);
    state = recordAutodefense(state, [{ step, ok: true }], [], at(5));
    expect(state.restores.firewall).toHaveLength(TUG_MAX_RESTORES);
    state = settled([off, off, off], state, 6);
    const third = plan(state, 8);
    expect(third).toEqual({ steps: [], standDown: ['firewall'], idle: null });
    state = recordAutodefense(state, [], third.standDown, at(8));
    // Fermo: non lo ridice e non riprova, nemmeno quando i ripristini sono usciti dalla finestra.
    state = settled([off], state, 9);
    expect(plan(state, 9)).toEqual({ steps: [], standDown: [], idle: null });
    state = settled([off], state, 200);
    expect(state.restores.firewall).toBeUndefined();
    expect(plan(state, 200)).toEqual({ steps: [], standDown: [], idle: null });
    // Torna acceso (lo ha rimesso il proprietario): il fermo cade e Skynet riprende a proteggere.
    state = settled([view()], state, 201);
    expect(state.standDown).toEqual({});
    state = settled([off, off], state, 202);
    expect(plan(state, 203).steps).toHaveLength(1);
  });

  it('Vercel rifiuta: riprova fino a tre volte, poi si ferma finché non torna acceso', () => {
    let state = settled([view(), off, off]);
    for (let attempt = 1; attempt <= DEFENSE_MAX_FAILS; attempt += 1) {
      const minute = 2 + (attempt - 1) * 3;
      state = settleAutodefense(state, off, NO_OWNER_SWITCH, at(minute));
      expect(plan(state, minute).steps).toHaveLength(1);
      state = recordAutodefense(state, [{ step, ok: false }], [], at(minute));
      expect(state.fails.firewall).toBe(attempt);
      expect(state.restores.firewall).toBeUndefined();
    }
    state = settled([off], state, 30);
    expect(plan(state, 30).steps).toEqual([]);
    state = settled([view()], state, 31);
    expect(state.fails).toEqual({});
  });

  it('«riprendi» del proprietario: via fermi, errori e conteggi, una volta sola', () => {
    let state = settled([view(), off, off]);
    state = recordAutodefense(state, [{ step, ok: false }], ['firewall'], at(2));
    state.restores.firewall = [at(1).toISOString(), at(2).toISOString()];
    const owner = { pausedUntil: null, resumedAt: at(3) };
    const resumed = settleAutodefense(state, off, owner, at(4));
    expect(resumed.standDown).toEqual({});
    expect(resumed.fails).toEqual({});
    expect(resumed.restores).toEqual({});
    expect(resumed.attempts).toEqual({});
    expect(resumed.resumeSeen).toBe(at(3).toISOString());
    expect(resumed.baseline.firewall).toBe(true);
    // Protezione ancora spenta e già confermata: riparte subito.
    expect(
      planAutodefense({ view: off, state: resumed, owner, now: at(4), enabled: true }).steps,
    ).toHaveLength(1);
    // Lo stesso «riprendi» non azzera di nuovo ai giri dopo.
    const stood = recordAutodefense(resumed, [], ['firewall'], at(4));
    expect(settleAutodefense(stood, off, owner, at(5)).standDown.firewall).toBeDefined();
  });

  it('cosa riaccenderà nei prossimi giri: solo ciò che ha visto acceso, non è fermo e non è in errore', () => {
    const broken = view({
      firewallEnabled: false,
      managedRules: { ai_bots: { active: false, action: 'deny' } },
      rules: rulesWith({ rule_ai: false }),
    });
    const state = settled([view(), broken]);
    expect(pendingRestores(broken, state)).toEqual(['firewall', 'ai-bots', 'skynet-rules']);
    expect(pendingRestores(view(), state)).toEqual([]);
    expect(pendingRestores(null, state)).toEqual([]);
    // Mai visto acceso: nessuna promessa.
    expect(pendingRestores(broken, settled([broken]))).toEqual([]);
    // Fermo per il tiro alla fune, o arreso dopo gli errori: nemmeno.
    const stuck = recordAutodefense(state, [], ['firewall'], at(2));
    stuck.fails['ai-bots'] = DEFENSE_MAX_FAILS;
    expect(pendingRestores(broken, stuck)).toEqual(['skynet-rules']);
    // Una regola cancellata non si può riaccendere.
    const deleted = view({ rules: config().rules.filter((rule) => rule.id !== 'rule_ai') });
    expect(pendingRestores(deleted, settled([deleted], state, 2))).toEqual([]);
  });

  it('la rilettura decide: acceso davvero, o no', () => {
    expect(stepHolds(view(), step)).toBe(true);
    expect(stepHolds(off, step)).toBe(false);
    const rule = { ...step, target: 'skynet-rules' as const, ruleId: 'rule_ai' };
    expect(stepHolds(view(), rule)).toBe(true);
    expect(stepHolds(view({ rules: rulesWith({ rule_ai: false }) }), rule)).toBe(false);
    const ai = { ...step, target: 'ai-bots' as const };
    expect(
      stepHolds(view({ managedRules: { ai_bots: { active: true, action: 'log' } } }), ai),
    ).toBe(false);
  });
});

describe('autodifesa: cosa dice', () => {
  const firewall = {
    target: 'firewall' as const,
    label: 'il firewall di Vercel',
    ruleId: null,
    body: { action: 'firewallEnabled', id: null, value: true },
  };
  const rule = {
    target: 'skynet-rules' as const,
    label: 'la regola «Skynet · sonde e scanner»',
    ruleId: 'rule_sonde',
    body: { action: 'rules.update', id: 'rule_sonde', value: {} },
  };
  const record = (outcomes: DefenseOutcome[], fails = 0) => {
    const state = emptyAutodefense();
    if (fails > 0) state.fails.firewall = fails;
    return recordAutodefense(state, outcomes, [], at(2));
  };

  it('ripristino riuscito: cosa ha riacceso, che ha verificato e come metterla in pausa', () => {
    const outcomes = [
      { step: firewall, ok: true },
      { step: rule, ok: true },
    ];
    const event = restoreEvent(outcomes, record(outcomes));
    expect(event).toMatchObject({
      severity: 'warning',
      title: 'Autodifesa: ho riacceso il firewall di Vercel e la regola «Skynet · sonde e scanner»',
      keys: ['firewall-off', 'skynet-rules'],
    });
    expect(event?.report).toContain('Le ho riaccese identiche a prima');
    expect(event?.report).toContain('ho riletto il firewall: ora sono in funzione');
    expect(event?.report).toContain('«pausa autodifesa 2 ore»');
    expect(event?.report).toContain('revochi i token');
    const single = restoreEvent([{ step: firewall, ok: true }], record(outcomes), false);
    expect(single?.report).toContain("L'ho riaccesa identica a prima");
    expect(single?.report).toContain('non sono riuscito a rileggere il firewall');
  });

  it('errore: lo dice la prima volta e quando si arrende, in mezzo tace', () => {
    const outcomes = [{ step: firewall, ok: false }];
    const first = restoreEvent(outcomes, record(outcomes));
    expect(first).toMatchObject({
      severity: 'critical',
      title: 'Autodifesa: non riesco a riaccendere il firewall di Vercel',
      keys: ['firewall-off'],
    });
    expect(first?.report).toContain('Riprovo da solo fra qualche minuto, altre 2 volte');
    expect(restoreEvent(outcomes, record(outcomes, 1))).toBeNull();
    const last = restoreEvent(outcomes, record(outcomes, DEFENSE_MAX_FAILS - 1));
    expect(last?.report).toContain('Ho provato 3 volte');
    expect(last?.report).toContain('«riprendi autodifesa»');
    expect(restoreEvent([], emptyAutodefense())).toBeNull();
  });

  it('tiro alla fune, pausa e ripresa', () => {
    const stand = standDownEvent(['firewall', 'ai-bots']);
    expect(stand.severity).toBe('critical');
    expect(stand.title).toBe(
      'Autodifesa ferma: qualcuno continua a spegnere il firewall di Vercel e il blocco delle AI («AI Bots»)',
    );
    expect(stand.report).toContain('«riprendi autodifesa»');
    expect(standDownEvent(['skynet-rules']).severity).toBe('warning');
    // 14:30 UTC del 20 novembre = 15:30 in Italia.
    const until = new Date(Date.UTC(2026, 10, 20, 14, 30));
    expect(romeTime(until)).toBe('20 novembre alle 15:30');
    const pause = pauseEvent(until, 'telegram');
    expect(pause.title).toBe('Autodifesa in pausa fino al 20 novembre alle 15:30');
    expect(pause.report).toContain('Richiesta da Telegram');
    expect(pauseEvent(until, 'pannello').report).toContain('dal pannello di amministrazione');
    expect(resumeEvent('pannello')).toMatchObject({
      severity: 'info',
      title: 'Autodifesa ripresa',
    });
  });

  it('la pausa dura da 1 minuto a 24 ore', () => {
    expect(pauseUntil(120, at(0))).toEqual(at(120));
    expect(pauseUntil(0, at(0))).toEqual(at(1));
    expect(pauseUntil(100_000, at(0))).toEqual(at(MAX_PAUSE_MINUTES));
    expect(pauseUntil(Number.NaN, at(0))).toEqual(at(120));
  });

  it('riepilogo per pannello e chat', () => {
    const state = recordAutodefense(
      settled([view()]),
      [{ step: firewall, ok: true }],
      ['ai-bots'],
      at(2),
    );
    state.fails['skynet-rules'] = DEFENSE_MAX_FAILS;
    expect(autodefenseSummary(state, NO_OWNER_SWITCH, at(3), true)).toEqual({
      mode: 'active',
      pausedUntil: null,
      watching: { firewall: true, aiBots: true, rules: 2 },
      standDown: ['ai-bots'],
      failing: ['skynet-rules'],
      restoredLastHour: 1,
    });
    const paused = autodefenseSummary(state, { pausedUntil: at(60), resumedAt: null }, at(3), true);
    expect(paused).toMatchObject({ mode: 'paused', pausedUntil: at(60).toISOString() });
    expect(autodefenseSummary(state, NO_OWNER_SWITCH, at(120), false)).toMatchObject({
      mode: 'disabled',
      restoredLastHour: 0,
    });
  });
});

describe('autodifesa: stato salvato e interruttore', () => {
  it('SKYNET_AUTODEFENSE spegne solo con 0, off, false o no', () => {
    expect(autodefenseEnabled({})).toBe(true);
    expect(autodefenseEnabled({ SKYNET_AUTODEFENSE: 'on' })).toBe(true);
    for (const value of ['0', 'off', 'OFF', ' false ', 'no']) {
      expect(autodefenseEnabled({ SKYNET_AUTODEFENSE: value })).toBe(false);
    }
  });

  it('lo stato salvato torna identico; quello corrotto o di un altro formato si scarta', () => {
    const off = view({ firewallEnabled: false });
    let state = settled([view(), off, off]);
    state = recordAutodefense(
      state,
      [
        {
          step: {
            target: 'firewall',
            label: 'il firewall di Vercel',
            ruleId: null,
            body: { action: 'firewallEnabled', id: null, value: true },
          },
          ok: false,
        },
      ],
      ['ai-bots'],
      at(2),
    );
    expect(parseAutodefense(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(parseAutodefense(null)).toEqual(emptyAutodefense());
    expect(parseAutodefense({ ...state, v: 99 })).toEqual(emptyAutodefense());
    expect(
      parseAutodefense({
        v: 1,
        baseline: { firewall: 'sì', aiBots: 'log', rules: ['ok', 7, '', 'ok'] },
        off: { firewall: -2, altro: 5 },
        restores: { firewall: ['non una data', at(1).toISOString()] },
        attempts: { firewall: 12 },
        standDown: 'tutto',
        resumeSeen: 'ieri',
      }),
    ).toEqual({
      ...emptyAutodefense(),
      baseline: { firewall: false, aiBots: null, rules: ['ok'] },
      restores: { firewall: [at(1).toISOString()] },
    });
  });
});
