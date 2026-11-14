// @polsia:user-owned — Cerca unificata (client): mentre si digita si cercano Audius + radio +
// podcast SENZA toccare YouTube; all'invio si aggiunge YouTube una sola volta. L'elenco è misto,
// deduplicato e filtrabile; ogni riga suona nel player; quando la quota YouTube è finita resta
// l'avviso con il link «Cerca su YouTube» e le altre fonti. I brani «In evidenza» (catalogo Solco
// con diritti dichiarati) si mostrano con distintivo e copertina e suonano ESATTAMENTE come in Home.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  replace: vi.fn(),
  currentTrack: null as { qualifiedId: string } | null,
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
    currentTrack: mocks.currentTrack,
    status: 'idle',
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
  trackStreamPath: (track: { qualifiedId: string }) => `/stream/${track.qualifiedId}`,
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));
vi.mock('@/components/custom/music/ai-music-search', () => ({ AiMusicSearch: () => null }));
vi.mock('@/components/custom/music/listen-in-solco', () => ({ ListenInSolco: () => null }));

import { HomeTracksSection } from '@/components/custom/music/home-tracks-section';
import { homeTrackToTrack } from '@/components/custom/music/live-tracks';
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
  mocks.currentTrack = null;
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

// Brano in evidenza (file privato nello store Blob, servito dal proxy), con il video dello stesso
// brano come alternativa; un secondo brano in evidenza per la coda.
const featuredTrack = {
  id: 'Cantautori/Lucio Dalla - Caruso.mp3',
  title: 'Caruso',
  artist: 'Lucio Dalla',
  streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent('Cantautori/Lucio Dalla - Caruso.mp3')}`,
  durationSeconds: 0,
  artworkUrl: `/api/music/home-tracks/cover?p=${encodeURIComponent('Cantautori/cover.jpg')}`,
};
const featuredTrack2 = {
  id: 'Strumentale - Caruso al piano.mp3',
  title: 'Caruso al piano',
  artist: null,
  streamUrl:
    'https://store.public.blob.vercel-storage.com/Strumentale%20-%20Caruso%20al%20piano.mp3',
  durationSeconds: 0,
  artworkUrl: null,
};
const withFeatured = {
  ...typingResponse,
  results: [
    {
      kind: 'featured',
      key: `featured:${featuredTrack.id}`,
      score: 100,
      track: featuredTrack,
      youtubeAlternative: altVideo,
    },
    {
      kind: 'featured',
      key: `featured:${featuredTrack2.id}`,
      score: 70,
      track: featuredTrack2,
      youtubeAlternative: null,
    },
    radioEntry,
    podcastEntry,
  ],
  sources: {
    ...typingResponse.sources,
    featured: { status: 'results', tracks: [featuredTrack, featuredTrack2] },
  },
};

describe('Cerca unificata: brani in evidenza', () => {
  it('ogni richiesta dichiara di saper mostrare i brani in evidenza (featured=1)', async () => {
    respondWith(withFeatured, withFeatured);
    const container = await mount('caruso');
    await submitForm(container);
    await flush();
    expect(urlCalls().length).toBeGreaterThanOrEqual(2);
    for (const url of urlCalls()) expect(url).toContain('featured=1');
  });

  it('mostra distintivo «In evidenza», copertina, titolo e artista; conta fra i Brani', async () => {
    respondWith(withFeatured, withFeatured);
    const container = await mount('caruso');

    const row = container.querySelector('li[data-kind="featured"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-source="featured"]')?.textContent).toBe('In evidenza');
    expect(row?.querySelector('[data-art]')?.getAttribute('data-art')).toBe(
      featuredTrack.artworkUrl,
    );
    expect(row?.textContent).toContain('Caruso');
    expect(row?.textContent).toContain('Lucio Dalla');
    // Senza artista: «Solco», come in Home.
    expect(container.querySelectorAll('li[data-kind="featured"]')[1]?.textContent).toContain(
      'Solco',
    );

    await act(async () => {
      chip(container, 'Brani')?.click();
    });
    expect(rows(container)).toHaveLength(2);
    expect(chip(container, 'Brani')?.textContent).toContain('2');
  });

  it('suona con lo STESSO avvio della Home: stesso brano del player, stesso percorso, coda dei brani in evidenza', async () => {
    respondWith(withFeatured, withFeatured);
    const container = await mount('caruso');
    await act(async () => {
      button(container, 'Riproduci Caruso di Lucio Dalla')?.click();
    });

    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [track, path, queue] = mocks.playTrack.mock.calls[0] ?? [];
    expect(track).toEqual(homeTrackToTrack(featuredTrack));
    expect(path).toBe(featuredTrack.streamUrl);
    expect(queue).toEqual([homeTrackToTrack(featuredTrack), homeTrackToTrack(featuredTrack2)]);
    // Riproduzione «upload» del player come in Home (stesse regole: niente percorso inventato).
    expect(track).toMatchObject({
      qualifiedId: `upload:${featuredTrack.id}`,
      playbackMode: 'upload',
      sourceLabel: 'In evidenza',
    });
  });

  it('parità con la Home: la stessa chiamata al player dalla Home e dalla ricerca', async () => {
    const homeResponse = {
      items: [featuredTrack],
      sections: [{ id: 'Cantautori', title: 'Cantautori', items: [featuredTrack] }],
    };
    mocks.apiFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith('/api/music/home-tracks')
          ? homeResponse
          : {
              ...withFeatured,
              results: [withFeatured.results[0]],
              sources: {
                ...withFeatured.sources,
                featured: { status: 'results', tracks: [featuredTrack] },
              },
            },
      ),
    );

    const home = document.createElement('div');
    document.body.append(home);
    const homeRoot = createRoot(home);
    roots.push(homeRoot);
    await act(async () => homeRoot.render(<HomeTracksSection />));
    await flush();
    await act(async () => {
      button(home, 'Riproduci Caruso di Lucio Dalla')?.click();
    });

    const search = await mount('caruso');
    await act(async () => {
      button(search, 'Riproduci Caruso di Lucio Dalla')?.click();
    });

    expect(mocks.playTrack).toHaveBeenCalledTimes(2);
    const [fromHome, fromSearch] = mocks.playTrack.mock.calls;
    expect(fromSearch).toEqual(fromHome);
  });

  it('sul brano già in corso mette in pausa/riprende, come in Home', async () => {
    mocks.currentTrack = { qualifiedId: `upload:${featuredTrack.id}` };
    respondWith(withFeatured, withFeatured);
    const container = await mount('caruso');
    await act(async () => {
      button(container, 'Riproduci Caruso di Lucio Dalla')?.click();
    });
    expect(mocks.togglePlayback).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('il nome dell’artista porta alla sua pagina SOLO con artistSlug', async () => {
    const linked = { ...featuredTrack, artistSlug: 'lucio-dalla' };
    const response = {
      ...withFeatured,
      results: [
        { ...withFeatured.results[0], track: linked },
        // Server meno recente (nessun artistSlug) e brano senza artista: nessun link.
        withFeatured.results[1],
        radioEntry,
        podcastEntry,
      ],
      sources: {
        ...withFeatured.sources,
        featured: { status: 'results', tracks: [linked, featuredTrack2] },
      },
    };
    respondWith(response, response);
    const container = await mount('caruso');
    const rowsWithKind = container.querySelectorAll('li[data-kind="featured"]');
    const artistLinks = [...(rowsWithKind[0]?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
    expect(artistLinks.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Lucio Dalla', '/artista/lucio-dalla'],
    ]);
    expect(rowsWithKind[1]?.querySelector('a')).toBeNull();
    expect(rowsWithKind[1]?.textContent).toContain('Solco');

    // Stesso brano con artistSlug null: testo, nessun link.
    respondWith(
      {
        ...response,
        results: [{ ...withFeatured.results[0], track: { ...linked, artistSlug: null } }],
      },
      {
        ...response,
        results: [{ ...withFeatured.results[0], track: { ...linked, artistSlug: null } }],
      },
    );
    const other = await mount('lucio');
    const row = other.querySelector('li[data-kind="featured"]');
    expect(row?.querySelector('a')).toBeNull();
    expect(row?.textContent).toContain('Lucio Dalla');
  });

  it('il video dello stesso brano resta come «Ascolta su YouTube», senza una riga a sé', async () => {
    respondWith(withFeatured, withFeatured);
    const container = await mount('caruso');
    expect(rows(container)).toHaveLength(4);
    const row = container.querySelector('li[data-kind="featured"]');
    const secondary = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) =>
      b.textContent?.includes('Ascolta su YouTube'),
    );
    await act(async () => {
      secondary?.click();
    });
    expect(mocks.playTrack.mock.calls.map((call) => call[0].qualifiedId)).toEqual([
      'youtube:alt1111alt1',
    ]);
  });
});
