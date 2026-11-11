// @polsia:user-owned
import 'server-only';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { prisma } from '@/lib/db';

type WindowLimit = { requests: number; windowMs: number };

export const ACTION_RATE_LIMITS = {
  'music.search': [
    { requests: 8, windowMs: 10_000 },
    { requests: 30, windowMs: 60_000 },
  ],
  // Each AI search is a paid Claude request: a few per minute, 30 per day per account.
  'music.ai_search': [
    { requests: 3, windowMs: 60_000 },
    { requests: 30, windowMs: 86_400_000 },
  ],
  'ai.chat': [
    { requests: 12, windowMs: 60_000 },
    { requests: 60, windowMs: 3_600_000 },
  ],
  'solco.support': [{ requests: 5, windowMs: 600_000 }],
  'admin.assistant': [
    { requests: 20, windowMs: 60_000 },
    { requests: 100, windowMs: 3_600_000 },
  ],
  'product.check.start': [
    { requests: 5, windowMs: 600_000 },
    { requests: 30, windowMs: 86_400_000 },
  ],
  'product.check.link': [
    { requests: 60, windowMs: 60_000 },
    { requests: 180, windowMs: 86_400_000 },
  ],
  'messages.send': [
    { requests: 10, windowMs: 60_000 },
    { requests: 120, windowMs: 3_600_000 },
  ],
  'community.follow': [
    { requests: 20, windowMs: 60_000 },
    { requests: 120, windowMs: 3_600_000 },
  ],
  'community.unfollow': [
    { requests: 30, windowMs: 60_000 },
    { requests: 180, windowMs: 3_600_000 },
  ],
  'community.profile.update': [
    { requests: 10, windowMs: 60_000 },
    { requests: 60, windowMs: 3_600_000 },
  ],
  'shops.create': [
    { requests: 3, windowMs: 600_000 },
    { requests: 10, windowMs: 86_400_000 },
  ],
  'shops.update': [
    { requests: 10, windowMs: 60_000 },
    { requests: 60, windowMs: 3_600_000 },
  ],
  'products.create': [
    { requests: 20, windowMs: 60_000 },
    { requests: 100, windowMs: 3_600_000 },
  ],
  'products.update': [
    { requests: 20, windowMs: 60_000 },
    { requests: 100, windowMs: 3_600_000 },
  ],
  'library.write': [
    { requests: 60, windowMs: 60_000 },
    { requests: 600, windowMs: 3_600_000 },
  ],
  'library.import': [
    { requests: 3, windowMs: 600_000 },
    { requests: 20, windowMs: 86_400_000 },
  ],
  'subscriptions.checkout': [
    { requests: 5, windowMs: 600_000 },
    { requests: 30, windowMs: 86_400_000 },
  ],
} as const satisfies Record<string, readonly WindowLimit[]>;

export type RateLimitAction = keyof typeof ACTION_RATE_LIMITS;
export type RateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterSeconds: number;
      status: 429 | 503;
      error: string;
      message: string;
    };

const RATE_LIMIT_BACKEND_RETRY_SECONDS = 30;
const UNKNOWN_IDENTITY_RETRY_SECONDS = 60;

/** Gli id autenticati hanno priorità; gli anonimi usano solo gli header dell’ingress. */
export function getRateLimitIdentity(userId: string | null, headers: Headers): string | null {
  if (userId) return `user:${userId}`;

  for (const header of ['cf-connecting-ip', 'x-real-ip']) {
    const candidate = headers.get(header)?.trim();
    if (candidate && !candidate.includes(',') && isIP(candidate)) {
      return `ip:${candidate.toLowerCase()}`;
    }
  }

  return null;
}

export function evaluateRateLimit(
  timestamps: readonly number[],
  limits: readonly WindowLimit[],
  now: number,
): { allowed: true; timestamps: number[] } | { allowed: false; retryAfterSeconds: number } {
  const longestWindow = Math.max(...limits.map((limit) => limit.windowMs));
  const active = timestamps
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now - longestWindow)
    .sort((left, right) => left - right);
  const blockedWindows = limits.flatMap((limit) => {
    const hits = active.filter((timestamp) => timestamp > now - limit.windowMs);
    if (hits.length < limit.requests) return [];

    const firstHitToExpire = hits[hits.length - limit.requests];
    if (firstHitToExpire === undefined) return [];
    return [firstHitToExpire + limit.windowMs - now];
  });

  if (blockedWindows.length > 0) {
    const waitMs = Math.max(...blockedWindows);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  return { allowed: true, timestamps: [...active, now] };
}

