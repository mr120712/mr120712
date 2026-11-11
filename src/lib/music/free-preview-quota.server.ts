// @polsia:user-owned
import 'server-only';
import { prisma } from '@/lib/db';
import { FREE_PREVIEW_LIMIT_SECONDS } from '@/lib/music/playback-policy';

const millisecondsPerSecond = 1000;
const maximumCompareAndSwapAttempts = 12;

export type FreePreviewQuota = {
  usedMilliseconds: number;
  limitMilliseconds: number;
  remainingMilliseconds: number;
};

function quotaFromUsage(consumedMilliseconds: number): FreePreviewQuota {
  const limitMilliseconds = FREE_PREVIEW_LIMIT_SECONDS * millisecondsPerSecond;
  const usedMilliseconds = Math.max(0, Math.min(limitMilliseconds, consumedMilliseconds));
  return {
    usedMilliseconds,
    limitMilliseconds,
    remainingMilliseconds: limitMilliseconds - usedMilliseconds,
  };
}

export async function readFreePreviewQuota(userId: string): Promise<FreePreviewQuota> {
  const usage = await prisma.musicFreePreviewUsage.findUnique({ where: { userId } });
  return quotaFromUsage(usage?.consumedMilliseconds ?? 0);
}

/**
 * Charge one complete, rights-verified preview before audio bytes are returned.
 * A compare-and-swap update makes concurrent requests across devices share the
 * same account limit. Charging each delivered excerpt is deliberately
 * conservative when a client pauses or loses its connection.
 */
export async function consumeFreePreviewQuota(userId: string, durationSeconds: number) {
  if (
    !userId.trim() ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > FREE_PREVIEW_LIMIT_SECONDS
  ) {
    return false;
  }

  const requestedMilliseconds = Math.ceil(durationSeconds * millisecondsPerSecond);
  const limitMilliseconds = FREE_PREVIEW_LIMIT_SECONDS * millisecondsPerSecond;

  for (let attempt = 0; attempt < maximumCompareAndSwapAttempts; attempt += 1) {
    const usage = await prisma.musicFreePreviewUsage.upsert({
      where: { userId },
      update: {},
      create: { userId, consumedMilliseconds: 0 },
    });
    if (usage.consumedMilliseconds + requestedMilliseconds > limitMilliseconds) return false;

    const updated = await prisma.musicFreePreviewUsage.updateMany({
      where: { userId, consumedMilliseconds: usage.consumedMilliseconds },
      data: { consumedMilliseconds: { increment: requestedMilliseconds } },
    });
    if (updated.count === 1) return true;
  }

  return false;
}

export function serializeFreePreviewQuota(quota: FreePreviewQuota) {
  return {
    usedSeconds: quota.usedMilliseconds / millisecondsPerSecond,
    limitSeconds: quota.limitMilliseconds / millisecondsPerSecond,
    remainingSeconds: quota.remainingMilliseconds / millisecondsPerSecond,
  };
}
