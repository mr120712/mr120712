// @polsia:user-owned — parità tra il conteggio admin dei Pro (/admin/iscritti) e hasPremiumAccess.
// Un Prisma finto in memoria valuta where/orderBy/distinct/select per ENTRAMBI i percorsi: il
// conteggio aggregato e la vera hasPremiumAccess (con le verifiche in tempo reale spente). Per una
// matrice di casi per fonte (attivo, scaduto, in tolleranza, disdetto ma pagato fino a, rimborsato,
// revocato, inizio futuro, utente bloccato, account cancellato, Pro da due fonti, ruolo admin) il
// numero di Pro e i Pro per fonte devono coincidere con le funzioni che concedono l'accesso. Il
// conteggio non scrive e non chiama Stripe, PayPal o gli store.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {};
  const writes: string[] = [];

  const sortKey = (value: unknown) => (value instanceof Date ? value.getTime() : value) as string;
  const same = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

  function compare(value: unknown, operator: string, operand: unknown): boolean {
    // Come SQL: un confronto con NULL non è mai vero.
    if (value === null || value === undefined) return false;
    const left = sortKey(value);
    const right = sortKey(operand);
    if (operator === 'lt') return left < right;
    if (operator === 'lte') return left <= right;
    if (operator === 'gt') return left > right;
    return left >= right;
  }

  /** Sottoinsieme dei filtri di Prisma; un operatore sconosciuto fa fallire il test. */
  function matches(row: Row, where: unknown): boolean {
    if (where === undefined) return true;
    return Object.entries(where as Row).every(([field, condition]) => {
      if (field === 'OR') return (condition as Row[]).some((part) => matches(row, part));
      if (field === 'AND') return (condition as Row[]).every((part) => matches(row, part));
      const value = row[field];
      if (condition === null) return value === null || value === undefined;
      if (condition instanceof Date || typeof condition !== 'object') return same(value, condition);
      return Object.entries(condition as Row).every(([operator, operand]) => {
        if (operator === 'equals') return same(value, operand);
        if (operator === 'in') return (operand as unknown[]).some((item) => same(value, item));
        if (operator === 'notIn') return !(operand as unknown[]).some((item) => same(value, item));
        if (['lt', 'lte', 'gt', 'gte'].includes(operator)) {
          return compare(value, operator, operand);
        }
        throw new Error(`Operatore non supportato dal Prisma finto: ${operator}`);
      });
    });
  }

  function findMany(table: string, args: Row = {}): Row[] {
    for (const key of Object.keys(args)) {
      if (!['where', 'orderBy', 'distinct', 'select'].includes(key)) {
        throw new Error(`Argomento non supportato dal Prisma finto: ${key}`);
      }
    }
    let rows = (tables[table] ?? []).filter((row) => matches(row, args.where));
    if (args.orderBy) {
      const order = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) as Row[];
      rows = [...rows].sort((a, b) => {
        for (const entry of order) {
          const [field, direction] = Object.entries(entry)[0] as [string, 'asc' | 'desc'];
          const left = sortKey(a[field]);
          const right = sortKey(b[field]);
          if (left === right) continue;
          return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1);
        }
        return 0;
      });
    }
    if (args.distinct) {
      // Come Prisma: dopo l'ordinamento resta la prima riga per ogni valore distinto.
      const fields = args.distinct as string[];
      const seen = new Set<string>();
      rows = rows.filter((row) => {
        const key = JSON.stringify(fields.map((field) => row[field]));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const select = args.select as Record<string, boolean> | undefined;
    return rows.map((row) =>
      select
        ? Object.fromEntries(
            Object.entries(select)
              .filter(([, wanted]) => wanted)
              .map(([field]) => [field, row[field]]),
          )
        : { ...row },
    );
  }

  function delegate(table: string) {
    const write = (operation: string) => async () => {
      writes.push(`${table}.${operation}`);
      return { count: 0 };
    };
    return {
      findMany: async (args?: Row) => findMany(table, args),
      findFirst: async (args?: Row) => findMany(table, args)[0] ?? null,
      findUnique: async (args?: Row) =>
        findMany(table, { where: args?.where, select: args?.select })[0] ?? null,
      update: write('update'),
      updateMany: write('updateMany'),
      upsert: write('upsert'),
      create: write('create'),
    };
  }

  const prisma: Row = {
    solcoProStripeEntitlement: delegate('solcoProStripeEntitlement'),
    premiumGrant: delegate('premiumGrant'),
    solcoSubscription: delegate('solcoSubscription'),
    payPalSubscription: delegate('payPalSubscription'),
    solcoIapSubscription: delegate('solcoIapSubscription'),
    // Premium illimitato per email: le concessioni e gli account (email verificata o no).
    premiumAccessGrant: delegate('premiumAccessGrant'),
    user: delegate('user'),
  };
  return { tables, writes, prisma, matches };
});

