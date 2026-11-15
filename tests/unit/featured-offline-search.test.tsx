// @polsia:user-owned — «Scarica offline» nella ricerca unificata: sulla riga di un brano in
// evidenza compare lo stesso pulsante a icona delle pagine d'artista e di cartella SOLO quando il
// server manda `offline` true e il brano ha il suo id opaco (shareId). Per ogni altra riga (brano
// senza permesso, senza id, non dichiarato, Audius, radio, podcast) non c'è nessun pulsante e la
// riga resta com'era. Senza accesso il pulsante dice che serve accedere; un tocco non fa mai
// partire il brano. Su un telefono la riga con tre pulsanti lascia meno spazio alla colonna del
// testo: «Ascolta su YouTube» ha lì un margine più stretto (una riga a 390 px) e la sua icona non
// si restringe mai.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  fetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  signedIn: true,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  addDownloaded: vi.fn(),
  getTrack: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({ replace: vi.fn() }),
}));
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
  trackStreamPath: (track: { qualifiedId: string }) => `/stream/${track.qualifiedId}`,
}));
vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({ signedIn: mocks.signedIn }),
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));
vi.mock('@/components/custom/music/ai-music-search', () => ({ AiMusicSearch: () => null }));
vi.mock('@/components/custom/music/listen-in-solco', () => ({ ListenInSolco: () => null }));
vi.mock('@/components/custom/music/admin-search-hint', () => ({ AdminSearchHint: () => null }));
vi.mock('@/components/custom/music/library-search-results', () => ({
  LibrarySearchResults: () => null,
  librarySearchCount: () => 0,
}));
vi.mock('@/lib/local-music', () => ({
  addDownloadedTrack: mocks.addDownloaded,
  getTrack: mocks.getTrack,
  removeTrack: vi.fn(),
}));

import { UnifiedSearchResults } from '@/components/custom/music/unified-search-results';

const ID_OK = 'AbCdEfGhIjKlMnOpQrStUv';
const ID_NO = 'NNNNNNNNNNNNNNNNNNNNNN';
const ID_OLD = 'VVVVVVVVVVVVVVVVVVVVVV';

function featured(title: string, extra: Record<string, unknown> = {}) {
  const id = `Cantautori/Autrice - ${title}.mp3`;
  return {
    id,
    title,
    artist: 'Autrice',
    streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
    durationSeconds: 0,
    artworkUrl: null,
    ...extra,
  };
}

// Dichiarato, copia offline consentita: l'unica riga con «Scarica offline».
const allowed = featured('Concessa', { shareId: ID_OK, offline: true });
// Dichiarato ma solo streaming.
const streamingOnly = featured('Su licenza', { shareId: ID_NO, offline: false });
// Server meno recente: manda l'id ma non `offline`.
const oldServer = featured('Vecchio server', { shareId: ID_OLD });
// Permesso senza id (condivisione spenta) o con un id malformato: non si può scaricare.
const noId = featured('Senza id', { shareId: null, offline: true });
const badId = featured('Id rovinato', { shareId: 'troppo-corto', offline: true });
// Non dichiarato in diritti.json: né id né `offline` (come lo manda il server).
const undeclared = featured('Non dichiarato');

const audiusTrack = {
  provider: 'audius',
  id: 'abc123',
  qualifiedId: 'audius:abc123',
  title: 'Brano Audius',
  artistName: 'Artista',
  artistHandle: 'artista',
  artistId: 'art1',
  artistQualifiedId: 'audius:art1',
  artistUrl: 'https://audius.co/artista',
  trackUrl: 'https://audius.co/artista/brano',
  artworkUrl: null,
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
const station = {
  id: 'radio1',
  name: 'Radio di prova',
  artworkUrl: null,
  country: 'Italia',
  countryCode: 'IT',
  tags: [],
  codec: null,
  bitrate: null,
  homepage: null,
  votes: 0,
};
const podcast = {
  id: '99',
  title: 'Podcast di prova',
  author: 'RAI',
  artworkUrl: null,
  genre: null,
};

const FEATURED = [allowed, streamingOnly, oldServer, noId, badId, undeclared];

const response = {
  query: 'prova',
  youtubeRequested: false,
  results: [
    ...FEATURED.map((track, index) => ({
      kind: 'featured',
      key: `featured:${track.id}`,
      score: 100 - index,
      track,
      youtubeAlternative: null,
    })),
    {
      kind: 'audius',
      key: 'audius:abc123',
      score: 50,
      track: audiusTrack,
      youtubeAlternative: null,
    },
    { kind: 'radio', key: 'radio:radio1', score: 40, station },
    { kind: 'podcast', key: 'podcast:99', score: 30, podcast },
  ],
  sources: {
    featured: { status: 'results', tracks: FEATURED },
    audius: { status: 'results', tracks: [audiusTrack], artists: [], playlists: [], albums: [] },
    youtube: { status: 'skipped', videos: [] },
    radio: { status: 'results', stations: [station] },
    podcasts: { status: 'results', podcasts: [podcast] },
  },
};

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<UnifiedSearchResults initialQuery="prova" />));
  await flush();
  return container;
}

