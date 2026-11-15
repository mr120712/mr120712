// @polsia:user-owned — pagina d'artista (client): carica l'artista con apiFetch e il suo contratto,
// mostra mosaico, nome, «N brani» e l'elenco; «Riproduci tutto» avvia la coda dell'artista come in
// Home (playHomeTrack, anche se il primo brano è già in corso), «Casuale» la mescola senza perdere
// brani, un tocco su una riga suona quel brano (o mette in pausa quello in corso, segnato come
// corrente); stati di caricamento, nessun brano (404) ed errore con «Riprova»; link alla Home.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  currentTrack: null as { qualifiedId: string } | null,
  status: 'idle' as string,
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: lo stub inoltra ciò che passa il componente.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: mocks.currentTrack,
    status: mocks.status,
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));

import { FeaturedArtistView } from '@/components/custom/music/featured-artist-view';
import { homeTrackToTrack } from '@/components/custom/music/live-tracks';

function track(id: string, title: string, artist = 'Lucio Dalla') {
  return {
    id,
    title,
    artist,
    streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
    durationSeconds: 0,
    artworkUrl: `/api/music/home-tracks/cover?p=${encodeURIComponent(`${id}.jpg`)}`,
    artistSlug: 'lucio-dalla',
  };
}

const TRACKS = [
  track('Cantautori/Lucio Dalla - Caruso.mp3', 'Caruso'),
  track('Cantautori/Lucio Dalla - Anna e Marco.mp3', 'Anna e Marco'),
  track('Cantautori/Lucio Dalla feat. Mina - Duetto.mp3', 'Duetto', 'Lucio Dalla feat. Mina'),
  track('Cantautori/Lucio Dalla - 4 marzo 1943.mp3', '4 marzo 1943'),
];
const RESPONSE = { artist: { name: 'Lucio Dalla', slug: 'lucio-dalla' }, tracks: TRACKS };

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(slug = 'lucio-dalla') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<FeaturedArtistView slug={slug} />));
  await flush();
  return container;
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(text),
  );
}

