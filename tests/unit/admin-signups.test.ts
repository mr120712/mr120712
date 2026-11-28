// @polsia:user-owned — scheda Iscritti: giorni di calendario in ora italiana (mezzanotte e cambi
// dell'ora legale), finestra dei 30 giorni, riempimento con zero, conversione dei conteggi,
// divisione Free/Pro e query aggregate parametrizzate (database finto: nessun Postgres nel sandbox),
// testo esatto della query degli esclusi e Free/Pro null se una fonte del Premium non risponde.
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: vi.fn() } }));

import {
  buildPlanSplit,
  buildSignupStats,
  percentShare,
  type RawPremiumSplit,
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

type SqlLike = { strings: readonly string[]; values: readonly unknown[] };

function isSql(value: unknown): value is SqlLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as SqlLike).strings) &&
    Array.isArray((value as SqlLike).values)
  );
}

/** Come Prisma: i frammenti annidati (Prisma.sql, Prisma.join, Prisma.raw) diventano testo e parametri. */
function flattenSql(strings: readonly string[], values: readonly unknown[]) {
  const text = [strings[0] ?? ''];
  const params: unknown[] = [];
  values.forEach((value, index) => {
    const tail = strings[index + 1] ?? '';
    if (isSql(value)) {
      const inner = flattenSql(value.strings, value.values);
      text[text.length - 1] += inner.strings[0] ?? '';
      inner.values.forEach((param, position) => {
        params.push(param);
        text.push(inner.strings[position + 1] ?? '');
      });
      text[text.length - 1] += tail;
    } else {
      params.push(value);
      text.push(tail);
    }
  });
  return { strings: text, values: params };
}

/** Nessun Pro e nessun utente escluso. */
const noPremium: RawPremiumSplit = {
  sources: { stripe: [], paypal: [], inApp: [], solcoPro: [], rewards: [], unlimited: [] },
  ineligible: [],
};

/** Spazi e a capo ridotti a uno: il confronto guarda la struttura della query, non l'impaginazione. */
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** Regola del blocco in corso, identica nei totali e negli esclusi ($? = istante del calcolo). */
const BAN_RULE =
  '"banned" IS TRUE AND ("banExpires" IS NULL OR "banExpires" > ($?::timestamptz AT TIME ZONE \'UTC\'))';

/**
 * Query degli esclusi parola per parola: un id resta fuori da Free e Pro solo se NON esiste un
 * account con quell'id che NON sia bloccato. Invertire NOT EXISTS o NOT (blocco) farebbe contare
 * tutti i Pro come esclusi (o i bloccati come Pro): qui il test fallisce.
 */
const EXCLUDE_SQL = [
  'SELECT "source"."userId" AS "userId"',
  'FROM (SELECT "userId" FROM "SolcoSubscription"',
  'UNION SELECT "userId" FROM "PayPalSubscription"',
  'UNION SELECT "userId" FROM "SolcoIapSubscription"',
  'UNION SELECT "userId" FROM "SolcoProStripeEntitlement"',
  'UNION SELECT "userId" FROM "PremiumGrant") AS "source"',
  'WHERE NOT EXISTS ( SELECT 1 FROM "user"',
  'WHERE "user"."id" = "source"."userId"',
  `AND NOT (${BAN_RULE}) )`,
].join(' ');

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
    const stats = buildSignupStats(
      now,
      keys,
      totalsWithPersonalColumns,
      [dayWithPersonalColumns],
      noPremium,
    );
    expect(AdminSignupsSchema.parse(stats)).toEqual(stats);
    expect(Object.keys(stats.totals).sort()).toEqual(
      ['admins', 'banned', 'last24h', 'last30d', 'last7d', 'total', 'verified'].sort(),
    );
    expect(stats.daily.at(-1)).toEqual({ day: '2026-11-14', count: 1 });
    // 10 account, 1 bloccato, nessun Pro: 9 Free.
    expect(stats.plans).toEqual({
      free: 9,
      pro: 0,
      proShare: 0,
      proBySource: { stripe: 0, paypal: 0, inApp: 0, solcoPro: 0, rewards: 0, unlimited: 0 },
    });
    expect(JSON.stringify(stats)).not.toMatch(/mario|user-1|@/i);
  });

  it('senza i dati del Premium esce plans null, con totali e giorni invariati', () => {
    const stats = buildSignupStats(now, keys, totals, [{ day: '2026-11-14', count: 1n }], null);
    expect(stats.plans).toBeNull();
    expect(stats.totals.total).toBe(10);
    expect(stats.daily.at(-1)).toEqual({ day: '2026-11-14', count: 1 });
    expect(AdminSignupsSchema.parse(stats)).toEqual(stats);
  });

  it('rifiuta righe senza totali o con un giorno non valido', () => {
    expect(() => buildSignupStats(now, keys, undefined, [], noPremium)).toThrow(TypeError);
    expect(() =>
      buildSignupStats(now, keys, totals, [{ day: '14/11', count: 1n }], noPremium),
    ).toThrow(TypeError);
  });
});

