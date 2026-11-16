// @polsia:user-owned — conta e limita gli ascolti degli account free: 40 al mese per Audius, podcast
// e audio.com, e un conteggio a parte di 30 avvii al mese per i brani in evidenza della Home.
import 'server-only';
import type { Prisma } from '@prisma/client';
import {
  decidePlay,
  FEATURED_PLAY_ROW_PREFIX,
  FREE_MONTHLY_PLAYS,
  FREE_QUOTA_EXEMPT_PREFIXES,
  freeMonthlyLimit,
  type PlayDecision,
  type PlayQuotaClass,
  playQuotaClass,
  REPLAY_WINDOW_MS,
  romeMonth,
} from '@/lib/business/play-quota';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { prisma } from '@/lib/db';
import { jamendoEnabled } from '@/lib/music/jamendo-license';

/** Client globale o transazione: le letture del limite sono le stesse nei due casi. */
type MusicPlayClient = Pick<Prisma.TransactionClient, 'musicPlay'>;

/** Un conteggio Free che può bloccare: catalogo (40) o brani in evidenza (30). */
type CountedQuotaClass = Exclude<PlayQuotaClass, 'exempt'>;

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

/** Ascolti del mese del catalogo (Audius, podcast, audio.com): le righe non esenti. */
function countMonthlyPlays(db: MusicPlayClient, userId: string, now: Date) {
  // YouTube and radio rows recorded before their exemption never count either; `upload:` rows are
  // the featured tracks, which have their own count (countMonthlyFeaturedPlays).
  return db.musicPlay.count({
    where: {
      userId,
      month: romeMonth(now),
      NOT: FREE_QUOTA_EXEMPT_PREFIXES.map((prefix) => ({ qualifiedId: { startsWith: prefix } })),
    },
  });
}

/** Avvii del mese dei brani in evidenza: le righe `upload:<pathname>` (solo loro usano il prefisso). */
function countMonthlyFeaturedPlays(db: MusicPlayClient, userId: string, now: Date) {
  return db.musicPlay.count({
    where: {
      userId,
      month: romeMonth(now),
      qualifiedId: { startsWith: FEATURED_PLAY_ROW_PREFIX },
    },
  });
}

function countMonthlyPlaysFor(
  db: MusicPlayClient,
  userId: string,
  now: Date,
  quotaClass: CountedQuotaClass,
) {
  return quotaClass === 'featured'
    ? countMonthlyFeaturedPlays(db, userId, now)
    : countMonthlyPlays(db, userId, now);
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

export async function monthlyFeaturedPlays(userId: string, now = new Date()) {
  return countMonthlyFeaturedPlays(prisma, userId, now);
}

/**
 * Il conteggio in cui entra il brano OGGI. Jamendo spento (manca la licenza commerciale, vedi
 * src/lib/music/jamendo-license.ts): nessun audio può partire, quindi un brano Jamendo salvato
 * (libreria, coda, cronologia) non deve consumare uno dei 40 ascolti Free.
 */
function quotaClassNow(qualifiedId: string): PlayQuotaClass {
  if (qualifiedId.startsWith('jamendo:') && !jamendoEnabled()) return 'exempt';
  return playQuotaClass(qualifiedId);
}

function freePlayDecision(usedThisMonth: number, recent: unknown, limit: number) {
  return decidePlay({
    signedIn: true,
    premium: false,
    usedThisMonth,
    recentSameTrack: Boolean(recent),
    limit,
  });
}

type DecideFree = (
  userId: string,
  quotaClass: CountedQuotaClass,
  limit: number,
) => Promise<PlayDecision>;

/**
 * Le regole comuni a `decidePlayFor` e `consumePlay`: ospiti, Premium e fonti escluse non
 * scrivono mai; solo un brano che può consumare un ascolto Free (del catalogo o dei brani in
 * evidenza) arriva a `decideFree`, con il suo conteggio e il suo tetto.
 */
async function resolvePlay(
  user: { id: string } | null,
  qualifiedId: string,
  now: Date,
  decideFree: DecideFree,
): Promise<PlayDecision> {
  const quotaClass = quotaClassNow(qualifiedId);
  const limit = freeMonthlyLimit(quotaClass);
  if (!user) {
    return decidePlay({
      signedIn: false,
      premium: false,
      usedThisMonth: 0,
      recentSameTrack: false,
      limit,
    });
  }
  const premium = await hasPremiumAccess(user.id);
  if (quotaClass === 'exempt') {
    // YouTube, live radio and switched-off Jamendo: never counted nor blocked.
    return {
      allowed: true,
      counted: false,
      used: premium ? 0 : await monthlyPlays(user.id, now),
      limit: premium ? null : FREE_MONTHLY_PLAYS,
    };
  }
  if (premium) {
    return decidePlay({
      signedIn: true,
      premium: true,
      usedThisMonth: 0,
      recentSameTrack: false,
      limit,
    });
  }
  return decideFree(user.id, quotaClass, limit);
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
  return resolvePlay(user, qualifiedId, now, async (userId, quotaClass, limit) => {
    const [usedThisMonth, recent] = await Promise.all([
      countMonthlyPlaysFor(prisma, userId, now, quotaClass),
      findRecentSameTrack(prisma, userId, qualifiedId, now),
    ]);
    return freePlayDecision(usedThisMonth, recent, limit);
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
async function recordFreePlay(
  userId: string,
  qualifiedId: string,
  now: Date,
  quotaClass: CountedQuotaClass,
  limit: number,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < PLAY_RECORD_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          const usedThisMonth = await countMonthlyPlaysFor(transaction, userId, now, quotaClass);
          const recent = await findRecentSameTrack(transaction, userId, qualifiedId, now);
          const decision = freePlayDecision(usedThisMonth, recent, limit);
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
 * l'audio parte davvero (route di stream, tramite `recordStreamPlay`), oppure dal permesso del
 * player per le fonti che nessuna route di stream vede (audio.com: permitRecordsPlay). Lancia
 * `PlayQuotaUnavailableError` se i conflitti non si risolvono: nessuna riga scritta, e le route
 * rispondono 503 senza audio.
 */
export async function consumePlay(
  user: { id: string } | null,
  qualifiedId: string,
  now = new Date(),
): Promise<PlayDecision> {
  return resolvePlay(user, qualifiedId, now, (userId, quotaClass, limit) =>
    recordFreePlay(userId, qualifiedId, now, quotaClass, limit),
  );
}

/** Risposta di blocco comune alle route di stream e all'API degli ascolti. */
export function playDeniedResponse(decision: Extract<PlayDecision, { allowed: false }>) {
  return Response.json(
    {
      allowed: false,
      reason: decision.reason,
      used: decision.used,
      // Il tetto del conteggio in cui entra il brano: 40 per il catalogo, 30 per i brani in evidenza.
      limit: decision.limit,
    },
    {
      status: decision.reason === 'login_required' ? 401 : 402,
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
    },
  );
}