function featuredRow(container: HTMLElement, title: string): HTMLLIElement {
  const row = [...container.querySelectorAll<HTMLLIElement>('li[data-kind="featured"]')].find(
    (item) => item.querySelector('strong')?.textContent === title,
  );
  if (!row) throw new Error(`Nessuna riga per «${title}»`);
  return row;
}

function downloadButtons(scope: ParentNode) {
  return [
    ...scope.querySelectorAll<HTMLButtonElement>('button[aria-label$="per l’ascolto offline"]'),
  ];
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', mocks.fetch);
  window.localStorage.clear();
  for (const mock of [
    mocks.apiFetch,
    mocks.fetch,
    mocks.playTrack,
    mocks.togglePlayback,
    mocks.toast,
    mocks.toast.success,
    mocks.toast.error,
    mocks.addDownloaded,
    mocks.getTrack,
  ]) {
    mock.mockReset();
  }
  mocks.signedIn = true;
  mocks.apiFetch.mockResolvedValue(response);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Cerca unificata: «Scarica offline» sui brani in evidenza', () => {
  it('il pulsante compare SOLO sulla riga con offline true e un id valido', async () => {
    const container = await mount();
    expect(container.querySelectorAll('li[data-kind="featured"]')).toHaveLength(FEATURED.length);

    // Un solo pulsante in tutta la pagina, con il nome di sempre.
    expect(downloadButtons(container).map((button) => button.getAttribute('aria-label'))).toEqual([
      'Scarica Concessa per l’ascolto offline',
    ]);
    const row = featuredRow(container, 'Concessa');
    const [button] = downloadButtons(row);
    expect(button).toBeDefined();
    expect(button?.getAttribute('title')).toBe('Scarica offline');
    // Solo l'icona: il nome accessibile è quello completo.
    expect(button?.textContent).toBe('');
    expect(row.getAttribute('data-downloadable')).toBe('true');

    for (const title of [
      'Su licenza',
      'Vecchio server',
      'Senza id',
      'Id rovinato',
      'Non dichiarato',
    ]) {
      const other = featuredRow(container, title);
      expect(downloadButtons(other), title).toEqual([]);
      expect(other.hasAttribute('data-downloadable'), title).toBe(false);
    }
    // Nessun pulsante sulle righe delle altre fonti.
    const others = [...container.querySelectorAll('ol li')].filter(
      (item) => item.getAttribute('data-kind') !== 'featured',
    );
    expect(others).toHaveLength(3);
    for (const item of others) expect(downloadButtons(item)).toEqual([]);
  });

  it('le righe senza offline true restano com’erano: stesse azioni, nessuna classe in più', async () => {
    const container = await mount();
    const withButton = featuredRow(container, 'Concessa');
    const declared = featuredRow(container, 'Su licenza');
    const plain = featuredRow(container, 'Non dichiarato');

    const labels = (row: HTMLLIElement) =>
      [...row.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
    // Brano dichiarato senza copia offline: «Condividi» e «Riproduci», come prima.
    expect(labels(declared)).toEqual(['Condividi Su licenza', 'Riproduci Su licenza di Autrice']);
    // Brano non dichiarato: solo «Riproduci».
    expect(labels(plain)).toEqual(['Riproduci Non dichiarato di Autrice']);
    expect(declared.className).toBe(plain.className);
    // Con la copia offline: «Scarica offline» prima di «Condividi» e «Riproduci», mai dentro.
    expect(labels(withButton)).toEqual([
      'Scarica Concessa per l’ascolto offline',
      'Condividi Concessa',
      'Riproduci Concessa di Autrice',
    ]);
    expect(withButton.className).not.toBe(plain.className);
  });

  it('un tocco scarica dalla rotta del brano (id opaco) e non fa partire la riproduzione', async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ error: 'offline_not_allowed', message: 'Revocato.' }, { status: 403 }),
    );
    const container = await mount();
    const [button] = downloadButtons(featuredRow(container, 'Concessa'));
    await act(async () => button?.click());
    await flush();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe(`/api/music/featured/tracks/${ID_OK}/download`);
    expect(String(mocks.fetch.mock.calls[0]?.[0])).not.toContain('Cantautori');
    // Il server ha detto di no (permesso revocato nel frattempo): il motivo, nessun salvataggio.
    expect(mocks.toast.error).toHaveBeenCalledWith('Revocato.');
    expect(mocks.addDownloaded).not.toHaveBeenCalled();
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(mocks.togglePlayback).not.toHaveBeenCalled();
  });

  it('senza accesso: il messaggio di sempre, nessuna richiesta', async () => {
    mocks.signedIn = false;
    const container = await mount();
    const [button] = downloadButtons(featuredRow(container, 'Concessa'));
    expect(button?.getAttribute('aria-label')).toBe('Scarica Concessa per l’ascolto offline');
    await act(async () => button?.click());
    await flush();
    expect(mocks.toast.error).toHaveBeenCalledWith('Per scaricare i brani devi prima accedere.');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('copia già sul dispositivo: il pulsante parte «Offline» e non scarica di nuovo', async () => {
    window.localStorage.setItem(
      'solco:featured-offline-copies:v1',
      JSON.stringify({
        v: 1,
        copies: [{ localId: 'copia-1', featuredId: ID_OK, attribution: null, savedAt: 1 }],
      }),
    );
    mocks.getTrack.mockResolvedValue({ id: 'copia-1' });
    const container = await mount();
    const row = featuredRow(container, 'Concessa');
    const saved = row.querySelector<HTMLButtonElement>(
      'button[aria-label="Concessa è nella tua Libreria per l’ascolto offline"]',
    );
    expect(saved).not.toBeNull();
    expect(saved?.getAttribute('title')).toBe('Disponibile offline');
    await act(async () => saved?.click());
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('riga con «Scarica offline» su un telefono: «Ascolta su YouTube» (CSS)', () => {
  const css = readFileSync(
    join(process.cwd(), 'src/components/custom/music/unified-search-results.module.css'),
    'utf8',
  );

  /** Le dichiarazioni della prima regola con esattamente questo selettore. */
  function rule(source: string, selector: string): string {
    const start = source.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`Nessuna regola per ${selector}`);
    const open = source.indexOf('{', start);
    return source.slice(open + 1, source.indexOf('}', open));
  }

  /** Il contenuto del blocco @media (max-width: 480px). */
  function phoneBlock(): string {
    const start = css.indexOf('@media (max-width: 480px) {');
    if (start < 0) throw new Error('Nessun blocco per i telefoni');
    return css.slice(start, css.indexOf('\n}\n', start));
  }

  /** Il margine orizzontale in px di una dichiarazione `padding: 0 <n>px`. */
  function horizontalPadding(declarations: string): number {
    const match = /padding:\s*0\s+(\d+)px\s*;/.exec(declarations);
    if (!match) throw new Error(`Nessun padding orizzontale in: ${declarations}`);
    return Number(match[1]);
  }

  it('l’icona della pillola non si restringe quando il testo va a capo', () => {
    const icon = rule(css, '.secondaryBtn svg');
    expect(icon).toMatch(/flex:\s*none\s*;/);
    expect(icon).toMatch(/width:\s*14px\s*;/);
    expect(icon).toMatch(/height:\s*14px\s*;/);
  });

  it('solo nelle righe con «Scarica offline», e solo sui telefoni, la pillola ha un margine più stretto', () => {
    // Le altre righe (e gli schermi larghi) tengono il margine di sempre.
    expect(horizontalPadding(rule(css, '.secondaryBtn'))).toBe(10);
    const phone = phoneBlock();
    const narrow = horizontalPadding(rule(phone, '.rowDownloadable .secondaryBtn'));
    // A 390 px la colonna del testo è di 150 px (358 di pagina, 16 di margine della riga, 52 di
    // copertina, 24 di spazi, 116 dei tre pulsanti). La pillola è testo + icona (14) + spazio (4)
    // + bordo (2) + i due margini: con 10 px è larga circa 153 (misurata) e va a capo; deve
    // scendere sotto i 150 con qualche pixel di scorta.
    const pill = 153.4 - 2 * 10 + 2 * narrow;
    expect(pill).toBeLessThanOrEqual(150 - 3);
    // La regola non esiste fuori dal blocco dei telefoni.
    expect(css.replace(phone, '')).not.toContain('.rowDownloadable .secondaryBtn');
  });
});
