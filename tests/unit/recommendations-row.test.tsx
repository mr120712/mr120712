// @polsia:user-owned — riga «Potrebbe piacerti» della Home (client): solo con l'accesso; scheletro
// mentre carica, errore con «Riprova», «Per iniziare» a freddo, «Popolari su Solco» con i consigli
// spenti, «Non mi interessa» subito (con «Annulla» e ripristino se il server rifiuta), «Riproduci
// tutti» in coda, «Altri consigli», «Aggiungi alla Libreria» solo per Audius, brani "song" segnati
// come cercati su YouTube al loro turno, nota di licenza OML e avviso per gli account Free.
// Tastiera: il focus non finisce mai su <body> (dopo «Non mi interessa», «Aggiungi alla Libreria»,
// «Altri consigli» e «Riprova»); intestazione e avviso Free già presenti mentre carica.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecommendationItem, RecommendationsResponse } from '@/lib/contracts/recommendations';

type Call = { url: string; init?: { method?: string; body?: string; cache?: string } };

const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  handler: (_call: Call): Promise<unknown> => new Promise(() => undefined),
  playTrack: vi.fn(async () => true),
  togglePlayback: vi.fn(async () => undefined),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  signedIn: true,
  premium: true as boolean | null,
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string, init?: Call['init']) => {
    const call = { url, init };
    mocks.calls.push(call);
    return mocks.handler(call);
  },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub forwards whatever the component passes.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({ default: () => <span data-testid="cover" /> }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: 'idle',
    premium: mocks.premium,
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
  trackStreamPath: (track: { qualifiedId: string }) => `/stream/${track.qualifiedId}`,
}));
vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({ signedIn: mocks.signedIn }),
}));

import { RecommendationsRow } from '@/components/custom/music/recommendations-row';

function audius(id: string, artistName = `Artista ${id}`): RecommendationItem {
  return {
    kind: 'audius',
    id,
    qualifiedId: `audius:${id}`,
    title: `Brano ${id}`,
    artistName,
    artistUrl: `https://audius.co/artista${id}`,
    trackUrl: `https://audius.co/artista${id}/brano-${id}`,
    artworkUrl: `https://audius.example/${id}.jpg`,
    durationSeconds: 180,
    license: null,
    licensorName: artistName,
    copyrightNotice: null,
    attributionRemovalRequested: false,
    playbackEligible: true,
    playbackReason: 'ready',
    genre: 'Lo-Fi',
    reason: { kind: 'artist', text: `Perché hai ascoltato ${artistName}` },
  };
}

const song: RecommendationItem = {
  kind: 'song',
  qualifiedId: `song:${'a'.repeat(32)}`,
  title: 'Canzone AI',
  artistName: 'Nuovo Artista',
  reason: { kind: 'ai', text: 'Suggerito dall’AI, simile a Alfa' },
};

function response(
  items: RecommendationItem[],
  extra: Partial<RecommendationsResponse> = {},
): RecommendationsResponse {
  return { mode: 'personal', items, page: 0, nextPage: 1, ...extra };
}

/** Risposte per URL: GET dei consigli e POST di feedback/Preferiti. */
function route(handlers: {
  get?: (url: string) => Promise<unknown>;
  feedback?: (body: { kind: string; itemKey: string }) => Promise<unknown>;
  favorite?: () => Promise<unknown>;
}) {
  mocks.handler = (call) => {
    if (call.url.startsWith('/api/music/recommendations/feedback')) {
      return (
        handlers.feedback?.(JSON.parse(call.init?.body ?? '{}')) ?? Promise.resolve({ ok: true })
      );
    }
    if (call.url.startsWith('/api/music/recommendations')) {
      return handlers.get?.(call.url) ?? new Promise(() => undefined);
    }
    if (call.url === '/api/music/collections') return handlers.favorite?.() ?? Promise.resolve({});
    return Promise.reject(new Error(`unexpected ${call.url}`));
  };
}

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<RecommendationsRow />);
  });
  return container;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

