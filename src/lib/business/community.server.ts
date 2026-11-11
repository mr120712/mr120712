// @polsia:user-owned
import 'server-only';
import type { UserProfile } from '@prisma/client';
import { prisma } from '@/lib/db';

export type CommunityProfile = Pick<
  UserProfile,
  | 'id'
  | 'userId'
  | 'profileRole'
  | 'profileVisibility'
  | 'followersVisibility'
  | 'followingVisibility'
>;

export async function ensureCommunityProfile(userId: string) {
  return prisma.userProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export async function findAvailableUsers(userIds: string[]) {
  if (userIds.length === 0) return [];
  return prisma.user.findMany({
    where: {
      id: { in: userIds },
      OR: [{ banned: false }, { banned: null }],
    },
    select: { id: true, name: true },
  });
}

export function profileRole(value: string): 'fan' | 'artist' {
  return value === 'artist' ? 'artist' : 'fan';
}

export function isPublic(value: string): boolean {
  return value === 'public';
}

export async function profileCounts(userIds: string[]) {
  if (userIds.length === 0) {
    return { followers: new Map<string, number>(), following: new Map<string, number>() };
  }

  const [followers, following] = await Promise.all([
    prisma.userFollow.groupBy({
      by: ['followedId'],
      where: { followedId: { in: userIds } },
      _count: { _all: true },
    }),
    prisma.userFollow.groupBy({
      by: ['followerId'],
      where: { followerId: { in: userIds } },
      _count: { _all: true },
    }),
  ]);

  return {
    followers: new Map(followers.map((row) => [row.followedId, row._count._all])),
    following: new Map(following.map((row) => [row.followerId, row._count._all])),
  };
}
