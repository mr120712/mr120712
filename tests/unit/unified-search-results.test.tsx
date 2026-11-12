// @polsia:user-owned — Cerca unificata (client): mentre si digita si cercano Audius + radio +
// podcast SENZA toccare YouTube; all'invio si aggiunge YouTube una sola volta. L'elenco è misto,
// deduplicato e filtrabile; ogni riga suona nel player; quando la quota YouTube è finita resta
// l'avviso con il link «Cerca su YouTube» e le altre fonti.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub forwards whatever the component passes.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: 'idle',
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
  trackStreamPath: (track: { qualifiedId: string }) => `/stream/${track.qualifiedId}`,
}));
vi.mock('@/components/custom/music/fallback-art', () => ({ FallbackArt: () => null }));
vi.mock('@/components/custom/music/ai-music-search', () => ({ AiMusicSearch: () => null }));
vi.mock('@/components/custom/music/listen-in-solco', () => ({ ListenInSolco: () => null }));

import { UnifiedSearchResults } from '@/components/custom/music/unified-search-results';

const RESETS_AT = '2026-11-12T08:00:00.000Z';

const audiusTrack = {
  provider: 'audius',
  id: 'abc123',
  qualifiedId: 'audius:abc123',
  title: 'Caruso',
  artistName: 'Lucio Dalla',
  artistHandle: 'luciodalla',
  artistId: 'art1',
  artistQualifiedId: 'audius:art1',
  artistUrl: 'https://audius.co/luciodalla',
  trackUrl: 'https://audius.co/luciodalla/caruso',
  artworkUrl: 'https://example.com/caruso.jpg',
  durationSeconds: 215,
  genre: null,
  mood: null,
  tags: null,
  releaseDate: null,
  license: null,
  licensorName: null,
  copyrightNotice: null,
  producerCopyrightNotice: null,
  attributionRemovalRequested: false,
  attributionComplete: true,
  playbackEligible: true,
  playbackReason: 'ready',
};
// Lo stesso brano su YouTube: alternativa secondaria del brano Audius, mai una riga a sé.
const altVideo = {
  provider: 'youtube',
  videoId: 'alt1111alt1',
  title: 'Lucio Dalla - Caruso (Official)',
  channelTitle: 'Lucio Dalla',
  channelId: null,
  description: null,
  publishedAt: null,
  thumbnailUrl: null,
};
// Un video YouTube distinto: una riga propria.
const soloVideo = {
  provider: 'youtube',
  videoId: 'solo2222sol',
  title: 'Caruso Karaoke',
  channelTitle: 'KaraokeFun',
  channelId: null,
  description: null,
  publishedAt: null,
  thumbnailUrl: null,
};
const station = {
  id: 'radio1',
  name: 'Radio Caruso',
  artworkUrl: null,
  country: 'Italia',
  countryCode: 'IT',
  tags: ['napoletana'],
  codec: null,
  bitrate: null,
  homepage: null,
  votes: 0,
};
const podcast = {
  id: '99',
  title: 'Storie di Caruso',
  author: 'RAI',
  artworkUrl: null,
  genre: null,
};

const audiusEntry = {
  kind: 'audius',
  key: 'audius:abc123',
  score: 100,
  track: audiusTrack,
  youtubeAlternative: null,
};
const radioEntry = { kind: 'radio', key: 'radio:radio1', score: 40, station };
const podcastEntry = { kind: 'podcast', key: 'podcast:99', score: 40, podcast };

// Mentre si digita: niente YouTube (status skipped), Audius + radio + podcast.
const typingResponse = {
  query: 'caruso',
  youtubeRequested: false,
  results: [audiusEntry, radioEntry, podcastEntry],
  sources: {
    audius: { status: 'results', tracks: [audiusTrack], artists: [], playlists: [], albums: [] },
    youtube: { status: 'skipped', videos: [] },
    radio: { status: 'results', stations: [station] },
    podcasts: { status: 'results', podcasts: [podcast] },
  },
};