const titles = (container: HTMLElement) =>
  [...container.querySelectorAll('ol li strong')].map((node) => node.textContent);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.calls.length = 0;
  mocks.signedIn = true;
  mocks.premium = true;
  mocks.playTrack.mockClear();
  mocks.togglePlayback.mockClear();
  mocks.toast.mockClear();
  mocks.toast.success.mockClear();
  mocks.toast.error.mockClear();
  window.localStorage.clear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('RecommendationsRow', () => {
  it('senza accesso non mostra nulla e non chiede nulla', async () => {
    mocks.signedIn = false;
    route({});
    const container = await mount();
    expect(container.innerHTML).toBe('');
    expect(mocks.calls).toHaveLength(0);
  });

  it('mentre carica mostra lo scheletro (senza schede vere), poi i brani; richiesta privata', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    route({
      get: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const container = await mount();
    const section = container.querySelector('section');
    expect(section?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('output')?.textContent).toBe('Caricamento dei consigli…');
    expect(container.querySelectorAll('ul[aria-hidden="true"] li')).toHaveLength(6);
    expect(container.querySelector('h2')?.textContent).toBe('Potrebbe piacerti');
    // Pulsanti già al loro posto (inattivi): l'intestazione non cambia altezza all'arrivo.
    expect(button(container, 'Riproduci tutti').getAttribute('aria-disabled')).toBe('true');
    expect(button(container, 'Altri consigli').getAttribute('aria-disabled')).toBe('true');
    expect(mocks.calls[0]).toMatchObject({
      url: '/api/music/recommendations?page=0',
      init: { cache: 'no-store' },
    });

    await act(async () => resolve(response([audius('1'), song])));
    await flush();
    expect(section?.getAttribute('aria-busy')).toBe('false');
    expect(container.querySelector('ul[aria-hidden="true"]')).toBeNull();
    expect(titles(container)).toEqual(['Brano 1', 'Canzone AI']);
    expect(container.textContent).toContain('Perché hai ascoltato Artista 1');
  });

  it('errore: messaggio e «Riprova» che richiede di nuovo', async () => {
    let attempt = 0;
    route({
      get: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error('503'))
          : Promise.resolve(response([audius('2')]));
      },
    });
    const container = await mount();
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Non riesco a caricare i consigli',
    );
    const retry = button(container, 'Riprova');
    retry.focus();
    await act(async () => retry.click());
    // «Riprova» sparisce con lo scheletro: il focus va al titolo, non all'inizio della pagina.
    expect(document.activeElement).toBe(container.querySelector('h2'));
    await flush();
    expect(attempt).toBe(2);
    expect(titles(container)).toEqual(['Brano 2']);
    expect(document.activeElement).toBe(container.querySelector('h2'));
  });

  it('nessun consiglio: la riga si nasconde', async () => {
    route({ get: () => Promise.resolve(response([], { nextPage: null })) });
    const container = await mount();
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('partenza a freddo: «Per iniziare», spiegato', async () => {
    route({ get: () => Promise.resolve(response([audius('3')], { mode: 'starter' })) });
    const container = await mount();
    await flush();
    expect(container.querySelector('h2')?.textContent).toBe('Per iniziare');
    expect(container.textContent).toContain('i consigli diventano');
  });

  it('consigli personalizzati spenti: chiede solo i popolari e rimanda a Impostazioni', async () => {
    window.localStorage.setItem('solco:recommendations', '0');
    route({ get: () => Promise.resolve(response([audius('4')], { mode: 'popular' })) });
    const container = await mount();
    await flush();
    expect(mocks.calls[0]?.url).toBe('/api/music/recommendations?page=0&personal=0');
    expect(container.querySelector('h2')?.textContent).toBe('Popolari su Solco');
    expect(container.querySelector('a[href="/impostazioni"]')).not.toBeNull();
  });

  it('«Non mi interessa»: via subito, poi «Annulla» lo rimette', async () => {
    let finishHide: (value: unknown) => void = () => undefined;
    const feedback = vi.fn((body: { kind: string }) =>
      body.kind === 'hide'
        ? new Promise((done) => {
            finishHide = done;
          })
        : Promise.resolve({ ok: true }),
    );
    route({ get: () => Promise.resolve(response([audius('5'), audius('6')])), feedback });
    const container = await mount();
    await flush();

    const hideFive = button(container, 'Non mi interessa: Brano 5');
    hideFive.focus();
    await act(async () => hideFive.click());
    // Tolto prima ancora che il server risponda.
    expect(titles(container)).toEqual(['Brano 6']);
    // Il focus passa al brano vicino, non all'inizio della pagina.
    expect(document.activeElement).toBe(button(container, 'Non mi interessa: Brano 6'));
    expect(feedback).toHaveBeenCalledWith({ kind: 'hide', itemKey: 'audius:5' });

    await act(async () => finishHide({ ok: true }));
    await flush();
    expect(mocks.toast).toHaveBeenCalledWith(
      'Non vedrai più questo brano nei consigli.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Annulla' }) }),
    );
    const options = mocks.toast.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    await act(async () => options.action.onClick());
    await flush();
    expect(feedback).toHaveBeenLastCalledWith({ kind: 'unhide', itemKey: 'audius:5' });
    expect(titles(container)).toEqual(['Brano 5', 'Brano 6']);
  });

  it('«Non mi interessa» sull’ultimo brano: focus al precedente; pagina vuota: ad «Altri consigli»', async () => {
    route({ get: () => Promise.resolve(response([audius('30'), audius('31')])) });
    const container = await mount();
    await flush();
    const last = button(container, 'Non mi interessa: Brano 31');
    last.focus();
    await act(async () => last.click());
    await flush();
    expect(document.activeElement).toBe(button(container, 'Non mi interessa: Brano 30'));
    await act(async () => button(container, 'Non mi interessa: Brano 30').click());
    await flush();
    expect(container.textContent).toContain('Hai nascosto tutti i brani di questa pagina.');
    expect(document.activeElement).toBe(button(container, 'Altri consigli'));
  });

  it('«Non mi interessa» non salvato: il brano torna al suo posto con un errore', async () => {
    route({
      get: () => Promise.resolve(response([audius('7'), audius('8')])),
      feedback: () => Promise.reject(new Error('500')),
    });
    const container = await mount();
    await flush();
    await act(async () => button(container, 'Non mi interessa: Brano 7').click());
    await flush();
    expect(titles(container)).toEqual(['Brano 7', 'Brano 8']);
    expect(mocks.toast.error).toHaveBeenCalledWith('Non è stato possibile nasconderlo. Riprova.');
  });

  it('«Riproduci tutti» mette in coda tutti i brani; un brano parte dentro la stessa coda', async () => {
    route({ get: () => Promise.resolve(response([audius('9'), song])) });
    const container = await mount();
    await flush();
    await act(async () => button(container, 'Riproduci tutti').click());
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [first, path, queue] = mocks.playTrack.mock.calls[0] as unknown as [
      { qualifiedId: string; playbackMode: string },
      string,
      Array<{ qualifiedId: string; playbackMode: string; sourceLabel: string }>,
    ];
    expect(first).toMatchObject({ qualifiedId: 'audius:9', playbackMode: 'audius' });
    expect(path).toBe('/stream/audius:9');
    expect(queue.map((track) => track.qualifiedId)).toEqual(['audius:9', song.qualifiedId]);
    // Il "song" resta da cercare su YouTube al suo turno: nessun video risolto qui.
    expect(queue[1]).toMatchObject({ playbackMode: 'song', sourceLabel: 'YouTube' });

    await act(async () => button(container, 'Riproduci Canzone AI').click());
    const [single, , sameQueue] = mocks.playTrack.mock.calls[1] as unknown as [
      { qualifiedId: string },
      string,
      unknown[],
    ];
    expect(single.qualifiedId).toBe(song.qualifiedId);
    expect(sameQueue).toHaveLength(2);
    expect(mocks.calls.some((call) => call.url.includes('resolve-song'))).toBe(false);
  });

  it('Audius: nota di licenza e «Aggiungi alla Libreria»; "song": cercato su YouTube, senza cuore', async () => {
    const favorite = vi.fn(() => Promise.resolve({ ok: true }));
    route({ get: () => Promise.resolve(response([audius('10'), song])), favorite });
    const container = await mount();
    await flush();
    const cards = [...container.querySelectorAll('ol li')];
    expect(cards[0]?.textContent).toContain('Licenza');
    expect(cards[1]?.textContent).toContain('Cercato su YouTube quando lo ascolti');
    expect(cards[1]?.querySelector('button[aria-label^="Aggiungi alla Libreria"]')).toBeNull();

    const heart = button(container, 'Aggiungi alla Libreria: Brano 10');
    heart.focus();
    await act(async () => heart.click());
    await flush();
    const call = mocks.calls.find((item) => item.url === '/api/music/collections');
    expect(JSON.parse(call?.init?.body ?? '{}')).toEqual({
      action: 'favorite',
      source: 'audius',
      sourceId: '10',
    });
    expect(mocks.toast.success).toHaveBeenCalledWith('Aggiunto ai Preferiti della Libreria.');
    const saved = button(container, 'Brano 10 è nei Preferiti');
    expect(saved.getAttribute('aria-pressed')).toBe('true');
    // Inattivo ma non disabled: il focus resta sul pulsante; un secondo clic non richiama l'API.
    expect(saved.disabled).toBe(false);
    expect(saved.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(saved);
    await act(async () => saved.click());
    await flush();
    expect(mocks.calls.filter((item) => item.url === '/api/music/collections')).toHaveLength(1);
  });

  it('«Altri consigli» chiede la pagina successiva e sostituisce la riga; il focus resta sul pulsante', async () => {
    let finish: (value: unknown) => void = () => undefined;
    route({
      get: (url) =>
        url.includes('page=1')
          ? new Promise((done) => {
              finish = done;
            })
          : Promise.resolve(response([audius('11')])),
    });
    const container = await mount();
    await flush();
    const more = button(container, 'Altri consigli');
    more.focus();
    await act(async () => more.click());
    // Mentre carica: inattivo ma non disabled (un pulsante disabled perde il focus).
    const loading = button(container, 'Caricamento…');
    expect(loading).toBe(more);
    expect(loading.disabled).toBe(false);
    expect(loading.getAttribute('aria-disabled')).toBe('true');
    await act(async () => loading.click());
    expect(mocks.calls.filter((call) => call.url.includes('page=1'))).toHaveLength(1);
    await act(async () => finish(response([audius('20')], { page: 1, nextPage: null })));
    await flush();
    expect(mocks.calls.map((call) => call.url)).toContain('/api/music/recommendations?page=1');
    expect(titles(container)).toEqual(['Brano 20']);
    expect(document.activeElement).toBe(more);
  });

  it('niente altro da mostrare: «Altri consigli» inattivo e non richiede nulla', async () => {
    route({ get: () => Promise.resolve(response([audius('12')], { nextPage: null })) });
    const container = await mount();
    await flush();
    const more = button(container, 'Altri consigli');
    expect(more.getAttribute('aria-disabled')).toBe('true');
    await act(async () => more.click());
    expect(mocks.calls).toHaveLength(1);
  });

  it('account Free: avviso sui 40 ascolti del mese, già presente mentre carica', async () => {
    mocks.premium = false;
    let resolve: (value: unknown) => void = () => undefined;
    route({
      get: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const container = await mount();
    expect(container.textContent).toContain('40 ascolti completi del mese');
    await act(async () => resolve(response([audius('13')])));
    await flush();
    expect(container.textContent).toContain('40 ascolti completi del mese');
  });

  it('consigli spenti: titolo e sottotitolo «Popolari su Solco» già mentre carica', async () => {
    window.localStorage.setItem('solco:recommendations', '0');
    route({});
    const container = await mount();
    expect(container.querySelector('h2')?.textContent).toBe('Popolari su Solco');
    expect(container.querySelector('a[href="/impostazioni"]')).not.toBeNull();
  });
});
