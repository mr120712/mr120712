// @polsia:user-owned — premi Solco: assegnazione idempotente di Premium gratuito.
import 'server-only';
import {
  grantWindow,
  isBirthdayToday,
  listeningRewardsEarned,
  makeReferralCode,
  monthsBetween,
  qualifyingListeningDays,
  REWARDS,
  referralTierGrants,
  romeDay,
} from '@/lib/business/rewards';
import { prisma } from '@/lib/db';

const REFERRAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type GrantReason =
  | 'referral_invitee'
  | 'referral_inviter'
  | 'founder'
  | 'listening'
  | 'loyalty'
  | 'birthday';

/** Regala `days` giorni di Premium una sola volta per `refKey`. I periodi si sommano. */
export async function grantPremium(input: {
  userId: string;
  reason: GrantReason;
  days: number;
  refKey: string;
  now?: Date;
  startsAt?: Date | null;
}) {
  const existing = await prisma.premiumGrant.findUnique({ where: { refKey: input.refKey } });
  if (existing) return existing;
  const now = input.now ?? new Date();
  const latest = await prisma.premiumGrant.findFirst({
    where: { userId: input.userId, endsAt: { gt: now } },
    orderBy: { endsAt: 'desc' },
    select: { endsAt: true },
  });
  const window = grantWindow({
    now,
    days: input.days,
    latestEnd: latest?.endsAt ?? null,
    startsAt: input.startsAt ?? null,
  });
  try {
    return await prisma.premiumGrant.create({
      data: {
        userId: input.userId,
        reason: input.reason,
        days: input.days,
        refKey: input.refKey,
        ...window,
      },
    });
  } catch {
    // Concurrent request created the same grant: the unique refKey keeps it single.
    return prisma.premiumGrant.findUnique({ where: { refKey: input.refKey } });
  }
}

export async function getActiveGrant(userId: string, now = new Date()) {
  return prisma.premiumGrant.findFirst({
    where: { userId, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { endsAt: 'desc' },
  });
}

export async function ensureReferralCode(userId: string) {
  const existing = await prisma.referralCode.findUnique({ where: { userId } });
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const row = await prisma.referralCode.create({ data: { userId, code: makeReferralCode() } });
      return row.code;
    } catch {
      const again = await prisma.referralCode.findUnique({ where: { userId } });
      if (again) return again.code;
    }
  }
  throw new Error('referral code unavailable');
}

export type ClaimResult =
  | 'claimed'
  | 'invalid_code'
  | 'own_code'
  | 'already_referred'
  | 'account_too_old';

/** Collega un nuovo iscritto a chi lo ha invitato (solo account creati da meno di 7 giorni). */
export async function claimReferral(inviteeId: string, code: string, now = new Date()) {
  const owner = await prisma.referralCode.findUnique({
    where: { code: code.trim().toLowerCase() },
  });
  if (!owner) return 'invalid_code' satisfies ClaimResult;
  if (owner.userId === inviteeId) return 'own_code' satisfies ClaimResult;
  const user = await prisma.user.findUnique({
    where: { id: inviteeId },
    select: { createdAt: true },
  });
  if (!user || now.getTime() - user.createdAt.getTime() > REFERRAL_WINDOW_MS) {
    return 'account_too_old' satisfies ClaimResult;
  }
  const existing = await prisma.referral.findUnique({ where: { inviteeId } });
  if (existing) return 'already_referred' satisfies ClaimResult;
  try {
    await prisma.referral.create({ data: { inviterId: owner.userId, inviteeId } });
  } catch {
    return 'already_referred' satisfies ClaimResult;
  }
  return 'claimed' satisfies ClaimResult;
}

/** Aggiunge un "tick" di ascolto al giorno corrente; ignora tick troppo ravvicinati. */
export async function recordListening(userId: string, seconds: number, now = new Date()) {
  const amount = Math.max(0, Math.min(REWARDS.maxTickSeconds, Math.floor(seconds)));
  if (amount === 0) return false;
  const day = romeDay(now);
  const existing = await prisma.listeningDay.findUnique({
    where: { userId_day: { userId, day } },
  });
  if (existing && now.getTime() - existing.updatedAt.getTime() < REWARDS.minTickIntervalMs) {
    return false;
  }
  await prisma.listeningDay.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, seconds: amount },
    update: { seconds: { increment: amount } },
  });
  return true;
}

async function evaluateFounder(userId: string, now: Date) {
  const profile = await prisma.userRewardProfile.findUnique({ where: { userId } });
  if (profile?.founderNumber) return profile.founderNumber;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
  if (!user) return null;
  const rank = await prisma.user.count({ where: { createdAt: { lte: user.createdAt } } });
  if (rank > REWARDS.founderLimit) return null;
  await prisma.userRewardProfile.upsert({
    where: { userId },
    create: { userId, founderNumber: rank },
    update: { founderNumber: rank },
  });
  await grantPremium({
    userId,
    reason: 'founder',
    days: REWARDS.founderDays,
    refKey: `founder:${userId}`,
    now,
  });
  return rank;
}

/** true se l'utente ha almeno un pagamento Premium verificato (Stripe o PayPal). */
async function hasVerifiedPayment(userId: string) {
  const [stripe, paypal] = await Promise.all([
    prisma.solcoSubscription.count({ where: { userId, firstPaidAt: { not: null } } }),
    prisma.payPalSubscription.count({ where: { userId, firstPaidAt: { not: null } } }),
  ]);
  return stripe + paypal > 0;
}

/**
 * L'invito si converte una sola volta, al primo pagamento Premium verificato dell'amico:
 * l'amico riceve il benvenuto, chi invita i premi progressivi delle soglie raggiunte.
 */
