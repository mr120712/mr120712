// @polsia:user-owned — «Condividi» dei brani in evidenza nell'interfaccia: il pulsante compatto
// compare SOLO sui brani con `shareId` (Home e pagina d'artista), ha il nome «Condividi <titolo>»,
// condivide il link diretto /evidenza/<id> e non fa mai partire il brano; la pagina pubblica
// /evidenza/<id> (FeaturedShareView): senza sessione «Accedi per ascoltare» che torna qui, con la
// sessione «Riproduci» (mai in automatico) con playHomeTrack, «Condividi», link all'artista, stati
// di caricamento, brano non disponibile ed errore con «Riprova».
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  currentTrack: null as { qualifiedId: string } | null,
  status: 'idle' as string,
  session: { data: null as { user: { id: string } } | null, isPending: false },
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => mocks.session }));
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
import { FeaturedShareView } from '@/components/custom/music/featured-share-view';
import { HomeTracksSection } from '@/components/custom/music/home-tracks-section';
import { homeTrackToTrack } from '@/components/custom/music/live-tracks';

const SHARE_ID = 'AbCdEfGhIjKlMnOpQrStUv';

function track(id: string, title: string, shareId: string | null, artist = 'Lucio Dalla') {
  return {
    id,
    title,
    artist,
    streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
    durationSeconds: 0,
    artworkUrl: `/api/music/home-tracks/cover?p=${encodeURIComponent(`${id}.jpg`)}`,
    artistSlug: 'lucio-dalla',
    shareId,
  };
}

const DECLARED = track('Cantautori/Lucio Dalla - Caruso.mp3', 'Caruso', SHARE_ID);
const UNDECLARED = track('Download/Lucio Dalla - Attenti al lupo.mp3', 'Attenti al lupo', null);

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await flush();
  return { container, root };
}

function shareButtons(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Condividi"]')];
}

/** Tocco, clic e tastiera sul pulsante: apre il menu, non deve mai suonare il brano. */
async function pressShare(button: HTMLButtonElement | undefined) {
  await act(async () => {
    button?.click();
    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

function expectShareMenuForLink() {
  expect(document.body.textContent).toContain('Copia link');
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="evidenza"]')];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    const href = decodeURIComponent(link.href);
    expect(href).toContain(`/evidenza/${SHARE_ID}`);
    expect(href).not.toContain('Cantautori');
    expect(href).not.toContain('.mp3');
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.playTrack.mockReset();
  mocks.togglePlayback.mockReset();
  mocks.currentTrack = null;
  mocks.status = 'idle';
  mocks.session = { data: null, isPending: false };
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Home: «Condividi» solo sui brani dichiarati', () => {
  beforeEach(() => {
    mocks.apiFetch.mockResolvedValue({
      items: [DECLARED, UNDECLARED],
      sections: [{ id: 'Cantautori', title: 'Cantautori', items: [DECLARED, UNDECLARED] }],
    });
  });

  it('un pulsante per il brano con shareId, nessuno per l’altro', async () => {
    const { container } = await mount(<HomeTracksSection />);
    const buttons = shareButtons(container);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Condividi Caruso']);
    // Fuori dal pulsante della scheda: un pulsante non va dentro un altro.
    expect(buttons[0]?.closest('button[aria-label^="Riproduci"]')).toBeNull();
    const cards = container.querySelectorAll('li');
    expect(cards[0]?.contains(buttons[0] ?? null)).toBe(true);
    expect(cards[1]?.querySelector('button[aria-label^="Condividi"]')).toBeNull();
  });

  it('il tocco su «Condividi» apre il menu del link diretto e non suona il brano', async () => {
    const { container } = await mount(<HomeTracksSection />);
    await pressShare(shareButtons(container)[0]);
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(mocks.togglePlayback).not.toHaveBeenCalled();
    expectShareMenuForLink();
    // La scheda invece suona ancora il brano.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Riproduci Caruso di Lucio Dalla"]')
        ?.click();
    });
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
  });
});

/** Un evento di puntatore (jsdom non ha PointerEvent): dito, penna o mouse. */
function pointer(type: string, pointerType: string) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

