// @polsia:user-owned
// @vitest-environment node
//
// «Skynet» impara a difendersi meglio nel tempo (src/lib/skynet/learning.ts): statistiche aggregate
// degli attacchi (niente indirizzi IP) con media mobile, soglie di difesa regolate da solo DENTRO
// limiti fissi, e una vista spiegabile per il pannello. Si torna alle soglie di partenza se lo stato
// manca o è corrotto.
import { describe, expect, it } from 'vitest';
import {
  ADVANCED_OFFENSES_BOUNDS,
  adaptedThresholds,
  DEFAULT_ADVANCED_OFFENSES,
  DEFAULT_WAVE,
  defenseSummary,
  emptyDefense,
  type HuntObservation,
  LEARN_VERSION,
  LEARN_WARMUP,
  type LearnedDefense,
  learn,
  parseLearned,
  WAVE_BOUNDS,
} from '@/lib/skynet/learning';

const NOW = new Date('2026-11-18T03:00:00.000Z');

const obs = (o: Partial<HuntObservation> = {}): HuntObservation => ({
  challenged: 0,
  escalated: 0,
  advanced: 0,
  anomalies: 0,
  reasons: {},
  hour: 3,
  ...o,
});

/** Applica la stessa osservazione `n` volte, partendo da zero. */
function trainWith(o: HuntObservation, n: number, now = NOW): LearnedDefense {
  let state: LearnedDefense | null = null;
  for (let i = 0; i < n; i += 1) state = learn(state, o, now);
  if (!state) throw new Error('nessun giro');
  return state;
}

describe('stato appreso', () => {
  it('vuoto: tutto a zero, 24 ore, versione corrente', () => {
    const empty = emptyDefense(NOW);
    expect(empty.version).toBe(LEARN_VERSION);
    expect(empty.runs).toBe(0);
    expect(empty.hours).toHaveLength(24);
    expect(empty.hours.every((h) => h === 0)).toBe(true);
    expect(empty.pressure).toBe(0);
  });

  it('parseLearned: legge uno stato valido, rifiuta formati vecchi o corrotti, taglia i tassi', () => {
    const valid = learn(null, obs({ challenged: 2 }), NOW);
    expect(parseLearned(valid)?.runs).toBe(1);
    expect(parseLearned(null)).toBeNull();
    expect(parseLearned({ version: 999, runs: 5 })).toBeNull();
    expect(parseLearned('rumore')).toBeNull();
    // Tassi fuori scala vengono riportati in [0,1]; i negativi a 0.
    const clamped = parseLearned({
      version: LEARN_VERSION,
      runs: 3,
      escalationRate: 5,
      advancedRate: -2,
      pressure: -1,
      hours: [1, 2],
    });
    expect(clamped?.escalationRate).toBe(1);
    expect(clamped?.advancedRate).toBe(0);
    expect(clamped?.pressure).toBe(0);
    expect(clamped?.hours).toHaveLength(24);
  });
});

describe('apprendimento in linea', () => {
  it('la pressione sale con gli attacchi e scende quando torna calmo; i tassi restano in [0,1]', () => {
    const busy = trainWith(obs({ challenged: 4, escalated: 1, advanced: 1 }), 40);
    expect(busy.pressure).toBeGreaterThan(3);
    expect(busy.escalationRate).toBeGreaterThan(0.8);
    expect(busy.advancedRate).toBeGreaterThan(0.8);
    expect(busy.escalationRate).toBeLessThanOrEqual(1);

    // Dopo tanti giri calmi la pressione decade verso zero.
    let state: LearnedDefense | null = busy;
    for (let i = 0; i < 80; i += 1) state = learn(state, obs(), NOW);
    expect(state?.pressure).toBeLessThan(0.5);
    expect(state?.escalationRate).toBeLessThan(0.2);
  });

  it('impara il mix di tecniche e il profilo orario, e ricorda il picco', () => {
    let state: LearnedDefense | null = null;
    for (let i = 0; i < 60; i += 1) {
      state = learn(
        state,
        obs({ challenged: 3, reasons: { 'sonde da scanner': 3 }, hour: 2 }),
        NOW,
      );
    }
    expect(Object.keys(state?.reasonShare ?? {})).toContain('sonde da scanner');
    expect(state?.reasonShare['sonde da scanner']).toBeGreaterThan(0.8);
    // L'ora 2 (UTC) è la più calda.
    const hottest = (state?.hours ?? []).indexOf(Math.max(...(state?.hours ?? [0])));
    expect(hottest).toBe(2);
    expect(state?.peakChallenged).toBe(3);
  });
});

