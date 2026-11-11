// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createListeningUsage, getListeningCalendarMonth } from '@/lib/music/listening-quota';

describe('limite mensile degli ascolti', () => {
  it('consente il passaggio da 39 a 40 e indica zero ascolti rimanenti', () => {
    expect(createListeningUsage(39, new Date('2026-11-08T12:00:00.000Z'))).toMatchObject({
      used: 39,
      limit: 40,
      remaining: 1,
    });
    expect(createListeningUsage(40, new Date('2026-11-08T12:00:00.000Z'))).toMatchObject({
      used: 40,
      limit: 40,
      remaining: 0,
    });
  });

  it('sposta il conteggio al mese nuovo al confine del calendario italiano', () => {
    const lastMomentOfMarch = getListeningCalendarMonth(new Date('2026-03-31T21:59:59.999Z'));
    const firstMomentOfApril = getListeningCalendarMonth(new Date('2026-03-31T22:00:00.000Z'));

    expect(lastMomentOfMarch.monthLabel).toBe('marzo 2026');
    expect(lastMomentOfMarch.end.toISOString()).toBe('2026-03-31T22:00:00.000Z');
    expect(firstMomentOfApril.monthLabel).toBe('aprile 2026');
    expect(firstMomentOfApril.start.toISOString()).toBe('2026-03-31T22:00:00.000Z');
  });

  it('calcola il confine autunnale dopo il cambio dell’ora legale', () => {
    const lastMomentOfOctober = getListeningCalendarMonth(new Date('2026-10-31T22:59:59.999Z'));
    const firstMomentOfNovember = getListeningCalendarMonth(new Date('2026-10-31T23:00:00.000Z'));

    expect(lastMomentOfOctober.monthLabel).toBe('ottobre 2026');
    expect(lastMomentOfOctober.end.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(firstMomentOfNovember.monthLabel).toBe('novembre 2026');
    expect(firstMomentOfNovember.start.toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });
});
