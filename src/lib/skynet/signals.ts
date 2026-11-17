// @polsia:user-owned — «Skynet», la parte pura: dai segnali ai problemi e dai problemi alle
// decisioni (aprire un incidente, aggiornarlo, ricordarlo, chiuderlo; notare una modifica del
// firewall). Niente rete né database: la usano sentinel.server.ts, il pannello admin e i test.
//
// Skynet avvisa soltanto: non cambia mai firewall, codice, impostazioni o dati del sito. Per non
// mandare falsi allarmi un problema conta solo quando è confermato (CONFIRM_AFTER giri di fila) e
// un incidente si chiude solo dopo CALM_TO_RESOLVE giri tranquilli.

/** Le regole del firewall create per Skynet si riconoscono dal nome. */
export const SKYNET_RULE_PREFIX = 'Skynet ·';
/** Sonde e scanner, AI dichiarate, SMS/registrazioni/recupero. */
export const EXPECTED_SKYNET_RULES = 3;
/** Oltre questo tempo di risposta di /health il sito è «lento». */
export const SLOW_HEALTH_MS = 4_000;
/** Giri tranquilli di fila (uno al minuto) prima di dichiarare risolto un incidente. */
export const CALM_TO_RESOLVE = 3;
/** Un incidente ancora aperto viene ricordato al massimo una volta all'ora. */
export const REMIND_AFTER_MS = 60 * 60 * 1000;

export type InternalState = 'ok' | 'degraded' | 'down' | 'unknown';

export type SkynetSignals = {
  at: string;
  vercel: {
    /** C'è un token per leggere Vercel (SKYNET_VERCEL_TOKEN e gli identificativi del progetto). */
    configured: boolean;
    /** Vercel ha risposto; null se non configurato. */
    reachable: boolean | null;
    /** Anomalie di traffico (attacchi) rilevate da Vercel. */
    anomalies: number | null;
    firewallEnabled: boolean | null;
    firewallVersion: number | null;
    aiBotsActive: boolean | null;
    skynetRulesActive: number | null;
    attackMode: boolean | null;
  };
  site: {
    healthOk: boolean;
    healthStatus: number | null;
    healthMs: number | null;
    internal: InternalState;
    internalFailing: string[];
  };
};

export const PROBLEM_KEYS = [
  'ddos',
  'firewall-off',
  'ai-bots-off',
  'skynet-rules',
  'site-down',
  'site-slow',
  'internal-down',
  'vercel-blind',
] as const;
export type ProblemKey = (typeof PROBLEM_KEYS)[number];
export type Severity = 'critical' | 'warning';
export type Problem = { key: ProblemKey; severity: Severity; title: string; detail: string };

/** Giri di fila in cui un problema deve comparire prima di dare l'allarme. */
export const CONFIRM_AFTER: Readonly<Record<ProblemKey, number>> = {
  ddos: 1,
  'firewall-off': 1,
  'ai-bots-off': 1,
  'skynet-rules': 1,
  'site-down': 2,
  'site-slow': 3,
  'internal-down': 1,
  'vercel-blind': 5,
};

export function isProblemKey(value: unknown): value is ProblemKey {
  return typeof value === 'string' && (PROBLEM_KEYS as readonly string[]).includes(value);
}

