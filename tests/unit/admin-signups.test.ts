// @polsia:user-owned — scheda Iscritti: giorni di calendario in ora italiana (mezzanotte e cambi
// dell'ora legale), finestra dei 30 giorni, riempimento con zero, conversione dei conteggi e query
// aggregate parametrizzate (database finto: nessun Postgres nel sandbox).
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: vi.fn() } }));

import {
  buildSignupStats,
  romeDayKey,
  shiftDayKey,
  signupDayKeys,
  signupWindows,
  toCount,
  zeroFillDays,
} from '@/lib/admin/signups';
import { getSignupStats, type SignupsDb } from '@/lib/admin/signups.server';
import { AdminSignupsSchema, SIGNUPS_DAYS } from '@/lib/contracts/admin-signups';

const at = (iso: string) => new Date(iso);

function isConsecutive(keys: string[]) {
  return keys.every((key, index) => index === 0 || shiftDayKey(keys[index - 1] ?? '', 1) === key);
}

describe('romeDayKey: confini del giorno in ora italiana', () => {
  it('passa al giorno dopo alla mezzanotte di Roma, non a quella UTC (ora solare, +1)', () => {
    expect(romeDayKey(at('2026-11-13T22:59:59.999Z'))).toBe('2026-11-13');
    expect(romeDayKey(at('2026-11-13T23:00:00.000Z'))).toBe('2026-11-14');
    // 00:30 UTC sono già le 01:30 a Roma: stesso giorno in entrambi i casi.
    expect(romeDayKey(at('2026-11-14T00:30:00.000Z'))).toBe('2026-11-14');
  });

  it('usa +2 in ora legale', () => {
    expect(romeDayKey(at('2026-07-01T21:59:59.999Z'))).toBe('2026-07-01');
    expect(romeDayKey(at('2026-07-01T22:00:00.000Z'))).toBe('2026-07-02');
  });

  it('gestisce il giorno di 23 ore dell’inizio dell’ora legale (29 marzo 2026)', () => {
    // Inizia alla mezzanotte dell'ora solare (+1)…
    expect(romeDayKey(at('2026-03-28T22:59:59.999Z'))).toBe('2026-03-28');
    expect(romeDayKey(at('2026-03-28T23:00:00.000Z'))).toBe('2026-03-29');
    // …gli orologi vanno avanti alle 01:00 UTC…
    expect(romeDayKey(at('2026-03-29T01:30:00.000Z'))).toBe('2026-03-29');
    // …e finisce alla mezzanotte dell'ora legale (+2).
    expect(romeDayKey(at('2026-03-29T21:59:59.999Z'))).toBe('2026-03-29');
    expect(romeDayKey(at('2026-03-29T22:00:00.000Z'))).toBe('2026-03-30');
  });

  it('gestisce il giorno di 25 ore della fine dell’ora legale (25 ottobre 2026)', () => {
    expect(romeDayKey(at('2026-10-24T21:59:59.999Z'))).toBe('2026-10-24');
    expect(romeDayKey(at('2026-10-24T22:00:00.000Z'))).toBe('2026-10-25');
    // Le 02:30 locali capitano due volte; entrambe sono il 25 ottobre.
    expect(romeDayKey(at('2026-10-25T00:30:00.000Z'))).toBe('2026-10-25');
    expect(romeDayKey(at('2026-10-25T01:30:00.000Z'))).toBe('2026-10-25');
    expect(romeDayKey(at('2026-10-25T22:59:59.999Z'))).toBe('2026-10-25');
    expect(romeDayKey(at('2026-10-25T23:00:00.000Z'))).toBe('2026-10-26');
  });

  it('rifiuta una data non valida', () => {
    expect(() => romeDayKey(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('shiftDayKey e signupDayKeys', () => {
  it('sposta i giorni di calendario tra mesi, anni bisestili e cambi d’ora', () => {
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDayKey('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDayKey('2026-10-25', 1)).toBe('2026-10-26');
    expect(shiftDayKey('2026-03-29', 1)).toBe('2026-03-30');
    expect(() => shiftDayKey('14/11/2026', 1)).toThrow(RangeError);
  });

  it('restituisce 30 giorni consecutivi, dal più vecchio a oggi, col 25 ottobre una sola volta', () => {
    const keys = signupDayKeys(at('2026-11-14T10:00:00.000Z'));
    expect(keys).toHaveLength(SIGNUPS_DAYS);
    expect(keys[0]).toBe('2026-10-16');
    expect(keys.at(-1)).toBe('2026-11-14');
    expect(keys.filter((key) => key === '2026-10-25')).toHaveLength(1);
    expect(new Set(keys).size).toBe(SIGNUPS_DAYS);
    expect(isConsecutive(keys)).toBe(true);
  });

  it('considera "oggi" il giorno di Roma anche poco dopo la mezzanotte italiana', () => {
    // Le 23:30 UTC del 13 sono le 00:30 del 14 a Roma.
    const keys = signupDayKeys(at('2026-11-13T23:30:00.000Z'));
    expect(keys.at(-1)).toBe('2026-11-14');
    expect(keys[0]).toBe('2026-10-16');
  });

  it('attraversa l’inizio dell’ora legale senza buchi né doppioni', () => {
    const keys = signupDayKeys(at('2026-04-10T12:00:00.000Z'));
    expect(keys[0]).toBe('2026-03-12');
    expect(keys.at(-1)).toBe('2026-04-10');
    expect(keys.filter((key) => key === '2026-03-29')).toHaveLength(1);
    expect(isConsecutive(keys)).toBe(true);
  });
});

describe('signupWindows', () => {
  it('usa finestre mobili di 24 ore, 7 e 30 giorni fino a ora', () => {
    expect(signupWindows(at('2026-11-14T14:30:00.000Z'))).toEqual({
      nowIso: '2026-11-14T14:30:00.000Z',
      since24h: '2026-11-13T14:30:00.000Z',
      since7d: '2026-11-07T14:30:00.000Z',
      since30d: '2026-10-15T14:30:00.000Z',
    });
  });
});

describe('toCount e zeroFillDays', () => {
  it('converte i bigint di Postgres e rifiuta valori impossibili', () => {
    expect(toCount(5n)).toBe(5);
    expect(toCount(0)).toBe(0);
    expect(toCount('42')).toBe(42);
    for (const value of [-1, 1.5, Number.NaN, null, undefined, '4a', 2n ** 60n, -3n]) {
      expect(() => toCount(value)).toThrow(TypeError);
    }
  });

  it('mette zero nei giorni vuoti, ignora i giorni fuori finestra e somma i doppioni', () => {
    const keys = ['2026-11-12', '2026-11-13', '2026-11-14'];
    expect(
      zeroFillDays(keys, [
        { day: '2026-11-13', count: 2 },
        { day: '2026-11-15', count: 9 },
        { day: '2026-11-13', count: 1 },
      ]),
    ).toEqual([
      { day: '2026-11-12', count: 0 },
      { day: '2026-11-13', count: 3 },
      { day: '2026-11-14', count: 0 },
    ]);
  });
});

describe('buildSignupStats', () => {
  const now = at('2026-11-14T14:30:00.000Z');
  const keys = signupDayKeys(now);
  const totals = {
    total: 10n,
    last24h: 1n,
    last7d: 3n,
    last30d: 6n,
    verified: 7n,
    banned: 1n,
    admins: 1n,
  };

  it('copia solo i campi aggregati: colonne in più nelle righe grezze non escono', () => {
    const totalsWithPersonalColumns = { ...totals, email: 'mario@example.com' };
    const dayWithPersonalColumns = { day: '2026-11-14', count: 1n, name: 'Mario', id: 'user-1' };
    const stats = buildSignupStats(now, keys, totalsWithPersonalColumns, [dayWithPersonalColumns]);
    expect(AdminSignupsSchema.parse(stats)).toEqual(stats);
    expect(Object.keys(stats.totals).sort()).toEqual(
      ['admins', 'banned', 'last24h', 'last30d', 'last7d', 'total', 'verified'].sort(),
    );
    expect(stats.daily.at(-1)).toEqual({ day: '2026-11-14', count: 1 });
    expect(JSON.stringify(stats)).not.toMatch(/mario|user-1|@/i);
  });

  it('rifiuta righe senza totali o con un giorno non valido', () => {
    expect(() => buildSignupStats(now, keys, undefined, [])).toThrow(TypeError);
    expect(() => buildSignupStats(now, keys, totals, [{ day: '14/11', count: 1n }])).toThrow(
      TypeError,
    );
  });
});

describe('getSignupStats: query aggregate parametrizzate', () => {
  function fakeDb(totalsRow: Record<string, unknown>, dailyRows: Record<string, unknown>[]) {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('$?');
      calls.push({ sql, values });
      return sql.includes('GROUP BY') ? dailyRows : [totalsRow];
    });
    return { db: { $queryRaw } as unknown as SignupsDb, calls };
  }

  it('calcola i totali e la serie a zero riempita con due sole query sulla tabella "user"', async () => {
    const now = at('2026-11-14T14:30:00.000Z');
    const { db, calls } = fakeDb(
      { total: 12n, last24h: 2n, last7d: 4n, last30d: 9n, verified: 8n, banned: 1n, admins: 1n },
      [
        { day: '2026-10-16', count: 3n },
        { day: '2026-10-25', count: 2n },
        { day: '2026-11-14', count: 2n },
      ],
    );

    const stats = await getSignupStats(now, db);

    expect(calls).toHaveLength(2);
    const [totalsCall, dailyCall] = calls;
    // I valori viaggiano come parametri della query, mai dentro il testo SQL.
    expect(totalsCall?.values).toEqual([
      '2026-11-13T14:30:00.000Z',
      '2026-11-07T14:30:00.000Z',
      '2026-10-15T14:30:00.000Z',
      '2026-11-14T14:30:00.000Z',
    ]);
    expect(dailyCall?.values).toEqual(['2026-10-16']);
    for (const call of calls) {
      expect(call.sql).toContain('FROM "user"');
      expect(call.sql).not.toContain('2026-');
      // Solo aggregati: nessuna colonna personale viene mai letta.
      expect(call.sql).not.toMatch(/"(email|name|phoneNumber|id|image)"/);
    }
    expect(dailyCall?.sql).toContain("AT TIME ZONE 'Europe/Rome'");
    expect(dailyCall?.sql).toContain('date_trunc');
    expect(totalsCall?.sql).toContain('"phoneNumberVerified" IS TRUE');
    expect(totalsCall?.sql).toContain('"banExpires" IS NULL');

    expect(stats.generatedAt).toBe('2026-11-14T14:30:00.000Z');
    expect(stats.totals).toEqual({
      total: 12,
      last24h: 2,
      last7d: 4,
      last30d: 9,
      verified: 8,
      banned: 1,
      admins: 1,
    });
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily[0]).toEqual({ day: '2026-10-16', count: 3 });
    expect(stats.daily.find((entry) => entry.day === '2026-10-25')?.count).toBe(2);
    expect(stats.daily.at(-1)).toEqual({ day: '2026-11-14', count: 2 });
    expect(stats.daily.reduce((sum, entry) => sum + entry.count, 0)).toBe(7);
    expect(AdminSignupsSchema.parse(stats)).toEqual(stats);
  });
});
