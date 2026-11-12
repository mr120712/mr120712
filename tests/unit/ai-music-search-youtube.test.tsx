// @polsia:user-owned — "Cerca con l'AI": i video di YouTube non spariscono mai senza spiegazione
// (caricamento, ricerche finite, nessun risultato) e, a ricerche finite, le altre ricerche video
// del piano diventano link alla ricerca di YouTube (nessuna quota).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { YouTubeMusicSearchResponse } from '@/lib/contracts/youtube-search';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/custom/music/audius-section', () => ({ AudiusSection: () => null }));
vi.mock('@/components/custom/music/jamendo-section', () => ({ JamendoSection: () => null }));
vi.mock('@/components/custom/music/radio-station-tile', () => ({ StationTile: () => null }));
vi.mock('@/components/custom/music/youtube-video-list', () => ({
  YouTubeVideoList: ({ videos }: { videos: Array<{ title: string }> }) => (
    <ol>
      {videos.map((video) => (
        <li key={video.title}>{video.title}</li>
      ))}
    </ol>
  ),
}));

import { PlanResults } from '@/components/custom/music/ai-music-search';

const roots: Array<ReturnType<typeof createRoot>> = [];

function blocked(
  limit: NonNullable<YouTubeMusicSearchResponse['youtube']>['limit'],
  reason: 'quota_exceeded' | 'api_error' = 'quota_exceeded',
): YouTubeMusicSearchResponse {
  const response = everyoneOut();
  return {
    ...response,
    sourceStatus: { ...response.sourceStatus, unavailableReason: reason },
    youtube: { ...(response.youtube as NonNullable<typeof response.youtube>), limit },
  };
}

function everyoneOut(): YouTubeMusicSearchResponse {
  return {
    source: 'youtube',
    outcome: 'unavailable',
    tracks: [],
    artists: [],
    playlists: [],
    albums: [],
    videos: [],
    sourceStatus: {
      id: 'youtube',
      label: 'YouTube',
      active: true,
      searchOutcome: 'unavailable',
      unavailableReason: 'quota_exceeded',
      summary: 'YouTube.',
      prerequisite: 'YOUTUBE_DATA_API_KEY',
    },
    youtube: {
      freshness: 'live',
      savedAt: null,
      limit: 'everyone',
      resetsAt: '2026-11-12T08:00:00.000Z',
    },
  };
}

const plan = {
  intro: 'Jazz per la cena.',
  youtubeQueries: ['jazz rilassato', 'bossa nova', 'piano jazz'],
  audioQueries: [],
  radioTags: [],
  podcastQuery: null,
  genres: [],
};

async function mount(withPlan: typeof plan = plan) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<PlanResults plan={withPlan} />));
  return container;
}

const status = (container: HTMLElement) =>
  [...container.querySelectorAll('output')].map((output) => output.textContent);
const retryButton = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Riprova'),
  );

const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].filter((button) =>
    button.textContent?.includes('Mostra i video'),
  );
