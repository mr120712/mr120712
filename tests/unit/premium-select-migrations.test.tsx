// @polsia:user-owned — i <select> nativi sostituiti dal menu premium (SolcoSelect) mantengono lo
// stesso comportamento: compleanno in /premi (stessi valori "1"–"31" e "1"–"12", stesso POST, anche
// dal bottom sheet sul telefono), paese delle radio in /radio (stessa richiesta, "" = tutto il mondo,
// nessun invio del form) e cartella delle playlist in /library (stessa mutazione e stessi messaggi,
// nessuna chiamata se la cartella non cambia).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  mutate: vi.fn(),
  // Sessione stabile: RewardsView ricarica i premi quando cambia l'utente della sessione.
  session: {
    data: {
      user: { id: 'account-a', name: 'Ada Rossi', email: 'ada@example.test', emailVerified: true },
    },
    isPending: false,
  },
  folders: [] as Array<{ id: string; name: string; playlistIds: string[] }>,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/library',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: lo stub inoltra ciò che il componente passa.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));
vi.mock('@/lib/auth-client', () => ({
  authClient: {},
  useSession: () => mocks.session,
}));
vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({
    signedIn: true,
    loading: false,
    library: { stations: [], podcasts: [], folders: mocks.folders, history: [], hidden: [] },
    refresh: async () => undefined,
    mutate: mocks.mutate,
    isHidden: () => false,
    isStationSaved: () => false,
    isPodcastFollowed: () => false,
  }),
}));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: 'idle',
    playTrack: vi.fn(),
    togglePlayback: vi.fn(),
  }),
  trackStreamPath: (track: { qualifiedId: string }) => `/stream/${track.qualifiedId}`,
}));
vi.mock('@/components/custom/music/radio-station-tile', () => ({
  StationTile: ({ station }: { station: { name: string } }) => <div>{station.name}</div>,
}));
vi.mock('@/components/custom/share-menu', () => ({ ShareMenu: () => null }));
vi.mock('@/components/custom/telegram-link-button', () => ({ TelegramLinkButton: () => null }));
vi.mock('@/components/custom/telegram-mini-app-button', () => ({
  TelegramMiniAppButton: () => null,
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));
vi.mock('@/components/custom/music/local-music-section', () => ({ LocalMusicSection: () => null }));
vi.mock('@/components/custom/music/spotify-import', () => ({ SpotifyImport: () => null }));
vi.mock('@/components/custom/music/track-list-import', () => ({ TrackListImport: () => null }));
vi.mock('@/components/custom/music/ai-organize', () => ({ AiOrganize: () => null }));
vi.mock('@/components/custom/music/offline-download-button', () => ({
  OfflineDownloadButton: () => null,
}));
vi.mock('@/components/custom/music/recently-played-row', () => ({
  useHistoryPlayback: () => ({ isPlaying: () => false, play: () => undefined }),
}));

import { LibraryView } from '@/components/custom/music/library-view';
import { RadioDirectory } from '@/components/custom/music/radio-directory';
import { RewardsView } from '@/components/custom/rewards-view';

type Init = RequestInit & { schema?: ZodType<unknown> };

const rewardsSummary = {
  code: 'ADA7',
  founderNumber: null,
  birthday: null,
  friends: { joined: 0, qualified: 0 },
  listening: { qualifyingDays: 0, nextRewardIn: 10 },
  loyaltyMonths: null,
  activeGrantUntil: null,
  premiumUntil: null,
  grants: [],
};

const libraryCollections = {
  collections: [
    {
      id: 'pl-1',
      name: 'Primo',
      kind: 'playlist',
      createdAt: '2026-11-01T00:00:00.000Z',
      items: [],
    },
    {
      id: 'pl-2',
      name: 'Notte in città',
      kind: 'playlist',
      folderId: 'f1',
      createdAt: '2026-11-03T00:00:00.000Z',
      items: [],
    },
  ],
};

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.mutate.mockReset();
  mocks.mutate.mockResolvedValue(true);
  mocks.folders = [];
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  vi.unstubAllGlobals();
});

function serve(handler: (url: string, init?: Init) => unknown) {
  mocks.apiFetch.mockImplementation(async (url: string, init?: Init) => {
    const value = await handler(url, init);
    return init?.schema ? init.schema.parse(value) : value;
  });
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await flush();
  return container;
}

function combobox(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="combobox"]')].find(
    (node) => node.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`menu ${name} mancante`);
  return found;
}

function optionLabels() {
  return [...document.querySelectorAll('[role="option"]')].map((node) => node.textContent);
}

async function choose(name: string, label: string) {
  await act(async () => combobox(name).click());
  await flush();
  const target = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === label,
  );
  if (!target) throw new Error(`opzione ${label} mancante in ${name}`);
  await act(async () => target.click());
  await flush();
}