// All'invio: YouTube in tempo reale, brano Audius deduplicato (porta altVideo) + un video a sé.
const withYouTube = {
  query: 'caruso',
  youtubeRequested: true,
  results: [
    {
      kind: 'audius',
      key: 'audius:abc123',
      score: 100,
      track: audiusTrack,
      youtubeAlternative: altVideo,
    },
    { kind: 'youtube', key: 'youtube:solo2222sol', score: 70, video: soloVideo },
    radioEntry,
    podcastEntry,
  ],
  sources: {
    audius: { status: 'results', tracks: [audiusTrack], artists: [], playlists: [], albums: [] },
    youtube: { status: 'results', videos: [altVideo, soloVideo] },
    radio: { status: 'results', stations: [station] },
    podcasts: { status: 'results', podcasts: [podcast] },
  },
  youtube: { freshness: 'live', savedAt: null, limit: null, resetsAt: RESETS_AT },
};

// All'invio con quota YouTube finita per tutti: nessun video, le altre fonti restano.
const quotaOut = {
  query: 'caruso',
  youtubeRequested: true,
  results: [audiusEntry, radioEntry, podcastEntry],
  sources: {
    audius: { status: 'results', tracks: [audiusTrack], artists: [], playlists: [], albums: [] },
    youtube: { status: 'unavailable', videos: [] },
    radio: { status: 'results', stations: [station] },
    podcasts: { status: 'results', podcasts: [podcast] },
  },
  youtube: { freshness: 'live', savedAt: null, limit: 'everyone', resetsAt: RESETS_AT },
};

const roots: Array<ReturnType<typeof createRoot>> = [];

/** Risposte per modalità: senza consenso (digitazione) vs con consenso (invio). */
function respondWith(onSubmit: unknown, onType: unknown = typingResponse) {
  mocks.apiFetch.mockImplementation((url: string) =>
    Promise.resolve(url.includes('youtubeConsent=accepted') ? onSubmit : onType),
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(initialQuery: string) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<UnifiedSearchResults initialQuery={initialQuery} />));
  await flush();
  return container;
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector('form');
  return act(async () => {
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function rows(container: HTMLElement) {
  return [...container.querySelectorAll('ol li')];
}

function button(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function chip(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('fieldset button')].find((b) =>
    b.textContent?.startsWith(label),
  );
}

function urlCalls() {
  return mocks.apiFetch.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.playTrack.mockReset();
  mocks.togglePlayback.mockReset();
  mocks.replace.mockReset();
  respondWith(withYouTube);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Cerca unificata: digitazione vs invio', () => {
  it('mentre si digita cerca Audius + radio + podcast senza NESSUNA richiesta a YouTube', async () => {
    vi.useFakeTimers();
    respondWith(withYouTube, typingResponse);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<UnifiedSearchResults initialQuery="" />));

    const input = container.querySelector<HTMLInputElement>('#unified-query');
    if (!input) throw new Error('input assente');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(input, 'caruso');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Nessuna richiesta parte durante la digitazione finché non scatta l'attesa (debounce).
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    // Il punto critico: nessuna chiamata porta il consenso YouTube.
    expect(urlCalls().every((url) => !url.includes('youtubeConsent'))).toBe(true);
    expect(container.textContent).toContain('Caruso');
    expect(container.textContent).toContain('Radio Caruso');
    expect(container.textContent).toContain('Storie di Caruso');
  });

  it("all'invio aggiunge YouTube (una sola richiesta con il consenso) e mostra il video", async () => {
    respondWith(withYouTube, typingResponse);
    const container = await mount('caruso');
    // La ricerca iniziale (deep link) non tocca YouTube.
    expect(urlCalls()).toHaveLength(1);
    expect(urlCalls()[0]).not.toContain('youtubeConsent');

    await submitForm(container);
    await flush();

    const ytCalls = urlCalls().filter((url) => url.includes('youtubeConsent=accepted'));
    expect(ytCalls).toHaveLength(1);
    expect(mocks.replace).toHaveBeenCalled();
    // Il video YouTube distinto compare come riga propria.
    expect(container.textContent).toContain('Caruso Karaoke');
    // Risultati in tempo reale: nessun avviso di quota.
    expect(container.textContent).not.toContain('finite');
  });

  it("l'invio di un termine appena digitato aggiunge YouTube anche dopo la navigazione che cambia initialQuery", async () => {
    respondWith(withYouTube, typingResponse);
    // Deep link iniziale su un termine diverso: parte in modalità digitazione (niente YouTube).
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<UnifiedSearchResults initialQuery="mozart" />));
    await flush();

    // L'utente riscrive il campo con un termine nuovo e invia.
    const input = container.querySelector<HTMLInputElement>('#unified-query');
    if (!input) throw new Error('input assente');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(input, 'caruso');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submitForm(container);
    await flush();

    // La navigazione reale (router.replace, qui mockato come no-op) cambia il prop initialQuery →
    // 'caruso': la simuliamo ri-renderizzando lo STESSO componente (nessun key, stato conservato) con
    // il nuovo prop, come fa Next quando il Server Component rilegge searchParams. Senza il fix,
    // l'effetto di reset azzererebbe il consenso e YouTube sparirebbe (o lampeggerebbe e sparirebbe).
    await act(async () => root.render(<UnifiedSearchResults initialQuery="caruso" />));
    await flush();

    // Una sola chiamata con il consenso: la navigazione non ne ha aggiunta un'altra né cancellata quella.
    const ytCalls = urlCalls().filter((url) => url.includes('youtubeConsent=accepted'));
    expect(ytCalls).toHaveLength(1);
    // Il video YouTube distinto resta nell'elenco (non sostituito da una risposta senza YouTube).
    expect(container.textContent).toContain('Caruso Karaoke');
  });
});