const live = vi.hoisted(() => ({
  apple: vi.fn(async () => {
    throw new Error('Verifica Apple in tempo reale vietata nel test.');
  }),
  google: vi.fn(async () => {
    throw new Error('Verifica Google Play in tempo reale vietata nel test.');
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: store.prisma }));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: vi.fn(), requireAuth: vi.fn() }));
vi.mock('@/lib/stripe-billing/client', () => ({ verifyCheckoutSession: vi.fn() }));
vi.mock('@/lib/business/iap/apple-store.server', () => ({ getAppleSubscription: live.apple }));
vi.mock('@/lib/business/iap/google-play.server', () => ({
  getPlaySubscription: live.google,
  acknowledgePlaySubscription: live.google,
}));

import { getSignupStats, PREMIUM_SOURCES, type SignupsDb } from '@/lib/admin/signups.server';
import {
  hasActiveIapSubscription,
  iapAccessWhere,
  iapGrantsAccess,
} from '@/lib/business/iap/entitlement.server';
import {
  getUserPayPalSubscription,
  isPayPalSubscriptionActive,
} from '@/lib/business/paypal-subscriptions.server';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { hasEmailPremiumGrant } from '@/lib/business/premium-grants.server';
import { getActiveGrant } from '@/lib/business/rewards.server';
import { findActiveSolcoProEntitlement } from '@/lib/business/solco-pro-entitlement';
import {
  isActiveSolcoProEntitlement,
  solcoProEntitlementWhere,
} from '@/lib/business/solco-pro-purchase-policy';
import {
  getUserSubscription,
  isSubscriptionActive,
} from '@/lib/business/stripe-subscriptions.server';
import {
  ADMIN_PREMIUM_SOURCES,
  type AdminPremiumSource,
  AdminSignupsSchema,
} from '@/lib/contracts/admin-signups';

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

type Row = Record<string, unknown>;
type Table =
  | 'solcoSubscription'
  | 'payPalSubscription'
  | 'solcoIapSubscription'
  | 'solcoProStripeEntitlement'
  | 'premiumGrant'
  | 'premiumAccessGrant';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const DAY = 86_400_000;
const days = (offset: number) => new Date(NOW.getTime() + offset * DAY);
const at = (iso: string) => new Date(iso);

let seq = 0;
const next = () => {
  seq += 1;
  return seq;
};

// Righe senza userId: lo aggiunge il caso. Tutte "appena verificate" (checkedAt = adesso), quindi
// nemmeno con le chiavi configurate scatterebbe una nuova verifica presso Stripe/PayPal/store.
const stripe = (status: string, currentPeriodEnd: Date | null, extra: Row = {}) => {
  const n = next();
  return {
    table: 'solcoSubscription' as const,
    row: {
      id: `stripe-row-${n}`,
      planId: 'premium',
      period: 'month',
      stripeCustomerId: `cus_${n}`,
      stripeSubscriptionId: `sub_${n}`,
      status,
      currentPeriodEnd,
      cancelAtPeriodEnd: false,
      firstPaidAt: null,
      checkedAt: NOW,
      createdAt: days(-30),
      updatedAt: NOW,
      ...extra,
    },
  };
};
const paypal = (status: string, extra: Row = {}) => {
  const n = next();
  return {
    table: 'payPalSubscription' as const,
    row: {
      id: `paypal-row-${n}`,
      planId: 'premium',
      period: 'month',
      paypalSubscriptionId: `I-${n}`,
      status,
      nextBillingAt: days(20),
      firstPaidAt: null,
      checkedAt: NOW,
      createdAt: days(-30),
      updatedAt: NOW,
      ...extra,
    },
  };
};
const iap = (state: string, validUntil: Date | null, extra: Row = {}) => {
  const n = next();
  return {
    table: 'solcoIapSubscription' as const,
    row: {
      id: `iap-row-${n}`,
      platform: 'apple',
      storeSubId: `original-${n}`,
      latestOrderId: null,
      productId: 'solco_premium_monthly',
      planId: 'premium',
      period: 'month',
      state,
      autoRenew: true,
      environment: 'Production',
      accountToken: null,
      validFrom: days(-10),
      validUntil,
      acknowledged: true,
      firstPaidAt: null,
      checkedAt: NOW,
      createdAt: days(-10),
      updatedAt: NOW,
      ...extra,
    },
  };
};
const solcoPro = (validFrom: Date, validUntil: Date, extra: Row = {}) => {
  const n = next();
  return {
    table: 'solcoProStripeEntitlement' as const,
    row: {
      id: `solco-row-${n}`,
      checkoutOrderId: `order-${n}`,
      stripeCheckoutSessionId: `cs_test_${n}`,
      paymentMode: 'payment',
      amountEuroCents: 2400,
      currency: 'EUR',
      verificationState: 'confirmed',
      durationKey: 'one-calendar-month',
      durationKind: 'calendar_month',
      validFrom,
      validUntil,
      createdAt: validFrom,
      ...extra,
    },
  };
};
const grant = (startsAt: Date, endsAt: Date) => {
  const n = next();
  return {
    table: 'premiumGrant' as const,
    row: { id: `grant-row-${n}`, reason: 'listening', days: 7, startsAt, endsAt, refKey: `r${n}` },
  };
};

