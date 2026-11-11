// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import {
  findAvailableUsers,
  isPublic,
  profileCounts,
  profileRole,
} from '@/lib/business/community.server';
import {
  CommunityDirectoryResponseSchema,
  CommunityProfileRoleSchema,
} from '@/lib/contracts/community';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 24;
const MAX_OFFSET = 10_000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawRole = url.searchParams.get('role');
  const role = rawRole ? CommunityProfileRoleSchema.safeParse(rawRole) : null;
  if (role && !role.success) {
    return NextResponse.json({ error: 'invalid_profile_role' }, { status: 400 });
  }

  const rawOffset = Number(url.searchParams.get('offset') ?? 0);
  if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > MAX_OFFSET) {
    return NextResponse.json({ error: 'invalid_offset' }, { status: 400 });
  }

  try {
    const candidates = await prisma.userProfile.findMany({
      where: {
        profileVisibility: 'public',
        ...(role?.success ? { profileRole: role.data } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: rawOffset,
      take: PAGE_SIZE + 1,
    });
    const users = await findAvailableUsers(candidates.map((profile) => profile.userId));
    const usersById = new Map(users.map((user) => [user.id, user]));
    const visibleProfiles = candidates.filter((profile) => usersById.has(profile.userId));
    const pageProfiles = visibleProfiles.slice(0, PAGE_SIZE);
    const userIds = pageProfiles.map((profile) => profile.userId);
    const [counts, viewer] = await Promise.all([
      profileCounts(userIds),
      getSessionUser().catch(() => null),
    ]);
    const follows =
      viewer && userIds.length > 0
        ? await prisma.userFollow.findMany({
            where: { followerId: viewer.id, followedId: { in: userIds } },
            select: { followedId: true },
          })
        : [];
    const followedIds = new Set(follows.map((follow) => follow.followedId));

    return NextResponse.json(
      CommunityDirectoryResponseSchema.parse({
        profiles: pageProfiles.map((profile) => {
          const user = usersById.get(profile.userId);
          return {
            id: profile.id,
            name: user?.name.trim() || 'Profilo Solco',
            role: profileRole(profile.profileRole),
            followerCount: isPublic(profile.followersVisibility)
              ? (counts.followers.get(profile.userId) ?? 0)
              : null,
            followingCount: isPublic(profile.followingVisibility)
              ? (counts.following.get(profile.userId) ?? 0)
              : null,
            followersVisible: isPublic(profile.followersVisibility),
            followingVisible: isPublic(profile.followingVisibility),
            isFollowing: followedIds.has(profile.userId),
          };
        }),
        nextOffset: candidates.length > PAGE_SIZE ? rawOffset + PAGE_SIZE : null,
      }),
    );
  } catch {
    return NextResponse.json({ error: 'community_unavailable' }, { status: 500 });
  }
}