describe('buildPlanSplit: Free e Pro dagli id delle fonti', () => {
  it('unisce le fonti senza doppioni, toglie gli esclusi e conta ogni fonte a parte', () => {
    const plans = buildPlanSplit(10, {
      sources: {
        stripe: new Set(['a', 'b', 'banned-1']),
        paypal: new Set(['c']),
        inApp: new Set(['a', 'ghost-1']),
        solcoPro: new Set(),
        rewards: new Set(['a', 'd']),
        unlimited: new Set(['e', 'banned-1']),
      },
      ineligible: [{ userId: 'banned-1' }, { userId: 'ghost-1' }],
    });
    // Pro distinti: a, b, c, d, e (a ha tre fonti; bloccato e account cancellato esclusi).
    expect(plans).toEqual({
      free: 5,
      pro: 5,
      proShare: 50,
      proBySource: { stripe: 2, paypal: 1, inApp: 1, solcoPro: 0, rewards: 2, unlimited: 1 },
    });
    expect(JSON.stringify(plans)).not.toMatch(/banned|ghost|"a"|"b"/);
  });

  it('non va mai sotto zero e non supera il 100% se nel frattempo nascono nuovi Pro', () => {
    const plans = buildPlanSplit(1, {
      ...noPremium,
      sources: { ...noPremium.sources, rewards: ['x', 'y'] },
    });
    expect(plans.free).toBe(0);
    expect(plans.pro).toBe(2);
    expect(plans.proShare).toBe(100);
  });

  it('rifiuta un id escluso non valido', () => {
    expect(() => buildPlanSplit(3, { ...noPremium, ineligible: [{ userId: 42 }] })).toThrow(
      TypeError,
    );
    expect(() => buildPlanSplit(3, { ...noPremium, ineligible: [{ userId: '' }] })).toThrow(
      TypeError,
    );
  });

  it('arrotonda la quota a un decimale e vale zero senza utenti attivi', () => {
    expect(percentShare(1, 3)).toBe(33.3);
    expect(percentShare(2, 3)).toBe(66.7);
    expect(percentShare(345, 12345)).toBe(2.8);
    expect(percentShare(0, 0)).toBe(0);
    expect(percentShare(5, 5)).toBe(100);
  });

  it('il contratto rifiuta conteggi per fonte incoerenti con i Pro', () => {
    const base = {
      generatedAt: '2026-11-14T14:30:00.000Z',
      timeZone: 'Europe/Rome',
      totals: { total: 3, last24h: 0, last7d: 0, last30d: 0, verified: 0, banned: 0, admins: 0 },
      daily: signupDayKeys(at('2026-11-14T14:30:00.000Z')).map((day) => ({ day, count: 0 })),
    };
    const plans = (proBySource: Record<string, number>, pro = 2) => ({
      ...base,
      plans: { free: 1, pro, proShare: 66.7, proBySource },
    });
    const ok = { stripe: 2, paypal: 0, inApp: 1, solcoPro: 0, rewards: 0, unlimited: 0 };
    expect(AdminSignupsSchema.safeParse(plans(ok)).success).toBe(true);
    // Una fonte con più utenti dei Pro, o Pro senza nessuna fonte.
    expect(AdminSignupsSchema.safeParse(plans({ ...ok, stripe: 3 })).success).toBe(false);
    expect(AdminSignupsSchema.safeParse(plans({ ...ok, stripe: 0, inApp: 0 })).success).toBe(false);
    // Chiave in più (per esempio un elenco di id) o fonte mancante.
    expect(AdminSignupsSchema.safeParse(plans({ ...ok, ids: 1 })).success).toBe(false);
    const { rewards: _rewards, ...missing } = ok;
    expect(AdminSignupsSchema.safeParse(plans(missing)).success).toBe(false);
  });
});

