// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { MusicRightsActionSchema } from '@/lib/contracts/music-rights';
import { prisma } from '@/lib/db';
import {
  musicRightsPrivateHeaders,
  requireVerifiedMusicRightsAdmin,
} from '@/lib/music/rights-admin.server';
import { sameOrigin } from '@/lib/same-origin';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: musicRightsPrivateHeaders },
    );
  }
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;

  const { sourceId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json' },
      { status: 400, headers: musicRightsPrivateHeaders },
    );
  }
  const parsed = MusicRightsActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_action' },
      { status: 400, headers: musicRightsPrivateHeaders },
    );
  }

  try {
    const source = await prisma.musicPlaybackSource.findUnique({
      where: { id: sourceId },
      select: {
        id: true,
        rightsEvidence: { select: { id: true, revokedAt: true } },
      },
    });
    if (!source) {
      return NextResponse.json(
        { error: 'source_not_found' },
        { status: 404, headers: musicRightsPrivateHeaders },
      );
    }

    if (parsed.data.action === 'deactivate_source') {
      await prisma.musicPlaybackSource.update({
        where: { id: source.id },
        data: { active: false },
      });
      return NextResponse.json(
        { sourceId: source.id, state: 'deactivated' },
        { headers: musicRightsPrivateHeaders },
      );
    }

    if (!source.rightsEvidence || source.rightsEvidence.revokedAt) {
      return NextResponse.json(
        { error: 'evidence_missing_or_already_revoked' },
        { status: 409, headers: musicRightsPrivateHeaders },
      );
    }
    await prisma.musicRightsEvidence.update({
      where: { id: source.rightsEvidence.id },
      data: { revokedAt: new Date() },
    });
    return NextResponse.json(
      { sourceId: source.id, state: 'revoked' },
      { headers: musicRightsPrivateHeaders },
    );
  } catch {
    return NextResponse.json(
      { error: 'rights_update_unavailable' },
      { status: 503, headers: musicRightsPrivateHeaders },
    );
  }
}
