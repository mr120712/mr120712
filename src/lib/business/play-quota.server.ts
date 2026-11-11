// @polsia:user-owned — conta e limita gli ascolti degli account free (40 al mese).
import 'server-only';
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

export async function monthlyPlays(userId: string, now = new Date()) {
  // YouTube and radio rows recorded before their exemption never count either.
  return prisma.musicPlay.count({
    where: {
      userId,
      month: romeMonth(now),
      NOT: FREE_QUOTA_EXEMPT_PREFIXES.map((prefix) => ({ qualifiedId: { startsWith: prefix } })),
    },
  });
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
  const [usedThisMonth, recent] = premium
    ? [0, null]
    : await Promise.all([
        monthlyPlays(user.id, now),
        prisma.musicPlay.findFirst({
          where: {
            userId: user.id,
            qualifiedId,
            createdAt: { gt: new Date(now.getTime() - REPLAY_WINDOW_MS) },
          },
          select: { id: true },
        }),
      ]);
  return decidePlay({
    signedIn: true,
    premium,
    usedThisMonth,
    recentSameTrack: Boolean(recent),
  });
}

/**
 * Autorizza e registra l'avvio di un brano per l'utente indicato. Da chiamare solo quando
 * l'audio parte davvero (route di stream, tramite `recordStreamPlay`).
 */
export async function consumePlay(
  user: { id: string } | null,
  qualifiedId: string,
  now = new Date(),
): Promise<PlayDecision> {
  const decision = await decidePlayFor(user, qualifiedId, now);
  if (user && decision.allowed && decision.counted) {
    await prisma.musicPlay.create({
      data: { userId: user.id, qualifiedId, month: romeMonth(now), createdAt: now },
    });
  }
  return decision;
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