describe('getSignupStats: query aggregate parametrizzate', () => {
  type Call = { sql: string; values: unknown[] };

  function fakeDb(totalsRow: Record<string, unknown>, dailyRows: Record<string, unknown>[]) {
    const calls: Call[] = [];
    const delegateCalls: Record<string, unknown[]> = {};
    const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // Come Prisma: i frammenti annidati (Prisma.sql) diventano testo e parametri.
      const query = flattenSql(strings, values);
      const sql = query.strings.join('$?');
      calls.push({ sql, values: query.values });
      if (sql.includes('UNION')) return [{ userId: 'banned-user' }];
      return sql.includes('GROUP BY') ? dailyRows : [totalsRow];
    });
    const delegate = (name: string, rows: Record<string, unknown>[]) => ({
      findMany: vi.fn(async (args: unknown) => {
        delegateCalls[name] = [...(delegateCalls[name] ?? []), args];
        return rows;
      }),
    });
    const future = at('2026-12-01T00:00:00.000Z');
    const db = {
      $queryRaw,
      solcoSubscription: delegate('stripe', [
        { userId: 'stripe-user', status: 'active', currentPeriodEnd: future },
        { userId: 'banned-user', status: 'active', currentPeriodEnd: future },
      ]),
      payPalSubscription: delegate('paypal', [{ userId: 'paypal-user', status: 'SUSPENDED' }]),
      solcoIapSubscription: delegate('inApp', []),
      solcoProStripeEntitlement: delegate('solcoPro', []),
      premiumGrant: delegate('rewards', [{ userId: 'stripe-user' }]),
      // Premium illimitato: nessuna concessione, quindi nessuna lettura degli account.
      premiumAccessGrant: delegate('unlimited', []),
      user: delegate('users', []),
    };
    return { db: db as unknown as SignupsDb, calls, delegateCalls };
  }

  it('totali, serie a zero riempita e Free/Pro con un solo giro di query parametrizzate', async () => {
    const now = at('2026-11-14T14:30:00.000Z');
    const { db, calls, delegateCalls } = fakeDb(
      { total: 12n, last24h: 2n, last7d: 4n, last30d: 9n, verified: 8n, banned: 1n, admins: 1n },
      [
        { day: '2026-10-16', count: 3n },
        { day: '2026-10-25', count: 2n },
        { day: '2026-11-14', count: 2n },
      ],
    );

    const stats = await getSignupStats(now, db);

    expect(calls).toHaveLength(3);
    const totalsCall = calls.find((call) => call.sql.includes('AS "total"'));
    const dailyCall = calls.find((call) => call.sql.includes('GROUP BY'));
    const ineligibleCall = calls.find((call) => call.sql.includes('UNION'));
    // I valori viaggiano come parametri della query, mai dentro il testo SQL.
    expect(totalsCall?.values).toEqual([
      '2026-11-13T14:30:00.000Z',
      '2026-11-07T14:30:00.000Z',
      '2026-10-15T14:30:00.000Z',
      '2026-11-14T14:30:00.000Z',
    ]);
    expect(dailyCall?.values).toEqual(['2026-10-16']);
    expect(ineligibleCall?.values).toEqual(['2026-11-14T14:30:00.000Z']);
    for (const call of [totalsCall, dailyCall]) {
      expect(call?.sql).toContain('FROM "user"');
      // Solo aggregati: nessuna colonna personale viene mai letta.
      expect(call?.sql).not.toMatch(/"(email|name|phoneNumber|id|image)"/);
    }
    for (const call of calls) expect(call.sql).not.toContain('2026-');
    expect(dailyCall?.sql).toContain("AT TIME ZONE 'Europe/Rome'");
    expect(dailyCall?.sql).toContain('date_trunc');
    expect(totalsCall?.sql).toContain('"phoneNumberVerified" IS TRUE');
    expect(totalsCall?.sql).toContain('"banExpires" IS NULL');

    // Esclusi: tutte le tabelle delle fonti, chiave di "user" e la STESSA regola dei bloccati.
    const ineligibleSql = ineligibleCall?.sql ?? '';
    for (const table of [
      'SolcoSubscription',
      'PayPalSubscription',
      'SolcoIapSubscription',
      'SolcoProStripeEntitlement',
      'PremiumGrant',
    ]) {
      expect(ineligibleSql).toContain(`SELECT "userId" FROM "${table}"`);
    }
    expect(ineligibleSql).toMatch(/SELECT "source"\."userId" AS "userId"\s+FROM \(/);
    expect(ineligibleSql).not.toMatch(/"(email|name|phoneNumber|image)"/);
    // Testo intero della query (NOT EXISTS, NOT del blocco, chiave di "user") e regola del blocco
    // completa e identica a quella del totale dei bloccati.
    expect(normalize(ineligibleSql)).toBe(EXCLUDE_SQL);
    expect(normalize(totalsCall?.sql ?? '')).toContain(
      `COUNT(*) FILTER ( WHERE ${BAN_RULE} )::bigint AS "banned"`,
    );

    // Le fonti ricevono filtri e ordini condivisi con hasPremiumAccess.
    expect(delegateCalls.stripe).toEqual([
      {
        distinct: ['userId'],
        orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
        select: { userId: true, status: true, currentPeriodEnd: true },
      },
    ]);
    expect(delegateCalls.paypal).toEqual([
      {
        distinct: ['userId'],
        orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
        select: { userId: true, status: true },
      },
    ]);
    expect(delegateCalls.inApp).toEqual([
      {
        where: {
          state: { in: ['active', 'grace', 'canceled'] },
          OR: [{ validUntil: null }, { validUntil: { gt: now } }],
        },
        select: { userId: true, state: true, validUntil: true },
      },
    ]);
    expect(delegateCalls.solcoPro).toEqual([
      {
        where: {
          paymentMode: 'payment',
          verificationState: 'confirmed',
          amountEuroCents: 2400,
          currency: 'EUR',
          durationKey: 'one-calendar-month',
          durationKind: 'calendar_month',
          validFrom: { lte: now },
          validUntil: { gt: now },
        },
        distinct: ['userId'],
        orderBy: [{ userId: 'asc' }, { validFrom: 'desc' }],
      },
    ]);
    expect(delegateCalls.rewards).toEqual([
      {
        where: { startsAt: { lte: now }, endsAt: { gt: now } },
        distinct: ['userId'],
        select: { userId: true },
      },
    ]);

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
    // 11 utenti attivi; Pro: stripe-user (Stripe + premi). banned-user escluso, PayPal sospeso.
    expect(stats.plans).toEqual({
      free: 10,
      pro: 1,
      proShare: 9.1,
      proBySource: { stripe: 1, paypal: 0, inApp: 0, solcoPro: 0, rewards: 1, unlimited: 0 },
    });
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily[0]).toEqual({ day: '2026-10-16', count: 3 });
    expect(stats.daily.find((entry) => entry.day === '2026-10-25')?.count).toBe(2);
    expect(stats.daily.at(-1)).toEqual({ day: '2026-11-14', count: 2 });
    expect(stats.daily.reduce((sum, entry) => sum + entry.count, 0)).toBe(7);
    expect(AdminSignupsSchema.parse(stats)).toEqual(stats);
    expect(JSON.stringify(stats)).not.toMatch(/stripe-user|banned-user|paypal-user/);
  });

  it('fa partire tutte le query insieme: nessuna aspetta il risultato di un’altra', async () => {
    const now = at('2026-11-14T14:30:00.000Z');
    let started = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held =
      <T>(value: T) =>
      async () => {
        started += 1;
        await gate;
        return value;
      };
    const totalsRow = {
      total: 1n,
      last24h: 0n,
      last7d: 0n,
      last30d: 0n,
      verified: 0n,
      banned: 0n,
      admins: 0n,
    };
    const db = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        started += 1;
        await gate;
        const sql = strings.join('');
        if (sql.includes('GROUP BY')) return [];
        return sql.includes('"source"') ? [] : [totalsRow];
      }),
      solcoSubscription: { findMany: vi.fn(held([])) },
      payPalSubscription: { findMany: vi.fn(held([])) },
      solcoIapSubscription: { findMany: vi.fn(held([])) },
      solcoProStripeEntitlement: { findMany: vi.fn(held([])) },
      premiumGrant: { findMany: vi.fn(held([])) },
      premiumAccessGrant: { findMany: vi.fn(held([])) },
      user: { findMany: vi.fn(held([])) },
    } as unknown as SignupsDb;

    const pending = getSignupStats(now, db);
    await Promise.resolve();
    await Promise.resolve();
    // 3 query SQL + 6 fonti, tutte già partite prima che una qualsiasi risponda (l'illimitato legge
    // gli account solo dopo le concessioni, che qui non ci sono).
    expect(started).toBe(9);
    release();
    const stats = await pending;
    expect(stats.plans).toEqual({
      free: 1,
      pro: 0,
      proShare: 0,
      proBySource: { stripe: 0, paypal: 0, inApp: 0, solcoPro: 0, rewards: 0, unlimited: 0 },
    });
  });

  describe('una query di Free e Pro non riesce', () => {
    const now = at('2026-11-14T14:30:00.000Z');
    const totalsRow = {
      total: 12n,
      last24h: 2n,
      last7d: 4n,
      last30d: 9n,
      verified: 8n,
      banned: 1n,
      admins: 1n,
    };
    let errors: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
      errors?.mockRestore();
    });

    it.each([
      ['una fonte', 'paypal'],
      ['la query degli esclusi', 'exclude'],
    ] as const)(
      '%s: plans null, totali e grafico restano, log col solo nome',
      async (_, broken) => {
        errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const secret = new Error('relation "PayPalSubscription" does not exist password=segreta');
        const { db } = fakeDb(totalsRow, [{ day: '2026-11-14', count: 2n }]);
        const fake = db as unknown as {
          $queryRaw: ReturnType<typeof vi.fn>;
          payPalSubscription: { findMany: ReturnType<typeof vi.fn> };
        };
        if (broken === 'paypal') {
          fake.payPalSubscription.findMany.mockRejectedValue(secret);
        } else {
          const original = fake.$queryRaw.getMockImplementation() as
            | ((strings: TemplateStringsArray, ...values: unknown[]) => unknown)
            | undefined;
          fake.$queryRaw.mockImplementation(
            async (strings: TemplateStringsArray, ...values: unknown[]) => {
              if (strings.join('').includes('"source"')) throw secret;
              return original?.(strings, ...values);
            },
          );
        }

        const stats = await getSignupStats(now, db);

        expect(stats.plans).toBeNull();
        expect(stats.totals).toEqual({
          total: 12,
          last24h: 2,
          last7d: 4,
          last30d: 9,
          verified: 8,
          banned: 1,
          admins: 1,
        });
        expect(stats.daily.at(-1)).toEqual({ day: '2026-11-14', count: 2 });
        expect(AdminSignupsSchema.parse(stats)).toEqual(stats);
        expect(errors).toHaveBeenCalledTimes(1);
        expect(errors.mock.calls[0]).toEqual([
          '[admin/signups] Free e Pro non disponibili:',
          'Error',
        ]);
      },
    );

    it('un errore dei totali resta un errore: niente risposta a metà', async () => {
      errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { db } = fakeDb(totalsRow, []);
      (db as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw.mockRejectedValue(
        new Error('down'),
      );
      await expect(getSignupStats(now, db)).rejects.toThrow('down');
    });
  });
});