describe('soglie di difesa adattate (sempre dentro i limiti)', () => {
  it('prima della maturità usa le soglie di partenza del cacciatore', () => {
    expect(adaptedThresholds(null)).toMatchObject({
      advancedOffenses: DEFAULT_ADVANCED_OFFENSES,
      waveThreshold: DEFAULT_WAVE,
      learned: false,
    });
    const young = trainWith(obs({ challenged: 6, escalated: 2, advanced: 2 }), LEARN_WARMUP - 1);
    expect(adaptedThresholds(young).learned).toBe(false);
  });

  it('ambiente ostile: soglia aggiramento al minimo e ondata al massimo', () => {
    const hostile = trainWith(obs({ challenged: 6, escalated: 2, advanced: 2 }), LEARN_WARMUP + 20);
    const thr = adaptedThresholds(hostile);
    expect(thr.learned).toBe(true);
    expect(thr.advancedOffenses).toBe(ADVANCED_OFFENSES_BOUNDS.min);
    expect(thr.waveThreshold).toBe(WAVE_BOUNDS.max);
  });

  it('ambiente tranquillo: soglia aggiramento al massimo e ondata al minimo', () => {
    const calm = trainWith(obs({ challenged: 1 }), LEARN_WARMUP + 20);
    const thr = adaptedThresholds(calm);
    expect(thr.learned).toBe(true);
    expect(thr.advancedOffenses).toBe(ADVANCED_OFFENSES_BOUNDS.max);
    expect(thr.waveThreshold).toBe(WAVE_BOUNDS.min);
  });

  it('non esce mai dai limiti fissi, qualunque cosa abbia imparato', () => {
    const extreme = parseLearned({
      version: LEARN_VERSION,
      runs: 100000,
      escalationRate: 1,
      advancedRate: 1,
      waveRate: 1,
    });
    const thr = adaptedThresholds(extreme);
    expect(thr.advancedOffenses).toBeGreaterThanOrEqual(ADVANCED_OFFENSES_BOUNDS.min);
    expect(thr.advancedOffenses).toBeLessThanOrEqual(ADVANCED_OFFENSES_BOUNDS.max);
    expect(thr.waveThreshold).toBeGreaterThanOrEqual(WAVE_BOUNDS.min);
    expect(thr.waveThreshold).toBeLessThanOrEqual(WAVE_BOUNDS.max);
  });
});

describe('vista spiegabile per il pannello', () => {
  it('senza dati: sta ancora imparando, soglie di partenza', () => {
    const summary = defenseSummary(null);
    expect(summary.learned).toBe(false);
    expect(summary.runs).toBe(0);
    expect(summary.advancedOffenses).toBe(DEFAULT_ADVANCED_OFFENSES);
    expect(summary.note).toContain('imparando');
    expect(summary.topReasons).toEqual([]);
  });

  it('con dati: pressione, tecniche in percentuale, ore calde e nota coerente', () => {
    let state: LearnedDefense | null = null;
    for (let i = 0; i < LEARN_WARMUP + 20; i += 1) {
      state = learn(
        state,
        obs({
          challenged: 6,
          escalated: 2,
          advanced: 2,
          reasons: { 'sonde da scanner': 6 },
          hour: 5,
        }),
        NOW,
      );
    }
    const summary = defenseSummary(state);
    expect(summary.learned).toBe(true);
    expect(summary.pressurePerRun).toBeGreaterThan(5);
    expect(summary.topReasons[0]).toMatchObject({ reason: 'sonde da scanner' });
    expect(summary.topReasons[0]?.share).toBeGreaterThan(80);
    expect(summary.busiestHours).toContain(5);
    expect(summary.advancedOffenses).toBe(ADVANCED_OFFENSES_BOUNDS.min);
    expect(summary.note).toContain('insistono');
  });
});
