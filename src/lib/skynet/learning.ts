// @polsia:user-owned — «Skynet» impara a difendersi meglio nel tempo (apprendimento in linea, parte
// pura: niente rete né database). Non è un modello in cloud né un servizio esterno: a ogni giro
// aggiorna statistiche AGGREGATE degli attacchi — pressione, quanto spesso i recidivi insistono o si
// vedono aggiramenti, le ondate, il mix di tecniche e il profilo orario — con una media mobile
// esponenziale (EWMA). Nessun indirizzo IP entra qui: solo conteggi, tassi e ore.
//
// Da ciò che impara, Skynet regola DA SOLO due soglie di difesa, SEMPRE dentro limiti fissi: la
// soglia del «sospetto aggiramento» del cacciatore e la soglia dell'«ondata» per gli avvisi Telegram.
// Mai oltre i limiti: l'apprendimento non può spegnere una protezione, creare un blocco totale,
// toccare una regola o salvare un indirizzo. Se lo stato appreso manca o è corrotto, si torna alle
// soglie di sicurezza di partenza (fallisce al sicuro).
import { ADVANCED_OFFENSES, HUNT_WAVE } from './hunter';

/** Formato dello stato appreso: se cambia, lo stato vecchio viene scartato e si riparte dai valori base. */
export const LEARN_VERSION = 1;
/** Peso dell'ultimo giro nella media mobile (reattività a regime). */
export const LEARN_ALPHA = 0.08;
/** Peso di ogni giro nel profilo orario (più lento: è una fotografia di lungo periodo). */
export const HOUR_ALPHA = 0.05;
/** Giri osservati prima di fidarsi di ciò che si è imparato (circa un'ora di dati al minuto). */
export const LEARN_WARMUP = 60;
/** Al massimo quante tecniche d'attacco diverse si tengono a mente. */
export const MAX_REASONS = 8;

/** Soglie di difesa di partenza (quelle del cacciatore): usate finché non si è imparato abbastanza. */
export const DEFAULT_ADVANCED_OFFENSES = ADVANCED_OFFENSES;
export const DEFAULT_WAVE = HUNT_WAVE;
/** Limiti fissi entro cui l'apprendimento può muovere le soglie: mai fuori di qui. */
export const ADVANCED_OFFENSES_BOUNDS = { min: 4, max: 8 } as const;
export const WAVE_BOUNDS = { min: 3, max: 12 } as const;

/** Cosa Skynet ha visto in un giro (aggregato, senza indirizzi). */
export type HuntObservation = {
  /** Nuovi indirizzi mandati alla verifica. */
  challenged: number;
  /** Recidivi che hanno attaccato durante la verifica. */
  escalated: number;
  /** Di questi nuovi, quanti erano sospetti aggiramenti. */
  advanced: number;
  /** Anomalie di traffico (DDoS) rilevate da Vercel. */
  anomalies: number;
  /** Tecniche viste in questo giro (nomi delle regole → conteggi; nessun IP). */
  reasons: Record<string, number>;
  /** Ora del giro, 0..23 (UTC). */
  hour: number;
};

/** Ciò che Skynet ha imparato, tenuto nello stato della sentinella (SkynetState.learning). */
export type LearnedDefense = {
  version: number;
  runs: number;
  updatedAt: string;
  /** Media mobile degli attacchi per giro (nuovi + recidivi): la pressione «normale». */
  pressure: number;
  /** Media mobile delle anomalie di traffico per giro. */
  anomaly: number;
  /** Quanto spesso i recidivi insistono durante la verifica (0..1): la verifica breve non basta. */
  escalationRate: number;
  /** Quanto spesso si vedono tentativi di aggiramento (0..1). */
  advancedRate: number;
  /** Quanto spesso arriva un'ondata (0..1). */
  waveRate: number;
  /** Quota media di ciascuna tecnica d'attacco (0..1). */
  reasonShare: Record<string, number>;
  /** Profilo orario della pressione: 24 medie mobili (UTC). */
  hours: number[];
  /** Massimo di nuovi in un solo giro mai visto (memoria lunga). */
  peakChallenged: number;
};

/** Le soglie adattate da usare in questo giro; `learned` = l'apprendimento è maturo e le sta guidando. */
export type AdaptedThresholds = {
  advancedOffenses: number;
  waveThreshold: number;
  learned: boolean;
};

