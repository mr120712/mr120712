// @polsia:user-owned — «Scarica offline» dei brani in evidenza nell'interfaccia: il pulsante di riga
// (pagine d'artista e di cartella) e quello sulla copertina in Home compaiono SOLO con `offline`
// true (e un id); «Scarica la cartella per offline» scarica i soli consentiti ed elenca gli altri
// come «solo streaming» con il motivo; senza accesso il messaggio di sempre; i crediti di una copia
// mostrano la licenza; la pagina admin «Diritti e testi» dice se la copia vale e perché.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  signedIn: true,
  fetch: vi.fn(),
  addDownloaded: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/diritti-testi' }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: null }) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
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
    playTrack: vi.fn(),
    togglePlayback: vi.fn(),
  }),
}));
vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({ signedIn: mocks.signedIn }),
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));
vi.mock('@/components/custom/music/featured-share-button', () => ({
  FeaturedShareButton: ({ track }: { track: { title: string; shareId?: string | null } }) =>
    track.shareId ? <button type="button">{`Condividi ${track.title}`}</button> : null,
}));
vi.mock('@/lib/local-music', () => ({
  addDownloadedTrack: mocks.addDownloaded,
  removeTrack: vi.fn(),
  listTracks: vi.fn(async () => []),
}));

import { FeaturedRightsDashboard } from '@/components/custom/admin/featured-rights-dashboard';
import { DownloadedTrackCredit } from '@/components/custom/music/downloaded-track-credit';
import { FeaturedSectionView } from '@/components/custom/music/featured-section-view';
import { HomeTracksSection } from '@/components/custom/music/home-tracks-section';
import type {
  AdminFeaturedRights,
  FeaturedRightsTrack,
} from '@/lib/contracts/admin-featured-rights';

const SECTION_ID = 'AbCdEfGhIjKlMnOpQrSt_-';
const ID_OK = 'O'.repeat(22);
const ID_NO = 'N'.repeat(22);

function track(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    artist: 'Autrice',
    streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
    durationSeconds: 0,
    artworkUrl: null,
    artistSlug: null,
    shareId: null,
    ...extra,
  };
}

const TRACKS = [
  track('Cantautori/Autrice - Concessa.mp3', 'Concessa', { shareId: ID_OK, offline: true }),
  track('Cantautori/Autrice - Su licenza.mp3', 'Su licenza', { shareId: ID_NO, offline: false }),
  track('Cantautori/Autrice - Vecchio server.mp3', 'Vecchio server', { shareId: 'V'.repeat(22) }),
];

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await flush();
  return container;
}

function byLabel(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.apiFetch.mockReset();
  mocks.fetch.mockReset();
  mocks.addDownloaded.mockReset();
  mocks.toast.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.signedIn = true;
  window.localStorage.clear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pagina di una cartella: «Scarica offline»', () => {
  beforeEach(() => {
    mocks.apiFetch.mockResolvedValue({
      section: { id: SECTION_ID, title: 'Cantautori', root: false },
      tracks: TRACKS,
    });
  });

  it('pulsante di riga SOLO per i brani con offline true', async () => {
    const container = await mountView();
    expect(byLabel(container, 'Scarica Concessa per l’ascolto offline')).not.toBeNull();
    expect(byLabel(container, 'Scarica Su licenza per l’ascolto offline')).toBeNull();
    expect(byLabel(container, 'Scarica Vecchio server per l’ascolto offline')).toBeNull();
    const rows = [...container.querySelectorAll('li[data-downloadable="true"]')];
    expect(rows).toHaveLength(1);
  });

  it('«Scarica la cartella per offline»: solo i consentiti, gli altri «solo streaming» con il motivo', async () => {
    const container = await mountView();
    // Il nome accessibile comincia con il testo visibile (WCAG 2.5.3 «Label in Name»).
    const button = byLabel(
      container,
      'Scarica la cartella per offline (1): i brani consentiti di Cantautori',
    );
    expect(button?.textContent).toBe('Scarica la cartella per offline (1)');
    expect(button?.getAttribute('aria-label')?.startsWith(button?.textContent ?? '-')).toBe(true);
    // La descrizione del pulsante è la frase breve, non l'elenco dei brani.
    const description = document.getElementById(button?.getAttribute('aria-describedby') ?? '');
    expect(description?.tagName).toBe('P');
    expect(description?.textContent).toBe(
      'Solo streaming: per questi brani il titolare non ha concesso la copia offline. (2 brani restano solo in streaming)',
    );
    expect(description?.querySelector('li')).toBeNull();
    expect(container.textContent).toContain(
      'Il titolare non ha concesso la copia offline: questo brano si ascolta solo in streaming.',
    );
    expect(container.textContent).toContain(
      'Questo brano in evidenza non è disponibile per la copia offline.',
    );

    // Scarica: UNA sola richiesta, all'id del brano consentito.
    mocks.fetch.mockResolvedValue(
      Response.json({ error: 'offline_not_allowed', message: 'Revocato.' }, { status: 403 }),
    );
    await act(async () => button?.click());
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe(`/api/music/featured/tracks/${ID_OK}/download`);
  });

  it('senza accesso: il messaggio per accedere, nessun download', async () => {
    mocks.signedIn = false;
    const container = await mountView();
    expect(container.textContent).toContain(
      'Accedi per scaricare i brani consentiti di questa cartella',
    );
    const row = byLabel(container, 'Scarica Concessa per l’ascolto offline');
    await act(async () => row?.click());
    expect(mocks.toast.error).toHaveBeenCalledWith('Per scaricare i brani devi prima accedere.');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('nessun brano con la copia offline: nessun pulsante di cartella', async () => {
    mocks.apiFetch.mockResolvedValue({
      section: { id: SECTION_ID, title: 'Cantautori', root: false },
      tracks: TRACKS.slice(1),
    });
    const container = await mountView();
    expect(container.textContent).not.toContain('Scarica la cartella per offline');
    expect(container.querySelector('li[data-downloadable="true"]')).toBeNull();
  });

  async function mountView() {
    return mount(<FeaturedSectionView sectionId={SECTION_ID} />);
  }
});

describe('Home: «Scarica offline» sulla copertina', () => {
  it('solo per i brani dichiarati con offline true', async () => {
    vi.useFakeTimers();
    const VERSION = 'd'.repeat(16);
    const items = [
      ...TRACKS,
      // Non dichiarato: nessun shareId, nessun offline (come lo manda il server).
      track('Download/Commerciale - Hit.mp3', 'Hit'),
    ];
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/music/home-tracks/version') {
        return { version: VERSION, updatedAt: '2026-11-15T10:00:00.000Z' };
      }
      return {
        items,
        sections: [{ id: 'Cantautori', title: 'Cantautori', items }],
        version: VERSION,
      };
    });
    const container = await mount(<HomeTracksSection />);
    const labels = [...container.querySelectorAll('button[aria-label^="Scarica "]')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Scarica Concessa per l’ascolto offline']);
  });
});

