// @polsia:user-owned — Libreria: copertina a mosaico e descrizione delle playlist (editor in linea).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  session: {
    data: {
      user: {
        id: 'owner',
        name: 'Giulia Bianchi',
        email: 'giulia@example.test',
        emailVerified: true,
      },
    },
    isPending: false,
  },
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/auth-client', () => ({
  useSession: () => mocks.session,
  authClient: { sendVerificationEmail: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));

import { MusicCollections } from '@/components/custom/music/music-collections';
import { MusicPlayerProvider } from '@/components/custom/music/music-player';

type Collection = {
  id: string;
  name: string;
  kind: 'favorites' | 'playlist';
  description?: string | null;
  createdAt: string;
  items: Array<Record<string, unknown>>;
};

function item(id: string, artworkUrl: string | null) {
  return {
    id,
    source: 'audius' as const,
    sourceId: `track-${id}`,
    title: `Brano ${id}`,
    creatorName: 'Artista',
    artworkUrl,
    sourceUrl: null,
    artistUrl: null,
    durationSeconds: null,
    createdAt: '2026-11-10T00:00:00.000Z',
    expiresAt: null,
  };
}

const cover = (letter: string) => `https://audius.co/content/${letter}/480x480.jpg`;

let state: Collection[] = [];

function initialCollections(description: string | null = null): Collection[] {
  return [
    {
      id: 'favorites-1',
      name: 'Preferiti',
      kind: 'favorites',
      createdAt: '2026-11-10T00:00:00.000Z',
      items: [item('f1', cover('f'))],
    },
    {
      id: 'playlist-1',
      name: 'Brani misti',
      kind: 'playlist',
      description,
      createdAt: '2026-11-10T00:00:00.000Z',
      items: ['a', 'b', 'c', 'd', 'e'].map((letter) => item(letter, cover(letter))),
    },
  ];
}

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <MusicCollections />
      </MusicPlayerProvider>,
    ),
  );
  await flush();
  return container;
}

function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label,
  );
}

async function click(element: HTMLElement | undefined) {
  if (!element) throw new Error('Elemento non trovato.');
  await act(async () => {
    element.click();
  });
  await flush();
}

function textarea(container: HTMLElement) {
  const found = container.querySelector('textarea');
  if (!found) throw new Error('Area di testo non trovata.');
  return found;
}

/** Scrive nella textarea controllata come fa il browser (setter del valore + evento input). */
async function type(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(element: HTMLElement, init: KeyboardEventInit) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
  await flush();
}

function updateCalls() {
  return mocks.apiFetch.mock.calls
    .map(([, init]) => (init as RequestInit | undefined)?.body)
    .filter((body): body is string => typeof body === 'string')
    .map((body) => JSON.parse(body) as { action: string })
    .filter((body) => body.action === 'update_playlist');
}

function apiError(status: number, cause: unknown) {
  return new Error(`apiFetch failed (${status})`, { cause });
}

function playlistSection(container: HTMLElement) {
  const section = [...container.querySelectorAll('section')].find(
    (element) => element.querySelector('h2')?.textContent === 'Brani misti',
  );
  if (!section) throw new Error('Playlist non trovata.');
  return section;
}

beforeEach(() => {
  state = initialCollections();
  mocks.toast.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.apiFetch.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path !== '/api/music/collections') return null;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.action === 'update_playlist') {
      state = state.map((collection) =>
        collection.id === body.collectionId
          ? { ...collection, description: body.description }
          : collection,
      );
    }
    return { collections: state };
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('copertina a mosaico nella Libreria', () => {
  it('ogni raccolta ha la sua copertina automatica, decorativa', async () => {
    const container = await mount();
    const playlist = playlistSection(container);
    const mosaic = playlist.querySelector<HTMLElement>('[data-layout]');
    expect(mosaic?.dataset.layout).toBe('grid');
    expect(mosaic?.getAttribute('aria-hidden')).toBe('true');
    expect([...(mosaic?.querySelectorAll('img') ?? [])].map((image) => image.alt)).toEqual([
      '',
      '',
      '',
      '',
    ]);
    // I Preferiti hanno una copertina: un'immagine sola, intera.
    const favorites = [...container.querySelectorAll('section')].find(
      (section) => section.querySelector('h2')?.textContent === 'Preferiti',
    );
    expect(favorites?.querySelector<HTMLElement>('[data-layout]')?.dataset.layout).toBe('single');
  });
});

