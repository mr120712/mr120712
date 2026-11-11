// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { fetchYouTubePlaylist, parsePlaylistId } from '@/lib/music/youtube-playlist-import.server';

const listId = 'PLabcdefghij1234567890';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('import playlist YouTube', () => {
  it('riconosce link e ID di playlist', () => {
    expect(parsePlaylistId(`https://www.youtube.com/playlist?list=${listId}`)).toBe(listId);
    expect(parsePlaylistId(`https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=${listId}`)).toBe(
      listId,
    );
    expect(parsePlaylistId(listId)).toBe(listId);
    expect(parsePlaylistId(`https://evil.example.com/playlist?list=${listId}`)).toBeNull();
    expect(parsePlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('legge titolo e video, saltando duplicati e video non disponibili', async () => {
    const item = (videoId: string, title: string, owner?: string) => ({
      contentDetails: { videoId },
      snippet: {
        title,
        videoOwnerChannelTitle: owner,
        thumbnails: { medium: { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` } },
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [{ snippet: { title: 'Mix estivo' } }] }))
      .mockResolvedValueOnce(
        json({
          items: [
            item('aaaaaaaaaaa', 'Primo', 'Canale A'),
            item('aaaaaaaaaaa', 'Primo', 'Canale A'),
            item('bbbbbbbbbbb', 'Private video'),
          ],
          nextPageToken: 'p2',
        }),
      )
      .mockResolvedValueOnce(json({ items: [item('ccccccccccc', 'Terzo', 'Canale C')] }));
    const result = await fetchYouTubePlaylist(listId, 'key', fetcher as unknown as typeof fetch);
    expect(result.title).toBe('Mix estivo');
    expect(result.videos.map((video) => [video.videoId, video.channelTitle])).toEqual([
      ['aaaaaaaaaaa', 'Canale A'],
      ['ccccccccccc', 'Canale C'],
    ]);
    expect(result.skipped).toBe(2);
    expect(String(fetcher.mock.calls[2]?.[0])).toContain('pageToken=p2');
  });

  it('segnala quota esaurita e playlist mancanti', async () => {
    const quota = vi
      .fn()
      .mockResolvedValue(json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403));
    await expect(
      fetchYouTubePlaylist(listId, 'key', quota as unknown as typeof fetch),
    ).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    const missing = vi.fn().mockResolvedValue(json({ items: [] }));
    await expect(
      fetchYouTubePlaylist(listId, 'key', missing as unknown as typeof fetch),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      fetchYouTubePlaylist(listId, '', missing as unknown as typeof fetch),
    ).rejects.toMatchObject({
      code: 'not_configured',
    });
  });
});
