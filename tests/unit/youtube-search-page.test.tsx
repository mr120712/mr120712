// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { YouTubeMusicSearchResponse } from '@/lib/contracts/youtube-search';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/custom/music/ai-music-search', () => ({ AiMusicSearch: () => null }));
vi.mock('@/components/custom/music/listen-in-solco', () => ({ ListenInSolco: () => null }));
vi.mock('@/components/custom/music/search-extras', () => ({ SearchExtras: () => null }));
vi.mock('@/components/custom/music/audius-section', () => ({
  AudiusSection: ({ query }: { query: string }) => <p>Audius: {query}</p>,
}));
vi.mock('@/components/custom/music/youtube-video-list', () => ({
  YouTubeVideoList: ({ videos }: { videos: Array<{ title: string }> }) => (
    <ol>
      {videos.map((video) => (
        <li key={video.title}>{video.title}</li>
      ))}
    </ol>
  ),
}));

import {
  describeYouTubeSearch,
  YOUTUBE_RETRY_DELAY_MS,
} from '@/components/custom/music/youtube-search-notice';
import { YouTubeSearchPage } from '@/components/custom/music/youtube-search-page';

const RESETS_AT = '2026-11-12T08:00:00.000Z';
const roots: Array<ReturnType<typeof createRoot>> = [];

function response(
  overrides: Partial<YouTubeMusicSearchResponse> & {
    limit?: 'personal' | 'connection' | 'everyone' | 'busy' | null;
    savedAt?: string | null;
  } = {},
): YouTubeMusicSearchResponse {
  const { limit = null, savedAt = null, ...rest } = overrides;
  return {
    source: 'youtube',
    outcome: 'results',
    tracks: [],
    artists: [],
    playlists: [],
    albums: [],
    videos: [],
    sourceStatus: {
      id: 'youtube',
      label: 'YouTube',
      active: true,
      searchOutcome: 'results',
      summary: 'YouTube.',
      prerequisite: 'YOUTUBE_DATA_API_KEY',
    },
    youtube: {
      freshness: savedAt ? 'saved' : 'live',
      savedAt,
      limit,
      resetsAt: RESETS_AT,
    },
    ...rest,
  };
}

const video = {
  provider: 'youtube' as const,
  videoId: 'dQw4w9WgXcQ',
  title: 'Caruso',
  channelTitle: 'Lucio Dalla',
  channelId: null,
  description: null,
  publishedAt: null,
  thumbnailUrl: null,
};

function blocked(limit: 'personal' | 'connection' | 'everyone' | 'busy' | null) {
  return response({
    outcome: 'unavailable',
    limit,
    sourceStatus: {
      id: 'youtube',
      label: 'YouTube',
      active: true,
      searchOutcome: 'unavailable',
      unavailableReason:
        limit === 'personal' || limit === 'connection' || limit === 'everyone'
          ? 'quota_exceeded'
          : 'api_error',
      summary: 'YouTube.',
      prerequisite: 'YOUTUBE_DATA_API_KEY',
    },
  });
}

async function mount(query: string) {
  const container = document.createElement('div');
  // Attached, so focus can move inside it.
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<YouTubeSearchPage initialQuery={query} />));
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function retryButton(container: HTMLElement) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Riprova'),
  );
}