describe('Cerca unificata: quota YouTube finita', () => {
  it("mostra l'avviso, il link «Cerca su YouTube» e tiene le altre fonti", async () => {
    respondWith(quotaOut, typingResponse);
    const container = await mount('caruso');
    await submitForm(container);
    await flush();

    expect(container.textContent).toContain(
      'Le ricerche YouTube di oggi sono finite per tutti: tornano verso le 9:00.',
    );
    const linkOut = [...container.querySelectorAll<HTMLAnchorElement>('a')].find((a) =>
      a.href.startsWith('https://www.youtube.com/results'),
    );
    expect(linkOut?.href).toBe('https://www.youtube.com/results?search_query=caruso');
    // Le altre fonti restano nell'elenco.
    expect(container.textContent).toContain('Caruso');
    expect(container.textContent).toContain('Radio Caruso');
    expect(container.textContent).toContain('Storie di Caruso');
  });
});

describe('Cerca unificata: riproduzione e deduplica', () => {
  it('una riga per ogni fonte agisce: brano, video e radio suonano nel player, il podcast apre la scheda', async () => {
    respondWith(withYouTube, typingResponse);
    const container = await mount('caruso');
    await submitForm(container);
    await flush();

    // Audius → player.
    await act(async () => {
      button(container, 'Riproduci Caruso')?.click();
    });
    // YouTube → player.
    await act(async () => {
      button(container, 'Riproduci Caruso Karaoke')?.click();
    });
    // Radio → player.
    await act(async () => {
      button(container, 'Ascolta Radio Caruso in diretta')?.click();
    });

    const played = mocks.playTrack.mock.calls.map(
      (call) => (call[0] as { qualifiedId: string }).qualifiedId,
    );
    expect(played).toContain('audius:abc123');
    expect(played).toContain('youtube:solo2222sol');
    expect(played).toContain('radio:radio1');
    // Ogni avvio passa il percorso di streaming e una coda.
    for (const call of mocks.playTrack.mock.calls) {
      expect(typeof call[1]).toBe('string');
      expect(Array.isArray(call[2])).toBe(true);
    }
    // Podcast: nessuna riproduzione diretta, ma la scheda è raggiungibile.
    expect(container.querySelector('a[href="/podcasts/99"]')).not.toBeNull();
  });

  it('un brano presente su Audius e YouTube compare una sola volta, con «Ascolta su YouTube» come azione secondaria', async () => {
    respondWith(withYouTube, typingResponse);
    const container = await mount('caruso');
    await submitForm(container);
    await flush();

    // 4 risultati = 1 Audius (+ alternativa) + 1 YouTube a sé + 1 radio + 1 podcast: l'alternativa
    // NON è una quinta riga.
    expect(rows(container)).toHaveLength(4);
    // L'azione secondaria suona il video alternativo (youtube:<id>), senza una riga separata.
    const secondary = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Ascolta su YouTube'),
    );
    expect(secondary).toBeDefined();
    await act(async () => {
      secondary?.click();
    });
    const played = mocks.playTrack.mock.calls.map(
      (call) => (call[0] as { qualifiedId: string }).qualifiedId,
    );
    expect(played).toEqual(['youtube:alt1111alt1']);
  });

  it('ogni riga Audius porta la nota di licenza OML (link alla licenza e al brano)', async () => {
    respondWith(withYouTube, typingResponse);
    const container = await mount('caruso');
    await submitForm(container);
    await flush();

    // Come nella ricerca per fonte: un brano Audius non viene mai mostrato/riprodotto senza la nota
    // di licenza OML §1.5 (link alla licenza + link al brano su Audius).
    expect(container.textContent).toContain('Audius Open Music License');
    const trackLink = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(
      (a) => a.getAttribute('href') === 'https://audius.co/luciodalla/caruso',
    );
    expect(trackLink).toBeDefined();
  });

  it("la riga podcast ha un'unica destinazione principale: niente link sulla copertina", async () => {
    respondWith(withYouTube, typingResponse);
    const container = await mount('caruso');
    await submitForm(container);
    await flush();

    // La copertina non è più un link ("Apri il podcast …"): resta il titolo + una sola azione in coda.
    expect(container.querySelector('a[aria-label^="Apri il podcast"]')).toBeNull();
    expect(container.querySelectorAll('a[href="/podcasts/99"]')).toHaveLength(2);
  });
});