describe('«Condividi» nelle liste che si scorrono: dito e penna aprono solo al tocco completo', () => {
  beforeEach(() => {
    mocks.apiFetch.mockResolvedValue({
      items: [DECLARED],
      sections: [{ id: 'Cantautori', title: 'Cantautori', items: [DECLARED] }],
    });
  });

  it('uno scorrimento che parte sul pulsante (pressione + pointercancel) non apre il menu', async () => {
    const { container } = await mount(<HomeTracksSection />);
    const button = shareButtons(container)[0];
    for (const kind of ['touch', 'pen']) {
      await act(async () => {
        button?.dispatchEvent(pointer('pointerdown', kind));
        button?.dispatchEvent(pointer('pointercancel', kind));
      });
      expect(button?.getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelector('[role="menu"]')).toBeNull();
      // La pagina non resta bloccata (il menu modale toglierebbe i puntatori al body).
      expect(document.body.style.pointerEvents).not.toBe('none');
    }
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('il tocco completo (pressione, rilascio, click) apre il menu; un secondo tocco lo chiude', async () => {
    const { container } = await mount(<HomeTracksSection />);
    const button = shareButtons(container)[0];
    // Un evento per volta, come nel browser (ognuno nel suo task).
    const tap = async () => {
      await act(async () => {
        button?.dispatchEvent(pointer('pointerdown', 'touch'));
      });
      // Alla sola pressione il menu è ancora come prima.
      const pressed = button?.getAttribute('aria-expanded');
      await act(async () => {
        button?.dispatchEvent(pointer('pointerup', 'touch'));
      });
      await act(async () => {
        button?.click();
      });
      return pressed;
    };
    expect(await tap()).toBe('false');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expectShareMenuForLink();
    expect(await tap()).toBe('true');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(mocks.togglePlayback).not.toHaveBeenCalled();
  });

  it('mouse e tastiera come prima: il mouse apre alla pressione, Invio apre', async () => {
    const { container } = await mount(<HomeTracksSection />);
    const button = shareButtons(container)[0];
    await act(async () => {
      button?.dispatchEvent(pointer('pointerdown', 'mouse'));
    });
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    // Il click che segue la pressione del mouse non richiude il menu.
    await act(async () => {
      button?.click();
    });
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expectShareMenuForLink();

    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();
    const second = await mount(<HomeTracksSection />);
    const other = shareButtons(second.container)[0];
    // Un click senza pressione (tastiera, programmatico) non apre nulla da solo: apre Invio.
    await act(async () => {
      other?.click();
    });
    expect(other?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      other?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(other?.getAttribute('aria-expanded')).toBe('true');
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });
});

describe('pagina d’artista: «Condividi» accanto alla riga', () => {
  it('solo sulle righe con shareId; il tocco non suona la riga', async () => {
    mocks.apiFetch.mockResolvedValue({
      artist: { name: 'Lucio Dalla', slug: 'lucio-dalla' },
      tracks: [DECLARED, { ...UNDECLARED, shareId: undefined }],
    });
    const { container } = await mount(<FeaturedArtistView slug="lucio-dalla" />);
    const buttons = shareButtons(container);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Condividi Caruso']);
    const rows = container.querySelectorAll('ol li');
    expect(rows[0]?.getAttribute('data-shareable')).toBe('true');
    expect(rows[1]?.hasAttribute('data-shareable')).toBe(false);
    expect(buttons[0]?.closest('button[aria-label^="Riproduci"]')).toBeNull();

    await pressShare(buttons[0]);
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(mocks.togglePlayback).not.toHaveBeenCalled();
    expectShareMenuForLink();
  });
});

describe('pagina pubblica /evidenza/<id>', () => {
  const META = {
    shareId: SHARE_ID,
    title: 'Caruso',
    artist: 'Lucio Dalla',
    artistSlug: 'lucio-dalla',
    coverPath: `/api/music/featured/tracks/${SHARE_ID}/cover`,
  };

  it('senza sessione: copertina, titolo, artista, «Accedi per ascoltare» che torna qui', async () => {
    mocks.apiFetch.mockResolvedValue({ track: META, homeTrack: null });
    const { container } = await mount(<FeaturedShareView shareId={SHARE_ID} />);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe(`/api/music/featured/tracks/${SHARE_ID}`);
    expect(container.querySelector('h1')?.textContent).toBe('Caruso');
    expect(container.querySelector(`[data-art="${META.coverPath}"]`)).not.toBeNull();
    const artist = container.querySelector<HTMLAnchorElement>('a[href="/artista/lucio-dalla"]');
    expect(artist?.textContent).toBe('Lucio Dalla');
    const login = [...container.querySelectorAll<HTMLAnchorElement>('a')].find((a) =>
      a.textContent?.includes('Accedi per ascoltare'),
    );
    expect(login?.getAttribute('href')).toBe(
      `/login?callbackURL=${encodeURIComponent(`/evidenza/${SHARE_ID}`)}`,
    );
    expect(container.querySelector('button[aria-label^="Riproduci"]')).toBeNull();
    expect(shareButtons(container).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Condividi Caruso',
    ]);
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('con la sessione: «Riproduci» suona il brano con playHomeTrack, mai in automatico', async () => {
    mocks.session = { data: { user: { id: 'u1' } }, isPending: false };
    mocks.apiFetch.mockResolvedValue({ track: META, homeTrack: DECLARED });
    const { container } = await mount(<FeaturedShareView shareId={SHARE_ID} />);
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Accedi per ascoltare');
    const play = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Riproduci Caruso di Lucio Dalla"]',
    );
    expect(play?.textContent).toContain('Riproduci');
    await act(async () => play?.click());
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [playerTrack, path, queue] = mocks.playTrack.mock.calls[0] ?? [];
    expect(playerTrack).toEqual(homeTrackToTrack(DECLARED));
    expect(path).toBe(DECLARED.streamUrl);
    expect(queue).toEqual([homeTrackToTrack(DECLARED)]);
  });

  it('brano già in corso: il pulsante mette in pausa', async () => {
    mocks.session = { data: { user: { id: 'u1' } }, isPending: false };
    mocks.currentTrack = { qualifiedId: `upload:${DECLARED.id}` };
    mocks.status = 'playing';
    mocks.apiFetch.mockResolvedValue({ track: META, homeTrack: DECLARED });
    const { container } = await mount(<FeaturedShareView shareId={SHARE_ID} />);
    const pause = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Metti in pausa Caruso di Lucio Dalla"]',
    );
    expect(pause?.textContent).toContain('Pausa');
    await act(async () => pause?.click());
    expect(mocks.togglePlayback).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('aspetta la sessione prima di chiedere il brano; un accesso lo richiede di nuovo', async () => {
    mocks.session = { data: null, isPending: true };
    mocks.apiFetch.mockResolvedValue({ track: META, homeTrack: null });
    const { container, root } = await mount(<FeaturedShareView shareId={SHARE_ID} />);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Caricamento del brano');

    mocks.session = { data: null, isPending: false };
    await act(async () => root.render(<FeaturedShareView shareId={SHARE_ID} />));
    await flush();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    mocks.session = { data: { user: { id: 'u1' } }, isPending: false };
    mocks.apiFetch.mockResolvedValue({ track: META, homeTrack: DECLARED });
    await act(async () => root.render(<FeaturedShareView shareId={SHARE_ID} />));
    await flush();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('button[aria-label="Riproduci Caruso di Lucio Dalla"]'),
    ).not.toBeNull();
  });

  it('brano senza artista né copertina: nessun link all’artista, iniziale', async () => {
    mocks.apiFetch.mockResolvedValue({
      track: { ...META, artist: null, artistSlug: null, coverPath: null },
      homeTrack: null,
    });
    const { container } = await mount(<FeaturedShareView shareId={SHARE_ID} />);
    expect(container.querySelector('a[href^="/artista/"]')).toBeNull();
    expect(container.querySelector('[data-art=""]')).not.toBeNull();
  });

  it('404 (sconosciuto o non dichiarato) e id non valido: «non disponibile»', async () => {
    mocks.apiFetch.mockRejectedValue(
      new Error(`apiFetch /api/music/featured/tracks/${SHARE_ID} failed (404)`, {
        cause: { error: 'not_found' },
      }),
    );
    const { container } = await mount(<FeaturedShareView shareId={SHARE_ID} />);
    expect(container.querySelector('h1')?.textContent).toBe('Questo brano non è disponibile');
    expect(container.querySelector('a[href="/"]')?.textContent).toBe('Scopri Solco');

    mocks.apiFetch.mockReset();
    const invalid = await mount(<FeaturedShareView shareId="non-valido" />);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(invalid.container.querySelector('h1')?.textContent).toBe(
      'Questo brano non è disponibile',
    );
  });

  it('errore: messaggio e «Riprova» che richiede di nuovo il brano', async () => {
    mocks.apiFetch.mockRejectedValueOnce(
      new Error(`apiFetch /api/music/featured/tracks/${SHARE_ID} failed (503)`, {
        cause: { error: 'unavailable' },
      }),
    );
    const { container } = await mount(<FeaturedShareView shareId={SHARE_ID} />);
    expect(container.querySelector('[role="alert"] h1')?.textContent).toBe(
      'Non riesco a caricare il brano',
    );
    mocks.apiFetch.mockResolvedValueOnce({ track: META, homeTrack: null });
    const retry = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Riprova'),
    );
    await act(async () => retry?.click());
    await flush();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('h1')?.textContent).toBe('Caruso');
  });
});