/** Premium illimitato concesso a un'email (la riga non ha userId: vale l'email dell'account). */
const unlimited = (email: string, revokedAt: Date | null = null) => {
  const n = next();
  return {
    table: 'premiumAccessGrant' as const,
    row: {
      id: `unlimited-row-${n}`,
      email,
      note: null,
      createdBy: 'admin',
      createdAt: NOW,
      revokedAt,
    },
  };
};

type Case = {
  id: string;
  /** Cosa verifica il caso. */
  rule: string;
  /** Le fonti che, secondo le regole, danno Premium adesso (vuoto = Free). */
  sources: AdminPremiumSource[];
  user?: Row;
  /** Righe di pagamento rimaste senza account (account cancellato). */
  orphan?: boolean;
  rows?: Array<{ table: Table; row: Row }>;
};

const CASES: Case[] = [
  { id: 'free-plain', rule: 'nessuna riga', sources: [] },
  {
    id: 'free-admin',
    rule: 'ruolo admin senza fonti: il ruolo non concede Premium',
    sources: [],
    user: { role: 'admin' },
  },

  // Stripe: conta l'ULTIMO abbonamento dell'utente.
  { id: 'stripe-active', rule: 'attivo', sources: ['stripe'], rows: [stripe('active', days(20))] },
  {
    id: 'stripe-trial',
    rule: 'in prova',
    sources: ['stripe'],
    rows: [stripe('trialing', days(5))],
  },
  {
    id: 'stripe-past-due',
    rule: 'rinnovo non riuscito, in tolleranza',
    sources: ['stripe'],
    rows: [stripe('past_due', days(2))],
  },
  {
    id: 'stripe-cancel-at-end',
    rule: 'disdetto ma pagato fino a fine periodo',
    sources: ['stripe'],
    rows: [stripe('active', days(10), { cancelAtPeriodEnd: true })],
  },
  {
    id: 'stripe-no-end',
    rule: 'attivo senza fine periodo',
    sources: ['stripe'],
    rows: [stripe('active', null)],
  },
  {
    id: 'stripe-lapsed',
    rule: 'periodo finito (stato salvato non ancora riverificato)',
    sources: [],
    rows: [stripe('active', days(-1))],
  },
  {
    id: 'stripe-canceled',
    rule: 'cancellato',
    sources: [],
    rows: [stripe('canceled', days(10))],
  },
  { id: 'stripe-unpaid', rule: 'non pagato', sources: [], rows: [stripe('unpaid', days(10))] },
  {
    id: 'stripe-incomplete',
    rule: 'checkout incompleto',
    sources: [],
    rows: [stripe('incomplete', null)],
  },
  {
    id: 'stripe-stale-older',
    rule: 'riga vecchia ancora "active" ma l’ultima è scaduta: Free',
    sources: [],
    rows: [
      stripe('active', days(20), { createdAt: days(-60) }),
      stripe('incomplete_expired', null, { createdAt: days(-1) }),
    ],
  },
  {
    id: 'stripe-renewed',
    rule: 'riga vecchia cancellata, l’ultima attiva: Pro',
    sources: ['stripe'],
    rows: [
      stripe('canceled', days(-30), { createdAt: days(-60) }),
      stripe('active', days(25), { createdAt: days(-5) }),
    ],
  },
  {
    id: 'stripe-to-paypal',
    rule: 'Stripe cancellato, PayPal attivo (hasActiveSubscription prova anche PayPal)',
    sources: ['paypal'],
    rows: [stripe('canceled', days(-3)), paypal('ACTIVE')],
  },

  // PayPal: conta l'ULTIMO abbonamento, solo lo stato.
  { id: 'paypal-active', rule: 'attivo', sources: ['paypal'], rows: [paypal('ACTIVE')] },
  {
    id: 'paypal-approved',
    rule: 'approvato, attivazione in corso',
    sources: ['paypal'],
    rows: [paypal('APPROVED')],
  },
  { id: 'paypal-suspended', rule: 'sospeso', sources: [], rows: [paypal('SUSPENDED')] },
  { id: 'paypal-cancelled', rule: 'cancellato', sources: [], rows: [paypal('CANCELLED')] },
  { id: 'paypal-expired', rule: 'scaduto', sources: [], rows: [paypal('EXPIRED')] },
  {
    id: 'paypal-pending',
    rule: 'in attesa di approvazione',
    sources: [],
    rows: [paypal('APPROVAL_PENDING')],
  },
  {
    id: 'paypal-stale-older',
    rule: 'riga vecchia ACTIVE ma l’ultima è cancellata: Free',
    sources: [],
    rows: [
      paypal('ACTIVE', { createdAt: days(-90) }),
      paypal('CANCELLED', { createdAt: days(-2) }),
    ],
  },

  // Acquisti in-app: basta una riga che dia accesso.
  { id: 'iap-active', rule: 'attivo', sources: ['inApp'], rows: [iap('active', days(20))] },
  {
    id: 'iap-grace',
    rule: 'periodo di tolleranza',
    sources: ['inApp'],
    rows: [iap('grace', days(3))],
  },
  {
    id: 'iap-canceled-paid',
    rule: 'disdetto ma valido fino alla scadenza',
    sources: ['inApp'],
    rows: [iap('canceled', days(12))],
  },
  {
    id: 'iap-canceled-over',
    rule: 'disdetto e scaduto',
    sources: [],
    rows: [iap('canceled', days(-1))],
  },
  {
    id: 'iap-lapsed',
    rule: 'attivo ma scaduto (stato salvato)',
    sources: [],
    rows: [iap('active', days(-2))],
  },
  {
    id: 'iap-refunded',
    rule: 'rimborsato/revocato',
    sources: [],
    rows: [iap('revoked', days(20))],
  },
  { id: 'iap-on-hold', rule: 'in sospeso', sources: [], rows: [iap('on_hold', days(20))] },
  { id: 'iap-paused', rule: 'in pausa', sources: [], rows: [iap('paused', days(20))] },
  { id: 'iap-pending', rule: 'pagamento in attesa', sources: [], rows: [iap('pending', null)] },
  { id: 'iap-expired', rule: 'scaduto', sources: [], rows: [iap('expired', days(-5))] },
  {
    id: 'iap-no-end',
    rule: 'attivo senza scadenza',
    sources: ['inApp'],
    rows: [iap('active', null)],
  },
  {
    id: 'iap-google',
    rule: 'Google Play attivo',
    sources: ['inApp'],
    rows: [iap('active', days(15), { platform: 'google', environment: 'production' })],
  },
  {
    id: 'iap-two-rows',
    rule: 'una riga scaduta e una attiva',
    sources: ['inApp'],
    rows: [iap('expired', days(-40), { validFrom: days(-70) }), iap('active', days(20))],
  },

  // Solco Pro: la registrazione valida più recente, durata esatta di un mese di calendario.
  {
    id: 'solco-active',
    rule: 'confermato e in corso',
    sources: ['solcoPro'],
    rows: [solcoPro(at('2026-11-09T12:00:00.000Z'), at('2026-12-09T12:00:00.000Z'))],
  },
  {
    id: 'solco-month-end',
    rule: 'iniziato il 31: finisce l’ultimo giorno del mese dopo',
    sources: ['solcoPro'],
    rows: [solcoPro(at('2026-10-31T10:00:00.000Z'), at('2026-11-30T10:00:00.000Z'))],
  },
  {
    id: 'solco-expired',
    rule: 'mese finito',
    sources: [],
    rows: [solcoPro(at('2026-09-01T00:00:00.000Z'), at('2026-10-01T00:00:00.000Z'))],
  },
  {
    id: 'solco-future',
    rule: 'inizio nel futuro',
    sources: [],
    rows: [solcoPro(at('2026-11-20T00:00:00.000Z'), at('2026-12-20T00:00:00.000Z'))],
  },
  {
    id: 'solco-unconfirmed',
    rule: 'pagamento non confermato',
    sources: [],
    rows: [
      solcoPro(at('2026-11-09T12:00:00.000Z'), at('2026-12-09T12:00:00.000Z'), {
        verificationState: 'pending',
      }),
    ],
  },
  {
    id: 'solco-wrong-amount',
    rule: 'importo diverso dal prezzo',
    sources: [],
    rows: [
      solcoPro(at('2026-11-09T12:00:00.000Z'), at('2026-12-09T12:00:00.000Z'), {
        amountEuroCents: 1200,
      }),
    ],
  },
  {
    id: 'solco-wrong-length',
    rule: 'durata diversa da un mese (solo controllo TypeScript)',
    sources: [],
    rows: [solcoPro(at('2026-11-09T12:00:00.000Z'), at('2026-12-19T12:00:00.000Z'))],
  },
  {
    id: 'solco-blank-session',
    rule: 'sessione di checkout vuota (solo controllo TypeScript)',
    sources: [],
    rows: [
      solcoPro(at('2026-11-09T12:00:00.000Z'), at('2026-12-09T12:00:00.000Z'), {
        stripeCheckoutSessionId: '   ',
      }),
    ],
  },
  {
    id: 'solco-newest-invalid',
    rule: 'decide la più recente: se non è valida conta Free anche con una vecchia valida',
    sources: [],
    rows: [
      solcoPro(at('2026-11-01T12:00:00.000Z'), at('2026-12-01T12:00:00.000Z')),
      solcoPro(at('2026-11-10T12:00:00.000Z'), at('2026-12-31T12:00:00.000Z')),
    ],
  },
  {
    id: 'solco-newest-valid',
    rule: 'la più recente è valida',
    sources: ['solcoPro'],
    rows: [
      solcoPro(at('2026-11-01T12:00:00.000Z'), at('2026-12-31T12:00:00.000Z')),
      solcoPro(at('2026-11-10T12:00:00.000Z'), at('2026-12-10T12:00:00.000Z')),
    ],
  },

  // Premi: qualunque premio in corso.
  { id: 'reward-active', rule: 'in corso', sources: ['rewards'], rows: [grant(days(-3), days(4))] },
  {
    id: 'reward-starts-now',
    rule: 'inizia adesso',
    sources: ['rewards'],
    rows: [grant(NOW, days(7))],
  },
  { id: 'reward-ends-now', rule: 'finisce adesso', sources: [], rows: [grant(days(-7), NOW)] },
  { id: 'reward-expired', rule: 'finito', sources: [], rows: [grant(days(-30), days(-1))] },
  { id: 'reward-future', rule: 'inizio futuro', sources: [], rows: [grant(days(2), days(9))] },
  {
    id: 'reward-queued',
    rule: 'uno finito e uno in coda non ancora iniziato',
    sources: [],
    rows: [grant(days(-10), days(-3)), grant(days(1), days(8))],
  },

  // Più fonti: un solo Pro, contato in ogni fonte.
  {
    id: 'multi-source',
    rule: 'Stripe, App Store e premio insieme',
    sources: ['stripe', 'inApp', 'rewards'],
    rows: [stripe('active', days(20)), iap('active', days(20)), grant(days(-1), days(6))],
  },

  // Bloccati: esclusi da Free e Pro con la regola di totals.banned.
  {
    id: 'banned-stripe',
    rule: 'bloccato senza scadenza',
    sources: ['stripe'],
    user: { banned: true, banExpires: null },
    rows: [stripe('active', days(20))],
  },
  {
    id: 'banned-paypal',
    rule: 'bloccato fino a domani',
    sources: ['paypal'],
    user: { banned: true, banExpires: days(1) },
    rows: [paypal('ACTIVE')],
  },
  {
    id: 'banned-iap',
    rule: 'bloccato',
    sources: ['inApp'],
    user: { banned: true, banExpires: null },
    rows: [iap('active', days(20))],
  },
  {
    id: 'banned-solco',
    rule: 'bloccato',
    sources: ['solcoPro'],
    user: { banned: true, banExpires: null },
    rows: [solcoPro(at('2026-11-09T12:00:00.000Z'), at('2026-12-09T12:00:00.000Z'))],
  },
  {
    id: 'banned-reward',
    rule: 'bloccato',
    sources: ['rewards'],
    user: { banned: true, banExpires: null },
    rows: [grant(days(-1), days(6))],
  },
  {
    id: 'banned-free',
    rule: 'bloccato senza fonti',
    sources: [],
    user: { banned: true, banExpires: null },
  },
  {
    id: 'ban-over',
    rule: 'blocco scaduto: torna attivo e conta Pro',
    sources: ['rewards'],
    user: { banned: true, banExpires: days(-1) },
    rows: [grant(days(-1), days(6))],
  },

  // Premium illimitato concesso dall'admin: solo con l'email dell'account VERIFICATA.
  {
    id: 'unlimited-active',
    rule: 'email verificata, concessione attiva',
    sources: ['unlimited'],
    user: { email: 'illimitato@example.com', emailVerified: true },
    rows: [unlimited('illimitato@example.com')],
  },
  {
    id: 'unlimited-unverified',
    rule: 'email NON verificata: nessun Premium',
    sources: [],
    user: { email: 'non-verificata@example.com', emailVerified: false },
    rows: [unlimited('non-verificata@example.com')],
  },
  {
    id: 'unlimited-revoked',
    rule: 'concessione revocata',
    sources: [],
    user: { email: 'revocata@example.com', emailVerified: true },
    rows: [unlimited('revocata@example.com', days(-1))],
  },
  {
    id: 'unlimited-phone',
    rule: 'email segnaposto di un account col telefono: mai',
    sources: [],
    user: { email: '393331234567@telefono.solcomusic.invalid', emailVerified: true },
    rows: [unlimited('393331234567@telefono.solcomusic.invalid')],
  },
  {
    id: 'unlimited-banned',
    rule: 'blocco in corso: escluso dal conteggio (hasPremiumAccess non guarda i blocchi)',
    sources: ['unlimited'],
    user: {
      email: 'bloccato-illimitato@example.com',
      emailVerified: true,
      banned: true,
      banExpires: null,
    },
    rows: [unlimited('bloccato-illimitato@example.com')],
  },
  {
    id: 'ghost-unlimited',
    rule: 'concessione a un’email senza account: non conta',
    sources: [],
    orphan: true,
    rows: [unlimited('nessun-account@example.com')],
  },

  // Account cancellati: le righe di pagamento restano, l'utente no.
  {
    id: 'ghost-stripe',
    rule: 'account cancellato',
    sources: ['stripe'],
    orphan: true,
    rows: [stripe('active', days(20))],
  },
  {
    id: 'ghost-paypal',
    rule: 'account cancellato',
    sources: ['paypal'],
    orphan: true,
    rows: [paypal('ACTIVE')],
  },
  {
    id: 'ghost-iap',
    rule: 'account cancellato',
    sources: ['inApp'],
    orphan: true,
    rows: [iap('active', days(20))],
  },
  {
    id: 'ghost-solco',
    rule: 'account cancellato',
    sources: ['solcoPro'],
    orphan: true,
    rows: [solcoPro(at('2026-11-09T12:00:00.000Z'), at('2026-12-09T12:00:00.000Z'))],
  },
  {
    id: 'ghost-reward',
    rule: 'account cancellato',
    sources: ['rewards'],
    orphan: true,
    rows: [grant(days(-1), days(6))],
  },
];