/** I problemi visibili in questo giro (non ancora confermati). */
export function detectProblems(signals: SkynetSignals): Problem[] {
  const { vercel, site } = signals;
  const problems: Problem[] = [];
  if (vercel.anomalies !== null && vercel.anomalies > 0) {
    problems.push({
      key: 'ddos',
      severity: 'critical',
      title: 'Possibile attacco DDoS in corso',
      detail: `Vercel rileva ${vercel.anomalies === 1 ? '1 anomalia' : `${vercel.anomalies} anomalie`} di traffico`,
    });
  }
  if (vercel.firewallEnabled === false) {
    problems.push({
      key: 'firewall-off',
      severity: 'critical',
      title: 'Firewall di Vercel spento',
      detail: 'Nessuna regola del firewall è in funzione',
    });
  }
  if (vercel.aiBotsActive === false) {
    problems.push({
      key: 'ai-bots-off',
      severity: 'warning',
      title: 'Blocco delle AI («AI Bots») disattivato',
      detail: 'La regola gestita di Vercel contro i crawler AI non è attiva',
    });
  }
  if (vercel.skynetRulesActive !== null && vercel.skynetRulesActive < EXPECTED_SKYNET_RULES) {
    problems.push({
      key: 'skynet-rules',
      severity: 'warning',
      title: 'Regole Skynet del firewall mancanti o spente',
      detail: `Attive ${vercel.skynetRulesActive} su ${EXPECTED_SKYNET_RULES}`,
    });
  }
  if (!site.healthOk) {
    problems.push({
      key: 'site-down',
      severity: 'critical',
      title: 'Il sito non risponde',
      detail:
        site.healthStatus === null
          ? '/health non risponde (rete o tempo scaduto)'
          : `/health risponde HTTP ${site.healthStatus}`,
    });
  } else if (site.healthMs !== null && site.healthMs > SLOW_HEALTH_MS) {
    problems.push({
      key: 'site-slow',
      severity: 'warning',
      title: 'Il sito è lento',
      detail: `/health risponde in ${(site.healthMs / 1000).toFixed(1).replace('.', ',')} s`,
    });
  }
  if (site.internal === 'down') {
    problems.push({
      key: 'internal-down',
      severity: 'critical',
      title: 'Controlli interni in errore',
      detail: site.internalFailing.length
        ? `Non funzionano: ${site.internalFailing.join(', ')}`
        : 'Un controllo essenziale non funziona',
    });
  }
  if (vercel.configured && vercel.reachable === false) {
    problems.push({
      key: 'vercel-blind',
      severity: 'warning',
      title: 'Skynet non riesce a leggere Vercel',
      detail: 'Il token SKYNET_VERCEL_TOKEN è scaduto, revocato o senza accesso al progetto',
    });
  }
  return problems;
}

export type SkynetMemory = {
  streaks: Partial<Record<ProblemKey, number>>;
  calmStreak: number;
  incidentSince: string | null;
  incidentKeys: ProblemKey[];
  lastNotifiedAt: string | null;
  firewallVersion: number | null;
};

export const EMPTY_MEMORY: SkynetMemory = {
  streaks: {},
  calmStreak: 0,
  incidentSince: null,
  incidentKeys: [],
  lastNotifiedAt: null,
  firewallVersion: null,
};

export type SkynetDecision =
  | { kind: 'none' }
  | { kind: 'incident' | 'update' | 'reminder'; severity: Severity; problems: Problem[] }
  | { kind: 'resolved'; since: string; keys: ProblemKey[] };

export type SkynetStep = {
  memory: SkynetMemory;
  decision: SkynetDecision;
  confirmed: Problem[];
  firewallChange: { from: number; to: number } | null;
};

function worst(problems: Problem[]): Severity {
  return problems.some((problem) => problem.severity === 'critical') ? 'critical' : 'warning';
}