function buttonByLabel(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function httpError(status: number, cause: unknown) {
  return new Error(`apiFetch /api/music/featured/artists/lucio-dalla failed (${status})`, {
    cause,
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.playTrack.mockReset();
  mocks.togglePlayback.mockReset();
  mocks.currentTrack = null;
  mocks.status = 'idle';
  mocks.apiFetch.mockResolvedValue(RESPONSE);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FeaturedArtistView: caricamento e contenuto', () => {
  it('chiede l’artista all’API con il suo contratto e mostra intestazione ed elenco', async () => {
    const container = await mount();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.apiFetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/music/featured/artists/lucio-dalla');
    expect(options).toHaveProperty('schema');

    expect(container.querySelector('h1')?.textContent).toBe('Lucio Dalla');
    expect(container.textContent).toContain('4 brani');
    // Mosaico 2×2 con le copertine dei brani (4 diverse).
    const tiles = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(tiles).toEqual(TRACKS.map((t) => t.artworkUrl));
    const rows = container.querySelectorAll('ol li');
    expect(rows).toHaveLength(4);
    expect(rows[2]?.textContent).toContain('Lucio Dalla feat. Mina');
    // Link alla Home (un <Button asChild><Link/></Button>).
    const back = container.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(back?.textContent).toContain('Torna alla Home');
  });

  it('mentre carica mostra lo scheletro con l’annuncio per lo screen reader', async () => {
    mocks.apiFetch.mockReturnValue(new Promise(() => undefined));
    const container = await mount();
    expect(container.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('Caricamento dell’artista…');
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
  });

  it('404 (nessun brano dichiarato): stato vuoto con il link alla Home, nessun elenco', async () => {
    mocks.apiFetch.mockRejectedValue(httpError(404, { error: 'not_found' }));
    const container = await mount();
    expect(container.querySelector('h1')?.textContent).toBe('Nessun brano disponibile');
    expect(container.querySelector('ol')).toBeNull();
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
  });

  it('risposta senza brani: lo stesso stato vuoto', async () => {
    mocks.apiFetch.mockResolvedValue({ ...RESPONSE, tracks: [] });
    const container = await mount();
    expect(container.querySelector('h1')?.textContent).toBe('Nessun brano disponibile');
  });

  it('slug non valido: stato vuoto senza chiamare l’API', async () => {
    const container = await mount('Lucio Dalla');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.querySelector('h1')?.textContent).toBe('Nessun brano disponibile');
  });

  it('errore: messaggio, «Riprova» ricarica e il titolo prende il focus', async () => {
    mocks.apiFetch.mockRejectedValueOnce(httpError(503, { error: 'unavailable' }));
    const container = await mount();
    expect(container.querySelector('[role="alert"] h1')?.textContent).toBe(
      'Non riesco a caricare l’artista',
    );
    await act(async () => {
      buttonByText(container, 'Riprova')?.click();
    });
    await flush();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    const heading = container.querySelector('h1');
    expect(heading?.textContent).toBe('Lucio Dalla');
    expect(document.activeElement).toBe(heading);
  });

  it('limite raggiunto (429): mostra il testo del server', async () => {
    mocks.apiFetch.mockRejectedValue(
      httpError(429, { error: 'rate_limited', message: 'Riprova tra 8 secondi.' }),
    );
    const container = await mount();
    expect(container.textContent).toContain('Riprova tra 8 secondi.');
  });
});

describe('FeaturedArtistView: riproduzione', () => {
  it('«Riproduci tutto» avvia il primo brano con la coda di tutti i brani, come in Home', async () => {
    const container = await mount();
    await act(async () => {
      buttonByText(container, 'Riproduci tutto')?.click();
    });
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [first, path, queue] = mocks.playTrack.mock.calls[0] ?? [];
    expect(first).toEqual(homeTrackToTrack(TRACKS[0] as (typeof TRACKS)[number]));
    expect(path).toBe(TRACKS[0]?.streamUrl);
    expect(queue).toEqual(TRACKS.map(homeTrackToTrack));
  });

  it('«Riproduci tutto» sul primo brano già in corso riparte con la coda (non mette in pausa)', async () => {
    mocks.currentTrack = { qualifiedId: `upload:${TRACKS[0]?.id}` };
    mocks.status = 'playing';
    const container = await mount();
    await act(async () => {
      buttonByText(container, 'Riproduci tutto')?.click();
    });
    expect(mocks.togglePlayback).not.toHaveBeenCalled();
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack.mock.calls[0]?.[2]).toEqual(TRACKS.map(homeTrackToTrack));
  });

  it('«Casuale» mescola la coda senza perdere né ripetere brani', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const container = await mount();
    await act(async () => {
      buttonByText(container, 'Casuale')?.click();
    });
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [first, , queue] = mocks.playTrack.mock.calls[0] ?? [];
    const ids = (queue as Array<{ qualifiedId: string }>).map((entry) => entry.qualifiedId);
    // Math.random = 0 → Fisher–Yates dà [2, 3, 4, 1].
    expect(ids).toEqual([1, 2, 3, 0].map((index) => `upload:${TRACKS[index]?.id}`));
    expect([...ids].sort()).toEqual(TRACKS.map((t) => `upload:${t.id}`).sort());
    expect(first.qualifiedId).toBe(ids[0]);
    // L'elenco mostrato resta nell'ordine dell'artista.
    expect(container.querySelector('ol li')?.textContent).toContain('Caruso');
  });

  it('un tocco su una riga suona quel brano con la coda dell’artista', async () => {
    const container = await mount();
    await act(async () => {
      buttonByLabel(container, 'Riproduci Anna e Marco di Lucio Dalla')?.click();
    });
    const [selected, path, queue] = mocks.playTrack.mock.calls[0] ?? [];
    expect(selected).toEqual(homeTrackToTrack(TRACKS[1] as (typeof TRACKS)[number]));
    expect(path).toBe(TRACKS[1]?.streamUrl);
    expect(queue).toEqual(TRACKS.map(homeTrackToTrack));
  });

  it('il brano in corso è segnato (aria-current) e un tocco lo mette in pausa', async () => {
    mocks.currentTrack = { qualifiedId: `upload:${TRACKS[1]?.id}` };
    mocks.status = 'playing';
    const container = await mount();
    const current = buttonByLabel(container, 'Metti in pausa Anna e Marco di Lucio Dalla');
    expect(current?.getAttribute('aria-current')).toBe('true');
    expect(current?.closest('li')?.getAttribute('data-current')).toBe('true');
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(container.textContent).toContain('In riproduzione: Anna e Marco');
    await act(async () => {
      current?.click();
    });
    expect(mocks.togglePlayback).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });
});

describe('piano Free della pagina d’artista', () => {
  it('«30 di 34 brani» e, sotto l’elenco, gli altri con Premium', async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      track(`Lucio Dalla - Brano ${index + 1}.mp3`, `Brano ${index + 1}`),
    );
    mocks.apiFetch.mockResolvedValue({ ...RESPONSE, tracks: many, total: 34 });
    const container = await mount();
    expect(container.textContent).toContain('30 di 34 brani');
    const aside = container.querySelector('aside[aria-label="Altri brani con Premium"]');
    expect(aside?.textContent).toContain('di questo artista');
    expect(aside?.textContent).toContain('altri 4 brani');
    expect(aside?.querySelector('a[href="/piani"]')).not.toBeNull();
  });

  it('elenco completo: nessun invito', async () => {
    mocks.apiFetch.mockResolvedValue({ ...RESPONSE, total: RESPONSE.tracks.length });
    const container = await mount();
    expect(container.querySelector('aside[aria-label="Altri brani con Premium"]')).toBeNull();
  });
});
