// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { ensureCommunityProfile, profileCounts } from '@/lib/business/community.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { CommunitySelfResponseSchema, CommunitySettingsSchema } from '@/lib/contracts/community';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  try {
    const profile = await ensureCommunityProfile(user.id);
    const counts = await profileCounts([user.id]);
    return NextResponse.json(
      CommunitySelfResponseSchema.parse({
        profile: {
          id: profile.id,
          name: user.name.trim() || 'Profilo Solco',
          profileRole: profile.profileRole,
          profileVisibility: profile.profileVisibility,
          followersVisibility: profile.followersVisibility,
          followingVisibility: profile.followingVisibility,
          followerCount: counts.followers.get(user.id) ?? 0,
          followingCount: counts.following.get(user.id) ?? 0,
        },
      }),
    );
  } catch {
    return NextResponse.json({ error: 'profile_unavailable' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const payload = await readJsonLimited(request, 4096);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = CommunitySettingsSchema.safeParse(payload.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_profile_settings' }, { status: 400 });
  }

  const limited = await enforceRateLimit('community.profile.update', `user:${user.id}`);
  if (limited) return limited;

  try {
    await prisma.userProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...parsed.data },
      update: parsed.data,
    });
    const profile = await ensureCommunityProfile(user.id);
    const counts = await profileCounts([user.id]);
    return NextResponse.json(
      CommunitySelfResponseSchema.parse({
        profile: {
          id: profile.id,
          name: user.name.trim() || 'Profilo Solco',
          profileRole: profile.profileRole,
          profileVisibility: profile.profileVisibility,
          followersVisibility: profile.followersVisibility,
          followingVisibility: profile.followingVisibility,
          followerCount: counts.followers.get(user.id) ?? 0,
          followingCount: counts.following.get(user.id) ?? 0,
        },
      }),
    );
  } catch {
    return NextResponse.json({ error: 'profile_settings_save_failed' }, { status: 500 });
  }
}