/** Un giro della sentinella: aggiorna la memoria e decide se avvisare. */
export function decide(
  memory: SkynetMemory,
  problems: Problem[],
  signals: SkynetSignals,
  now: Date,
): SkynetStep {
  const streaks: Partial<Record<ProblemKey, number>> = {};
  for (const problem of problems) streaks[problem.key] = (memory.streaks[problem.key] ?? 0) + 1;
  const confirmed = problems.filter(
    (problem) => (streaks[problem.key] ?? 0) >= CONFIRM_AFTER[problem.key],
  );

  const version = signals.vercel.firewallVersion;
  const firewallChange =
    version !== null && memory.firewallVersion !== null && version !== memory.firewallVersion
      ? { from: memory.firewallVersion, to: version }
      : null;

  const next: SkynetMemory = {
    ...memory,
    streaks,
    firewallVersion: version ?? memory.firewallVersion,
  };
  const at = now.toISOString();

  if (confirmed.length > 0) {
    next.calmStreak = 0;
    const keys = confirmed.map((problem) => problem.key);
    if (!memory.incidentSince) {
      next.incidentSince = at;
      next.incidentKeys = keys;
      next.lastNotifiedAt = at;
      return {
        memory: next,
        decision: { kind: 'incident', severity: worst(confirmed), problems: confirmed },
        confirmed,
        firewallChange,
      };
    }
    const added = keys.filter((key) => !memory.incidentKeys.includes(key));
    if (added.length > 0) {
      next.incidentKeys = [...memory.incidentKeys, ...added];
      next.lastNotifiedAt = at;
      return {
        memory: next,
        decision: { kind: 'update', severity: worst(confirmed), problems: confirmed },
        confirmed,
        firewallChange,
      };
    }
    const last = memory.lastNotifiedAt ? Date.parse(memory.lastNotifiedAt) : 0;
    if (now.getTime() - last >= REMIND_AFTER_MS) {
      next.lastNotifiedAt = at;
      return {
        memory: next,
        decision: { kind: 'reminder', severity: worst(confirmed), problems: confirmed },
        confirmed,
        firewallChange,
      };
    }
    return { memory: next, decision: { kind: 'none' }, confirmed, firewallChange };
  }

  if (memory.incidentSince) {
    next.calmStreak = memory.calmStreak + 1;
    if (next.calmStreak >= CALM_TO_RESOLVE) {
      const resolved: SkynetDecision = {
        kind: 'resolved',
        since: memory.incidentSince,
        keys: memory.incidentKeys,
      };
      return {
        memory: {
          ...next,
          calmStreak: 0,
          incidentSince: null,
          incidentKeys: [],
          lastNotifiedAt: at,
        },
        decision: resolved,
        confirmed,
        firewallChange,
      };
    }
    return { memory: next, decision: { kind: 'none' }, confirmed, firewallChange };
  }
  next.calmStreak = 0;
  return { memory: next, decision: { kind: 'none' }, confirmed, firewallChange };
}

/** Durata leggibile in italiano («3 minuti», «1 ora e 5 minuti»). */
export function durationText(fromIso: string, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return minutes === 1 ? '1 minuto' : `${minutes} minuti`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = hours === 1 ? '1 ora' : `${hours} ore`;
  return rest === 0 ? h : `${h} e ${rest === 1 ? '1 minuto' : `${rest} minuti`}`;
}

/** Rapporto di riserva quando Claude non è disponibile: solo fatti, nessuna ipotesi. */
export function fallbackReport(decision: SkynetDecision, now: Date): string {
  if (decision.kind === 'none') return '';
  if (decision.kind === 'resolved') {
    return `Tutto è tornato normale dopo ${durationText(decision.since, now)}. Nessuna azione richiesta.`;
  }
  const lines = decision.problems.map((problem) => `- ${problem.title}: ${problem.detail}.`);
  const steps: string[] = [];
  const keys = new Set(decision.problems.map((problem) => problem.key));
  if (keys.has('ddos')) {
    steps.push(
      'Se il sito rallenta, accenda la protezione anti-attacco: Vercel → progetto → Firewall → Attack Challenge Mode.',
    );
  }
  if (keys.has('firewall-off') || keys.has('ai-bots-off') || keys.has('skynet-rules')) {
    steps.push(
      'Controlli in Vercel → Firewall chi ha cambiato le regole; se non è stato lei, cambi la password di Vercel e revochi i token.',
    );
  }
  if (keys.has('site-down') || keys.has('internal-down')) {
    steps.push('Guardi lo stato in Amministrazione → Monitoraggio e gli ultimi deploy su Vercel.');
  }
  if (keys.has('vercel-blind')) {
    steps.push('Crei un nuovo token Vercel e lo salvi come SKYNET_VERCEL_TOKEN.');
  }
  return [
    ...lines,
    ...(steps.length ? ['', 'Cosa fare:', ...steps.map((s) => `- ${s}`)] : []),
  ].join('\n');
}
