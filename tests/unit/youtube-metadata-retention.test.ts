// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ updateMany: vi.fn().mockResolvedValue({ count: 0 }) }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: { userMusicCollectionItem: { updateMany: mocks.updateMany } },
}));

import {
  expireYouTubeCollectionMetadata,
  YOUTUBE_METADATA_RETENTION_DAYS,
  youtubeMetadataExpiry,
} from '@/lib/music/collections.server';

describe('conservazione dei dati API YouTube', () => {
  it('fissa la scadenza delle raccolte a 29 giorni di calendario dal salvataggio', () => {
    const savedAt = new Date('2026-01-01T03:00:00.000Z');
    expect(YOUTUBE_METADATA_RETENTION_DAYS).toBe(29);
    expect(youtubeMetadataExpiry(savedAt).toISOString()).toBe('2026-01-30T03:00:00.000Z');
  });

  it('rimuove i metadati scaduti ma conserva gli ID video e limita la pulizia a un account', async () => {
    const now = new Date('2026-02-01T00:00:00.000Z');
    await expireYouTubeCollectionMetadata(now, 'account-17');
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        source: 'youtube',
        expiresAt: { lte: now },
        collection: { userId: 'account-17' },
      },
      data: {
        title: null,
        creatorName: null,
        artworkUrl: null,
        sourceUrl: null,
        artistUrl: null,
        durationSeconds: null,
        expiresAt: null,
      },
    });
  });
});