function linkOut(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
    link.href.startsWith('https://www.youtube.com/results'),
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('pagina Cerca quando YouTube non risponde in tempo reale', () => {
  it('mostra i risultati salvati con etichetta, data, ora di ripresa e link a YouTube', async () => {
    mocks.apiFetch.mockResolvedValue(
      response({ videos: [video], limit: 'everyone', savedAt: '2026-11-10T08:00:00.000Z' }),
    );
    const container = await mount('lucio dalla');
    // The date is said once, without calling a weeks-old result "recent".
    expect(container.textContent).toContain('Risultati salvati il 10 novembre');
    expect(container.textContent).not.toContain('di recente');
    expect(container.textContent).toContain(
      'La ricerca YouTube in tempo reale torna verso le 9:00.',
    );
    expect(container.textContent?.match(/10 novembre/g)).toHaveLength(2); // label + status line
    expect(container.textContent).toContain('Caruso');
    const link = linkOut(container);
    expect(link?.href).toBe('https://www.youtube.com/results?search_query=lucio+dalla');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(link?.textContent).toContain('(si apre in una nuova scheda)');
    expect(container.textContent).not.toContain('esaurite');
  });

  it('distingue le ricerche personali finite, con link a YouTube e brani Audius', async () => {
    mocks.apiFetch.mockResolvedValue(blocked('personal'));
    const container = await mount('mina');
    expect(container.textContent).toContain(
      'Hai usato le tue ricerche YouTube di oggi: tornano verso le 9:00.',
    );
    expect(container.textContent).toContain('Audius: mina');
    expect(linkOut(container)).toBeDefined();
    expect(container.textContent).not.toContain('Riprova');
  });

  it('dice quando le ricerche sono finite per tutti, con classifiche e generi', async () => {
    mocks.apiFetch.mockResolvedValue(blocked('everyone'));
    const container = await mount('mina');
    expect(container.textContent).toContain(
      'Le ricerche YouTube di oggi sono finite per tutti: tornano verso le 9:00.',
    );
    expect(linkOut(container)).toBeDefined();
    const hrefs = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/#tendenze');
    expect(hrefs).toContain('/generi');
  });

  it('senza accesso non dice "le tue" ricerche: sono quelle della connessione', async () => {
    mocks.apiFetch.mockResolvedValue(blocked('connection'));
    const container = await mount('mina');
    expect(container.textContent).toContain(
      'Le ricerche YouTube per questa connessione sono finite per oggi: tornano verso le 9:00. Accedi per avere le tue.',
    );
    expect(container.textContent).not.toContain('Hai usato');
  });

  it('un rallentamento di YouTube propone di riprovare (dopo una breve attesa) e ripete la ricerca', async () => {
    vi.useFakeTimers();
    try {
      mocks.apiFetch.mockResolvedValueOnce(blocked('busy'));
      mocks.apiFetch.mockResolvedValueOnce(response({ videos: [video] }));
      const container = await mount('mina');
      expect(container.textContent).toContain(
        'YouTube è momentaneamente occupato, riprova tra poco.',
      );
      const retry = retryButton(container);
      // A second try straight away would fail the same way and cost another search.
      expect(retry?.disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(YOUTUBE_RETRY_DELAY_MS);
      });
      expect(retry?.disabled).toBe(false);
      await act(async () => {
        retry?.click();
        await Promise.resolve();
      });
      expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('Caruso');
      expect(container.textContent).not.toContain('salvati');
      // The button is gone: the focus stays in the section, on its heading.
      expect(document.activeElement?.id).toBe('videos-heading');
    } finally {
      vi.useRealTimers();
    }
  });

  it('risultati salvati con YouTube occupato: c’è il pulsante Riprova', async () => {
    mocks.apiFetch.mockResolvedValue(
      response({ videos: [video], limit: 'busy', savedAt: '2026-11-10T08:00:00.000Z' }),
    );
    const container = await mount('mina');
    expect(container.textContent).toContain('Riprova tra poco.');
    expect(retryButton(container)).toBeDefined();
  });

  it('se la ricerca non riesce offre Riprova e il link a YouTube', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('offline'));
    mocks.apiFetch.mockResolvedValueOnce(response({ videos: [video] }));
    const container = await mount('mina');
    expect(container.textContent).toContain('La ricerca non è riuscita. Riprova tra poco.');
    expect(linkOut(container)).toBeDefined();
    await act(async () => {
      retryButton(container)?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Caruso');
  });

  it('annuncia ogni cambiamento in una riga di stato sempre presente', async () => {
    mocks.apiFetch.mockResolvedValue(blocked('everyone'));
    const container = await mount('mina');
    const status = container.querySelector('output');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('Le ricerche YouTube di oggi sono finite per tutti');
    // The notice box itself is not a live region (it appears together with its text).
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('risultati in tempo reale: nessun avviso', async () => {
    mocks.apiFetch.mockResolvedValue(response({ videos: [video] }));
    const container = await mount('caruso');
    expect(container.textContent).toContain('Caruso');
    expect(container.textContent).not.toContain('salvati');
    expect(linkOut(container)).toBeUndefined();
  });
});

describe('describeYouTubeSearch', () => {
  it('senza avviso dal server calcola comunque l’ora di ripresa', () => {
    const state = describeYouTubeSearch(
      { ...blocked('everyone'), youtube: undefined },
      new Date('2026-03-10T12:00:00Z'),
    );
    // US already on summer time, Italy not yet: the quota resets at 8:00 Italian time.
    expect(state).toMatchObject({ kind: 'blocked', retry: false });
    expect(state.kind === 'blocked' && state.text).toContain('tornano verso le 8:00');
  });

  it('distingue nessun risultato da ricerca bloccata', () => {
    expect(describeYouTubeSearch(response({ outcome: 'no_results' }))).toEqual({
      kind: 'no_results',
    });
    expect(describeYouTubeSearch(blocked(null))).toMatchObject({ kind: 'blocked', retry: true });
  });

  it('su una pagina di genere non dice che le ricerche sono finite per tutti', () => {
    const state = describeYouTubeSearch(blocked('everyone'), new Date(), 'genre');
    expect(state).toMatchObject({ kind: 'blocked', quotaOut: true });
    expect(state.kind === 'blocked' && state.text).toContain('I brani YouTube di questo genere');
    expect(state.kind === 'blocked' && state.text).not.toContain('per tutti');
  });
});