/** La vista spiegabile per il pannello: cosa ha imparato Skynet e come ha regolato le difese. */
export type DefenseSummary = {
  learned: boolean;
  runs: number;
  /** Attacchi tipici per giro. */
  pressurePerRun: number;
  /** Anomalie tipiche per giro. */
  anomalyPerRun: number;
  advancedOffenses: number;
  waveThreshold: number;
  /** Tecniche più viste, con la quota in percentuale. */
  topReasons: Array<{ reason: string; share: number }>;
  /** Fino a 3 ore (UTC) con più attacchi. */
  busiestHours: number[];
  note: string;
};

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
const clamp01 = (value: number): number => clamp(value, 0, 1);
const ewma = (prev: number, next: number, alpha: number): number => prev + alpha * (next - prev);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const round1 = (value: number): number => Math.round(value * 10) / 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stato appreso vuoto (prima esecuzione). */
export function emptyDefense(now: Date): LearnedDefense {
  return {
    version: LEARN_VERSION,
    runs: 0,
    updatedAt: now.toISOString(),
    pressure: 0,
    anomaly: 0,
    escalationRate: 0,
    advancedRate: 0,
    waveRate: 0,
    reasonShare: {},
    hours: new Array<number>(24).fill(0),
    peakChallenged: 0,
  };
}

/** Legge lo stato appreso dal JSON salvato; null se manca, è corrotto o di un formato vecchio. */
export function parseLearned(raw: unknown): LearnedDefense | null {
  if (!isRecord(raw) || raw.version !== LEARN_VERSION) return null;
  const num = (value: unknown, min = 0): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, value) : min;
  const hoursRaw = Array.isArray(raw.hours) ? raw.hours : [];
  const hours = Array.from({ length: 24 }, (_, i) => num(hoursRaw[i]));
  const reasonShare: Record<string, number> = {};
  if (isRecord(raw.reasonShare)) {
    for (const [key, value] of Object.entries(raw.reasonShare)) {
      if (typeof value === 'number' && Number.isFinite(value)) reasonShare[key] = clamp01(value);
    }
  }
  return {
    version: LEARN_VERSION,
    runs: Math.floor(num(raw.runs)),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
    pressure: num(raw.pressure),
    anomaly: num(raw.anomaly),
    escalationRate: clamp01(num(raw.escalationRate)),
    advancedRate: clamp01(num(raw.advancedRate)),
    waveRate: clamp01(num(raw.waveRate)),
    reasonShare,
    hours,
    peakChallenged: Math.floor(num(raw.peakChallenged)),
  };
}

/** Aggiorna ciò che Skynet ha imparato con l'osservazione di questo giro. */
export function learn(
  prev: LearnedDefense | null,
  obs: HuntObservation,
  now: Date,
): LearnedDefense {
  const base = prev && prev.version === LEARN_VERSION ? prev : emptyDefense(now);
  const runs = base.runs + 1;
  // All'inizio impara in fretta (media dei campioni), poi si assesta sulla reattività fissa.
  const alpha = Math.max(LEARN_ALPHA, 1 / runs);
  const challenged = Math.max(0, obs.challenged);
  const escalated = Math.max(0, obs.escalated);
  const activity = challenged + escalated;
  const isWave = challenged >= DEFAULT_WAVE ? 1 : 0;

  // Quota delle tecniche di questo giro, poi media mobile (anche le assenti scendono verso 0).
  const total = Object.values(obs.reasons).reduce((sum, count) => sum + Math.max(0, count), 0);
  const keys = new Set([...Object.keys(base.reasonShare), ...Object.keys(obs.reasons)]);
  const merged: Record<string, number> = {};
  for (const key of keys) {
    const share = total > 0 ? Math.max(0, obs.reasons[key] ?? 0) / total : 0;
    merged[key] = clamp01(ewma(base.reasonShare[key] ?? 0, share, alpha));
  }
  const reasonShare = Object.fromEntries(
    Object.entries(merged)
      .filter(([, share]) => share > 0.001)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_REASONS),
  );

  const hours = base.hours.slice();
  const hour = clamp(Math.floor(obs.hour), 0, 23);
  hours[hour] = ewma(hours[hour] ?? 0, activity, HOUR_ALPHA);

  return {
    version: LEARN_VERSION,
    runs,
    updatedAt: now.toISOString(),
    pressure: Math.max(0, ewma(base.pressure, activity, alpha)),
    anomaly: Math.max(0, ewma(base.anomaly, Math.max(0, obs.anomalies), alpha)),
    escalationRate: clamp01(ewma(base.escalationRate, escalated > 0 ? 1 : 0, alpha)),
    advancedRate: clamp01(ewma(base.advancedRate, obs.advanced > 0 ? 1 : 0, alpha)),
    waveRate: clamp01(ewma(base.waveRate, isWave, alpha)),
    reasonShare,
    hours,
    peakChallenged: Math.max(base.peakChallenged, challenged),
  };
}

