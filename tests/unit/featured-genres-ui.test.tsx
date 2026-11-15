// @polsia:user-owned — «Per genere» dei brani in evidenza, lato client: in Home la fila «Per genere» compare
// (prima delle sezioni) SOLO quando il server manda `genres`, con un riquadro per genere che apre
// /cartella/<id> (nome, «N brani», mosaico delle copertine, nome accessibile che comincia con il
// nome del genere); senza generi, con un server meno recente o con un id malformato nessun
// riquadro, e le sezioni restano com'erano. La pagina di un genere dice «Genere · In evidenza».
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
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
    currentTrack: null,
    status: 'idle',
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));
vi.mock('@/components/custom/music/featured-share-button', () => ({
  FeaturedShareButton: () => null,
}));

import { FeaturedSectionView } from '@/components/custom/music/featured-section-view';
import { HomeTracksSection } from '@/components/custom/music/home-tracks-section';

const VERSION = 'd'.repeat(16);
const RAP_ID = 'RaPiTaLiAnO0123456789_';
const POP_ID = 'PoPpOpPoPpOpPoPpOp-_12';
const cover = (name: string) => `/api/music/home-tracks/cover?p=${encodeURIComponent(name)}`;

function homeItem(id: string, title: string) {
  return {
    id,
    title,
    artist: null,
    streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
    durationSeconds: 0,
  };
}

const SECTIONS = [{ id: '', title: 'In evidenza', items: [homeItem('a.mp3', 'A')] }];

function serveHome(genres: unknown) {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/music/home-tracks/version') {
      return { version: VERSION, updatedAt: '2026-11-15T10:00:00.000Z' };
    }
    if (url.startsWith('/api/music/home-tracks')) {
      const items = SECTIONS.flatMap((section) => section.items);
      return genres === undefined
        ? { items, sections: SECTIONS, version: VERSION }
        : { items, sections: SECTIONS, genres, version: VERSION };
    }
    throw new Error(`URL inattesa: ${url}`);
  });
}

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await flush();
  return container;
}

function genreSection(container: HTMLElement) {
  return container.querySelector<HTMLElement>(
    'section[aria-labelledby="in-evidenza-generi-heading"]',
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  mocks.apiFetch.mockReset();
  mocks.playTrack.mockReset();
  mocks.togglePlayback.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Home: fila «Per genere»', () => {
  it('un riquadro per genere, prima delle sezioni, che apre la pagina del genere', async () => {
    serveHome([
      {
        id: RAP_ID,
        name: 'Rap italiano',
        count: 3,
        artworkUrls: [cover('1.jpg'), cover('2.jpg'), cover('3.jpg'), cover('4.jpg')],
      },
      { id: POP_ID, name: 'Pop', count: 1, artworkUrls: [] },
    ]);
    const container = await mount(<HomeTracksSection />);
    const sections = [...container.querySelectorAll('section')];
    // Prima la fila dei generi, poi la sezione dei brani com'era.
    expect(sections).toHaveLength(2);
    expect(sections[0]).toBe(genreSection(container));
    expect(sections[0]?.querySelector('h2')?.textContent).toBe('Per genere');

    const links = [...(sections[0]?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/cartella/${RAP_ID}`,
      `/cartella/${POP_ID}`,
    ]);
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Rap italiano, 3 brani',
      'Pop, 1 brano',
    ]);
    expect(links[0]?.textContent).toContain('Rap italiano');
    expect(links[0]?.textContent).toContain('3 brani');
    // Mosaico 2×2 con le copertine dei suoi brani; senza copertine l'iniziale del genere.
    expect(
      [...(links[0]?.querySelectorAll('img') ?? [])].map((img) => img.getAttribute('src')),
    ).toEqual([cover('1.jpg'), cover('2.jpg'), cover('3.jpg'), cover('4.jpg')]);
    expect(links[1]?.querySelector('img')).toBeNull();
    expect(links[1]?.textContent).toContain('P');

    // La sezione dei brani resta com'era: un brano, nessun riquadro di genere.
    expect(sections[1]?.querySelectorAll('ul li')).toHaveLength(1);
    expect(sections[1]?.querySelector('a[href^="/cartella/"]')).toBeNull();
  });

  it('nessun genere: nessuna fila, e le sezioni restano com’erano', async () => {
    serveHome([]);
    const container = await mount(<HomeTracksSection />);
    expect(genreSection(container)).toBeNull();
    expect(container.querySelectorAll('section')).toHaveLength(1);
    expect(container.textContent).not.toContain('Per genere');
  });

  it('server meno recente (nessun campo) o id malformato: nessun riquadro', async () => {
    serveHome(undefined);
    let container = await mount(<HomeTracksSection />);
    expect(genreSection(container)).toBeNull();

    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = '';
    serveHome([
      { id: 'non valido', name: 'Rap', count: 2, artworkUrls: [] },
      { id: POP_ID, name: 'Pop', count: 0, artworkUrls: [] },
    ]);
    container = await mount(<HomeTracksSection />);
    expect(genreSection(container)).toBeNull();
  });
});

describe('pagina di un genere', () => {
  const track = (id: string, title: string) => ({
    ...homeItem(id, title),
    artworkUrl: null,
    artistSlug: null,
    shareId: null,
  });

  it('dice «Genere · In evidenza» e mostra il nome del genere', async () => {
    mocks.apiFetch.mockResolvedValue({
      section: { id: RAP_ID, title: 'Rap italiano', root: false, genre: true },
      tracks: [track('r1.mp3', 'Uno'), track('r2.mp3', 'Due')],
    });
    const container = await mount(<FeaturedSectionView sectionId={RAP_ID} />);
    expect(container.querySelector('h1')?.textContent).toBe('Rap italiano');
    expect(container.textContent).toContain('Genere · In evidenza');
    expect(container.textContent).not.toContain('Sezione · In evidenza');
  });

  it('una cartella resta «Sezione · In evidenza»', async () => {
    mocks.apiFetch.mockResolvedValue({
      section: { id: RAP_ID, title: 'Cantautori', root: false },
      tracks: [track('c1.mp3', 'Uno')],
    });
    const container = await mount(<FeaturedSectionView sectionId={RAP_ID} />);
    expect(container.textContent).toContain('Sezione · In evidenza');
    expect(container.textContent).not.toContain('Genere · In evidenza');
  });
});
