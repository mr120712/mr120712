// @polsia:user-owned — conta e limita gli ascolti degli account free (40 al mese).
import 'server-only';
import {
  decidePlay,
  FREE_MONTHLY_PLAYS,
  type PlayDecision,
  REPLAY_WINDOW_MS,
  romeMonth,
} from '@/lib/business/play-quota';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/require-auth';

export async function monthlyPlays(userId: string, now = new Date()) {
  return prisma.musicPlay.count({ where: { userId, month: romeMonth(now) } });
}

/** Autorizza (e registra) l'avvio di un brano per l'utente indicato. */
export async function consumePlay(
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
  const decision = decidePlay({
    signedIn: true,
    premium,
    usedThisMonth,
    recentSameTrack: Boolean(recent),
  });
  if (decision.allowed && decision.counted) {
    await prisma.musicPlay.create({
      data: { userId: user.id, qualifiedId, month: romeMonth(now), createdAt: now },
    });
  }
  return decision;
}

/** Per le route di stream: utente della sessione corrente + verifica del limite. */
export async function consumePlayForCurrentUser(qualifiedId: string) {
  const user = await getSessionUser().catch(() => null);
  return consumePlay(user, qualifiedId);
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
