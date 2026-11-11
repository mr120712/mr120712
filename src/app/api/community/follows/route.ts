// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { findAvailableUsers, isPublic } from '@/lib/business/community.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  CommunityFollowRequestSchema,
  CommunityFollowResponseSchema,
} from '@/lib/contracts/community';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const payload = await readJsonLimited(request, 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = CommunityFollowRequestSchema.safeParse(payload.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_profile_id' }, { status: 400 });
  }

  try {
    const target = await prisma.userProfile.findUnique({ where: { id: parsed.data.profileId } });
    if (!target || !isPublic(target.profileVisibility)) {
      return NextResponse.json({ error: 'profile_not_found' }, { status: 404 });
    }
    if (target.userId === user.id) {
      return NextResponse.json({ error: 'cannot_follow_self' }, { status: 400 });
    }
    const available = await findAvailableUsers([target.userId]);
    if (available.length === 0) {
      return NextResponse.json({ error: 'profile_not_found' }, { status: 404 });
    }

    const limited = await enforceRateLimit('community.follow', `user:${user.id}`);
    if (limited) return limited;

    await prisma.userFollow.upsert({
      where: {
        followerId_followedId: { followerId: user.id, followedId: target.userId },
      },
      create: { followerId: user.id, followedId: target.userId },
      update: {},
    });
    return NextResponse.json(CommunityFollowResponseSchema.parse({ following: true }));
  } catch {
    return NextResponse.json({ error: 'follow_failed' }, { status: 500 });
  }
}
