// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getAudiusPlaybackReasonText } from '@/lib/music/audius';
import {
  isOfflineAvailable,
  isOfflineDownloadable,
  OFFLINE_INELIGIBLE_REASONS,
  offlineEligibility,
} from '@/lib/music/offline-eligibility';

describe('offlineEligibility', () => {
  it('tratta i file locali come già offline', () => {
    expect(offlineEligibility({ source: 'local' })).toEqual({ kind: 'local' });
  });

  it('consente il download Audius solo se scaricabile E riproducibile sotto la licenza aperta', () => {
    expect(
      offlineEligibility({ source: 'audius', isDownloadable: true, playbackEligible: true }),
    ).toEqual({ kind: 'audius-download' });
  });

  it('nega un brano Audius riproducibile ma non reso scaricabile dall’artista', () => {
    expect(
      offlineEligibility({ source: 'audius', isDownloadable: false, playbackEligible: true }),
    ).toEqual({ kind: 'online-only', reason: OFFLINE_INELIGIBLE_REASONS.audiusNotDownloadable });
  });

  it('nega un brano Audius con licenza non aperta, anche se segnato scaricabile', () => {
    expect(
      offlineEligibility({
        source: 'audius',
        isDownloadable: true,
        playbackEligible: false,
        playbackReason: 'license_not_allowed',
      }),
    ).toEqual({ kind: 'online-only', reason: OFFLINE_INELIGIBLE_REASONS.audiusLicense });
  });

  it('riusa la spiegazione Audius tradotta per gli altri motivi di non riproducibilità', () => {
    expect(
      offlineEligibility({
        source: 'audius',
        isDownloadable: true,
        playbackEligible: false,
        playbackReason: 'gated',
      }),
    ).toEqual({ kind: 'online-only', reason: getAudiusPlaybackReasonText('gated') });
  });

  it('usa una nota generica quando il motivo Audius non è noto', () => {
    expect(
      offlineEligibility({ source: 'audius', isDownloadable: true, playbackEligible: false }),
    ).toEqual({ kind: 'online-only', reason: OFFLINE_INELIGIBLE_REASONS.audiusUnavailable });
  });

  it('consente il download degli episodi podcast (enclosure RSS)', () => {
    expect(offlineEligibility({ source: 'podcast' })).toEqual({ kind: 'podcast-download' });
    expect(offlineEligibility({ source: 'podcast', hasEnclosure: true })).toEqual({
      kind: 'podcast-download',
    });
    expect(offlineEligibility({ source: 'podcast', hasEnclosure: false })).toEqual({
      kind: 'online-only',
      reason: OFFLINE_INELIGIBLE_REASONS.podcastNoAudio,
    });
  });

  it('non scarica mai da YouTube, radio, Jamendo o dai brani importati', () => {
    expect(offlineEligibility({ source: 'youtube' })).toEqual({
      kind: 'online-only',
      reason: OFFLINE_INELIGIBLE_REASONS.youtube,
    });
    expect(offlineEligibility({ source: 'radio' })).toEqual({
      kind: 'online-only',
      reason: OFFLINE_INELIGIBLE_REASONS.radio,
    });
    expect(offlineEligibility({ source: 'jamendo' })).toEqual({
      kind: 'online-only',
      reason: OFFLINE_INELIGIBLE_REASONS.jamendo,
    });
    expect(offlineEligibility({ source: 'song' })).toEqual({
      kind: 'online-only',
      reason: OFFLINE_INELIGIBLE_REASONS.song,
    });
  });

  it('classifica gli esiti con i predicati di comodo', () => {
    expect(isOfflineAvailable({ kind: 'local' })).toBe(true);
    expect(isOfflineAvailable({ kind: 'audius-download' })).toBe(true);
    expect(isOfflineAvailable({ kind: 'podcast-download' })).toBe(true);
    expect(isOfflineAvailable({ kind: 'online-only', reason: 'x' })).toBe(false);

    expect(isOfflineDownloadable({ kind: 'audius-download' })).toBe(true);
    expect(isOfflineDownloadable({ kind: 'podcast-download' })).toBe(true);
    expect(isOfflineDownloadable({ kind: 'local' })).toBe(false);
    expect(isOfflineDownloadable({ kind: 'online-only', reason: 'x' })).toBe(false);
  });
});
