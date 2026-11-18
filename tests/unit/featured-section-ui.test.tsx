// @polsia:user-owned — «Mostra tutti» delle sezioni dei brani in evidenza, lato client: la pagina
// /cartella/<id> carica la sezione con apiFetch e il suo contratto, mostra mosaico, titolo, «N brani»
// e l'elenco; «Riproduci tutto» avvia la coda della sezione come in Home (anche se il primo brano è
// già in corso), «Casuale» la mescola senza perdere brani, un tocco su una riga suona quel brano (o
// mette in pausa quello in corso); «Condividi» solo sulle righe con shareId; stati di caricamento,
// nessun brano (404) ed errore con «Riprova»; link alla Home. Il guscio della pagina rifiuta un id
// malformato (404) e ha metadati generici. In Home il link «Mostra tutti (N)» compare SOLO quando
// il server manda sectionId e declaredCount > 0.
import { act, isValidElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  currentTrack: null as { qualifiedId: string } | null,
  status: 'idle' as string,
  premium: false,
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
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
    premium: mocks.premium,
  }),
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));
vi.mock('@/components/custom/music/featured-share-button', () => ({
  FeaturedShareButton: ({ track }: { track: { title: string; shareId?: string | null } }) =>
    track.shareId ? <button type="button">{`Condividi ${track.title}`}</button> : null,
}));

import FeaturedSectionPage, { metadata } from '@/app/(custom)/cartella/[sectionId]/page';
import { FeaturedSectionView } from '@/components/custom/music/featured-section-view';
import { HomeTracksSection, sectionShowAll } from '@/components/custom/music/home-tracks-section';
import { homeTrackToTrack } from '@/components/custom/music/live-tracks';

const SECTION_ID = 'AbCdEfGhIjKlMnOpQrSt_-';

function track(id: string, title: string, artist: string | null = 'Lucio Dalla', shareId?: string) {
  return {
    id,
    title,
    artist,
    streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
    durationSeconds: 0,
    artworkUrl: `/api/music/home-tracks/cover?p=${encodeURIComponent(`${id}.jpg`)}`,
    artistSlug: artist ? 'lucio-dalla' : null,
    shareId: shareId ?? null,
  };
}

