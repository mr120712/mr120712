import { describe, expect, it } from 'vitest';
import {
  isVerifiedTrackPlayback,
  isVerifiedTrackPreview,
  resolvePreviewByteRange,
  type TrackPlaybackResolution,
  type TrackPreviewResolution,
  type VerifiedTrackPlayback,
} from '@/lib/music/playback-policy';

const albumId = '300';
const trackId = '301';
const now = new Date('2026-11-08T12:00:00.000Z');
const verified: VerifiedTrackPlayback = {
  state: 'verified',
  albumId,
  trackId,
  source: {
    sourceId: 'source-record-test',
    albumId,
    trackId,
    completeness: 'full_track',
    durationSeconds: 180,
    mimeType: 'audio/mpeg',
    byteLength: 4096,
  },
  rights: {
    evidenceId: 'rights-record-test',
    albumId,
    trackId,
    grant: 'solco_streaming',
    sourceId: 'source-record-test',
    durationSeconds: 180,
    validFrom: '2026-11-08T11:00:00.000Z',
    validUntil: '2026-11-09T11:00:00.000Z',
  },
  checkSourceAvailable: async () => true,
  checkRightsEvidenceAvailable: async () => true,
  openStream: async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'content-type': 'audio/mpeg' },
  }),
};

const verifiedPreview: TrackPreviewResolution = {
  state: 'verified_preview',
  albumId,
  trackId,
  source: {
    sourceId: 'preview-source-test',
    albumId,
    trackId,
    completeness: 'preview_excerpt',
    durationSeconds: 40,
    byteLength: 4096,
  },
  rights: {
    evidenceId: 'preview-rights-test',
    albumId,
    trackId,
    grant: 'solco_preview',
    sourceId: 'preview-source-test',
    durationSeconds: 40,
    validFrom: '2026-11-08T11:00:00.000Z',
    validUntil: '2026-11-09T11:00:00.000Z',
  },
  openPreview: async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'content-type': 'audio/mpeg' },
  }),
};

function isPlayable(candidate: unknown) {
  return isVerifiedTrackPlayback(candidate as TrackPlaybackResolution, albumId, trackId, now);
}

describe('verifica della fonte e dei diritti per traccia', () => {
  it('ammette soltanto una risoluzione verificata riferita esattamente ad album e brano', () => {
    expect(isVerifiedTrackPlayback(verified, albumId, trackId, now)).toBe(true);
    expect(isVerifiedTrackPlayback(verified, albumId, '999', now)).toBe(false);
    expect(isVerifiedTrackPlayback(verified, '999', trackId, now)).toBe(false);
  });

  it.each(['unavailable', 'unverified', 'ambiguous'] as const)(
    'nega una risoluzione %s senza restituire un riferimento audio',
    (state) => {
      const result: TrackPlaybackResolution = { state, albumId, trackId };
      expect(isVerifiedTrackPlayback(result, albumId, trackId, now)).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/audio|streamPath|sourceUrl/i);
    },
  );

  it('nega prove mancanti, non complete o riferite a un album o brano diverso', () => {
    expect(isPlayable({ ...verified, checkSourceAvailable: undefined })).toBe(false);
    expect(
      isVerifiedTrackPlayback(
        { ...verified, source: { ...verified.source, sourceId: '' } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
    expect(
      isPlayable({ ...verified, source: { ...verified.source, completeness: 'preview' } }),
    ).toBe(false);
    expect(
      isVerifiedTrackPlayback(
        { ...verified, source: { ...verified.source, trackId: '999' } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
    expect(
      isVerifiedTrackPlayback(
        { ...verified, rights: { ...verified.rights, evidenceId: '' } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
    expect(
      isVerifiedTrackPlayback(
        { ...verified, rights: { ...verified.rights, albumId: '999' } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
    expect(
      isPlayable({ ...verified, rights: { ...verified.rights, grant: 'catalog_metadata' } }),
    ).toBe(false);
  });

  it('nega prove scadute, future o prive di date correnti', () => {
    expect(
      isVerifiedTrackPlayback(
        { ...verified, rights: { ...verified.rights, validUntil: '2026-11-08T11:59:59.999Z' } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
    expect(
      isVerifiedTrackPlayback(
        { ...verified, rights: { ...verified.rights, validFrom: '2026-11-08T12:00:00.001Z' } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
    expect(
      isVerifiedTrackPlayback(
        { ...verified, rights: { ...verified.rights, validUntil: 'non-una-data' } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
  });
});

describe('policy dell’anteprima Free', () => {
  it('accetta soltanto un estratto fino a 40 secondi con fonte e prova per album e brano esatti', () => {
    expect(isVerifiedTrackPreview(verifiedPreview, albumId, trackId, now)).toBe(true);
    expect(isVerifiedTrackPreview(verifiedPreview, albumId, '999', now)).toBe(false);
    expect(isVerifiedTrackPreview(verifiedPreview, '999', trackId, now)).toBe(false);
    expect(
      isVerifiedTrackPreview(
        { ...verifiedPreview, source: { ...verifiedPreview.source, durationSeconds: 40.01 } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
    const fullTrackSource = {
      ...verifiedPreview,
      source: { ...verifiedPreview.source, completeness: 'full_track' },
    } as unknown as TrackPreviewResolution;
    expect(isVerifiedTrackPreview(fullTrackSource, albumId, trackId, now)).toBe(false);
  });

  it('nega prove scadute o incoerenti e risoluzioni non disponibili', () => {
    expect(
      isVerifiedTrackPreview(
        { ...verifiedPreview, rights: { ...verifiedPreview.rights, validUntil: '2026-11-08T11:59:59.999Z' } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
    expect(
      isVerifiedTrackPreview(
        { ...verifiedPreview, rights: { ...verifiedPreview.rights, trackId: '999' } },
        albumId,
        trackId,
        now,
      ),
    ).toBe(false);
    expect(
      isVerifiedTrackPreview({ state: 'unavailable', albumId, trackId }, albumId, trackId, now),
    ).toBe(false);
  });

  it('nega byte-range che iniziano oltre la risorsa autorizzata dell’anteprima', () => {
    expect(resolvePreviewByteRange('bytes=0-39', 40)).toEqual({ start: 0, end: 39 });
    expect(resolvePreviewByteRange('bytes=40-', 40)).toBeNull();
    expect(resolvePreviewByteRange('bytes=0-9,20-29', 40)).toBeNull();
  });
});