function activeBan(user: Row) {
  return user.banned === true && (user.banExpires == null || (user.banExpires as Date) > NOW);
}

const users = CASES.filter((item) => !item.orphan).map((item) => ({
  id: item.id,
  email: `${item.id}@example.com`,
  emailVerified: true,
  role: 'user',
  banned: false,
  banExpires: null,
  ...item.user,
}));
const activeCases = CASES.filter((item) => {
  const account = users.find((entry) => entry.id === item.id);
  return account !== undefined && !activeBan(account);
});

function loadFixtures() {
  for (const table of Object.keys(store.tables)) delete store.tables[table];
  store.writes.length = 0;
  for (const item of CASES) {
    for (const { table, row } of item.rows ?? []) {
      store.tables[table] = [...(store.tables[table] ?? []), { ...row, userId: item.id }];
    }
  }
  // Gli account (per il Premium illimitato, che si lega all'email dell'account).
  store.tables.user = users.map((user) => ({ ...user }));
}

const rawQueries: Array<{ sql: string; values: unknown[] }> = [];

/** Regola del blocco che il Postgres finto sa valutare (? = istante del calcolo). */
const BAN_SQL =
  '"banned" IS TRUE AND ("banExpires" IS NULL OR "banExpires" > (?::timestamptz AT TIME ZONE \'UTC\'))';
