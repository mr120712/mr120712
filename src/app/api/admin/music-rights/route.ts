// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { MusicRightsRegistrationSchema } from '@/lib/contracts/music-rights';
import { prisma } from '@/lib/db';
import { getAudiusAlbumCatalogDetail } from '@/lib/music/audius-source.server';
import {
  InvalidPrivateAudioSource,
  InvalidPrivateEvidenceFile,
  inspectPrivateAudioSource,
  inspectPrivateEvidenceFile,
  PrivateAudioStorageUnavailable,
} from '@/lib/music/private-audio-source.server';
import {
  musicRightsPrivateHeaders,
  requireVerifiedMusicRightsAdmin,
} from '@/lib/music/rights-admin.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

function rightsState(
  evidence: {
    validFrom: Date;
    validUntil: Date;
    revokedAt: Date | null;
  } | null,
  now: Date,
) {
  if (!evidence) return 'missing' as const;
  if (evidence.revokedAt) return 'revoked' as const;
  if (evidence.validFrom.getTime() > now.getTime()) return 'scheduled' as const;
  if (evidence.validUntil.getTime() <= now.getTime()) return 'expired' as const;
  return 'current' as const;
}

export async function GET(request: Request) {
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;

  try {
    const now = new Date();
    const sources = await prisma.musicPlaybackSource.findMany({
      where: { completeness: 'full_track' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        albumId: true,
        trackId: true,
        completeness: true,
        durationSeconds: true,
        active: true,
        rightsEvidence: {
          select: {
            validFrom: true,
            validUntil: true,
            verifiedAt: true,
            verifiedByUserId: true,
            revokedAt: true,
          },
        },
      },
    });
    const records = sources.map((source) => ({
      sourceId: source.id,
      albumId: source.albumId,
      trackId: source.trackId,
      active: source.active,
      completeness: 'full_track' as const,
      durationSeconds: source.durationSeconds,
      rightsState: rightsState(source.rightsEvidence, now),
      validFrom: source.rightsEvidence?.validFrom.toISOString() ?? null,
      validUntil: source.rightsEvidence?.validUntil.toISOString() ?? null,
      verifiedByUserId: source.rightsEvidence?.verifiedByUserId ?? null,
      verifiedAt: source.rightsEvidence?.verifiedAt.toISOString() ?? null,
      revokedAt: source.rightsEvidence?.revokedAt?.toISOString() ?? null,
    }));
    return NextResponse.json({ records }, { headers: musicRightsPrivateHeaders });
  } catch {
    return NextResponse.json(
      { error: 'rights_records_unavailable' },
      { status: 503, headers: musicRightsPrivateHeaders },
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: musicRightsPrivateHeaders },
    );
  }
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json' },
      { status: 400, headers: musicRightsPrivateHeaders },
    );
  }
  const parsed = MusicRightsRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_rights_record', fields: parsed.error.flatten().fieldErrors },
      { status: 400, headers: musicRightsPrivateHeaders },
    );
  }
  const input = parsed.data;
  if (Date.parse(input.validUntil) <= Date.now()) {
    return NextResponse.json(
      { error: 'rights_already_expired' },
      { status: 400, headers: musicRightsPrivateHeaders },
    );
  }

  const catalog = await getAudiusAlbumCatalogDetail(input.albumId);
  if (catalog.state === 'unavailable') {
    return NextResponse.json(
      { error: 'catalog_unavailable' },
      { status: 503, headers: musicRightsPrivateHeaders },
    );
  }
  if (
    catalog.state !== 'available' ||
    !catalog.tracks.some((track) => track.id === input.trackId)
  ) {
    return NextResponse.json(
      { error: 'catalog_track_not_found' },
      { status: 404, headers: musicRightsPrivateHeaders },
    );
  }

  try {
    const [audio, evidence] = await Promise.all([
      inspectPrivateAudioSource(input.audio.key, input.audio.mimeType, input.audio.byteLength),
      inspectPrivateEvidenceFile(
        input.evidence.key,
        input.evidence.mimeType,
        input.evidence.byteLength,
      ),
    ]);
    const existing = await prisma.musicPlaybackSource.findMany({
      where: {
        albumId: input.albumId,
        trackId: input.trackId,
        completeness: 'full_track',
        active: true,
      },
      select: { id: true },
      take: 2,
    });
    if (existing.length > 0) {
      return NextResponse.json(
        { error: 'active_source_exists' },
        { status: 409, headers: musicRightsPrivateHeaders },
      );
    }

    const now = new Date();
    const source = await prisma.$transaction(async (transaction) => {
      const createdSource = await transaction.musicPlaybackSource.create({
        data: {
          albumId: input.albumId,
          trackId: input.trackId,
          completeness: 'full_track',
          fileKey: input.audio.key,
          mimeType: audio.mimeType,
          byteLength: audio.byteLength,
          durationSeconds: audio.durationSeconds,
          active: true,
          createdByUserId: access.user.id,
        },
        select: { id: true },
      });
      await transaction.musicRightsEvidence.create({
        data: {
          sourceId: createdSource.id,
          albumId: input.albumId,
          trackId: input.trackId,
          grant: 'solco_streaming',
          durationSeconds: audio.durationSeconds,
          evidenceFileKey: input.evidence.key,
          evidenceMimeType: evidence.mimeType,
          evidenceByteLength: evidence.byteLength,
          validFrom: new Date(input.validFrom),
          validUntil: new Date(input.validUntil),
          verifiedAt: now,
          verifiedByUserId: access.user.id,
        },
      });
      return createdSource;
    });
    return NextResponse.json(
      { sourceId: source.id, state: 'recorded' },
      { status: 201, headers: musicRightsPrivateHeaders },
    );
  } catch (error) {
    const invalidUpload =
      error instanceof InvalidPrivateAudioSource || error instanceof InvalidPrivateEvidenceFile;
    const unavailable = error instanceof PrivateAudioStorageUnavailable;
    return NextResponse.json(
      {
        error: invalidUpload
          ? 'private_file_invalid'
          : unavailable
            ? 'private_storage_unavailable'
            : 'rights_record_not_saved',
      },
      { status: unavailable || !invalidUpload ? 503 : 422, headers: musicRightsPrivateHeaders },
    );
  }
}