describe('descrizione delle playlist nella Libreria', () => {
  it('solo le playlist hanno "Aggiungi descrizione", non i Preferiti', async () => {
    const container = await mount();
    const add = button(container, 'Aggiungi descrizione');
    expect(add?.getAttribute('aria-label')).toBe('Aggiungi descrizione della playlist Brani misti');
    const favorites = [...container.querySelectorAll('section')].find(
      (section) => section.querySelector('h2')?.textContent === 'Preferiti',
    );
    expect(favorites?.textContent).not.toContain('descrizione');
  });

  it('apre l’editor, conta i caratteri, salva e mostra il testo con le righe', async () => {
    const container = await mount();
    await click(button(container, 'Aggiungi descrizione'));
    const field = textarea(container);
    expect(document.activeElement).toBe(field);
    expect(field.maxLength).toBe(300);
    expect(container.textContent).toContain('0/300');
    // L'etichetta nomina la playlist per gli screen reader.
    expect(field.labels?.[0]?.textContent).toBe('Descrizione della playlist Brani misti');

    await type(field, 'Brani lenti\n\n\n\nper le sere d’inverno  ');
    // Il testo grezzo, come lo conta il maxLength della textarea.
    expect(container.textContent).toContain('38/300');

    await click(button(container, 'Salva'));
    expect(updateCalls()).toEqual([
      {
        action: 'update_playlist',
        collectionId: 'playlist-1',
        description: 'Brani lenti\n\nper le sere d’inverno',
      },
    ]);
    expect(mocks.toast.success).toHaveBeenCalledWith('Descrizione salvata.');
    expect(container.querySelector('textarea')).toBeNull();
    const shown = playlistSection(container).querySelector('p[dir="auto"]');
    expect(shown?.textContent).toBe('Brani lenti\n\nper le sere d’inverno');
    // Il focus torna sul pulsante, ora "Modifica descrizione".
    const edit = button(container, 'Modifica descrizione');
    expect(document.activeElement).toBe(edit);
  });

  it('Invio va a capo e non salva; Ctrl+Invio salva; Esc annulla', async () => {
    const container = await mount();
    await click(button(container, 'Aggiungi descrizione'));
    const field = textarea(container);
    await type(field, 'Prima riga');
    await key(field, { key: 'Enter' });
    expect(updateCalls()).toHaveLength(0);
    expect(container.querySelector('textarea')).not.toBeNull();

    await key(field, { key: 'Enter', ctrlKey: true });
    expect(updateCalls()).toHaveLength(1);
    expect(mocks.toast.success).toHaveBeenCalledWith('Descrizione salvata.');

    await click(button(container, 'Modifica descrizione'));
    const again = textarea(container);
    expect(again.value).toBe('Prima riga');
    await type(again, 'Da buttare');
    await key(again, { key: 'Escape' });
    expect(container.querySelector('textarea')).toBeNull();
    expect(updateCalls()).toHaveLength(1);
    expect(container.textContent).toContain('Prima riga');
    expect(container.textContent).not.toContain('Da buttare');
  });

  it('"Annulla" chiude senza salvare e riporta il focus sul pulsante', async () => {
    state = initialCollections('Descrizione attuale');
    const container = await mount();
    await click(button(container, 'Modifica descrizione'));
    const field = textarea(container);
    expect(field.value).toBe('Descrizione attuale');
    await type(field, 'Bozza');
    await click(button(container, 'Annulla'));
    expect(updateCalls()).toHaveLength(0);
    expect(container.textContent).toContain('Descrizione attuale');
    expect(document.activeElement).toBe(button(container, 'Modifica descrizione'));

    // Riaprendo si parte dal testo salvato, non dalla bozza scartata.
    await click(button(container, 'Modifica descrizione'));
    expect(textarea(container).value).toBe('Descrizione attuale');
  });

  it('un testo vuoto toglie la descrizione', async () => {
    state = initialCollections('Da togliere');
    const container = await mount();
    await click(button(container, 'Modifica descrizione'));
    await type(textarea(container), '   \n  ');
    await click(button(container, 'Salva'));
    expect(updateCalls()).toEqual([
      { action: 'update_playlist', collectionId: 'playlist-1', description: null },
    ]);
    expect(mocks.toast.success).toHaveBeenCalledWith('Descrizione rimossa.');
    expect(button(container, 'Aggiungi descrizione')).toBeDefined();
    expect(container.textContent).not.toContain('Da togliere');
  });

  it('l’errore del server sul campo resta sotto l’area di testo, senza toast', async () => {
    const container = await mount();
    await click(button(container, 'Aggiungi descrizione'));
    const message = 'La descrizione può avere al massimo 300 caratteri.';
    mocks.apiFetch.mockRejectedValueOnce(apiError(400, { errors: { description: message } }));
    await type(textarea(container), 'Testo rifiutato');
    await click(button(container, 'Salva'));
    const field = textarea(container);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const describedBy = field.getAttribute('aria-describedby') ?? '';
    const error = describedBy
      .split(' ')
      .map((id) => document.getElementById(id))
      .find((element) => element?.textContent === message);
    expect(error).toBeDefined();
    expect(document.activeElement).toBe(field);
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    // La bozza resta per un secondo tentativo.
    expect(field.value).toBe('Testo rifiutato');
  });

  it('un altro errore va in un toast e la bozza resta', async () => {
    const container = await mount();
    await click(button(container, 'Aggiungi descrizione'));
    mocks.apiFetch.mockRejectedValueOnce(apiError(503, { error: 'unavailable' }));
    await type(textarea(container), 'Bozza da tenere');
    await click(button(container, 'Salva'));
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Non è stato possibile salvare la descrizione. Riprova.',
    );
    expect(textarea(container).value).toBe('Bozza da tenere');
  });

  it('un 400 su un campo che il modulo non ha va in un toast, mai in silenzio', async () => {
    const container = await mount();
    await click(button(container, 'Aggiungi descrizione'));
    mocks.apiFetch.mockRejectedValueOnce(
      apiError(400, { errors: { body: 'Controlla i dati della raccolta.' } }),
    );
    await type(textarea(container), 'Bozza da tenere');
    await click(button(container, 'Salva'));
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Non è stato possibile salvare la descrizione. Riprova.',
    );
    const field = textarea(container);
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expect(field.value).toBe('Bozza da tenere');
  });

  it('una playlist che non esiste più: lo dice, chiude l’editor e ricarica le raccolte', async () => {
    const container = await mount();
    await click(button(container, 'Aggiungi descrizione'));
    const loads = () =>
      mocks.apiFetch.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method)
        .length;
    const loadsBefore = loads();
    mocks.apiFetch.mockRejectedValueOnce(apiError(404, { error: 'not_found' }));
    // Eliminata in un'altra scheda: la prossima lettura non la contiene più.
    state = state.filter((collection) => collection.id !== 'playlist-1');
    await type(textarea(container), 'Bozza');
    await click(button(container, 'Salva'));
    expect(mocks.toast.error).toHaveBeenCalledWith('Questa playlist non esiste più.');
    expect(mocks.toast.error).not.toHaveBeenCalledWith(expect.stringContaining('Riprova'));
    expect(container.querySelector('textarea')).toBeNull();
    expect(loads()).toBe(loadsBefore + 1);
    expect(container.textContent).not.toContain('Brani misti');
  });

  it('salvare un campo vuoto senza descrizione chiude e basta: niente richiesta né toast', async () => {
    const container = await mount();
    await click(button(container, 'Aggiungi descrizione'));
    await type(textarea(container), '  \n ');
    await click(button(container, 'Salva'));
    expect(updateCalls()).toHaveLength(0);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button(container, 'Aggiungi descrizione'));
  });

  it('"Modifica descrizione" mette il cursore alla fine del testo', async () => {
    state = initialCollections('Prima riga\nSeconda riga');
    const container = await mount();
    await click(button(container, 'Modifica descrizione'));
    const field = textarea(container);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
    expect(field.selectionEnd).toBe(field.value.length);
  });

  describe('durante il salvataggio Annulla ed Esc non fanno nulla', () => {
    /** La prossima update_playlist resta in sospeso finché il test non la risolve o la rifiuta. */
    function holdNextUpdate() {
      let settle: { resolve: () => void; reject: (error: unknown) => void } | null = null;
      const fallback = mocks.apiFetch.getMockImplementation();
      mocks.apiFetch.mockImplementationOnce(
        (path: string, init?: RequestInit) =>
          new Promise((resolve, reject) => {
            settle = {
              resolve: () => resolve(fallback?.(path, init)),
              reject,
            };
          }),
      );
      return {
        resolve: async () => {
          await act(async () => settle?.resolve());
          await flush();
        },
        reject: async (error: unknown) => {
          await act(async () => settle?.reject(error));
          await flush();
        },
      };
    }

    it('Annulla mentre salva: la richiesta decide, niente salvataggio "annullato"', async () => {
      const container = await mount();
      await click(button(container, 'Aggiungi descrizione'));
      const pending = holdNextUpdate();
      await type(textarea(container), 'Nuova');
      await click(button(container, 'Salva'));
      const cancel = button(container, 'Annulla');
      expect(cancel?.getAttribute('aria-disabled')).toBe('true');
      expect(textarea(container).readOnly).toBe(true);
      await click(cancel);
      // L'editor resta aperto finché il server non risponde.
      expect(container.querySelector('textarea')).not.toBeNull();
      await pending.resolve();
      expect(mocks.toast.success).toHaveBeenCalledWith('Descrizione salvata.');
      expect(container.querySelector('textarea')).toBeNull();
      expect(playlistSection(container).querySelector('p[dir="auto"]')?.textContent).toBe('Nuova');
    });

    it('Esc mentre salva: un rifiuto del server resta visibile sul campo con la bozza', async () => {
      const container = await mount();
      await click(button(container, 'Aggiungi descrizione'));
      const pending = holdNextUpdate();
      await type(textarea(container), 'Bozza importante');
      await click(button(container, 'Salva'));
      await key(textarea(container), { key: 'Escape' });
      expect(container.querySelector('textarea')).not.toBeNull();
      await pending.reject(apiError(400, { errors: { description: 'Troppo lunga.' } }));
      const field = textarea(container);
      expect(field.value).toBe('Bozza importante');
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(field.readOnly).toBe(false);
      expect(container.textContent).toContain('Troppo lunga.');
      expect(button(container, 'Annulla')?.hasAttribute('aria-disabled')).toBe(false);

      // Finito il salvataggio, Esc torna ad annullare.
      await key(field, { key: 'Escape' });
      expect(container.querySelector('textarea')).toBeNull();
    });
  });

  it('vicino al limite il contatore lo annuncia agli screen reader', async () => {
    const container = await mount();
    await click(button(container, 'Aggiungi descrizione'));
    const live = container.querySelector('output[aria-live="polite"]');
    expect(live?.textContent).toBe('');
    await type(textarea(container), 'x'.repeat(285));
    expect(live?.textContent).toBe('Restano 15 caratteri.');
    await type(textarea(container), 'x'.repeat(299));
    expect(live?.textContent).toBe('Resta 1 carattere.');
    expect(container.textContent).toContain('299/300');
  });

  it('mostra la descrizione come testo, mai come HTML', async () => {
    state = initialCollections('<img src=x onerror="alert(1)"> <b>grassetto</b>');
    const container = await mount();
    const shown = playlistSection(container).querySelector('p[dir="auto"]');
    expect(shown?.textContent).toBe('<img src=x onerror="alert(1)"> <b>grassetto</b>');
    expect(shown?.querySelector('img, b')).toBeNull();
  });

  it('il riepilogo del link condiviso dice che la descrizione è pubblica', async () => {
    state = initialCollections('Per correre').map((collection) =>
      collection.kind === 'playlist'
        ? Object.assign(collection, {
            shareId: 'AbCdEfGhIjKlMnOpQrStUv',
            sharedAt: '2026-11-11T00:00:00.000Z',
          })
        : collection,
    );
    const container = await mount();
    expect(container.textContent).toContain(
      'chi lo apre vede «Brani misti» di Giulia, la descrizione e i brani, e può salvarne una copia.',
    );
  });
});
