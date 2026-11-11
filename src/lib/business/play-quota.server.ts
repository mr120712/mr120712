// @polsia:user-owned — conta e limita gli ascolti degli account free (40 al mese).
import 'server-only';
import type { Prisma } from '@prisma/client';
import {
  countsTowardFreeQuota,
  decidePlay,
  FREE_MONTHLY_PLAYS,
  FREE_QUOTA_EXEMPT_PREFIXES,
  type PlayDecision,
  REPLAY_WINDOW_MS,
  romeMonth,
} from '@/lib/business/play-quota';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { prisma } from '@/lib/db';
import { jamendoEnabled } from '@/lib/music/jamendo-license';

/** Client globale o transazione: le letture del limite sono le stesse nei due casi. */
type MusicPlayClient = Pick<Prisma.TransactionClient, 'musicPlay'>;

/** Tentativi della transazione che registra un ascolto Free (come `consumeRateLimit`). */
export const PLAY_RECORD_ATTEMPTS = 4;

/**
 * Il registro degli ascolti non ha potuto decidere in modo coerente (conflitti di serializzazione
 * oltre `PLAY_RECORD_ATTEMPTS`). Le route di stream la intercettano come ogni errore di
 * `recordStreamPlay` e rispondono 503 `stream_unavailable` senza audio: si fallisce chiusi.
 */
export class PlayQuotaUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Free play quota temporarily unavailable', options);
    this.name = 'PlayQuotaUnavailableError';
  }
}

function countMonthlyPlays(db: MusicPlayClient, userId: string, now: Date) {
  // YouTube and radio rows recorded before their exemption never count either.
  return db.musicPlay.count({
    where: {
      userId,
      month: romeMonth(now),
      NOT: FREE_QUOTA_EXEMPT_PREFIXES.map((prefix) => ({ qualifiedId: { startsWith: prefix } })),
    },
  });
}

function findRecentSameTrack(db: MusicPlayClient, userId: string, qualifiedId: string, now: Date) {
  return db.musicPlay.findFirst({
    where: {
      userId,
      qualifiedId,
      createdAt: { gt: new Date(now.getTime() - REPLAY_WINDOW_MS) },
    },
    select: { id: true },
  });
}

export async function monthlyPlays(userId: string, now = new Date()) {
  return countMonthlyPlays(prisma, userId, now);
}

/**
 * Jamendo spento (manca la licenza commerciale, vedi src/lib/music/jamendo-license.ts): nessun
 * audio può partire, quindi un brano Jamendo salvato (libreria, coda, cronologia) non deve
 * consumare uno dei 40 ascolti Free.
 */
function countsNow(qualifiedId: string) {
  if (qualifiedId.startsWith('jamendo:') && !jamendoEnabled()) return false;
  return countsTowardFreeQuota(qualifiedId);
}

function freePlayDecision(usedThisMonth: number, recent: unknown) {
  return decidePlay({
    signedIn: true,
    premium: false,
    usedThisMonth,
    recentSameTrack: Boolean(recent),
  });
}

/**
 * Le regole comuni a `decidePlayFor` e `consumePlay`: ospiti, Premium e fonti escluse non
 * scrivono mai; solo un brano che può consumare uno dei 40 ascolti Free arriva a `decideFree`.
 */
async function resolvePlay(
  user: { id: string } | null,
  qualifiedId: string,
  now: Date,
  decideFree: (userId: string) => Promise<PlayDecision>,
): Promise<PlayDecision> {
  if (!user) {
    return decidePlay({
      signedIn: false,
      premium: false,
      usedThisMonth: 0,
      recentSameTrack: false,
    });
  }
  const premium = await hasPremiumAccess(user.id);
  if (!countsNow(qualifiedId)) {
    // YouTube, live radio and switched-off Jamendo: never counted nor blocked.
    return {
      allowed: true,
      counted: false,
      used: premium ? 0 : await monthlyPlays(user.id, now),
      limit: premium ? null : FREE_MONTHLY_PLAYS,
    };
  }
  if (premium) {
    return decidePlay({ signedIn: true, premium: true, usedThisMonth: 0, recentSameTrack: false });
  }
  return decideFree(user.id);
}

/**
 * La decisione sul limite Free per un brano, senza scrivere nulla: unica fonte delle regole,
 * usata da `consumePlay` (che poi registra) e dal controllo delle route di stream e del permesso
 * del player (`checkStreamPlay`), così le due strade non possono divergere.
 */
export async function decidePlayFor(
  user: { id: string } | null,
  qualifiedId: string,
  now = new Date(),
): Promise<PlayDecision> {
  return resolvePlay(user, qualifiedId, now, async (userId) => {
    const [usedThisMonth, recent] = await Promise.all([
      countMonthlyPlays(prisma, userId, now),
      findRecentSameTrack(prisma, userId, qualifiedId, now),
    ]);
    return freePlayDecision(usedThisMonth, recent);
  });
}

/** Postgres 40001 (serialization_failure), che Prisma riporta come P2034. */
function isSerializationFailure(error: unknown) {
  if (typeof error !== 'object' || error === null) return false;
  const { code, meta, message } = error as { code?: unknown; meta?: unknown; message?: unknown };
  if (code === 'P2034' || code === '40001') return true;
  if (typeof meta === 'object' && meta !== null && (meta as { code?: unknown }).code === '40001') {
    return true;
  }
  return typeof message === 'string' && /\b40001\b|could not serialize access/.test(message);
}

/**
 * Letture (ascolti del mese, stesso brano nella finestra di ripresa) e scrittura nella stessa
 * transazione Serializable: due richieste concorrenti (Range in parallelo, prefetch + play, due
 * brani a 39/40) non possono più passare entrambe sulla stessa lettura. La perdente riceve un
 * errore di serializzazione e riprova vedendo la riga della vincitrice.
 */
async function recordFreePlay(userId: string, qualifiedId: string, now: Date) {
  let lastError: unknown;
  for (let attempt = 0; attempt < PLAY_RECORD_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          const usedThisMonth = await countMonthlyPlays(transaction, userId, now);
          const recent = await findRecentSameTrack(transaction, userId, qualifiedId, now);
          const decision = freePlayDecision(usedThisMonth, recent);
          if (decision.allowed && decision.counted) {
            await transaction.musicPlay.create({
              data: { userId, qualifiedId, month: romeMonth(now), createdAt: now },
            });
          }
          return decision;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      lastError = error;
    }
  }
  throw new PlayQuotaUnavailableError({ cause: lastError });
}

/**
 * Autorizza e registra l'avvio di un brano per l'utente indicato. Da chiamare solo quando
 * l'audio parte davvero (route di stream, tramite `recordStreamPlay`). Lancia
 * `PlayQuotaUnavailableError` se i conflitti non si risolvono: nessuna riga scritta, e le route
 * rispondono 503 senza audio.
 */
export async function consumePlay(
  user: { id: string } | null,
  qualifiedId: string,
  now = new Date(),
): Promise<PlayDecision> {
  return resolvePlay(user, qualifiedId, now, (userId) => recordFreePlay(userId, qualifiedId, now));
}

/** Risposta di blocco comune alle route di stream e all'API degli ascolti. */
export function playDeniedResponse(decision: Extract<PlayDecision, { allowed: false }>) {
  return Response.json(
    {
      allowed: false,
      reason: decision.reason,
      used: decision.used,
      limit: FREE_MONTHLY_PLAYS,
    },
    {
      status: decision.reason === 'login_required' ? 401 : 402,
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
    },
  );
}
