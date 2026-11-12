// @polsia:user-owned
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  collectionDownloadPlan,
  resolveDownloadableSongs,
} from '@/components/custom/music/offline-download';
import type { MusicCollectionItem } from '@/lib/contracts/music';

function item(
  over: Partial<MusicCollectionItem> & Pick<MusicCollectionItem, 'id' | 'source'>,
): MusicCollectionItem {
  return {
    sourceId: over.id,
    title: null,
    creatorName: null,
    artworkUrl: null,
    sourceUrl: null,
    artistUrl: null,
    durationSeconds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    ...over,
  };
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('collectionDownloadPlan', () => {
  it('classifica audius scaricabile, youtube online-only e brani importati come risolvibili', () => {
    const plan = collectionDownloadPlan([
      item({
        id: 'au',
        source: 'audius',
        sourceId: 'track-1',
        title: 'Open Track',
        creatorName: 'Indie',
        sourceUrl: 'https://audius.co/x',
      }),
      item({ id: 'yt', source: 'youtube', title: 'Video', creatorName: 'Ch' }),
      item({ id: 'sp', source: 'song', title: 'Blinding Lights', creatorName: 'The Weeknd' }),
      item({ id: 'nocreator', source: 'song', title: 'Sconosciuto', creatorName: null }),
    ]);
    expect(plan.downloadable.map((t) => t.id)).toEqual(['au']);
    expect(plan.resolvable).toEqual([{ id: 'sp', title: 'Blinding Lights', artist: 'The Weeknd' }]);
    expect(plan.onlineOnly.map((o) => o.id).sort()).toEqual(['nocreator', 'yt']);
  });
});

describe('resolveDownloadableSongs', () => {
  const songs = [
    { id: 's1', title: 'A', artist: 'X' },
    { id: 's2', title: 'B', artist: 'Y' },
  ];

  it('mappa i brani trovati in bersagli Audius e lascia gli altri tra gli unresolved', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        okJson({
          results: [
            { id: 's1', audiusTrackId: 'audius-1' },
            { id: 's2', audiusTrackId: null },
          ],
        }),
      ),
    );
    const { targets, unresolved } = await resolveDownloadableSongs(songs, { fetcher });
    expect(targets).toEqual([
      { id: 's1', title: 'A', endpoint: { kind: 'audius', trackId: 'audius-1' } },
    ]);
    expect(unresolved.map((s) => s.id)).toEqual(['s2']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('un errore di rete lascia tutto il lotto tra gli unresolved', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error('offline')));
    const { targets, unresolved } = await resolveDownloadableSongs(songs, { fetcher });
    expect(targets).toEqual([]);
    expect(unresolved.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('spezza in lotti sopra il massimo', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      title: `T${i}`,
      artist: 'A',
    }));
    const fetcher = vi.fn<typeof fetch>((_, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        songs: Array<{ id: string }>;
      };
      return Promise.resolve(
        okJson({ results: body.songs.map((s) => ({ id: s.id, audiusTrackId: null })) }),
      );
    });
    const { unresolved } = await resolveDownloadableSongs(many, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2); // 25 + 5
    expect(unresolved).toHaveLength(30);
  });
});