const youtubeLinks = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLAnchorElement>('a')].filter((link) =>
    link.href.startsWith('https://www.youtube.com/results'),
  );

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Cerca con l’AI: video YouTube', () => {
  it('toccando «Mostra i video» dice che cerca, poi spiega le ricerche finite con il link', async () => {
    let answerFirst: ((value: YouTubeMusicSearchResponse) => void) | undefined;
    mocks.apiFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        answerFirst = resolve;
      }),
    );
    let answerSecond: ((value: YouTubeMusicSearchResponse) => void) | undefined;
    mocks.apiFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        answerSecond = resolve;
      }),
    );
    const container = await mount();
    // The first query runs on its own and says it is searching.
    expect(container.textContent).toContain('Cerco i video per «jazz rilassato»…');
    expect(buttons(container)).toHaveLength(2);

    await act(async () => buttons(container)[0]?.click());
    expect(container.textContent).toContain('Cerco i video per «bossa nova»…');

    await act(async () => {
      answerSecond?.(everyoneOut());
    });
    expect(container.textContent).toContain(
      'Le ricerche YouTube di oggi sono finite per tutti: tornano verso le 9:00.',
    );
    expect(youtubeLinks(container).map((link) => link.href)).toContain(
      'https://www.youtube.com/results?search_query=bossa+nova',
    );
    // The searches are used up: the last query becomes a plain link, not another button.
    expect(buttons(container)).toHaveLength(0);
    expect(youtubeLinks(container).map((link) => link.href)).toContain(
      'https://www.youtube.com/results?search_query=piano+jazz',
    );

    await act(async () => {
      answerFirst?.(everyoneOut());
    });
    expect(youtubeLinks(container).map((link) => link.href)).toContain(
      'https://www.youtube.com/results?search_query=jazz+rilassato',
    );
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });

  it('se la prima ricerca trova le ricerche finite non propone altri video da cercare', async () => {
    mocks.apiFetch.mockResolvedValue(everyoneOut());
    const container = await mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(buttons(container)).toHaveLength(0);
    expect(youtubeLinks(container)).toHaveLength(3);
    expect(mocks.apiFetch).toHaveBeenCalledOnce();
  });

  it('mostrando i video su richiesta sposta il focus sulla sezione e annuncia ogni stato', async () => {
    let answerSecond: ((value: YouTubeMusicSearchResponse) => void) | undefined;
    mocks.apiFetch.mockResolvedValueOnce({ ...everyoneOut(), outcome: 'no_results' });
    mocks.apiFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        answerSecond = resolve;
      }),
    );
    const container = await mount();
    const button = buttons(container)[0];
    button?.focus();
    await act(async () => button?.click());
    // The button is gone: the focus is on the new section's heading, not lost on <body>.
    expect(document.activeElement?.tagName).toBe('H3');
    expect(document.activeElement?.textContent).toBe('Video · bossa nova');
    expect(status(container)).toContain('Cerco i video per «bossa nova»…');
    await act(async () => {
      answerSecond?.(everyoneOut());
    });
    expect(status(container).join(' ')).toContain('Le ricerche YouTube di oggi sono finite');
    expect(status(container)).toContain('Nessun video per «jazz rilassato».');
  });

  it('se YouTube è occupato o i video non si caricano offre «Riprova»', async () => {
    vi.useFakeTimers();
    mocks.apiFetch.mockResolvedValueOnce(blocked('busy', 'api_error'));
    mocks.apiFetch.mockRejectedValueOnce(new Error('offline'));
    mocks.apiFetch.mockResolvedValueOnce({ ...everyoneOut(), outcome: 'no_results' });
    const container = await mount({ ...plan, youtubeQueries: ['jazz rilassato'] });
    expect(container.textContent).toContain('YouTube è momentaneamente occupato');
    // Disabled for a moment: a quick second try would fail the same way.
    expect(retryButton(container)?.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(15_000));
    await act(async () => retryButton(container)?.click());
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(document.activeElement?.textContent).toBe('Video · jazz rilassato');
    expect(container.textContent).toContain('non si caricano in questo momento');
    await act(async () => vi.advanceTimersByTime(15_000));
    await act(async () => retryButton(container)?.click());
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('Nessun video per «jazz rilassato».');
  });

  it('senza accesso, a ricerche della connessione finite offre «Accedi»', async () => {
    mocks.apiFetch.mockResolvedValue(blocked('connection'));
    const container = await mount({ ...plan, youtubeQueries: ['jazz rilassato'] });
    const signIn = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent === 'Accedi',
    );
    expect(signIn?.getAttribute('href')).toBe(
      `/login?callbackURL=${encodeURIComponent('/search?q=jazz%20rilassato')}`,
    );
  });

  it('il pulsante per una ricerca lunga non allarga la pagina: il testo finisce con «…»', async () => {
    mocks.apiFetch.mockReturnValue(new Promise(() => {}));
    const long = 'Nujabes Fat Jon Uyama Hiroto lo-fi hip hop giapponese per studiare di notte';
    const container = await mount({ ...plan, youtubeQueries: ['jazz', long] });
    const button = buttons(container)[0];
    expect(button?.className).toContain('min-w-0');
    expect(button?.className).toContain('max-w-full');
    expect(button?.querySelector('span.truncate')?.textContent).toBe(
      `Mostra i video per «${long}»`,
    );
  });

  it('se i video non si caricano lo dice, con il link a YouTube', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('offline'));
    const container = await mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      'I video per «jazz rilassato» non si caricano in questo momento.',
    );
    expect(youtubeLinks(container)).toHaveLength(1);
  });
});
