// @polsia:user-owned — avviso «Solo per admin» nella pagina Cerca (client): chi non è admin (o è
// admin con l'email non verificata) non fa NESSUNA richiesta all'endpoint dell'avviso e non vede
// nulla; per l'admin la richiesta privata parte in parallelo a search-all, l'avviso sta in cima
// (role="note") e alla prima ricerca non aspetta i risultati, una query nuova annulla la richiesta
// in volo e una risposta vecchia non compare (mai il conteggio della query precedente), un errore
// (anche un 403 o una risposta fuori contratto) lo nasconde in silenzio. I testi: manifest assente,
// non valido, brani non dichiarati (singolare e plurale) e store non leggibile; il link porta a
// «Diritti e testi»; niente segnaposto se prima non c'era un avviso. Quando la query cambia,
// l'elenco vecchio non si sposta: il riquadro resta (stesso elemento e altezza, «controllo…»)
// finché arrivano la risposta nuova o i risultati nuovi, e un avviso nuovo compare con questi.
// Poche richieste: la prima parte subito, le successive aspettano la pausa minima dall'ultima (con
// la query più recente); in attesa, i risultati nuovi portano via il riquadro, che ricompare solo se
// l'avviso ha qualcosa da dire. Tempo finto: la pausa si fa passare con settle().
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

type Session = {
  user: { id: string; role?: string | null; email?: string | null; emailVerified?: boolean | null };
} | null;

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  replace: vi.fn(),
  toast: vi.fn(),
  session: null as Session,
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/auth-client', () => ({
  authClient: {},
  useSession: () => ({ data: mocks.session, isPending: false }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub forwards whatever the component passes.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(mocks.toast, { success: mocks.toast, error: mocks.toast }),
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
vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({ signedIn: mocks.session !== null }),
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));
vi.mock('@/components/custom/music/ai-music-search', () => ({ AiMusicSearch: () => null }));
vi.mock('@/components/custom/music/listen-in-solco', () => ({ ListenInSolco: () => null }));

import {
  ADMIN_SEARCH_HINT_MIN_SPACING_MS,
  AdminSearchHint,
  adminSearchHintNotice,
} from '@/components/custom/music/admin-search-hint';
import { UnifiedSearchResults } from '@/components/custom/music/unified-search-results';
import type { AdminSearchHint as AdminSearchHintData } from '@/lib/contracts/admin-search-hint';

const ADMIN: Session = {
  user: { id: 'admin-1', role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true },
};
const HINT_PREFIX = '/api/admin/featured-rights/search-hint';

const station = {
  id: 'radio1',
  name: 'Radio Caruso',
  artworkUrl: null,
  country: 'Italia',
  countryCode: 'IT',
  tags: ['jazz'],
  codec: null,
  bitrate: null,
  homepage: null,
  votes: 0,
};

function searchAll(query: string) {
  return {
    query,
    youtubeRequested: false,
    results: [{ kind: 'radio', key: 'radio:radio1', score: 70, station }],
    sources: {
      audius: { status: 'empty', tracks: [], artists: [], playlists: [], albums: [] },
      youtube: { status: 'skipped', videos: [] },
      radio: { status: 'results', stations: [station] },
      podcasts: { status: 'empty', podcasts: [] },
    },
  };
}

const undeclared = (count: number): AdminSearchHintData => ({
  manifest: 'valid',
  matchedDeclared: 1,
  matchedUndeclared: count,
});

type Handler = (url: string, init?: RequestInit) => unknown;

/** Ogni risposta passa dallo schema che il client chiede: le fixture rispettano i contratti. */
function serve(handler: Handler) {
  mocks.apiFetch.mockImplementation(
    async (url: string, init?: RequestInit & { schema?: ZodType<unknown> }) => {
      const value = await handler(url, init);
      return init?.schema ? init.schema.parse(value) : value;
    },
  );
}

function queryOf(url: string) {
  return new URL(url, 'https://solco.test').searchParams.get('q') ?? '';
}