/** Forma della query degli esclusi; le due negazioni sono catturate e valutate, non ignorate. */
const EXCLUDE_SHAPE =
  /^SELECT "source"\."userId" AS "userId" FROM \((.+)\) AS "source" WHERE (NOT )?EXISTS \( SELECT 1 FROM "user" WHERE "user"\."id" = "source"\."userId" AND (NOT )?\((.+)\) \)$/;

/**
 * Valuta la query degli esclusi come farebbe Postgres sui casi: tabelle dell'UNION lette dal testo,
 * EXISTS o NOT EXISTS, blocco o NOT blocco, con l'istante passato come parametro. Una forma o una
 * regola diversa fa fallire il test invece di essere ignorata.
 */
function evaluateExclude(sql: string, values: readonly unknown[]) {
  const shape = EXCLUDE_SHAPE.exec(sql.replace(/\s+/g, ' ').trim());
  if (!shape) throw new Error(`Query degli esclusi non riconosciuta: ${sql}`);
  const [, union = '', notExists, notBanned, ban = ''] = shape;
  if (ban !== BAN_SQL) throw new Error(`Regola del blocco non riconosciuta: ${ban}`);
  // Legge dal testo della query l'elenco delle tabelle: una fonte dimenticata nella query
  // lascerebbe passare i suoi utenti bloccati o cancellati, e il conteggio non tornerebbe.
  const tables = union.split(' UNION ').map((part) => {
    const name = /^SELECT "userId" FROM "(\w+)"$/.exec(part)?.[1] ?? '';
    const table = `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
    if (!name || !(table in store.prisma)) throw new Error(`Tabella sconosciuta: ${part}`);
    return table;
  });
  expect(values).toHaveLength(1);
  const at = new Date(values[0] as string);
  const banned = (user: Row) =>
    user.banned === true && (user.banExpires == null || (user.banExpires as Date) > at);
  const accountMatches = (id: string) =>
    users.some((user) => user.id === id && (notBanned ? !banned(user) : banned(user)));
  const ids = new Set(
    tables.flatMap((table) => (store.tables[table] ?? []).map((row) => row.userId as string)),
  );
  return [...ids]
    .filter((id) => (notExists ? !accountMatches(id) : accountMatches(id)))
    .map((userId) => ({ userId }));
}

/** Postgres finto per le tre query SQL: i conteggi della tabella "user" e gli utenti esclusi. */
store.prisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = flattenSql(strings, values);
  const sql = query.strings.join('?');
  rawQueries.push({ sql, values: query.values });
  if (sql.includes('UNION')) return evaluateExclude(sql, query.values);
  if (sql.includes('GROUP BY')) return [];
  return [
    {
      total: BigInt(users.length),
      last24h: 0n,
      last7d: 0n,
      last30d: 0n,
      verified: 0n,
      banned: BigInt(users.filter(activeBan).length),
      admins: BigInt(users.filter((user) => user.role === 'admin').length),
    },
  ];
};

const db = store.prisma as unknown as SignupsDb;
const fetchSpy = vi.fn(async () => {
  throw new Error('Nessuna chiamata di rete nel test.');
});

/** Conteggio admin sui casi. Qui le fonti rispondono sempre: plans null = una query è rotta. */
async function adminStats() {
  const stats = await getSignupStats(NOW, db);
  if (stats.plans === null) {
    throw new Error('Free e Pro mancanti: una query del Premium è fallita.');
  }
  return { ...stats, plans: stats.plans };
}

/** Le funzioni che concedono l'accesso, fonte per fonte (le stesse usate da hasPremiumAccess). */
const sourceChecks: Record<AdminPremiumSource, (userId: string) => Promise<boolean>> = {
  stripe: async (userId) => isSubscriptionActive(await getUserSubscription(userId, NOW), NOW),
  paypal: async (userId) =>
    isPayPalSubscriptionActive(await getUserPayPalSubscription(userId, NOW)),
  inApp: (userId) => hasActiveIapSubscription(userId, NOW),
  solcoPro: async (userId) => (await findActiveSolcoProEntitlement(userId, NOW)) !== null,
  rewards: async (userId) => (await getActiveGrant(userId, NOW)) !== null,
  unlimited: (userId) => hasEmailPremiumGrant(userId),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // Verifiche in tempo reale spente: nessuna chiave Stripe/PayPal/store.
  for (const name of [
    'STRIPE_SECRET_KEY',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'APPLE_IAP_BUNDLE_ID',
    'APPLE_IAP_PRIVATE_KEY',
    'GOOGLE_PLAY_PACKAGE_NAME',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  live.apple.mockClear();
  live.google.mockClear();
  rawQueries.length = 0;
  loadFixtures();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Pro e Free dell’admin = hasPremiumAccess sugli stessi dati', () => {
  it('i casi coprono ogni fonte con almeno un Pro e un Free', () => {
    for (const source of ADMIN_PREMIUM_SOURCES) {
      // L'illimitato non ha una tabella con "userId": le sue righe sono le concessioni per email.
      const table = (PREMIUM_SOURCES[source].table ?? 'PremiumAccessGrant').toLowerCase();
      const withRows = CASES.filter((item) =>
        (item.rows ?? []).some((entry) => entry.table.toLowerCase() === table),
      );
      expect(withRows.some((item) => item.sources.includes(source))).toBe(true);
      expect(withRows.some((item) => item.sources.length === 0)).toBe(true);
    }
  });

  it.each(CASES.filter((item) => !item.orphan))('hasPremiumAccess($id) — $rule', async (item) => {
    expect(await hasPremiumAccess(item.id)).toBe(item.sources.length > 0);
  });

  it('il numero di Pro e di Free coincide con hasPremiumAccess (live spento)', async () => {
    const stats = await adminStats();
    expect(AdminSignupsSchema.parse(stats)).toEqual(stats);

    const proByAccess: string[] = [];
    for (const item of activeCases) {
      if (await hasPremiumAccess(item.id)) proByAccess.push(item.id);
    }
    expect(proByAccess.sort()).toEqual(
      activeCases
        .filter((item) => item.sources.length > 0)
        .map((item) => item.id)
        .sort(),
    );
    expect(stats.plans.pro).toBe(proByAccess.length);
    expect(stats.plans.free).toBe(activeCases.length - proByAccess.length);
    expect(stats.plans.free + stats.plans.pro).toBe(stats.totals.total - stats.totals.banned);
    expect(stats.plans.proShare).toBe(
      Math.round((proByAccess.length / activeCases.length) * 1000) / 10,
    );
    // Numeri attesi scritti per esteso, così un errore uguale nei due percorsi non passa.
    // 63 account, 7 bloccati: 56 attivi, 23 Pro (multi-source conta una volta sola).
    expect(stats.plans).toEqual({
      free: 33,
      pro: 23,
      proShare: 41.1,
      proBySource: { stripe: 7, paypal: 3, inApp: 7, solcoPro: 3, rewards: 4, unlimited: 1 },
    });
  });

  it('ogni fonte conta gli stessi utenti della funzione che concede l’accesso', async () => {
    const stats = await adminStats();
    for (const source of ADMIN_PREMIUM_SOURCES) {
      const granted: string[] = [];
      for (const item of activeCases) {
        if (await sourceChecks[source](item.id)) granted.push(item.id);
      }
      expect(granted.sort()).toEqual(
        activeCases
          .filter((item) => item.sources.includes(source))
          .map((item) => item.id)
          .sort(),
      );
      expect(stats.plans.proBySource[source]).toBe(granted.length);
    }
  });

  it('bloccati e account cancellati restano fuori anche se le loro righe darebbero Premium', async () => {
    const stats = await adminStats();
    const excluded = CASES.filter((item) => item.sources.length > 0 && !activeCases.includes(item));
    expect(excluded.map((item) => item.id).sort()).toEqual(
      [
        'banned-iap',
        'banned-paypal',
        'banned-reward',
        'banned-solco',
        'banned-stripe',
        'ghost-iap',
        'ghost-paypal',
        'ghost-reward',
        'ghost-solco',
        'ghost-stripe',
        'unlimited-banned',
      ].sort(),
    );
    // Le righe danno davvero accesso: li esclude solo la regola del blocco o l'account mancante.
    for (const item of excluded) expect(await hasPremiumAccess(item.id)).toBe(true);
    expect(stats.totals.banned).toBe(7);
    expect(stats.plans.free + stats.plans.pro).toBe(activeCases.length);
  });

  it('non scrive e non chiama Stripe, PayPal o gli store, nemmeno con le chiavi configurate', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_configurato');
    vi.stubEnv('PAYPAL_CLIENT_ID', 'paypal-client-id-configurato');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'paypal-client-secret-configurato');
    // Righe da riverificare per hasPremiumAccess (controllate più di un'ora fa).
    for (const table of ['solcoSubscription', 'payPalSubscription', 'solcoIapSubscription']) {
      for (const row of store.tables[table] ?? []) row.checkedAt = days(-2);
    }

    const stats = await adminStats();

    expect(store.writes).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(live.apple).not.toHaveBeenCalled();
    expect(live.google).not.toHaveBeenCalled();
    // Conta lo stato salvato: lo stesso risultato di prima.
    expect(stats.plans.pro).toBe(23);
    // Solo le tre query SQL, tutte parametrizzate con l'istante del calcolo.
    expect(rawQueries).toHaveLength(3);
    for (const query of rawQueries) expect(query.sql).not.toContain('2026-');
  });
});

describe('filtri del database e funzioni di decisione coincidono', () => {
  it('iapAccessWhere sceglie esattamente le righe per cui iapGrantsAccess è vera', () => {
    const rows = store.tables.solcoIapSubscription ?? [];
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      const grants = iapGrantsAccess(row as { state: string; validUntil: Date | null }, NOW);
      expect(store.matches(row, iapAccessWhere(NOW))).toBe(grants);
    }
  });

  it('solcoProEntitlementWhere non scarta nessuna registrazione valida', () => {
    const rows = store.tables.solcoProStripeEntitlement ?? [];
    for (const row of rows) {
      if (isActiveSolcoProEntitlement(row, row.userId as string, NOW)) {
        expect(store.matches(row, solcoProEntitlementWhere(NOW))).toBe(true);
      }
    }
  });
});
