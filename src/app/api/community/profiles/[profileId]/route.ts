// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import {
  findAvailableUsers,
  isPublic,
  profileCounts,
  profileRole,
} from '@/lib/business/community.server';
import { CommunityProfileResponseSchema } from '@/lib/contracts/community';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const { profileId } = await params;
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

    const users = await findAvailableUsers([profile.userId]);
    const user = users[0];
    if (!user) return NextResponse.json({ error: 'profile_not_found' }, { status: 404 });

    const [counts, relationship] = await Promise.all([
      profileCounts([profile.userId]),
      viewer && !isSelf
        ? prisma.userFollow.findUnique({
            where: {
              followerId_followedId: {
                followerId: viewer.id,
                followedId: profile.userId,
              },
            },
            select: { id: true },
          })
        : null,
    ]);
    const followersVisible = isSelf || isPublic(profile.followersVisibility);
    const followingVisible = isSelf || isPublic(profile.followingVisibility);

    return NextResponse.json(
      CommunityProfileResponseSchema.parse({
        profile: {
          id: profile.id,
          name: user.name.trim() || 'Profilo Solco',
          role: profileRole(profile.profileRole),
          followerCount: followersVisible ? (counts.followers.get(profile.userId) ?? 0) : null,
          followingCount: followingVisible ? (counts.following.get(profile.userId) ?? 0) : null,
          followersVisible,
          followingVisible,
          isFollowing: Boolean(relationship),
          isSelf,
        },
      }),
    );
  } catch {
    return NextResponse.json({ error: 'profile_unavailable' }, { status: 500 });
  }
}
