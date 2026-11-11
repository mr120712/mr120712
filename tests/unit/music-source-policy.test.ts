// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  AUDIUS_PREREQUISITE,
  sourceStatus,
  withSourceSearchOutcomes,
  YOUTUBE_PREREQUISITE,
} from '@/lib/music/source-policy';

describe('stato delle fonti musicali Solco', () => {
  it('riporta Audius come non configurata solo quando manca la chiave server-side', () => {
    const missing = sourceStatus({
      id: 'audius',
      active: false,
      outcome: 'unavailable',
      unavailableReason: 'not_configured',
      blockers: ['credential_missing'],
    });
    const configured = sourceStatus({ id: 'audius', active: true, outcome: 'results' });

    expect(missing).toMatchObject({
      active: false,
      searchOutcome: 'unavailable',
      unavailableReason: 'not_configured',
      blockers: ['credential_missing'],
    });
    expect(missing.summary).toContain('AUDIUS_API_KEY');
    expect(AUDIUS_PREREQUISITE).toContain('AUDIUS_API_KEY');
    expect(configured).toMatchObject({ active: true, searchOutcome: 'results', blockers: [] });
  });

  it('distingue una chiave YouTube assente da quota e errore reale', () => {
    const missing = sourceStatus({
      id: 'youtube',
      active: false,
      unavailableReason: 'not_configured',
      youtubeConfigured: false,
    });
    const quota = sourceStatus({
      id: 'youtube',
      active: true,
      outcome: 'unavailable',
      unavailableReason: 'quota_exceeded',
      youtubeConfigured: true,
    });
    const apiError = sourceStatus({
      id: 'youtube',
      active: true,
      outcome: 'unavailable',
      unavailableReason: 'api_error',
      youtubeConfigured: true,
    });

    expect(missing).toMatchObject({
      active: false,
      searchOutcome: 'inactive',
      unavailableReason: 'not_configured',
    });
    expect(missing.prerequisite).toContain('YOUTUBE_DATA_API_KEY');
    expect(quota).toMatchObject({
      searchOutcome: 'unavailable',
      unavailableReason: 'quota_exceeded',
    });
    expect(apiError).toMatchObject({
      searchOutcome: 'unavailable',
      unavailableReason: 'api_error',
    });
    expect(JSON.stringify([missing, quota, apiError])).not.toContain('test-key');
  });

  it('espone solo Audius e YouTube', () => {
    const statuses = withSourceSearchOutcomes(
      { audius: 'inactive', youtube: 'no_results' },
      { audiusActive: false, youtubeConfigured: true },
    );
    expect(statuses.map((item) => item.id)).toEqual(['audius', 'youtube']);
    expect(statuses[0]).toMatchObject({ label: 'Solco', active: false, searchOutcome: 'inactive' });
    expect(statuses[1]).toMatchObject({
      label: 'YouTube',
      active: true,
      searchOutcome: 'no_results',
    });
    expect(YOUTUBE_PREREQUISITE).toContain('YOUTUBE_DATA_API_KEY');
  });
});
