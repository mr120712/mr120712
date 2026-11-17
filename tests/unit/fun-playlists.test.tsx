// @polsia:user-owned — playlist divertenti «di casa»: ogni copertina disegnata si rende (decorativa
// accanto al nome, descritta quando sta da sola), la riga della Home/Libreria e la griglia di
// /generi portano a /generi/<slug> con la copertina giusta.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import GenresPage from '@/app/(custom)/generi/page';
import {
  FunPlaylistGrid,
  FunPlaylistsRow,
  isFunPlaylist,
} from '@/components/custom/music/fun-playlist-tile';
import { PlaylistCover } from '@/components/custom/music/playlist-cover';
import { funPlaylists } from '@/lib/music/genre-catalog';
import { PLAYLIST_COVER_IDS, PLAYLIST_COVER_LABELS } from '@/lib/music/playlist-covers';

const roots: Array<ReturnType<typeof createRoot>> = [];

async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('copertine disegnate', () => {
  it('ogni copertina è un SVG inline senza script, decorativo quando il nome sta accanto', async () => {
    for (const cover of PLAYLIST_COVER_IDS) {
      const container = await render(<PlaylistCover cover={cover} />);
      const svg = container.querySelector('svg');
      expect(svg, cover).not.toBeNull();
      expect(svg?.getAttribute('data-cover'), cover).toBe(cover);
      expect(svg?.getAttribute('viewBox'), cover).toBe('0 0 200 200');
      expect(svg?.getAttribute('aria-hidden'), cover).toBe('true');
      expect(svg?.querySelector('script, image, foreignObject, a'), cover).toBeNull();
      // Un disegno vero: più di una forma, con lo sfondo pieno.
      expect(svg?.children.length ?? 0, cover).toBeGreaterThan(4);
      const background = svg?.querySelector('rect[width="200"][height="200"]');
      expect(background, cover).not.toBeNull();
    }
  });

  it('da sola, la copertina descrive il disegno (il comodino con il piede)', async () => {
    const container = await render(<PlaylistCover cover="comodino" decorative={false} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe(PLAYLIST_COVER_LABELS.comodino);
    expect(svg?.getAttribute('aria-label')).toContain('comodino');
    expect(svg?.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('riga e griglia delle playlist divertenti', () => {
  it('la riga ha un link per ogni playlist del server, con copertina, nome e descrizione', async () => {
    const container = await render(<FunPlaylistsRow />);
    const section = container.querySelector('section#playlist-divertenti');
    expect(section).not.toBeNull();
    expect(section?.querySelector('h2')?.textContent).toBe('Playlist divertenti');
    expect(section?.getAttribute('aria-labelledby')).toBe('playlist-divertenti-heading');
    const links = [...(section?.querySelectorAll<HTMLAnchorElement>('ul a') ?? [])];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      funPlaylists.map((entry) => `/generi/${entry.slug}`),
    );
    for (const entry of funPlaylists) {
      const link = links.find((item) => item.getAttribute('href') === `/generi/${entry.slug}`);
      expect(link?.getAttribute('aria-label'), entry.slug).toBe(`Apri la playlist ${entry.name}`);
      expect(link?.querySelector(`svg[data-cover="${entry.cover}"]`), entry.slug).not.toBeNull();
      expect(link?.textContent, entry.slug).toContain(entry.name);
      expect(link?.textContent, entry.slug).toContain(entry.description);
    }
    const comodino = links.find((item) => item.getAttribute('href') === '/generi/piede-comodino');
    expect(comodino?.querySelector('svg[data-cover="comodino"]')).not.toBeNull();
    // Il link a tutte le playlist e la nota.
    expect(
      [...(section?.querySelectorAll('a') ?? [])].some(
        (link) =>
          link.getAttribute('href') === '/generi' && link.textContent === 'Tutte le playlist',
      ),
    ).toBe(true);
    expect(section?.textContent).toContain('Pronte nel server');
  });

  it('nella Libreria la riga usa un h3 con titolo e nota propri', async () => {
    const container = await render(
      <FunPlaylistsRow
        id="libreria-playlist-divertenti"
        title="Playlist pronte di Solco"
        eyebrow="DIVERTENTI"
        note="Sono di Solco."
        headingLevel={3}
      />,
    );
    const section = container.querySelector('section#libreria-playlist-divertenti');
    expect(section?.querySelector('h2')).toBeNull();
    expect(section?.querySelector('h3')?.textContent).toBe('Playlist pronte di Solco');
    expect(section?.textContent).toContain('DIVERTENTI');
    expect(section?.textContent).toContain('Sono di Solco.');
  });

  it('la pagina /generi apre con le playlist divertenti in griglia, poi le altre famiglie', async () => {
    const container = await render(<GenresPage />);
    const headings = [...container.querySelectorAll('h2')].map((heading) => heading.textContent);
    expect(headings[0]).toBe('Playlist divertenti');
    expect(headings[1]).toBe('Playlist Solco');
    const first = container.querySelector('section');
    const covers = [...(first?.querySelectorAll('svg[data-cover]') ?? [])].map((svg) =>
      svg.getAttribute('data-cover'),
    );
    expect(covers).toEqual(funPlaylists.map((entry) => entry.cover));
    expect(first?.querySelector('a[href="/generi/piede-comodino"]')).not.toBeNull();
    // Le playlist a tema e i generi restano link di testo, senza copertina.
    expect(container.querySelectorAll('svg[data-cover]').length).toBe(funPlaylists.length);
    expect(container.querySelector('a[href="/generi/natale"]')).not.toBeNull();
    expect(container.querySelector('a[href="/generi/techno"]')).not.toBeNull();
  });

  it('la griglia accetta un sottoinsieme e salta le voci senza copertina', async () => {
    const [first, second] = funPlaylists.filter(isFunPlaylist);
    expect(first && second).toBeTruthy();
    if (!first || !second) return;
    const container = await render(<FunPlaylistGrid playlists={[first, second]} />);
    expect(container.querySelectorAll('li').length).toBe(2);
    expect(isFunPlaylist({ ...first, cover: undefined })).toBe(false);
    expect(isFunPlaylist({ ...first, family: 'playlist' })).toBe(false);
  });
});