describe('Cerca unificata: chip-filtro', () => {
  it('restringono lo stesso elenco a Brani / Radio / Podcast e tornano a Tutto', async () => {
    respondWith(withYouTube, typingResponse);
    const container = await mount('caruso');
    await submitForm(container);
    await flush();

    expect(rows(container)).toHaveLength(4);

    await act(async () => {
      chip(container, 'Radio')?.click();
    });
    expect(rows(container)).toHaveLength(1);
    expect(container.textContent).toContain('Radio Caruso');
    expect(chip(container, 'Radio')?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      chip(container, 'Brani')?.click();
    });
    // Brani = Audius + YouTube.
    expect(rows(container)).toHaveLength(2);

    await act(async () => {
      chip(container, 'Podcast')?.click();
    });
    expect(rows(container)).toHaveLength(1);
    expect(container.textContent).toContain('Storie di Caruso');

    await act(async () => {
      chip(container, 'Tutto')?.click();
    });
    expect(rows(container)).toHaveLength(4);
  });
});

describe('Cerca unificata: accessibilità', () => {
  it('ha una sola riga di stato live che annuncia il conteggio', async () => {
    respondWith(withYouTube, typingResponse);
    const container = await mount('caruso');
    const live = container.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0]?.getAttribute('aria-live')).toBe('polite');
    expect(live[0]?.textContent).toContain('risultati per “caruso”');
  });
});