describe('crediti di una copia di un brano in evidenza', () => {
  it('titolare, licenza con link; nessun link «Brano su Audius»', async () => {
    const container = await mount(
      <DownloadedTrackCredit
        source="featured-download"
        title="Aperta"
        attribution={{
          sourceName: 'Solco · In evidenza',
          sourceUrl: null,
          licenseName: 'Creative Commons Attribuzione (CC BY)',
          licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.it',
          creditLine: '© Band',
        }}
      />,
    );
    expect(container.textContent).toContain('© Band');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://creativecommons.org/licenses/by/4.0/deed.it');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).not.toContain('Audius');
  });
});

describe('admin «Diritti e testi»: copia offline', () => {
  function row(pathname: string, extra: Partial<FeaturedRightsTrack>): FeaturedRightsTrack {
    const name = pathname.slice(pathname.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    return {
      pathname,
      folder: 'Cantautori',
      section: 'Cantautori',
      title: name,
      artist: null,
      declared: true,
      licenza: 'propria',
      titolare: 'Autrice',
      testo: false,
      testoOffBy: null,
      sidecars: { lrc: false, txt: false },
      lyrics: { status: 'not_checked' },
      ...extra,
    };
  }

  const report: AdminFeaturedRights = {
    generatedAt: '2026-11-15T10:00:00.000Z',
    store: { status: 'ok', listedAt: '2026-11-15T10:00:00.000Z', reason: null },
    manifest: {
      status: 'valid',
      reasons: [],
      location: null,
      counts: { entries: 5, valid: 4, invalid: 0, ignored: 1 },
      problems: [],
    },
    summary: {
      totalTracks: 5,
      declared: 4,
      declaredWithLyrics: 0,
      lyricsFound: 0,
      lyricsMissing: 0,
      lyricsErrors: 0,
      lyricsSkipped: 0,
      lyricsNotShown: 0,
      manifestProblems: 1,
      offlineAllowed: 2,
    },
    tracks: [
      row('Cantautori/Dalla licenza.mp3', {
        offline: { allowed: true, basis: 'licence_default', offBy: null },
      }),
      row('Cantautori/Con opt-in.mp3', {
        licenza: 'licenza',
        titolare: 'Etichetta',
        offline: { allowed: true, basis: 'opt_in', offBy: null },
      }),
      row('Cantautori/Senza opt-in.mp3', {
        licenza: 'licenza',
        titolare: 'Etichetta',
        offline: { allowed: false, basis: 'licence_needs_opt_in', offBy: null },
      }),
      row('Cantautori/Doppione.mp3', {
        offline: { allowed: false, basis: 'opt_out', offBy: 5 },
      }),
      row('Download/Non dichiarato.mp3', {
        declared: false,
        licenza: null,
        titolare: null,
      }),
    ],
    tracksTruncated: false,
  };

  it('scheda di sintesi, distintivi e perché per ogni brano dichiarato', async () => {
    mocks.apiFetch.mockImplementation(
      async (_path: string, init?: { schema?: { parse: (value: unknown) => unknown } }) =>
        init?.schema ? init.schema.parse(report) : report,
    );
    const container = await mount(<FeaturedRightsDashboard />);
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('Copia offline');
    expect(text).toContain('consentita (dalla licenza)');
    expect(text).toContain('consentita ("offline": true)');
    expect(text).toContain('spenta (licenza senza "offline": true)');
    expect(text).toContain('spenta (voci in disaccordo)');
    expect(text).toContain(
      'Copia offline spenta: con la licenza "licenza" (contratto) serve "offline": true',
    );
    expect(text).toContain('la voce n. 5 non la consente');
    const articles = [...container.querySelectorAll('article')];
    const undeclared = articles.find((article) => article.textContent?.includes('Non dichiarato'));
    expect(undeclared?.textContent).not.toContain('Copia offline');
    expect(undeclared?.textContent).not.toContain('Solo streaming');
  });
});
