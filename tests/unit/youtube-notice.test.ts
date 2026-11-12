// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  contractUnavailableReason,
  youtubeSearchLimit,
  youtubeSearchNotice,
  youtubeShareOwner,
} from '@/lib/music/youtube-notice';

describe('avviso della ricerca YouTube', () => {
  it('distingue ricerche personali, ricerche finite per tutti e rallentamenti', () => {
    expect(youtubeSearchLimit('personal_limit')).toBe('personal');
    expect(youtubeSearchLimit('budget_exhausted')).toBe('everyone');
    expect(youtubeSearchLimit('quota_exceeded')).toBe('everyone');
    expect(youtubeSearchLimit('rate_limited')).toBe('busy');
    expect(youtubeSearchLimit('api_error')).toBeNull();
    expect(youtubeSearchLimit(undefined)).toBeNull();
  });

  it('senza accesso la quota finita è della connessione, non della persona', () => {
    expect(youtubeShareOwner('user:abc')).toBe('user');
    expect(youtubeShareOwner('ip:203.0.113.7')).toBe('ip');
    expect(youtubeShareOwner(null)).toBe('user');
    expect(youtubeSearchLimit('personal_limit', 'ip')).toBe('connection');
    expect(youtubeSearchLimit('budget_exhausted', 'ip')).toBe('everyone');
    const now = new Date('2026-11-11T10:00:00Z');
    expect(
      youtubeSearchNotice({ stale: false, fetchedAt: now, blockedBy: 'personal_limit' }, now, 'ip')
        .limit,
    ).toBe('connection');
  });

  it('riduce i motivi ai tre del contratto condiviso', () => {
    expect(contractUnavailableReason('personal_limit')).toBe('quota_exceeded');
    expect(contractUnavailableReason('budget_exhausted')).toBe('quota_exceeded');
    expect(contractUnavailableReason('rate_limited')).toBe('api_error');
    expect(contractUnavailableReason('not_configured')).toBe('not_configured');
    expect(contractUnavailableReason(undefined)).toBeUndefined();
  });

  it('dà la data dei risultati salvati e l’ora di azzeramento della quota', () => {
    const now = new Date('2026-11-11T10:00:00Z');
    const fetchedAt = new Date('2026-11-09T18:00:00Z');
    expect(
      youtubeSearchNotice({ stale: true, fetchedAt, blockedBy: 'budget_exhausted' }, now),
    ).toEqual({
      freshness: 'saved',
      savedAt: fetchedAt.toISOString(),
      limit: 'everyone',
      resetsAt: '2026-11-12T08:00:00.000Z',
    });
    expect(youtubeSearchNotice({ stale: false, fetchedAt: now }, now)).toMatchObject({
      freshness: 'live',
      savedAt: null,
      limit: null,
    });
  });
});