/**
 * Le soglie di difesa adattate a ciò che Skynet ha imparato, SEMPRE dentro i limiti fissi. Finché
 * l'apprendimento non è maturo (LEARN_WARMUP giri) usa le soglie di partenza del cacciatore.
 */
export function adaptedThresholds(learned: LearnedDefense | null): AdaptedThresholds {
  if (!learned || learned.version !== LEARN_VERSION || learned.runs < LEARN_WARMUP) {
    return {
      advancedOffenses: DEFAULT_ADVANCED_OFFENSES,
      waveThreshold: DEFAULT_WAVE,
      learned: false,
    };
  }
  // Ambiente ostile (recidivi e aggiramenti frequenti) → più aggressivi: soglia aggiramento più bassa,
  // così si manda prima alla verifica di 7 giorni. Ambiente tranquillo → soglia più alta (meno zelo).
  const hostility = clamp01(0.6 * learned.escalationRate + 0.4 * learned.advancedRate);
  const advancedOffenses = clamp(
    Math.round(lerp(ADVANCED_OFFENSES_BOUNDS.max, ADVANCED_OFFENSES_BOUNDS.min, hostility)),
    ADVANCED_OFFENSES_BOUNDS.min,
    ADVANCED_OFFENSES_BOUNDS.max,
  );
  // Ondate frequenti → alza la soglia Telegram per non sommergere il proprietario; ondate rare →
  // abbassala per cogliere anche piccoli gruppi. Non tocca mai la protezione, solo gli avvisi.
  const waveLoad = clamp01(learned.waveRate / 0.2);
  const waveThreshold = clamp(
    Math.round(lerp(WAVE_BOUNDS.min, WAVE_BOUNDS.max, waveLoad)),
    WAVE_BOUNDS.min,
    WAVE_BOUNDS.max,
  );
  return { advancedOffenses, waveThreshold, learned: true };
}

function learnedNote(learned: LearnedDefense | null, thresholds: AdaptedThresholds): string {
  if (!learned || learned.runs === 0) {
    return 'Skynet sta ancora imparando dal traffico: servono alcuni giri prima di regolare le difese.';
  }
  if (!thresholds.learned) {
    return `Skynet sta imparando dal traffico (${learned.runs} giri): finché non ha abbastanza dati tiene le soglie di sicurezza di partenza.`;
  }
  const hostile = learned.escalationRate > 0.2 || learned.advancedRate > 0.2;
  if (hostile) {
    return `Negli ultimi giri gli attacchi insistono: Skynet ha abbassato a ${thresholds.advancedOffenses} blocchi la soglia del «sospetto aggiramento», così manda prima alla verifica di 7 giorni. Resta sempre solo una verifica del browser: una persona vera passa.`;
  }
  return `Poco traffico ostile di recente: Skynet tiene soglie prudenti (aggiramento a ${thresholds.advancedOffenses} blocchi) e avvisa anche per gruppi piccoli (ondata a ${thresholds.waveThreshold}).`;
}

/** La vista spiegabile per il pannello: cosa Skynet ha imparato e come ha regolato le difese. */
export function defenseSummary(learned: LearnedDefense | null): DefenseSummary {
  const thresholds = adaptedThresholds(learned);
  const topReasons = learned
    ? Object.entries(learned.reasonShare)
        .filter(([, share]) => share > 0.005)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, share]) => ({ reason, share: Math.round(share * 100) }))
    : [];
  const busiestHours = learned
    ? learned.hours
        .map((value, hour) => ({ hour, value }))
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 3)
        .map((entry) => entry.hour)
        .sort((a, b) => a - b)
    : [];
  return {
    learned: thresholds.learned,
    runs: learned?.runs ?? 0,
    pressurePerRun: round1(learned?.pressure ?? 0),
    anomalyPerRun: round1(learned?.anomaly ?? 0),
    advancedOffenses: thresholds.advancedOffenses,
    waveThreshold: thresholds.waveThreshold,
    topReasons,
    busiestHours,
    note: learnedNote(learned, thresholds),
  };
}
