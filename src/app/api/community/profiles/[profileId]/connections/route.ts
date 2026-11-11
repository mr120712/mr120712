// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { findAvailableUsers, isPublic, profileRole } from '@/lib/business/community.server';
import { CommunityConnectionsResponseSchema } from '@/lib/contracts/community';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 24;
// The response depends on the viewer (own private lists, isFollowing).
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const MAX_OFFSET = 10_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const { profileId } = await params;
  const url = new URL(request.url);
  const list = url.searchParams.get('list');
  if (list !== 'followers' && list !== 'following') {
    return NextResponse.json({ error: 'invalid_connection_list' }, { status: 400 });
  }

  const offset = Number(url.searchParams.get('offset') ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    return NextResponse.json({ error: 'invalid_offset' }, { status: 400 });
  }

  try {
    const [profile, viewer] = await Promise.all([
      prisma.userProfile.findUnique({ where: { id: profileId } }),
      getSessionUser().catch(() => null),
    ]);
    if (!profile) return NextResponse.json({ error: 'profile_not_found' }, { status: 404 });

    const isSelf = viewer?.id === profile.userId;
    if (!isPublic(profile.profileVisibility) && !isSelf) {
      return NextResponse.json({ error: 'profile_not_found' }, { status: 404 });
    }

    const visibility =
      list === 'followers' ? profile.followersVisibility : profile.followingVisibility;
    if (!isSelf && !isPublic(visibility)) {
      return NextResponse.json({ error: 'connection_list_private' }, { status: 403 });
    }

    const connections = await prisma.userFollow.findMany({
      where: list === 'followers' ? { followedId: profile.userId } : { followerId: profile.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: offset,
      take: PAGE_SIZE + 1,
      select: { followerId: true, followedId: true },
    });
    const otherUserIds = connections.map((connection) =>
      list === 'followers' ? connection.followerId : connection.followedId,
    );
    const [profiles, users] = await Promise.all([
      prisma.userProfile.findMany({
        where: { userId: { in: otherUserIds }, profileVisibility: 'public' },
      }),
      findAvailableUsers(otherUserIds),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const profileByUserId = new Map(profiles.map((item) => [item.userId, item]));
    const visibleUserIds = [
      ...new Set(
        otherUserIds.filter((userId) => profileByUserId.has(userId) && userById.has(userId)),
      ),
    ];
    const follows =
      viewer && visibleUserIds.length > 0
        ? await prisma.userFollow.findMany({
            where: { followerId: viewer.id, followedId: { in: visibleUserIds } },
            select: { followedId: true },
          })
        : [];
    const followedIds = new Set(follows.map((follow) => follow.followedId));

    return NextResponse.json(
      CommunityConnectionsResponseSchema.parse({
        profiles: visibleUserIds.map((userId) => {
          const publicProfile = profileByUserId.get(userId);
          const user = userById.get(userId);
          return {
            id: publicProfile?.id ?? '',
            name: user?.name.trim() || 'Profilo Solco',
            role: profileRole(publicProfile?.profileRole ?? 'fan'),
            isFollowing: followedIds.has(userId),
          };
        }),
        nextOffset: connections.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
      }),
      { headers: privateHeaders },
    );
  } catch {
    return NextResponse.json({ error: 'connections_unavailable' }, { status: 500 });
  }
}
