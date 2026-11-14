// @polsia:user-owned — testi della classifica «Brani più ascoltati dalla community ❤️» in Home e
// su /pubblica: il cuore è decorativo (aria-hidden) e il nome accessibile del titolo sono solo le
// parole; podio delle prime 3 posizioni; "N ascolti"; stati vuoto, errore e caricamento.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: 'idle',
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
}));
vi.mock('@/components/custom/music/public-upload-form', () => ({ PublicUploadForm: () => null }));
vi.mock('@/components/custom/music/upload-lyrics', () => ({ UploadLyricsEditor: () => null }));

import { PublicLibraryView } from '@/components/custom/music/public-library-view';
import {
  COMMUNITY_CHART_TITLE,
  PublicUploadsChart,
} from '@/components/custom/music/public-uploads-chart';
import { PublicUploadsHomeSection } from '@/components/custom/music/public-uploads-home-section';
import type { PublicUpload } from '@/lib/contracts/public-uploads';

const TITLE = 'Brani più ascoltati dalla community';
const STREAM = 'https://abc.public.blob.vercel-storage.com/public-uploads/x.mp3';

function upload(index: number, playCount: number, extra: Partial<PublicUpload> = {}): PublicUpload {
  return {
    id: `upload${String(index).padStart(20, '0')}`,
    title: `Brano ${index}`,
    artist: null,
    streamUrl: STREAM,
    durationSeconds: 120,
    playCount,
    createdAt: '2026-11-01T10:00:00.000Z',
    mine: false,
    published: true,
    canPlay: true,
    ...extra,
  };
}

type FetchInit = { schema?: { parse: (value: unknown) => unknown } };

/** Risponde come il vero apiFetch: lo schema del contratto valida i dati di prova. */
function respond(items: PublicUpload[]) {
  mocks.apiFetch.mockImplementation(async (_path: string, init?: FetchInit) =>
    init?.schema ? init.schema.parse({ items }) : { items },
  );
}

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

async function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => root.render(node));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

/** Nome accessibile testuale: il contenuto aria-hidden non conta. */
function accessibleName(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function heading(container: HTMLElement, id: string) {
  const element = container.querySelector(`h2#${id}`);
  if (!element) throw new Error(`Titolo #${id} non trovato.`);
  return element;
}

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  respond([]);
});

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

describe('titolo della classifica della community', () => {
  it('in Home: occhiello, titolo con il cuore nascosto ai lettori di schermo', async () => {
    const container = await mount(<PublicUploadsHomeSection />);
    const section = container.querySelector('section#community-uploads');
    const title = heading(container, 'community-uploads-heading');

    expect(COMMUNITY_CHART_TITLE).toBe(TITLE);
    expect(section?.getAttribute('aria-labelledby')).toBe('community-uploads-heading');
    expect(title.textContent?.replace(/\s+/g, ' ').trim()).toBe(`${TITLE} ❤️`);
    expect(accessibleName(title)).toBe(TITLE);
    const heart = title.querySelector('[aria-hidden="true"]');
    expect(heart?.textContent).toBe('❤️');
    // Spazio indivisibile: su schermi stretti il cuore non va a capo da solo.
    expect(title.textContent).toContain('community\u00a0❤️');
    expect(container.textContent).toContain('CLASSIFICA DELLA COMMUNITY');
    expect(container.textContent).not.toContain('Brani della community');
    expect(container.textContent).not.toContain('LIBRERIA PUBBLICA');
  });

  it('in Home: "Vedi tutti" porta a /pubblica e il nome accessibile comincia dal testo visibile', async () => {
    const container = await mount(<PublicUploadsHomeSection />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/pubblica"]');
    expect(link?.textContent).toBe('Vedi tutti');
    expect(link?.getAttribute('aria-label')).toBe(
      'Vedi tutti i brani più ascoltati dalla community',
    );
  });

  it('su /pubblica: stesso titolo, cuore aria-hidden, nota sul conteggio onesto', async () => {
    const container = await mount(<PublicLibraryView />);
    const section = container.querySelector('section[aria-labelledby="public-chart-heading"]');
    const title = heading(container, 'public-chart-heading');
    expect(section).not.toBeNull();
    expect(accessibleName(title)).toBe(TITLE);
    expect(title.querySelector('[aria-hidden="true"]')?.textContent).toBe('❤️');
    expect(section?.textContent).toContain('CLASSIFICA DELLA COMMUNITY');
    expect(section?.textContent).toContain('al massimo un ascolto al giorno');
    expect(container.textContent).not.toContain('Brani della community');
  });
});

describe('righe della classifica', () => {
  it('posizioni, podio delle prime 3 e "N ascolti" (formato italiano)', async () => {
    respond([upload(1, 12_345), upload(2, 40), upload(3, 1), upload(4, 0)]);
    const container = await mount(<PublicUploadsChart />);
    const rows = [...container.querySelectorAll('ol > li')];
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelector('[aria-hidden="true"]')?.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(rows.map((row) => row.getAttribute('data-podium'))).toEqual([
      'true',
      'true',
      'true',
      null,
    ]);
    expect(rows[0]?.textContent).toContain('12.345 ascolti');
    expect(rows[1]?.textContent).toContain('40 ascolti');
    expect(rows[2]?.textContent).toContain('1 ascolto');
    expect(rows[3]?.textContent).toContain('0 ascolti');
  });

  it('un brano a "0 ascolti" non va sul podio, anche tra i primi 3', async () => {
    respond([upload(1, 7), upload(2, 0), upload(3, 0), upload(4, 0)]);
    const container = await mount(<PublicUploadsChart />);
    const rows = [...container.querySelectorAll('ol > li')];
    expect(rows.map((row) => row.getAttribute('data-podium'))).toEqual(['true', null, null, null]);
    // Il numero di posizione resta: cambia solo il risalto.
    expect(rows.map((row) => row.querySelector('[aria-hidden="true"]')?.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(rows[1]?.textContent).toContain('0 ascolti');
  });

  it('classifica appena nata (tutti a 0): nessun podio', async () => {
    respond([upload(1, 0), upload(2, 0)]);
    const container = await mount(<PublicUploadsChart />);
    const rows = [...container.querySelectorAll('ol > li')];
    expect(rows.map((row) => row.getAttribute('data-podium'))).toEqual([null, null]);
  });

  it('in Home mostra solo le prime 5', async () => {
    respond([1, 2, 3, 4, 5, 6, 7].map((index) => upload(index, 10 - index)));
    const container = await mount(<PublicUploadsHomeSection />);
    expect(container.querySelectorAll('ol > li')).toHaveLength(5);
  });

  it('stato vuoto coerente con la classifica', async () => {
    respond([]);
    const container = await mount(<PublicUploadsChart />);
    expect(container.textContent).toBe(
      'La classifica della community è ancora vuota. Pubblica il primo brano e falla partire.',
    );
  });

  it('errore di caricamento', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('offline'));
    const container = await mount(<PublicUploadsChart />);
    expect(container.textContent).toBe('Classifica non disponibile in questo momento.');
  });

  it('un ascolto avvia il player e segnala la riproduzione al server (una POST)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    respond([upload(1, 3)]);
    const container = await mount(<PublicUploadsChart />);
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Riproduci Brano 1"]',
    );
    await act(async () => button?.click());
    expect(mocks.playTrack).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(`/api/music/public-uploads/${upload(1, 3).id}/play`, {
      method: 'POST',
    });
  });
});
