// @polsia:user-owned — «In evidenza da audio.com» lato client: in Home una sezione per collection
// (eyebrow, titolo, card); un brano con licenza ammessa si suona nel player di Solco con la coda dei
// soli brani riproducibili, gli altri hanno «Ascolta su audio.com»; sotto ogni card l'attribuzione;
// senza sezioni niente. Pannello admin: collection da spuntare (al massimo 6), ordine con su/giù,
// «Salva la scelta» manda l'ordine al server; senza account l'invito a collegarlo.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(async () => undefined),
  togglePlayback: vi.fn(async () => undefined),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: 'idle',
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
  trackStreamPath: (track: { streamUrl?: string | null }) => track.streamUrl ?? null,
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));

import { AudioComFeaturedAdmin } from '@/components/custom/music/audiocom-featured-admin';
import { AudioComFeaturedSections } from '@/components/custom/music/audiocom-featured-sections';
import { audioComQualifiedId } from '@/lib/music/audiocom-license';

function track(id: string, license: string, streamable: boolean) {
  return {
    id,
    title: `Brano ${id}`,
    authorName: 'Artista',
    pageUrl: `https://audio.com/artista/audio/brano-${id}`,
    imageUrl: null,
    streamUrl: streamable ? `https://s3.audio.com/audio/${id}.mp3` : null,
    durationSeconds: 180,
    category: 'music',
    license,
  };
}

function collection(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Raccolta ${id}`,
    type: 'playlist',
    itemsCount: 3,
    listed: true,
    imageUrl: null,
    featured: false,
    ...extra,
  };
}

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
  return container;
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error('elemento mancante');
  await act(async () => {
    (element as HTMLElement).click();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const fn of Object.values(mocks)) fn.mockClear();
  mocks.apiFetch.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Home: «In evidenza da audio.com»', () => {
  const sections = {
    sections: [
      {
        id: '10',
        title: 'Novità',
        imageUrl: null,
        tracks: [track('1', 'cc-by', true), track('2', 'arr', false), track('3', 'cc-0', true)],
      },
    ],
  };

  it('una sezione con eyebrow e titolo; il brano CC si suona in Solco con la coda dei riproducibili', async () => {
    mocks.apiFetch.mockResolvedValue(sections);
    const container = await mount(<AudioComFeaturedSections />);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/music/audiocom/featured', expect.anything());
    expect(container.textContent).toContain('IN EVIDENZA · AUDIO.COM');
    expect(container.querySelector('h2')?.textContent).toBe('Novità');

    await click(container.querySelector('button[aria-label="Riproduci Brano 1 di Artista"]'));
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [played, path, queue] = mocks.playTrack.mock.calls[0] as unknown as [
      { qualifiedId: string },
      string,
      Array<{ qualifiedId: string }>,
    ];
    expect(played.qualifiedId).toBe(audioComQualifiedId('1'));
    expect(path).toBe('https://s3.audio.com/audio/1.mp3');
    expect(queue.map((item) => item.qualifiedId)).toEqual([
      audioComQualifiedId('1'),
      audioComQualifiedId('3'),
    ]);
  });

  it('brano senza licenza ammessa: niente pulsante di Solco, «Ascolta su audio.com» e attribuzione', async () => {
    mocks.apiFetch.mockResolvedValue(sections);
    const container = await mount(<AudioComFeaturedSections />);
    expect(container.querySelector('button[aria-label="Riproduci Brano 2 di Artista"]')).toBeNull();
    expect(buttonByText(container, 'Ascolta su audio.com')).toBeTruthy();
    const pageLinks = [...container.querySelectorAll('a')].filter((link) =>
      link.getAttribute('href')?.startsWith('https://audio.com/artista/audio/'),
    );
    expect(pageLinks).toHaveLength(3);
  });

  it('nessuna sezione o errore: non mostra nulla', async () => {
    mocks.apiFetch.mockResolvedValue({ sections: [] });
    expect((await mount(<AudioComFeaturedSections />)).innerHTML).toBe('');
    mocks.apiFetch.mockRejectedValue(new Error('offline'));
    expect((await mount(<AudioComFeaturedSections />)).innerHTML).toBe('');
  });
});

describe('admin: «In evidenza nella Home»', () => {
  it('spunta, ordina e salva la scelta nell’ordine', async () => {
    mocks.apiFetch.mockImplementation(
      async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === 'PUT') {
          const ids = JSON.parse(init.body ?? '{}').collectionIds as string[];
          return {
            status: 'ok',
            collections: [collection('10'), collection('11')].map((item) => ({
              ...item,
              featured: ids.includes(item.id),
            })),
            featuredIds: ids,
          };
        }
        return {
          status: 'ok',
          collections: [collection('10'), collection('11', { featured: true, listed: false })],
          featuredIds: ['11'],
        };
      },
    );
    const container = await mount(<AudioComFeaturedAdmin />);
    expect(container.textContent).toContain('non pubblica su audio.com');
    expect(container.textContent).toContain('1. Raccolta 11');
    const save = buttonByText(container, 'Salva la scelta');
    expect(save?.disabled).toBe(true);

    await click(container.querySelector('#audiocom-collection-10'));
    expect(container.textContent).toContain('2. Raccolta 10');
    await click(container.querySelector('button[aria-label="Sposta su: Raccolta 10"]'));
    expect(container.textContent).toContain('1. Raccolta 10');

    await click(buttonByText(container, 'Salva la scelta'));
    const put = mocks.apiFetch.mock.calls.find(
      (call) => (call[1] as { method?: string } | undefined)?.method === 'PUT',
    );
    expect(put?.[0]).toBe('/api/admin/audiocom/collections');
    expect(JSON.parse((put?.[1] as { body: string }).body)).toEqual({
      collectionIds: ['10', '11'],
    });
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('al massimo 6 collection', async () => {
    const all = Array.from({ length: 7 }, (_, index) => collection(String(index + 1)));
    mocks.apiFetch.mockResolvedValue({ status: 'ok', collections: all, featuredIds: [] });
    const container = await mount(<AudioComFeaturedAdmin />);
    for (const item of all) await click(container.querySelector(`#audiocom-collection-${item.id}`));
    expect(container.textContent).toContain('Ordine in Home (6 di 6)');
    expect(mocks.toastError).toHaveBeenCalledWith('Al massimo 6 collection in Home.');
  });

  it('senza account collegato: l’invito a collegarlo', async () => {
    mocks.apiFetch.mockResolvedValue({ status: 'disconnected', collections: [], featuredIds: [] });
    const container = await mount(<AudioComFeaturedAdmin />);
    expect(container.textContent).toContain('Collega prima l’account audio.com');
  });
});