async function evaluateReferralAsInvitee(userId: string, now: Date) {
  const referral = await prisma.referral.findUnique({ where: { inviteeId: userId } });
  if (!referral || referral.qualifiedAt || !(await hasVerifiedPayment(userId))) return;
  const updated = await prisma.referral.updateMany({
    where: { id: referral.id, qualifiedAt: null },
    data: { qualifiedAt: now },
  });
  if (updated.count === 0) return;
  await grantPremium({
    userId,
    reason: 'referral_invitee',
    days: REWARDS.inviteeWelcomeDays,
    refKey: `ref-welcome:${userId}`,
    now,
  });
  await grantInviterTiers(referral.inviterId, now);
}

/** Assegna a chi invita i premi delle soglie raggiunte, ognuna una sola volta. */
export async function grantInviterTiers(inviterId: string, now = new Date()) {
  const paidFriends = await prisma.referral.count({
    where: { inviterId, qualifiedAt: { not: null } },
  });
  for (const tier of referralTierGrants(paidFriends)) {
    await grantPremium({
      userId: inviterId,
      reason: 'referral_inviter',
      days: tier.days,
      refKey: `ref-tier:${inviterId}:${tier.friends}`,
      now,
    });
  }
}

async function evaluateLoyalty(userId: string, now: Date) {
  const [stripe, paypal] = await Promise.all([
    prisma.solcoSubscription.findMany({
      where: { userId, status: { in: ['active', 'trialing'] } },
    }),
    prisma.payPalSubscription.findMany({ where: { userId, status: 'ACTIVE' } }),
  ]);
  const subscriptions = [
    ...stripe.map((row) => ({
      id: row.stripeSubscriptionId,
      since: row.createdAt,
      until: row.currentPeriodEnd,
    })),
    ...paypal.map((row) => ({
      id: row.paypalSubscriptionId,
      since: row.createdAt,
      until: row.nextBillingAt,
    })),
  ];
  for (const sub of subscriptions) {
    if (monthsBetween(sub.since, now) < REWARDS.loyaltyMonths) continue;
    // The free month starts when the paid period ends, so it is never wasted.
    await grantPremium({
      userId,
      reason: 'loyalty',
      days: REWARDS.loyaltyDays,
      refKey: `loyal:${sub.id}`,
      now,
      startsAt: sub.until,
    });
  }
}

/** Controlla e assegna tutti i premi maturati. Idempotente: si può chiamare spesso. */
export async function evaluateRewards(userId: string, now = new Date()) {
  const founderNumber = await evaluateFounder(userId, now);
  const days = await prisma.listeningDay.findMany({
    where: { userId },
    select: { day: true, seconds: true },
  });
  await evaluateReferralAsInvitee(userId, now);
  const earned = listeningRewardsEarned(days);
  for (let n = 1; n <= earned; n += 1) {
    await grantPremium({
      userId,
      reason: 'listening',
      days: 1,
      refKey: `listen:${userId}:${n}`,
      now,
    });
  }
  const profile = await prisma.userRewardProfile.findUnique({ where: { userId } });
  if (isBirthdayToday(profile?.birthday ?? null, now)) {
    await grantPremium({
      userId,
      reason: 'birthday',
      days: REWARDS.birthdayDays,
      refKey: `bday:${userId}:${romeDay(now).slice(0, 4)}`,
      now,
    });
  }
  await evaluateLoyalty(userId, now);
  return { founderNumber, days };
}

export async function setBirthday(userId: string, birthday: string) {
  const profile = await prisma.userRewardProfile.findUnique({ where: { userId } });
  // Set once: prevents moving the birthday around to collect the reward repeatedly.
  if (profile?.birthday) return false;
  await prisma.userRewardProfile.upsert({
    where: { userId },
    create: { userId, birthday },
    update: { birthday },
  });
  return true;
}

export async function getRewardsSummary(userId: string, now = new Date()) {
  const { founderNumber, days } = await evaluateRewards(userId, now);
  const [code, referrals, grants, activeGrant, profile, oldestSub] = await Promise.all([
    ensureReferralCode(userId),
    prisma.referral.findMany({ where: { inviterId: userId }, select: { qualifiedAt: true } }),
    prisma.premiumGrant.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    getActiveGrant(userId, now),
    prisma.userRewardProfile.findUnique({ where: { userId } }),
    prisma.solcoSubscription.findFirst({
      where: { userId, status: { in: ['active', 'trialing'] } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  const premiumUntil = grants
    .filter((grant) => grant.endsAt > now)
    .reduce<Date | null>((max, grant) => (!max || grant.endsAt > max ? grant.endsAt : max), null);
  const qualifyingDays = qualifyingListeningDays(days);
  return {
    code,
    founderNumber: founderNumber ?? profile?.founderNumber ?? null,
    birthday: profile?.birthday ?? null,
    friends: {
      joined: referrals.length,
      qualified: referrals.filter((row) => row.qualifiedAt).length,
    },
    listening: {
      qualifyingDays,
      nextRewardIn:
        REWARDS.listeningDaysPerReward - (qualifyingDays % REWARDS.listeningDaysPerReward),
    },
    loyaltyMonths: oldestSub ? monthsBetween(oldestSub.createdAt, now) : null,
    activeGrantUntil: activeGrant ? (premiumUntil?.toISOString() ?? null) : null,
    premiumUntil: premiumUntil?.toISOString() ?? null,
    grants: grants.map((grant) => ({
      reason: grant.reason,
      days: grant.days,
      startsAt: grant.startsAt.toISOString(),
      endsAt: grant.endsAt.toISOString(),
    })),
  };
}
