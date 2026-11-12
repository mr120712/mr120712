// @polsia:user-owned — pagina di un genere: se i brani non si caricano non resta su
// «Caricamento…», ma lo dice con il link a YouTube e il pulsante Riprova.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({ playTrack: vi.fn() }),
  trackStreamPath: () => null,
}));
vi.mock('@/components/custom/music/live-tracks', () => ({
  videoToTrack: (video: unknown) => video,
}));
vi.mock('@/components/custom/music/radio-station-tile', () => ({ StationTile: () => null }));
vi.mock('@/components/custom/music/tiktok-clips', () => ({ TikTokClips: () => null }));
vi.mock('@/components/custom/music/audius-section', () => ({ AudiusSection: () => null }));
vi.mock('@/components/custom/music/jamendo-section', () => ({ JamendoSection: () => null }));
vi.mock('@/components/custom/share-button', () => ({ ShareButton: () => null }));
vi.mock('@/components/custom/music/youtube-video-list', () => ({
  YouTubeVideoList: ({ videos }: { videos: Array<{ title: string }> }) => (
    <ol>
      {videos.map((video) => (
        <li key={video.title}>{video.title}</li>
      ))}
    </ol>
  ),
}));

import { GenreDetail } from '@/components/custom/music/genre-detail';

const genre = {
  slug: 'techno',
  name: 'Techno',
  family: 'electronic' as never,
  query: 'underground techno',
  radioTag: null,
  jamendoTag: null,
  description: 'Techno.',
};

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('pagina di un genere', () => {
  it('se i brani non si caricano lo dice, con link a YouTube e Riprova', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('offline'));
    mocks.apiFetch.mockResolvedValueOnce({
      source: 'youtube',
      outcome: 'results',
      tracks: [],
      artists: [],
      playlists: [],
      albums: [],
      videos: [
        {
          provider: 'youtube',
          videoId: 'abcdefghijk',
          title: 'Brano techno',
          channelTitle: 'Canale',
          channelId: null,
          description: null,
          publishedAt: null,
          thumbnailUrl: null,
        },
      ],
      sourceStatus: {
        id: 'youtube',
        label: 'YouTube',
        active: true,
        searchOutcome: 'results',
        summary: 'YouTube.',
        prerequisite: 'YOUTUBE_DATA_API_KEY',
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<GenreDetail genre={genre} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('Caricamento dei brani…');
    expect(container.textContent).toContain('I brani non si caricano in questo momento.');
    const link = [...container.querySelectorAll<HTMLAnchorElement>('a')].find((item) =>
      item.href.startsWith('https://www.youtube.com/results'),
    );
    expect(link?.href).toBe('https://www.youtube.com/results?search_query=underground+techno');
    const retry = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Riprova'),
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Brano techno');
    expect(document.activeElement?.id).toBe('genre-tracks');
    expect(container.querySelector('output')?.textContent).toBe('1 risultato.');
  });
});