function handlerWith(hint: (query: string) => unknown): Handler {
  return (url) => {
    if (url.startsWith('/api/music/search-all')) return searchAll(queryOf(url));
    if (url.startsWith('/api/music/library/search')) {
      return { query: queryOf(url), collections: [], tracks: [] };
    }
    if (url.startsWith(HINT_PREFIX)) return hint(queryOf(url));
    return null;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Fa passare la pausa minima fra due richieste dell'avviso: quella in attesa parte. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ADMIN_SEARCH_HINT_MIN_SPACING_MS);
  });
  await flush();
}

async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await flush();
  return { container, root };
}

function hintCalls() {
  return mocks.apiFetch.mock.calls.filter((call) => String(call[0]).startsWith(HINT_PREFIX));
}

function notice(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[role="note"]');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Solo i timer e l'orologio: le promesse (richieste, act) restano vere.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  mocks.apiFetch.mockReset();
  mocks.replace.mockReset();
  mocks.toast.mockReset();
  mocks.session = ADMIN;
  serve(handlerWith(() => undeclared(2)));
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('avviso admin: solo per gli admin', () => {
  it.each([
    ['senza accesso', null],
    ['utente normale', { user: { id: 'u-1', role: 'user', emailVerified: true } }],
    ['senza ruolo', { user: { id: 'u-2', emailVerified: true } }],
    [
      'admin con email non verificata',
      { user: { id: 'a-2', role: 'admin', emailVerified: false } },
    ],
  ])('%s: nessuna richiesta all’avviso e nessun avviso', async (_label, session) => {
    mocks.session = session as Session;
    const { container } = await render(<UnifiedSearchResults initialQuery="caruso" />);

    expect(hintCalls()).toHaveLength(0);
    expect(notice(container)).toBeNull();
    expect(container.textContent).not.toContain('Solo per admin');
    // La ricerca funziona come sempre.
    expect(container.textContent).toContain('Radio Caruso');
  });

  it('il componente da solo, per chi non è admin, non monta nulla e non chiama nulla', async () => {
    mocks.session = { user: { id: 'u-1', role: 'user', emailVerified: true } };
    const { container } = await render(<AdminSearchHint query="caruso" />);
    expect(container.innerHTML).toBe('');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});

describe('avviso admin: richiesta privata in parallelo', () => {
  it('parte insieme a search-all, compare prima dei risultati e resta in cima', async () => {
    const all = deferred<unknown>();
    const hint = deferred<unknown>();
    serve((url) => {
      if (url.startsWith('/api/music/search-all')) return all.promise;
      if (url.startsWith(HINT_PREFIX)) return hint.promise;
      return { query: queryOf(url), collections: [], tracks: [] };
    });
    const { container } = await render(<UnifiedSearchResults initialQuery="caruso" />);

    // Entrambe in volo prima che una delle due risponda; nessun segnaposto per l'avviso.
    const calls = mocks.apiFetch.mock.calls.map((call) => String(call[0]));
    expect(calls.filter((url) => url.startsWith('/api/music/search-all'))).toHaveLength(1);
    expect(calls.filter((url) => url.startsWith(HINT_PREFIX))).toEqual([`${HINT_PREFIX}?q=caruso`]);
    expect(notice(container)).toBeNull();

    // L'avviso risponde per primo: compare mentre le altre fonti cercano ancora.
    await act(async () => hint.resolve(undeclared(2)));
    await flush();
    const box = notice(container);
    expect(box).not.toBeNull();
    expect(container.textContent).toContain('Cerco “caruso”…');

    // Arrivano i risultati: lo STESSO elemento resta al suo posto, prima dell'elenco.
    await act(async () => all.resolve(searchAll('caruso')));
    await flush();
    expect(notice(container)).toBe(box);
    const list = container.querySelector('ol');
    expect(list).not.toBeNull();
    expect(
      (box as HTMLElement).compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // In cima ai risultati, sotto il titolo «Risultati».
    const heading = container.querySelector('#unified-results-heading');
    expect(
      (heading as HTMLElement).compareDocumentPosition(box as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('la richiesta porta la query ripulita, con un segnale per annullarla', async () => {
    await render(<UnifiedSearchResults initialQuery="  Lucio Dalla  " />);
    const [call] = hintCalls();
    expect(String(call?.[0])).toBe(`${HINT_PREFIX}?q=Lucio+Dalla`);
    expect((call?.[1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it('digitando: la prima richiesta subito, poi al massimo una ogni pausa minima, con l’ultima query', async () => {
    const { root } = await render(<AdminSearchHint query="c" />);
    expect(hintCalls().map((call) => String(call[0]))).toEqual([`${HINT_PREFIX}?q=c`]);

    // Tre lettere in meno di un secondo: nessuna richiesta in più, quella in volo è annullata.
    for (const query of ['ca', 'car', 'caru']) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await act(async () => root.render(<AdminSearchHint query={query} />));
      await flush();
    }
    expect(hintCalls()).toHaveLength(1);
    expect((hintCalls()[0]?.[1] as { signal?: AbortSignal }).signal?.aborted).toBe(true);

    // Passata la pausa minima dalla prima richiesta: una sola richiesta, con la query più recente.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ADMIN_SEARCH_HINT_MIN_SPACING_MS - 900);
    });
    await flush();
    expect(hintCalls().map((call) => String(call[0]))).toEqual([
      `${HINT_PREFIX}?q=c`,
      `${HINT_PREFIX}?q=caru`,
    ]);

    // Un'altra lettera subito dopo: aspetta di nuovo tutta la pausa dall'ultima richiesta.
    await act(async () => root.render(<AdminSearchHint query="caruso" />));
    await flush();
    expect(hintCalls()).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ADMIN_SEARCH_HINT_MIN_SPACING_MS - 1);
    });
    await flush();
    expect(hintCalls()).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    expect(hintCalls().map((call) => String(call[0]))).toEqual([
      `${HINT_PREFIX}?q=c`,
      `${HINT_PREFIX}?q=caru`,
      `${HINT_PREFIX}?q=caruso`,
    ]);
  });

  it('una query nuova annulla la richiesta in volo e la risposta vecchia non compare', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    serve(handlerWith((query) => (query === 'caruso' ? first.promise : second.promise)));
    const { container, root } = await render(<UnifiedSearchResults initialQuery="caruso" />);
    const signal = (hintCalls()[0]?.[1] as { signal?: AbortSignal }).signal;
    expect(signal?.aborted).toBe(false);

    await act(async () => root.render(<UnifiedSearchResults initialQuery="mozart" />));
    await flush();
    expect(signal?.aborted).toBe(true);
    // La richiesta nuova aspetta la pausa minima dall'ultima, poi parte con la query nuova.
    expect(hintCalls()).toHaveLength(1);
    await settle();
    expect(hintCalls().map((call) => String(call[0]))).toEqual([
      `${HINT_PREFIX}?q=caruso`,
      `${HINT_PREFIX}?q=mozart`,
    ]);

    // La risposta della query vecchia arriva tardi: ignorata.
    await act(async () => first.resolve(undeclared(4)));
    await flush();
    expect(notice(container)).toBeNull();

    await act(async () => second.resolve(undeclared(1)));
    await flush();
    expect(notice(container)?.textContent).toContain('corrisponde a «mozart»');
    expect(container.textContent).not.toContain('«caruso»');
  });

  it('mai il conteggio della query precedente mentre arriva la risposta della nuova', async () => {
    const laterAll = deferred<unknown>();
    const later = deferred<unknown>();
    serve((url) => {
      const query = queryOf(url);
      if (url.startsWith('/api/music/search-all')) {
        return query === 'caruso' ? searchAll('caruso') : laterAll.promise;
      }
      if (url.startsWith(HINT_PREFIX)) return query === 'caruso' ? undeclared(3) : later.promise;
      return { query, collections: [], tracks: [] };
    });
    const { container, root } = await render(<UnifiedSearchResults initialQuery="caruso" />);
    const box = notice(container);
    expect(box?.textContent).toContain('3 brani in evidenza corrispondono a «caruso»');

    await act(async () => root.render(<UnifiedSearchResults initialQuery="mozart" />));
    await flush();
    // Lo stesso riquadro resta (nessun salto), ma senza il conteggio vecchio: prima in attesa della
    // pausa minima, poi con la richiesta in volo.
    expect(notice(container)).toBe(box);
    expect(box?.textContent).toBe('Solo per admin · controllo i brani in evidenza…');
    expect(box?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).not.toContain('«caruso»');
    await settle();
    expect(hintCalls()).toHaveLength(2);
    expect(notice(container)).toBe(box);
    expect(box?.textContent).toBe('Solo per admin · controllo i brani in evidenza…');

    // La query nuova non ha brani nascosti: il riquadro resta finché l'elenco vecchio è a schermo
    // e va via con i risultati nuovi.
    await act(async () => later.resolve(undeclared(0)));
    await flush();
    expect(notice(container)).toBe(box);
    await act(async () => laterAll.resolve(searchAll('mozart')));
    await flush();
    expect(notice(container)).toBeNull();
    expect(container.textContent).toContain('risultato per “mozart”');
  });

  describe('nessun salto dei risultati mentre la query cambia', () => {
    /** search-all e avviso rinviati per «caruson»; «caruso» ha già risultati e avviso. */
    async function changeQuery(caruso: AdminSearchHintData) {
      const all = deferred<unknown>();
      const hint = deferred<unknown>();
      serve((url) => {
        const query = queryOf(url);
        if (url.startsWith('/api/music/search-all')) {
          return query === 'caruso' ? searchAll('caruso') : all.promise;
        }
        if (url.startsWith(HINT_PREFIX)) return query === 'caruso' ? caruso : hint.promise;
        return { query, collections: [], tracks: [] };
      });
      const view = await render(<UnifiedSearchResults initialQuery="caruso" />);
      const before = notice(view.container);
      const beforeText = before?.textContent ?? null;
      const list = view.container.querySelector('ol');
      await act(async () => view.root.render(<UnifiedSearchResults initialQuery="caruson" />));
      await flush();
      return { ...view, all, hint, before, beforeText, list };
    }

    it('il riquadro resta (stesso elemento, stessa altezza) finché i risultati nuovi lo sostituiscono', async () => {
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(48);
      const { container, all, hint, before, beforeText, list } = await changeQuery(undeclared(2));
      expect(beforeText).toContain('2 brani in evidenza corrispondono a «caruso»');

      // Entrambe in volo: elenco vecchio a schermo, riquadro al suo posto con la stessa altezza.
      expect(container.querySelector('ol')).toBe(list);
      expect(notice(container)).toBe(before);
      expect(before?.style.minHeight).toBe('48px');
      expect(before?.textContent).not.toContain('2 brani');
      expect(before?.textContent).not.toContain('«caruso»');

      // La richiesta dell'avviso aspetta la pausa minima e search-all non ha ancora risposto:
      // il riquadro resta, l'elenco vecchio non si sposta.
      expect(hintCalls()).toHaveLength(1);
      await act(async () => hint.resolve(undeclared(0)));
      await flush();
      expect(notice(container)).toBe(before);
      expect(container.querySelector('ol')).toBe(list);

      // Arrivano i risultati nuovi: il riquadro va via con l'elenco vecchio.
      await act(async () => all.resolve(searchAll('caruson')));
      await flush();
      expect(notice(container)).toBeNull();
      expect(container.textContent).toContain('risultato per “caruson”');

      // Passata la pausa la richiesta parte e non ha nulla da dire: nessun riquadro.
      await settle();
      expect(hintCalls()).toHaveLength(2);
      expect(notice(container)).toBeNull();
    });

    it('il conteggio nuovo prende il posto del vecchio nello stesso riquadro', async () => {
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(48);
      const { container, hint, before } = await changeQuery(undeclared(2));
      await settle();
      await act(async () => hint.resolve(undeclared(1)));
      await flush();
      expect(notice(container)).toBe(before);
      expect(before?.textContent).toContain('1 brano in evidenza corrisponde a «caruson»');
      expect(before?.getAttribute('aria-busy')).toBeNull();
      // L'avviso vero non ha altezza forzata.
      expect(before?.style.minHeight).toBe('');
    });

    it('un avviso nuovo non compare sopra i risultati vecchi: arriva insieme ai nuovi', async () => {
      const { container, all, hint, before, list } = await changeQuery(undeclared(0));
      expect(before).toBeNull();
      expect(notice(container)).toBeNull();

      await settle();
      await act(async () => hint.resolve(undeclared(3)));
      await flush();
      expect(notice(container)).toBeNull();
      expect(container.querySelector('ol')).toBe(list);

      await act(async () => all.resolve(searchAll('caruson')));
      await flush();
      expect(notice(container)?.textContent).toContain(
        '3 brani in evidenza corrispondono a «caruson»',
      );
    });

    it('un errore dell’avviso nuovo toglie il riquadro insieme all’elenco vecchio', async () => {
      const { container, all, hint, before } = await changeQuery(undeclared(2));
      await settle();
      await act(async () => hint.reject(new Error('boom')));
      await flush();
      expect(notice(container)).toBe(before);
      expect(container.textContent).not.toContain('«caruso»');

      await act(async () => all.resolve(searchAll('caruson')));
      await flush();
      expect(notice(container)).toBeNull();
    });

    it('in attesa della pausa, i risultati nuovi portano via il riquadro; l’avviso ricompare se poi ha qualcosa da dire', async () => {
      const { container, all, hint, before } = await changeQuery(undeclared(2));
      expect(notice(container)).toBe(before);

      // I risultati nuovi arrivano mentre la richiesta aspetta ancora: niente «controllo…» sopra
      // l'elenco nuovo.
      await act(async () => all.resolve(searchAll('caruson')));
      await flush();
      expect(notice(container)).toBeNull();
      expect(container.textContent).toContain('risultato per “caruson”');
      expect(hintCalls()).toHaveLength(1);

      // Passata la pausa la richiesta parte; con qualcosa da dire, l'avviso compare allora.
      await settle();
      expect(hintCalls().map((call) => String(call[0]))).toEqual([
        `${HINT_PREFIX}?q=caruso`,
        `${HINT_PREFIX}?q=caruson`,
      ]);
      await act(async () => hint.resolve(undeclared(3)));
      await flush();
      expect(notice(container)?.textContent).toContain(
        '3 brani in evidenza corrispondono a «caruson»',
      );
    });
  });

  it('un avviso che non dipende dalla query (manifest assente) resta mentre arriva la risposta nuova', async () => {
    const later = deferred<unknown>();
    serve(
      handlerWith((query) =>
        query === 'caruso'
          ? { manifest: 'missing', matchedDeclared: 0, matchedUndeclared: 2 }
          : later.promise,
      ),
    );
    const { container, root } = await render(<UnifiedSearchResults initialQuery="caruso" />);
    const box = notice(container);
    expect(box?.textContent).toContain("diritti.json non c'è");

    await act(async () => root.render(<UnifiedSearchResults initialQuery="mozart" />));
    await flush();
    // Stesso elemento, nessun salto dei risultati: anche in attesa della pausa minima.
    expect(notice(container)).toBe(box);
    expect(box?.textContent).toContain("diritti.json non c'è");
    await settle();
    expect(notice(container)).toBe(box);

    // La risposta nuova dice che il manifest ora è valido e nulla è nascosto: l'avviso sparisce.
    await act(async () => later.resolve(undeclared(0)));
    await flush();
    expect(notice(container)).toBeNull();
  });

  it.each([
    [
      'un errore (403)',
      () => Promise.reject(new Error('forbidden', { cause: { error: 'forbidden' } })),
    ],
    ['un 429', () => Promise.reject(new Error('rate', { cause: { error: 'rate_limited' } }))],
    [
      'una risposta fuori contratto',
      () => ({ manifest: 'valid', matchedDeclared: 0, matchedUndeclared: 2, titles: ['X'] }),
    ],
    [
      'uno stato sconosciuto',
      () => ({ manifest: 'boh', matchedDeclared: 0, matchedUndeclared: 2 }),
    ],
  ])('%s nasconde l’avviso in silenzio; la ricerca resta', async (_label, answer) => {
    serve(handlerWith(answer));
    const { container } = await render(<UnifiedSearchResults initialQuery="caruso" />);
    expect(hintCalls()).toHaveLength(1);
    expect(notice(container)).toBeNull();
    expect(container.textContent).not.toContain('Solo per admin');
    expect(container.textContent).toContain('Radio Caruso');
    expect(container.textContent).not.toContain('La ricerca non è riuscita');
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('un errore dopo un avviso già mostrato lo toglie', async () => {
    serve(
      handlerWith((query) =>
        query === 'caruso'
          ? { manifest: 'invalid', matchedDeclared: 0, matchedUndeclared: 1 }
          : Promise.reject(new Error('boom')),
      ),
    );
    const { container, root } = await render(<UnifiedSearchResults initialQuery="caruso" />);
    expect(notice(container)).not.toBeNull();
    await act(async () => root.render(<UnifiedSearchResults initialQuery="mozart" />));
    await flush();
    await settle();
    expect(notice(container)).toBeNull();
  });

  it('l’invio con YouTube (stessa query) non rifà la richiesta dell’avviso', async () => {
    const { container } = await render(<UnifiedSearchResults initialQuery="caruso" />);
    expect(hintCalls()).toHaveLength(1);
    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(
      mocks.apiFetch.mock.calls.filter((call) => String(call[0]).includes('youtubeConsent')),
    ).toHaveLength(1);
    expect(hintCalls()).toHaveLength(1);
  });
});

describe('avviso admin: i testi', () => {
  async function shown(hint: AdminSearchHintData, query = 'caruso') {
    serve(handlerWith(() => hint));
    const { container } = await render(<AdminSearchHint query={query} />);
    return notice(container);
  }

  it('manifest assente: testo e link a «Diritti e testi»', async () => {
    const box = await shown({ manifest: 'missing', matchedDeclared: 0, matchedUndeclared: 0 });
    expect(box?.textContent).toBe(
      "Solo per admin · diritti.json non c'è: nessun brano in evidenza compare nella ricerca. Apri Diritti e testi",
    );
    const link = box?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/admin/diritti-testi');
    expect(link?.textContent).toBe('Apri Diritti e testi');
  });

  it('manifest non valido: testo e link', async () => {
    const box = await shown({ manifest: 'invalid', matchedDeclared: 0, matchedUndeclared: 5 });
    expect(box?.textContent).toBe(
      'Solo per admin · diritti.json non è valido: nessun brano in evidenza compare nella ricerca. Apri Diritti e testi',
    );
    expect(box?.querySelector('a')?.getAttribute('href')).toBe('/admin/diritti-testi');
  });

  it('brani non dichiarati: plurale con il numero e la query', async () => {
    const box = await shown(undeclared(3), 'Lucio Dalla');
    expect(box?.textContent).toBe(
      'Solo per admin · 3 brani in evidenza corrispondono a «Lucio Dalla» ma non sono dichiarati in diritti.json, quindi non compaiono. Apri Diritti e testi',
    );
    expect(box?.querySelector('a')?.getAttribute('href')).toBe('/admin/diritti-testi');
  });

  it('un solo brano non dichiarato: singolare', async () => {
    const box = await shown(undeclared(1));
    expect(box?.textContent).toBe(
      'Solo per admin · 1 brano in evidenza corrisponde a «caruso» ma non è dichiarato in diritti.json, quindi non compare. Apri Diritti e testi',
    );
  });

  it('store non leggibile: testo, senza link', async () => {
    const box = await shown({ manifest: 'unavailable', matchedDeclared: 0, matchedUndeclared: 0 });
    expect(box?.textContent).toBe(
      'Solo per admin · Non riesco a leggere lo store dei brani in evidenza.',
    );
    expect(box?.querySelector('a')).toBeNull();
  });

  it('manifest valido e nessun brano nascosto: nessun avviso (anche con brani dichiarati)', async () => {
    expect(await shown({ manifest: 'valid', matchedDeclared: 4, matchedUndeclared: 0 })).toBeNull();
    expect(await shown({ manifest: 'valid', matchedDeclared: 0, matchedUndeclared: 0 })).toBeNull();
  });

  it('l’avviso è una nota (role="note") con l’icona nascosta allo screen reader', async () => {
    const box = await shown(undeclared(2));
    expect(box?.getAttribute('role')).toBe('note');
    const icon = box?.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('adminSearchHintNotice: link solo dove serve, null quando non c’è nulla da dire', () => {
    expect(adminSearchHintNotice(undeclared(0), 'x')).toBeNull();
    expect(adminSearchHintNotice(undeclared(2), 'x')?.link).toBe(true);
    expect(
      adminSearchHintNotice(
        { manifest: 'unavailable', matchedDeclared: 0, matchedUndeclared: 0 },
        'x',
      )?.link,
    ).toBe(false);
  });
});