function storedTimestamps(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((timestamp): timestamp is number => typeof timestamp === 'number');
}

function retryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'P2034' || error.code === 'P2002';
}

function unavailableDecision(): RateLimitDecision {
  return {
    allowed: false,
    retryAfterSeconds: RATE_LIMIT_BACKEND_RETRY_SECONDS,
    status: 503,
    error: 'rate_limit_unavailable',
    message: `Il controllo temporaneo dei limiti non è disponibile; nessuna operazione è stata avviata. Riprova tra ${RATE_LIMIT_BACKEND_RETRY_SECONDS} secondi.`,
  };
}

function missingIdentityDecision(): RateLimitDecision {
  return {
    allowed: false,
    retryAfterSeconds: UNKNOWN_IDENTITY_RETRY_SECONDS,
    status: 503,
    error: 'rate_limit_identity_unavailable',
    message: `Non è possibile identificare in modo sicuro questa richiesta. Riprova tra ${UNKNOWN_IDENTITY_RETRY_SECONDS} secondi.`,
  };
}

export async function consumeRateLimit(
  action: RateLimitAction,
  identity: string | null,
  now = Date.now(),
): Promise<RateLimitDecision> {
  if (!identity) return missingIdentityDecision();

  const identityHash = createHash('sha256').update(identity).digest('hex');
  const limits = ACTION_RATE_LIMITS[action];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          const where = { action_identityHash: { action, identityHash } };
          const current = await transaction.actionRateLimit.findUnique({ where });
          const decision = evaluateRateLimit(storedTimestamps(current?.timestamps), limits, now);
          if (!decision.allowed) {
            return {
              allowed: false,
              retryAfterSeconds: decision.retryAfterSeconds,
              status: 429,
              error: 'rate_limited',
              message: `Hai raggiunto il limite per questa azione. Riprova tra ${decision.retryAfterSeconds} secondi.`,
            } satisfies RateLimitDecision;
          }

          await transaction.actionRateLimit.upsert({
            where,
            create: { action, identityHash, timestamps: decision.timestamps },
            update: { timestamps: decision.timestamps },
          });
          return { allowed: true } satisfies RateLimitDecision;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (attempt < 3 && retryableTransactionError(error)) continue;
      return unavailableDecision();
    }
  }

  return unavailableDecision();
}

const actionLabels: Record<RateLimitAction, string> = {
  'music.search': 'le ricerche musicali',
  'music.ai_search': 'le ricerche con l’AI',
  'ai.chat': 'le richieste all’assistente',
  'solco.support': 'le richieste al supporto',
  'admin.assistant': 'le richieste all’assistente amministrativo',
  'product.check.start': 'i controlli prodotto',
  'product.check.link': 'le letture dei link',
  'messages.send': 'l’invio dei messaggi',
  'community.follow': 'le azioni di community',
  'community.unfollow': 'le azioni di community',
  'community.profile.update': 'le modifiche al profilo community',
  'shops.create': 'la creazione di negozi',
  'shops.update': 'le modifiche ai negozi',
  'products.create': 'la creazione di prodotti',
  'products.update': 'le modifiche ai prodotti',
  'library.write': 'le modifiche alla Libreria',
  'library.import': 'l’importazione di playlist',
  'subscriptions.checkout': 'l’avvio dei pagamenti',
};

export async function enforceRateLimit(
  action: RateLimitAction,
  identity: string | null,
): Promise<Response | null> {
  const decision = await consumeRateLimit(action, identity);
  if (decision.allowed) return null;

  const message =
    decision.status === 429
      ? `Hai raggiunto il limite per ${actionLabels[action]}. Riprova tra ${decision.retryAfterSeconds} secondi.`
      : decision.message;
  return Response.json(
    { error: decision.error, message, retryAfterSeconds: decision.retryAfterSeconds },
    {
      status: decision.status,
      headers: {
        'Retry-After': String(decision.retryAfterSeconds),
        'Cache-Control': 'private, no-store',
      },
    },
  );
}
