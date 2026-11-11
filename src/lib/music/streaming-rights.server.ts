// @polsia:user-owned
import 'server-only';
import { prisma } from '@/lib/db';
import {
  FREE_PREVIEW_LIMIT_SECONDS,
  type TrackPlaybackResolution,
  type TrackPreviewResolution,
} from '@/lib/music/playback-policy';
import {
  isPrivateAudioSourceAvailable,
  isPrivateEvidenceFileAvailable,
  openPrivateAudioSource,
} from '@/lib/music/private-audio-source.server';

const audioMimePattern = /^audio\/[a-z0-9][a-z0-9.+-]*$/;
const evidenceMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function validSource(
  source: {
    id: string;
    albumId: string;
    trackId: string;
    completeness: string;
    fileKey: string;
    mimeType: string;
    byteLength: number;
    durationSeconds: number;
  },
  albumId: string,
  trackId: string,
  completeness: 'preview_excerpt' | 'full_track',
) {
  return (
    source.albumId === albumId &&
    source.trackId === trackId &&
    source.completeness === completeness &&
    source.id.trim().length > 0 &&
    source.fileKey.trim().length > 0 &&
    audioMimePattern.test(source.mimeType) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength > 0 &&
    Number.isFinite(source.durationSeconds) &&
    source.durationSeconds > 0 &&
    (completeness !== 'preview_excerpt' || source.durationSeconds <= FREE_PREVIEW_LIMIT_SECONDS)
  );
}

function validCurrentEvidence(
  evidence: {
    id: string;
    sourceId: string;
    albumId: string;
    trackId: string;
    grant: string;
    durationSeconds: number;
    evidenceFileKey: string;
    evidenceMimeType: string;
    evidenceByteLength: number;
    validFrom: Date;
    validUntil: Date;
    verifiedAt: Date;
    verifiedByUserId: string;
    revokedAt: Date | null;
  },
  source: { id: string; albumId: string; trackId: string; durationSeconds: number },
  grant: 'solco_preview' | 'solco_streaming',
  now: Date,
) {
  return (
    evidence.sourceId === source.id &&
    evidence.albumId === source.albumId &&
    evidence.trackId === source.trackId &&
    evidence.grant === grant &&
    evidence.durationSeconds === source.durationSeconds &&
    evidence.evidenceFileKey.trim().length > 0 &&
    evidenceMimeTypes.has(evidence.evidenceMimeType.toLowerCase()) &&
    Number.isSafeInteger(evidence.evidenceByteLength) &&
    evidence.evidenceByteLength > 0 &&
    evidence.revokedAt === null &&
    evidence.verifiedByUserId.trim().length > 0 &&
    Number.isFinite(evidence.verifiedAt.getTime()) &&
    Number.isFinite(evidence.validFrom.getTime()) &&
    Number.isFinite(evidence.validUntil.getTime()) &&
    evidence.verifiedAt.getTime() <= now.getTime() &&
    evidence.validFrom.getTime() <= now.getTime() &&
    evidence.validUntil.getTime() > now.getTime()
  );
}

async function resolveSourceAndEvidence(
  albumId: string,
  trackId: string,
  completeness: 'preview_excerpt' | 'full_track',
  grant: 'solco_preview' | 'solco_streaming',
  now: Date,
) {
  const sources = await prisma.musicPlaybackSource.findMany({
    where: { albumId, trackId, completeness, active: true },
    orderBy: { createdAt: 'desc' },
  });
  if (sources.length === 0) return { state: 'missing' as const };
  if (sources.length !== 1) return { state: 'ambiguous' as const };

  const source = sources[0];
  if (!source || !validSource(source, albumId, trackId, completeness)) {
    return { state: 'missing' as const };
  }

  const evidenceRows = await prisma.musicRightsEvidence.findMany({
    where: { sourceId: source.id, revokedAt: null },
    orderBy: { verifiedAt: 'desc' },
  });
  const currentEvidence = evidenceRows.filter((evidence) =>
    validCurrentEvidence(evidence, source, grant, now),
  );
  if (currentEvidence.length === 0) return { state: 'unverified' as const };
  if (currentEvidence.length !== 1) return { state: 'ambiguous' as const };
  const evidence = currentEvidence[0];
  if (!evidence) return { state: 'unverified' as const };

  return { state: 'verified' as const, source, evidence };
}

/** Risolve soltanto una fonte integrale privata con prova corrente e puntuale. */
export async function resolveVerifiedTrackPlayback(
  albumId: string,
  trackId: string,
  now = new Date(),
): Promise<TrackPlaybackResolution> {
  const resolved = await resolveSourceAndEvidence(
    albumId,
    trackId,
    'full_track',
    'solco_streaming',
    now,
  );
  if (resolved.state !== 'verified') {
    return {
      state: resolved.state === 'ambiguous' ? 'ambiguous' : 'unavailable',
      albumId,
      trackId,
      reason: resolved.state === 'missing' ? 'source_missing' : 'rights_unverified',
    };
  }

  const { source, evidence } = resolved;
  return {
    state: 'verified',
    albumId,
    trackId,
    source: {
      sourceId: source.id,
      albumId: source.albumId,
      trackId: source.trackId,
      completeness: 'full_track',
      durationSeconds: source.durationSeconds,
      mimeType: source.mimeType,
      byteLength: source.byteLength,
    },
    rights: {
      evidenceId: evidence.id,
      albumId: evidence.albumId,
      trackId: evidence.trackId,
      grant: 'solco_streaming',
      sourceId: evidence.sourceId,
      durationSeconds: evidence.durationSeconds,
      validFrom: evidence.validFrom.toISOString(),
      validUntil: evidence.validUntil.toISOString(),
    },
    checkSourceAvailable: () =>
      isPrivateAudioSourceAvailable(source.fileKey, source.mimeType, source.byteLength),
    checkRightsEvidenceAvailable: () =>
      isPrivateEvidenceFileAvailable(
        evidence.evidenceFileKey,
        evidence.evidenceMimeType,
        evidence.evidenceByteLength,
      ),
    openStream: (range) => openPrivateAudioSource(source.fileKey, range),
  };
}

/** Risolve un file privato di solo estratto, mai un URL di anteprima del catalogo. */
export async function resolveVerifiedTrackPreview(
  albumId: string,
  trackId: string,
  now = new Date(),
): Promise<TrackPreviewResolution> {
  const resolved = await resolveSourceAndEvidence(
    albumId,
    trackId,
    'preview_excerpt',
    'solco_preview',
    now,
  );
  if (resolved.state !== 'verified') {
    return {
      state: resolved.state === 'ambiguous' ? 'ambiguous' : 'unavailable',
      albumId,
      trackId,
      reason: resolved.state === 'missing' ? 'source_missing' : 'rights_unverified',
    };
  }

  const { source, evidence } = resolved;
  return {
    state: 'verified_preview',
    albumId,
    trackId,
    source: {
      sourceId: source.id,
      albumId: source.albumId,
      trackId: source.trackId,
      completeness: 'preview_excerpt',
      durationSeconds: source.durationSeconds,
      byteLength: source.byteLength,
    },
    rights: {
      evidenceId: evidence.id,
      albumId: evidence.albumId,
      trackId: evidence.trackId,
      grant: 'solco_preview',
      sourceId: evidence.sourceId,
      durationSeconds: evidence.durationSeconds,
      validFrom: evidence.validFrom.toISOString(),
      validUntil: evidence.validUntil.toISOString(),
    },
    openPreview: (range) => openPrivateAudioSource(source.fileKey, range),
  };
}
