// @polsia:user-owned — conta e limita gli utilizzi del «Bot Solco» degli account free (30 al mese).
// Stesso schema del limite ascolti (play-quota.server.ts): lettura + scrittura nella stessa
// transazione Serializable, così due richieste concorrenti non possono superare insieme la stessa
// lettura. I Premium sono illimitati e non scrivono righe.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { romeMonth } from '@/lib/business/play-quota';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { prisma } from '@/lib/db';

export const FREE_MONTHLY_BOT_USES = 30;
/** Tentativi della transazione che registra un utilizzo (come il registro ascolti). */
export const BOT_USE_RECORD_ATTEMPTS = 4;

type BotUseClient = Pick<Prisma.TransactionClient, 'botUse'>;

export type BotQuotaStatus = {
  premium: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
};

export type BotQuotaDecision =
  | {
      allowed: true;
      premium: boolean;
      used: number;
      limit: number | null;
      remaining: number | null;
    }
  | {
      allowed: false;
      reason: 'login_required' | 'quota_reached';
      used: number;
      limit: number;
      remaining: 0;
    };

/** Conflitti di serializzazione irrisolti: la route risponde 503 senza eseguire la ricerca. */
export class BotQuotaUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Bot quota temporarily unavailable', options);
    this.name = 'BotQuotaUnavailableError';
  }
}

function countMonthly(db: BotUseClient, userId: string, now: Date) {
  return db.botUse.count({ where: { userId, month: romeMonth(now) } });
}

export async function botUsesThisMonth(userId: string, now = new Date()) {
  return countMonthly(prisma, userId, now);
}

/** Stato della quota senza scrivere nulla (per il caricamento della pagina). */
export async function botQuotaStatus(
  user: { id: string },
  now = new Date(),
): Promise<BotQuotaStatus> {
  const premium = await hasPremiumAccess(user.id);
  if (premium) return { premium: true, used: 0, limit: null, remaining: null };
  const used = await botUsesThisMonth(user.id, now);
  return {
    premium: false,
    used,
    limit: FREE_MONTHLY_BOT_USES,
    remaining: Math.max(0, FREE_MONTHLY_BOT_USES - used),
  };
}

/** Postgres 40001 (serialization_failure), riportato da Prisma come P2034. */
function isSerializationFailure(error: unknown) {
  if (typeof error !== 'object' || error === null) return false;
  const { code, meta, message } = error as { code?: unknown; meta?: unknown; message?: unknown };
  if (code === 'P2034' || code === '40001') return true;
  if (typeof meta === 'object' && meta !== null && (meta as { code?: unknown }).code === '40001') {
    return true;
  }
  return typeof message === 'string' && /\b40001\b|could not serialize access/.test(message);
}

async function recordUse(userId: string, now: Date): Promise<BotQuotaDecision> {
  let lastError: unknown;
  for (let attempt = 0; attempt < BOT_USE_RECORD_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction): Promise<BotQuotaDecision> => {
          const used = await countMonthly(transaction, userId, now);
          if (used >= FREE_MONTHLY_BOT_USES) {
            return {
              allowed: false,
              reason: 'quota_reached',
              used,
              limit: FREE_MONTHLY_BOT_USES,
              remaining: 0,
            };
          }
          await transaction.botUse.create({
            data: { userId, month: romeMonth(now), createdAt: now },
          });
          const nowUsed = used + 1;
          return {
            allowed: true,
            premium: false,
            used: nowUsed,
            limit: FREE_MONTHLY_BOT_USES,
            remaining: Math.max(0, FREE_MONTHLY_BOT_USES - nowUsed),
          };
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      lastError = error;
    }
  }
  throw new BotQuotaUnavailableError({ cause: lastError });
}

/**
 * Autorizza e registra un utilizzo del bot. I Premium sono illimitati (nessuna riga); gli account
 * free consumano uno dei 30 utilizzi mensili. Senza utente: login richiesto.
 */
export async function consumeBotUse(
  user: { id: string } | null,
  now = new Date(),
): Promise<BotQuotaDecision> {
  if (!user) {
    return {
      allowed: false,
      reason: 'login_required',
      used: 0,
      limit: FREE_MONTHLY_BOT_USES,
      remaining: 0,
    };
  }
  const premium = await hasPremiumAccess(user.id);
  if (premium) return { allowed: true, premium: true, used: 0, limit: null, remaining: null };
  return recordUse(user.id, now);
}
