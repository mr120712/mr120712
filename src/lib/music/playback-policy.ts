// @polsia:user-owned

export const FREE_PREVIEW_LIMIT_SECONDS = 40;

export type PlaybackUnavailableReason =
  | 'source_missing'
  | 'rights_unverified'
  | 'service_unavailable';

type CurrentTrackRights = {
  evidenceId: string;
  albumId: string;
  trackId: string;
  grant: 'solco_streaming' | 'solco_preview';
  validFrom: string;
  validUntil: string;
};

export type VerifiedTrackPlayback = {
  state: 'verified';
  albumId: string;
  trackId: string;
  source: {
    sourceId: string;
    albumId: string;
    trackId: string;
    completeness: 'full_track';
    durationSeconds: number;
    mimeType: string;
    byteLength: number;
  };
  rights: CurrentTrackRights & {
    grant: 'solco_streaming';
    sourceId: string;
    durationSeconds: number;
  };
  checkSourceAvailable: () => Promise<boolean>;
  checkRightsEvidenceAvailable: () => Promise<boolean>;
  openStream: (range: string | null) => Promise<Response>;
};

export type VerifiedTrackPreview = {
  state: 'verified_preview';
  albumId: string;
  trackId: string;
  source: {
    sourceId: string;
    albumId: string;
    trackId: string;
    completeness: 'preview_excerpt';
    durationSeconds: number;
    byteLength: number;
  };
  rights: CurrentTrackRights & {
    grant: 'solco_preview';
    sourceId: string;
    durationSeconds: number;
  };
  openPreview: (range: string | null) => Promise<Response>;
};

export type UnavailableTrackPlayback = {
  state: 'unavailable' | 'unverified' | 'ambiguous';
  albumId: string;
  trackId: string;
  reason?: PlaybackUnavailableReason;
};

export type TrackPlaybackResolution = VerifiedTrackPlayback | UnavailableTrackPlayback;
export type TrackPreviewResolution = VerifiedTrackPreview | UnavailableTrackPlayback;

function hasCurrentRights(
  rights: CurrentTrackRights | null | undefined,
  albumId: string,
  trackId: string,
  grant: CurrentTrackRights['grant'],
  now: Date,
) {
  if (!rights || typeof rights !== 'object') return false;
  const validFrom = Date.parse(rights.validFrom);
  const validUntil = Date.parse(rights.validUntil);
  return (
    rights.albumId === albumId &&
    rights.trackId === trackId &&
    rights.grant === grant &&
    typeof rights.evidenceId === 'string' &&
    rights.evidenceId.trim().length > 0 &&
    Number.isFinite(validFrom) &&
    Number.isFinite(validUntil) &&
    validFrom <= now.getTime() &&
    validUntil > now.getTime()
  );
}

/** Only a trusted source-and-rights verifier may produce the verified result. */
export function isVerifiedTrackPlayback(
  result: TrackPlaybackResolution,
  albumId: string,
  trackId: string,
  now = new Date(),
): result is VerifiedTrackPlayback {
  if (!result || typeof result !== 'object' || result.state !== 'verified') return false;
  const source = result.source;
  return (
    result.albumId === albumId &&
    result.trackId === trackId &&
    Boolean(source && typeof source === 'object') &&
    source.albumId === albumId &&
    source.trackId === trackId &&
    source.completeness === 'full_track' &&
    typeof source.sourceId === 'string' &&
    source.sourceId.trim().length > 0 &&
    Number.isFinite(source.durationSeconds) &&
    source.durationSeconds > 0 &&
    /^audio\/[a-z0-9][a-z0-9.+-]*$/.test(source.mimeType) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength > 0 &&
    hasCurrentRights(result.rights, albumId, trackId, 'solco_streaming', now) &&
    result.rights.sourceId === source.sourceId &&
    result.rights.durationSeconds === source.durationSeconds &&
    typeof result.checkSourceAvailable === 'function' &&
    typeof result.checkRightsEvidenceAvailable === 'function' &&
    typeof result.openStream === 'function'
  );
}

/** A Free preview must be a distinct audio object containing only the licensed excerpt. */
export function isVerifiedTrackPreview(
  result: TrackPreviewResolution,
  albumId: string,
  trackId: string,
  now = new Date(),
): result is VerifiedTrackPreview {
  if (!result || typeof result !== 'object' || result.state !== 'verified_preview') return false;
  const source = result.source;
  return (
    result.albumId === albumId &&
    result.trackId === trackId &&
    Boolean(source && typeof source === 'object') &&
    source.albumId === albumId &&
    source.trackId === trackId &&
    source.completeness === 'preview_excerpt' &&
    typeof source.sourceId === 'string' &&
    source.sourceId.trim().length > 0 &&
    Number.isFinite(source.durationSeconds) &&
    source.durationSeconds > 0 &&
    source.durationSeconds <= FREE_PREVIEW_LIMIT_SECONDS &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength > 0 &&
    hasCurrentRights(result.rights, albumId, trackId, 'solco_preview', now) &&
    result.rights.sourceId === source.sourceId &&
    result.rights.durationSeconds === source.durationSeconds &&
    typeof result.openPreview === 'function'
  );
}

export type PreviewByteRange = { start: number; end: number };

/** Accepts only a single byte range contained within the verified excerpt asset. */
export function resolvePreviewByteRange(
  range: string | null,
  byteLength: number,
): PreviewByteRange | null {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) return null;
  if (range === null) return { start: 0, end: byteLength - 1 };

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') return null;

  if (startText === '') {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, byteLength - suffixLength),
      end: byteLength - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText === '' ? byteLength - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= byteLength
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, byteLength - 1) };
}
