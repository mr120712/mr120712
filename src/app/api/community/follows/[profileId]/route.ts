// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { CommunityFollowResponseSchema } from '@/lib/contracts/community';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ profileId: string }> },
) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const { profileId } = await params;
  try {
    const target = await prisma.userProfile.findUnique({ where: { id: profileId } });
    if (target) {
      const limited = await enforceRateLimit('community.unfollow', `user:${user.id}`);
      if (limited) return limited;
      await prisma.userFollow.deleteMany({
        where: { followerId: user.id, followedId: target.userId },
      });
    }
    return NextResponse.json(CommunityFollowResponseSchema.parse({ following: false }));
  } catch {
    return NextResponse.json({ error: 'unfollow_failed' }, { status: 500 });
  }
}