describe('/premi: compleanno con i menu premium', () => {
  function serveRewards() {
    serve((url, init) => {
      expect(url).toBe('/api/rewards');
      return init?.method === 'POST' ? { ok: true } : rewardsSummary;
    });
  }

  function saveButton() {
    return [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(
      (node) => node.textContent === 'Salva',
    );
  }

  it('stesse opzioni ed etichette, stesso POST di prima', async () => {
    serveRewards();
    await render(<RewardsView />);
    expect(document.querySelector('select')).toBeNull();
    const day = combobox('Giorno');
    const month = combobox('Mese');
    expect(day.id).toBe('bday-day');
    expect(month.id).toBe('bday-month');
    expect(day.textContent).toBe('Giorno');
    expect(month.textContent).toBe('Mese');
    // Dentro il form ma senza inviarlo: sono pulsanti normali.
    expect(day.type).toBe('button');
    expect(saveButton()?.disabled).toBe(true);

    await act(async () => day.click());
    expect(optionLabels()).toEqual(Array.from({ length: 31 }, (_, index) => String(index + 1)));
    await act(async () => day.click());

    await choose('Giorno', '15');
    expect(day.textContent).toBe('15');
    expect(saveButton()?.disabled).toBe(true);

    await act(async () => month.click());
    expect(optionLabels()).toEqual([
      'gennaio',
      'febbraio',
      'marzo',
      'aprile',
      'maggio',
      'giugno',
      'luglio',
      'agosto',
      'settembre',
      'ottobre',
      'novembre',
      'dicembre',
    ]);
    await act(async () => month.click());
    await choose('Mese', 'marzo');
    expect(month.textContent).toBe('marzo');
    expect(saveButton()?.disabled).toBe(false);

    await act(async () => saveButton()?.click());
    await flush();
    const post = mocks.apiFetch.mock.calls.find(([, init]) => (init as Init)?.method === 'POST');
    expect(post?.[0]).toBe('/api/rewards');
    expect((post?.[1] as Init).body).toBe(
      JSON.stringify({ action: 'set_birthday', birthday: '03-15' }),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Compleanno salvato: ti aspetta un regalo!');
  });

  it('sul telefono giorno e mese si scelgono dal bottom sheet, con lo stesso POST', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 639px)',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    serveRewards();
    await render(<RewardsView />);
    await act(async () => combobox('Giorno').click());
    await flush();
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet?.textContent).toContain('Giorno del compleanno');
    expect(sheet?.querySelector('[role="listbox"]')?.getAttribute('data-layout')).toBe('grid');
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((node) => node.textContent === '7')
        ?.click(),
    );
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await choose('Mese', 'dicembre');
    await act(async () => saveButton()?.click());
    await flush();
    const post = mocks.apiFetch.mock.calls.find(([, init]) => (init as Init)?.method === 'POST');
    expect((post?.[1] as Init).body).toBe(
      JSON.stringify({ action: 'set_birthday', birthday: '12-07' }),
    );
  });
});

describe('/radio: paese con il menu premium', () => {
  it('stessi paesi, stessa richiesta; "Tutto il mondo" toglie il filtro; il form non parte', async () => {
    const urls: string[] = [];
    serve((url) => {
      urls.push(url);
      return { outcome: 'results', stations: [] };
    });
    const container = await render(<RadioDirectory />);
    expect(container.querySelector('select')).toBeNull();
    expect(urls).toEqual(['/api/music/radio?limit=48&country=IT']);
    const country = combobox('Paese');
    expect(country.id).toBe('radio-country');
    expect(country.textContent).toBe('ITItalia');
    expect(country.closest('form')).not.toBeNull();
    expect(country.type).toBe('button');

    await act(async () => country.click());
    expect(optionLabels()).toEqual([
      'ITItalia',
      'Tutto il mondo',
      'USStati Uniti',
      'GBRegno Unito',
      'FRFrancia',
      'DEGermania',
      'ESSpagna',
      'BRBrasile',
      'JPGiappone',
    ]);
    const world = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === 'Tutto il mondo',
    );
    await act(async () => world?.click());
    await flush();
    expect(urls.at(-1)).toBe('/api/music/radio?limit=48');

    await choose('Paese', 'FRFrancia');
    expect(urls.at(-1)).toBe('/api/music/radio?limit=48&country=FR');
    expect(country.textContent).toBe('FRFrancia');
    expect(urls).toHaveLength(3);
  });
});

describe('/library: cartella della playlist con il menu premium', () => {
  it('stessa mutazione e stessi messaggi; nessuna chiamata se la cartella non cambia', async () => {
    mocks.folders = [
      { id: 'f1', name: 'Viaggi', playlistIds: ['pl-2'] },
      { id: 'f2', name: 'Sera', playlistIds: [] },
    ];
    serve((url) => (url === '/api/music/collections' ? libraryCollections : null));
    const container = await render(<LibraryView />);
    expect(container.querySelector('select')).toBeNull();

    const night = combobox('Cartella di Notte in città');
    expect(night.id).toBe('folder-pl-2');
    expect(night.textContent).toBe('Viaggi');
    expect(combobox('Cartella di Primo').textContent).toBe('Nessuna cartella');

    await act(async () => night.click());
    expect(optionLabels()).toEqual(['Nessuna cartella', 'Viaggi', 'Sera']);
    await act(async () => night.click());

    await choose('Cartella di Notte in città', 'Sera');
    expect(mocks.mutate).toHaveBeenCalledWith(
      { action: 'move_playlist', collectionId: 'pl-2', folderId: 'f2' },
      'Playlist spostata nella cartella.',
    );

    await choose('Cartella di Notte in città', 'Nessuna cartella');
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      { action: 'move_playlist', collectionId: 'pl-2', folderId: null },
      'Playlist spostata nella Libreria.',
    );

    // «Primo» è già senza cartella: riscegliere la stessa voce non chiama il server.
    await choose('Cartella di Primo', 'Nessuna cartella');
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
  });
});