const TRACKS = [
  track('Cantautori/Lucio Dalla - Caruso.mp3', 'Caruso', 'Lucio Dalla', 'S'.repeat(22)),
  track('Cantautori/Lucio Dalla - Anna e Marco.mp3', 'Anna e Marco'),
  track('Cantautori/Strumentale.mp3', 'Strumentale', null),
  track('Cantautori/Lucio Dalla - 4 marzo 1943.mp3', '4 marzo 1943'),
];
const RESPONSE = { section: { id: SECTION_ID, title: 'Cantautori', root: false }, tracks: TRACKS };

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function mountView(sectionId = SECTION_ID) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<FeaturedSectionView sectionId={sectionId} />));
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
  return new Error(`apiFetch /api/music/featured/sections/${SECTION_ID} failed (${status})`, {
    cause,
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.playTrack.mockReset();
  mocks.togglePlayback.mockReset();
  mocks.notFound.mockClear();
  mocks.currentTrack = null;
  mocks.status = 'idle';
  mocks.apiFetch.mockResolvedValue(RESPONSE);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pagina /cartella/<id> (guscio)', () => {
  it('id valido: monta la vista della sezione; metadati generici, non indicizzata', async () => {
    const element = await FeaturedSectionPage({
      params: Promise.resolve({ sectionId: SECTION_ID }),
    });
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe(FeaturedSectionView);
    expect(element.props).toEqual({ sectionId: SECTION_ID });
    expect(metadata.title).toBe('Brani in evidenza');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it.each(['Cantautori', 'a'.repeat(21), '..'])('id malformato %s: 404', async (sectionId) => {
    await expect(FeaturedSectionPage({ params: Promise.resolve({ sectionId }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(mocks.notFound).toHaveBeenCalled();
  });
});

describe('FeaturedSectionView: caricamento e contenuto', () => {
  it('chiede la sezione all’API con il suo contratto e mostra intestazione ed elenco', async () => {
    const container = await mountView();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.apiFetch.mock.calls[0] ?? [];
    expect(url).toBe(`/api/music/featured/sections/${SECTION_ID}`);
    expect(options).toHaveProperty('schema');

    expect(container.querySelector('h1')?.textContent).toBe('Cantautori');
    expect(container.textContent).toContain('Sezione · In evidenza');
    expect(container.textContent).toContain('4 brani');
    // Mosaico 2×2 con le copertine dei brani (4 diverse).
    const tiles = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(tiles).toEqual(TRACKS.map((t) => t.artworkUrl));
    const rows = container.querySelectorAll('ol li');
    expect(rows).toHaveLength(4);
    // Un brano senza artista nel nome del file: «Solco», come in Home.
    expect(rows[2]?.textContent).toContain('Solco');
    // Link alla Home (un <Button asChild><Link/></Button>).
    expect(container.querySelector<HTMLAnchorElement>('a[href="/"]')?.textContent).toContain(
      'Torna alla Home',
    );
  });

  it('radice: la stessa intestazione della Home («Ascolta ora» sotto «In evidenza»)', async () => {
    mocks.apiFetch.mockResolvedValue({
      section: { id: SECTION_ID, title: 'In evidenza', root: true },
      tracks: TRACKS,
    });
    const container = await mountView();
    // Lo stesso titolo dell'etichetta del link in Home («Mostra tutti (N): Ascolta ora»).
    expect(container.querySelector('h1')?.textContent).toBe('Ascolta ora');
    expect(container.textContent).toContain('In evidenza');
    expect(container.textContent).not.toContain('Sezione · In evidenza');
    // «In evidenza» una volta sola: l'occhiello, non anche il titolo.
    expect(container.querySelector('header')?.textContent?.split('In evidenza')).toHaveLength(2);
  });

  it('senza `root` nella risposta: intestazione di una sezione normale', async () => {
    mocks.apiFetch.mockResolvedValue({
      section: { id: SECTION_ID, title: 'Cantautori' },
      tracks: TRACKS,
    });
    const container = await mountView();
    expect(container.querySelector('h1')?.textContent).toBe('Cantautori');
    expect(container.textContent).toContain('Sezione · In evidenza');
  });

  it('«Condividi» solo sulle righe dei brani con shareId', async () => {
    const container = await mountView();
    const rows = [...container.querySelectorAll('ol li')];
    expect(rows[0]?.getAttribute('data-shareable')).toBe('true');
    expect(buttonByText(container, 'Condividi Caruso')).toBeDefined();
    expect(rows.slice(1).every((row) => !row.hasAttribute('data-shareable'))).toBe(true);
    expect(container.querySelectorAll('ol li button').length).toBe(5);
  });

  it('mentre carica mostra lo scheletro con l’annuncio per lo screen reader', async () => {
    mocks.apiFetch.mockReturnValue(new Promise(() => undefined));
    const container = await mountView();
    expect(container.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('Caricamento dei brani…');
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
  });

  it('404 (nessun brano dichiarato): stato vuoto con il link alla Home, nessun elenco', async () => {
    mocks.apiFetch.mockRejectedValue(httpError(404, { error: 'not_found' }));
    const container = await mountView();
    expect(container.querySelector('h1')?.textContent).toBe('Nessun brano disponibile');
    expect(container.querySelector('ol')).toBeNull();
    expect(
      [...container.querySelectorAll('a[href="/"]')].map((a) => a.textContent?.trim()),
    ).toContain('Vai alla Home');
  });

  it('risposta senza brani: lo stesso stato vuoto', async () => {
    mocks.apiFetch.mockResolvedValue({ ...RESPONSE, tracks: [] });
    const container = await mountView();
    expect(container.querySelector('h1')?.textContent).toBe('Nessun brano disponibile');
  });

  it('id non valido: stato vuoto senza chiamare l’API', async () => {
    const container = await mountView('Cantautori');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.querySelector('h1')?.textContent).toBe('Nessun brano disponibile');
  });

  it('errore: messaggio, «Riprova» ricarica e il titolo prende il focus', async () => {
    mocks.apiFetch.mockRejectedValueOnce(httpError(503, { error: 'unavailable' }));
    const container = await mountView();
    expect(container.querySelector('[role="alert"] h1')?.textContent).toBe(
      'Non riesco a caricare i brani',
    );
    await act(async () => {
      buttonByText(container, 'Riprova')?.click();
    });
    await flush();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    const heading = container.querySelector('h1');
    expect(heading?.textContent).toBe('Cantautori');
    expect(document.activeElement).toBe(heading);
  });

  it('limite raggiunto (429): mostra il testo del server', async () => {
    mocks.apiFetch.mockRejectedValue(
      httpError(429, { error: 'rate_limited', message: 'Riprova tra 8 secondi.' }),
    );
    const container = await mountView();
    expect(container.textContent).toContain('Riprova tra 8 secondi.');
  });
});

describe('FeaturedSectionView: riproduzione', () => {
  it('«Riproduci tutto» avvia il primo brano con la coda di tutta la sezione, come in Home', async () => {
    const container = await mountView();
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
    const container = await mountView();
    await act(async () => {
      buttonByText(container, 'Riproduci tutto')?.click();
    });
    expect(mocks.togglePlayback).not.toHaveBeenCalled();
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack.mock.calls[0]?.[2]).toEqual(TRACKS.map(homeTrackToTrack));
  });

  it('«Casuale» mescola la coda senza perdere né ripetere brani', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const container = await mountView();
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
    // L'elenco mostrato resta nell'ordine della sezione.
    expect(container.querySelector('ol li')?.textContent).toContain('Caruso');
  });

  it('«Casuale» è disattivato con un solo brano', async () => {
    mocks.apiFetch.mockResolvedValue({ ...RESPONSE, tracks: TRACKS.slice(0, 1) });
    const container = await mountView();
    expect(buttonByText(container, 'Casuale')?.disabled).toBe(true);
    expect(container.textContent).toContain('1 brano');
  });

  it('un tocco su una riga suona quel brano con la coda della sezione', async () => {
    const container = await mountView();
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
    const container = await mountView();
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

describe('Home: «Mostra tutti (N)»', () => {
  const VERSION = 'c'.repeat(16);
  const OTHER_ID = 'ZyXwVuTsRqPoNmLkJiHg-_';

  // Il link alla cartella con TUTTI i brani dichiarati è riservato ai Premium.
  beforeEach(() => {
    mocks.premium = true;
  });
  afterEach(() => {
    mocks.premium = false;
  });

  function homeItem(id: string, title: string) {
    return {
      id,
      title,
      artist: null,
      streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
      durationSeconds: 0,
    };
  }

  function serveHome(sections: unknown[]) {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/music/home-tracks/version') {
        return { version: VERSION, updatedAt: '2026-11-15T10:00:00.000Z' };
      }
      if (url.startsWith('/api/music/home-tracks')) {
        const items = (sections as Array<{ items: unknown[] }>).flatMap((s) => s.items);
        return { items, sections, version: VERSION };
      }
      throw new Error(`URL inattesa: ${url}`);
    });
  }

  async function mountHome() {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<HomeTracksSection />));
    await flush();
    return container;
  }

  it('il link compare solo per le sezioni con sectionId e declaredCount > 0', async () => {
    serveHome([
      {
        id: '',
        title: 'In evidenza',
        items: [homeItem('a.mp3', 'A')],
        sectionId: SECTION_ID,
        declaredCount: 3,
      },
      {
        id: 'Download',
        title: 'Download',
        items: [homeItem('Download/b.mp3', 'B')],
        sectionId: null,
        declaredCount: null,
      },
      {
        id: 'Zero',
        title: 'Zero',
        items: [homeItem('Zero/c.mp3', 'C')],
        sectionId: OTHER_ID,
        declaredCount: 0,
      },
      // Server meno recente: nessun campo.
      { id: 'Vecchio', title: 'Vecchio', items: [homeItem('Vecchio/d.mp3', 'D')] },
    ]);
    const container = await mountHome();
    const sections = [...container.querySelectorAll('section')];
    expect(sections).toHaveLength(4);
    const links = sections.map((section) =>
      [...section.querySelectorAll<HTMLAnchorElement>('a')].filter((a) =>
        a.textContent?.startsWith('Mostra tutti'),
      ),
    );
    expect(links.map((found) => found.length)).toEqual([1, 0, 0, 0]);
    const link = links[0]?.[0];
    expect(link?.getAttribute('href')).toBe(`/cartella/${SECTION_ID}`);
    expect(link?.textContent).toBe('Mostra tutti (3)');
    // Etichetta accessibile: inizia con il testo visibile e dice di quale sezione si tratta.
    expect(link?.getAttribute('aria-label')).toBe('Mostra tutti (3): Ascolta ora');
    // La sezione in Home resta com'è (un brano a schermo, anche se N è più grande).
    expect(sections[0]?.querySelectorAll('ul li')).toHaveLength(1);
  });

  it('per gli account Free il link «Mostra tutti» non compare', async () => {
    mocks.premium = false;
    serveHome([
      {
        id: '',
        title: 'In evidenza',
        items: [homeItem('a.mp3', 'A')],
        sectionId: SECTION_ID,
        declaredCount: 3,
      },
    ]);
    const container = await mountHome();
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a')].filter((a) =>
      a.textContent?.startsWith('Mostra tutti'),
    );
    expect(links).toHaveLength(0);
  });

  it('sectionShowAll: id valido e N > 0, altrimenti nessun link', () => {
    const base = { id: 'X', title: 'X', items: [] };
    expect(sectionShowAll({ ...base, sectionId: SECTION_ID, declaredCount: 12 })).toEqual({
      href: `/cartella/${SECTION_ID}`,
      count: 12,
    });
    expect(sectionShowAll({ ...base, sectionId: SECTION_ID, declaredCount: 0 })).toBeNull();
    expect(sectionShowAll({ ...base, sectionId: SECTION_ID, declaredCount: null })).toBeNull();
    expect(sectionShowAll({ ...base, sectionId: null, declaredCount: 5 })).toBeNull();
    expect(sectionShowAll({ ...base, sectionId: 'non valido', declaredCount: 5 })).toBeNull();
    expect(sectionShowAll(base)).toBeNull();
  });
});

describe('piano Free: «30 di N brani» e invito a Premium', () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    track(`Tanti/Artista - Brano ${index + 1}.mp3`, `Brano ${index + 1}`, 'Artista'),
  );

  it('elenco tagliato: «30 di 45 brani» e, sotto l’elenco, gli altri 15 con Premium', async () => {
    mocks.apiFetch.mockResolvedValue({
      section: { id: SECTION_ID, title: 'Tanti', root: false },
      tracks: many,
      total: 45,
    });
    const container = await mountView();
    expect(container.textContent).toContain('30 di 45 brani');
    const aside = container.querySelector('aside[aria-label="Altri brani con Premium"]');
    expect(aside?.textContent).toContain('i 30 brani più recenti di questa cartella');
    expect(aside?.textContent).toContain('altri 15 brani');
    expect(aside?.querySelector('a[href="/piani"]')?.textContent).toBe('Passa a Premium');
    expect(aside?.querySelector('[data-premium-badge]')).not.toBeNull();
  });

  it('genere: lo dice per il genere; un solo brano in più al singolare', async () => {
    mocks.apiFetch.mockResolvedValue({
      section: { id: SECTION_ID, title: 'Rap italiano', genre: true },
      tracks: many,
      total: 31,
    });
    const container = await mountView();
    const aside = container.querySelector('aside[aria-label="Altri brani con Premium"]');
    expect(aside?.textContent).toContain('di questo genere');
    expect(aside?.textContent).toContain('ancora 1 brano');
  });

  it('elenco completo (Premium o entro il tetto) o server meno recente: nessun invito', async () => {
    for (const total of [30, undefined]) {
      mocks.apiFetch.mockResolvedValue({
        section: { id: SECTION_ID, title: 'Tanti', root: false },
        tracks: many,
        ...(total === undefined ? {} : { total }),
      });
      const container = await mountView();
      expect(container.textContent).toContain('30 brani');
      expect(container.textContent).not.toContain('30 di');
      expect(container.querySelector('aside[aria-label="Altri brani con Premium"]')).toBeNull();
    }
  });
});
