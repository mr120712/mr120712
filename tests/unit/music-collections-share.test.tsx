// @polsia:user-owned
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
    } as {
      user: { id: string; name: string; email: string; emailVerified: boolean };
    } | null,
    isPending: false,
  },
  sendVerificationEmail: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/auth-client', () => ({
  useSession: () => mocks.session,
  authClient: { sendVerificationEmail: mocks.sendVerificationEmail },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));

import { MusicCollections } from '@/components/custom/music/music-collections';
import { MusicPlayerProvider } from '@/components/custom/music/music-player';

const SHARE_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const SHARE_URL = `https://solco.test/playlist/${SHARE_ID}`;

function collections(shareId: string | null) {
  return [
    {
      id: 'favorites-1',
      name: 'Preferiti',
      kind: 'favorites' as const,
      shareId: null,
      sharedAt: null,
      createdAt: '2026-11-10T00:00:00.000Z',
      items: [],
    },
    {
      id: 'playlist-1',
      name: 'Brani misti',
      kind: 'playlist' as const,
      shareId,
      sharedAt: shareId ? '2026-11-11T00:00:00.000Z' : null,
      createdAt: '2026-11-10T00:00:00.000Z',
      items: [],
    },
  ];
}

const SHARE_BODY = JSON.stringify({ action: 'share', collectionId: 'playlist-1' });
const DELETE_BODY = JSON.stringify({ action: 'delete_playlist', collectionId: 'playlist-1' });

function callsWith(body: string) {
  return mocks.apiFetch.mock.calls.filter(
    ([, init]) => String((init as RequestInit | undefined)?.body ?? '') === body,
  );
}

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

function buttons(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
    (element) => element.textContent?.trim() === label,
  );
}

async function click(element: HTMLElement | undefined) {
  if (!element) throw new Error('Elemento non trovato.');
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await flush();
}

function apiError(status: number, cause: unknown) {
  return new Error(`apiFetch failed (${status})`, { cause });
}

/** The confirmation dialog is portaled to <body>, outside the component's container. */
function dialog() {
  return document.body.querySelector<HTMLElement>('[role="alertdialog"]');
}

function dialogButton(label: string) {
  return [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (element) => element.textContent?.trim() === label,
  );
}

/** Radix moves the focus back on a timer once the dialog closes. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush();
}

function setNavigator(key: 'share' | 'clipboard', value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
}

let shared: string | null = null;

beforeEach(() => {
  shared = null;
  mocks.session = {
    data: {
      user: {
        id: 'owner',
        name: 'Giulia Bianchi',
        email: 'giulia@example.test',
        emailVerified: true,
      },
    },
    isPending: false,
  };
  mocks.sendVerificationEmail.mockReset();
  mocks.toast.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.apiFetch.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path !== '/api/music/collections') return null;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.action === 'share') {
      shared = SHARE_ID;
      return { shareId: SHARE_ID, url: SHARE_URL, collections: collections(shared) };
    }
    if (body?.action === 'unshare') {
      shared = null;
      return { collections: collections(null) };
    }
    if (body?.action === 'delete_playlist') {
      return { collections: collections(shared).filter((item) => item.id !== 'playlist-1') };
    }
    return { collections: collections(shared) };
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  setNavigator('share', undefined);
  setNavigator('clipboard', undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('condividere una playlist dalla Libreria', () => {
  it('offre "Condividi" solo per le playlist, non per i Preferiti', async () => {
    const container = await mount();
    expect(buttons(container, 'Condividi')).toHaveLength(1);
    // The accessible name says which playlist (several "Condividi" on the same page).
    expect(buttons(container, 'Condividi')[0]?.getAttribute('aria-label')).toBe(
      'Condividi la playlist Brani misti',
    );
    const favorites = [...container.querySelectorAll('section')].find(
      (section) => section.querySelector('h2')?.textContent === 'Preferiti',
    );
    expect(favorites?.textContent).not.toContain('Condividi');
  });

  it('prima del primo link mostra esattamente cosa vedrà chi lo apre', async () => {
    const container = await mount();
    const trigger = buttons(container, 'Condividi')[0];
    trigger?.focus();
    await click(trigger);

    const alert = dialog();
    expect(alert?.textContent).toContain('Condividere “Brani misti” con un link?');
    // The same label the public page shows: first word of the account name, never the email.
    expect(alert?.textContent).toContain(
      'Chi apre il link vedrà «Brani misti» di Giulia e i brani',
    );
    expect(alert?.textContent).toContain('«Giulia» è la prima parola del nome del tuo account.');
    expect(alert?.textContent).toContain('La tua email non compare mai');
    expect(alert?.textContent).not.toContain('Bianchi');
    expect(alert?.textContent).not.toContain('giulia@example.test');
    expect(alert?.querySelector('bdi')?.textContent).toBe('Brani misti');
    expect(document.activeElement).toBe(dialogButton('Annulla'));

    // Nothing is published until the person confirms.
    await click(dialogButton('Annulla'));
    await settle();
    expect(callsWith(SHARE_BODY)).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it('crea il link e apre il menu di condivisione del telefono', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator('share', share);
    const container = await mount();
    await click(buttons(container, 'Condividi')[0]);
    await click(dialogButton('Crea il link'));

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/music/collections',
      expect.objectContaining({ method: 'POST', body: SHARE_BODY }),
    );
    expect(share).toHaveBeenCalledWith({ title: 'Brani misti', url: SHARE_URL });
    expect(mocks.toast.success).toHaveBeenCalledWith('Playlist condivisa.');
    expect(container.querySelector(`a[href="${SHARE_URL}"]`)?.textContent).toBe(SHARE_URL);
    expect(container.textContent).toContain(
      'chi lo apre vede «Brani misti» di Giulia e i brani, e può salvarne una copia.',
    );
    expect(container.textContent).not.toContain('nome di battesimo');
    expect(buttons(container, 'Smetti di condividere')).toHaveLength(1);
  });

  it('senza menu di condivisione copia il link negli appunti', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator('share', undefined);
    setNavigator('clipboard', { writeText });
    const container = await mount();
    await click(buttons(container, 'Condividi')[0]);
    await click(dialogButton('Crea il link'));
    expect(writeText).toHaveBeenCalledWith(SHARE_URL);
    expect(mocks.toast.success).toHaveBeenCalledWith('Link copiato negli appunti.');
  });

  it('se il menu viene chiuso non mostra errori', async () => {
    const share = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('chiuso'), { name: 'AbortError' }));
    const writeText = vi.fn();
    setNavigator('share', share);
    setNavigator('clipboard', { writeText });
    const container = await mount();
    await click(buttons(container, 'Condividi')[0]);
    await click(dialogButton('Crea il link'));
    expect(writeText).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('"Smetti di condividere" chiede conferma e spiega cosa succede ai link inviati', async () => {
    shared = SHARE_ID;
    const container = await mount();
    const trigger = buttons(container, 'Smetti di condividere')[0];
    expect(trigger?.getAttribute('aria-label')).toBe(
      'Smetti di condividere la playlist Brani misti',
    );
    trigger?.focus();
    await click(trigger);

    const alert = dialog();
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Smettere di condividere “Brani misti”?');
    expect(alert?.textContent).toContain('Ogni link a questa playlist che hai già inviato');
    expect(alert?.textContent).toContain('creerà un link nuovo');
    expect(alert?.textContent).toContain('restano nelle loro Librerie');
    // The safe choice has the focus; nothing was sent yet.
    expect(document.activeElement).toBe(dialogButton('Annulla'));
    const unshareCalls = () =>
      mocks.apiFetch.mock.calls.filter(([, init]) =>
        String((init as RequestInit | undefined)?.body ?? '').includes('"unshare"'),
      );
    expect(unshareCalls()).toHaveLength(0);

    await click(dialogButton('Annulla'));
    await settle();
    expect(dialog()).toBeNull();
    expect(unshareCalls()).toHaveLength(0);
    expect(container.querySelector(`a[href$="/playlist/${SHARE_ID}"]`)).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('confermando, il link viene disattivato e il focus torna su "Condividi"', async () => {
    shared = SHARE_ID;
    const container = await mount();
    const trigger = buttons(container, 'Smetti di condividere')[0];
    trigger?.focus();
    await click(trigger);
    await click(dialogButton('Smetti di condividere'));
    await settle();

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/music/collections',
      expect.objectContaining({
        body: JSON.stringify({ action: 'unshare', collectionId: 'playlist-1' }),
      }),
    );
    expect(dialog()).toBeNull();
    expect(container.querySelector(`a[href$="/playlist/${SHARE_ID}"]`)).toBeNull();
    expect(buttons(container, 'Smetti di condividere')).toHaveLength(0);
    // The dialog already explained the details: the toast stays short enough to read.
    expect(mocks.toast.success).toHaveBeenCalledWith('Non condividi più la playlist.');
    expect(document.activeElement).toBe(buttons(container, 'Condividi')[0]);
  });

  it('mentre crea il link "Condividi" resta focalizzabile e non invia due richieste', async () => {
    const container = await mount();
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path !== '/api/music/collections') return null;
      if (String(init?.body ?? '').includes('"share"')) return new Promise(() => undefined);
      return { collections: collections(shared) };
    });
    const share = buttons(container, 'Condividi')[0];
    share?.focus();
    await click(share);
    await click(dialogButton('Crea il link'));
    await settle();
    expect(share?.disabled).toBe(false);
    expect(share?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(share);
    await click(share);
    expect(dialog()).toBeNull();
    expect(callsWith(SHARE_BODY)).toHaveLength(1);
  });

  it('senza email verificata non pubblica nulla e mostra l’avviso sotto quella playlist', async () => {
    mocks.session = {
      data: {
        user: {
          id: 'owner',
          name: 'Giulia',
          email: 'giulia@example.test',
          emailVerified: false,
        },
      },
      isPending: false,
    };
    const share = vi.fn();
    setNavigator('share', share);
    const container = await mount();

    // No permanent banner for people who never share.
    expect(container.textContent).not.toContain('serve un indirizzo email verificato');
    const button = buttons(container, 'Condividi')[0];
    button?.focus();
    await click(button);

    expect(dialog()).toBeNull();
    expect(callsWith(SHARE_BODY)).toHaveLength(0);
    expect(share).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('Verifica prima la tua email.');
    // The hint sits under that playlist and takes the focus (scrolled into view).
    const section = [...container.querySelectorAll('section')].find(
      (item) => item.querySelector('h2')?.textContent === 'Brani misti',
    );
    const hintId = button?.getAttribute('aria-describedby');
    const hint = hintId ? document.getElementById(hintId) : null;
    expect(hint?.textContent).toContain('serve un indirizzo email verificato');
    expect(section?.contains(hint ?? null)).toBe(true);
    expect(document.activeElement).toBe(hint);
    expect(container.querySelector('a[href*="/playlist/"]')).toBeNull();

    // The hint offers a new verification link, back to the Library.
    mocks.sendVerificationEmail.mockResolvedValue({ error: null });
    await click(buttons(container, 'Invia di nuovo il link di verifica')[0]);
    expect(mocks.sendVerificationEmail).toHaveBeenCalledWith({
      email: 'giulia@example.test',
      callbackURL: '/library',
    });
  });

  it('se il server rifiuta per email non verificata mostra lo stesso avviso', async () => {
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path !== '/api/music/collections') return null;
      if (String(init?.body ?? '').includes('"share"')) {
        throw apiError(403, { error: 'email_not_verified', message: 'Verifica l’email.' });
      }
      return { collections: collections(null) };
    });
    const container = await mount();
    await click(buttons(container, 'Condividi')[0]);
    await click(dialogButton('Crea il link'));
    await settle();
    expect(mocks.toast.error).toHaveBeenCalledWith('Verifica prima la tua email.');
    expect(container.textContent).toContain('serve un indirizzo email verificato');
  });

  it('con email verificata non mostra l’avviso', async () => {
    const container = await mount();
    expect(container.textContent).not.toContain('serve un indirizzo email verificato');
    expect(buttons(container, 'Condividi')[0]?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('"Elimina playlist" chiede conferma e, se condivisa, avvisa che il link smette di funzionare', async () => {
    shared = SHARE_ID;
    const container = await mount();
    const trigger = buttons(container, 'Elimina playlist')[0];
    expect(trigger?.getAttribute('aria-label')).toBe('Elimina la playlist Brani misti');
    trigger?.focus();
    await click(trigger);

    expect(dialog()?.textContent).toContain('Eliminare “Brani misti”?');
    expect(dialog()?.textContent).toContain('Ogni link a questa playlist che hai già inviato');
    expect(dialog()?.textContent).toContain('restano nelle loro Librerie');
    expect(document.activeElement).toBe(dialogButton('Annulla'));
    await click(dialogButton('Annulla'));
    await settle();
    expect(callsWith(DELETE_BODY)).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);

    await click(trigger);
    await click(dialogButton('Elimina playlist'));
    await settle();
    expect(callsWith(DELETE_BODY)).toHaveLength(1);
    expect(mocks.toast.success).toHaveBeenCalledWith('Playlist eliminata e link disattivato.');
    expect(container.textContent).not.toContain('Brani misti');
    // The section is gone: the focus goes to the heading next to it, not to <body>.
    expect(document.activeElement?.textContent).toBe('Preferiti');
  });

  it('una playlist non condivisa si elimina con una conferma più breve', async () => {
    const container = await mount();
    await click(buttons(container, 'Elimina playlist')[0]);
    expect(dialog()?.textContent).toContain('non si può recuperare');
    expect(dialog()?.textContent).not.toContain('link');
    await click(dialogButton('Elimina playlist'));
    await settle();
    expect(mocks.toast.success).toHaveBeenCalledWith('Playlist eliminata.');
  });

  it('conta gli elementi al singolare e al plurale', async () => {
    mocks.apiFetch.mockImplementation(async () => ({
      collections: collections(null).map((item) =>
        item.kind === 'playlist'
          ? {
              ...item,
              items: [
                {
                  id: 'item-1',
                  source: 'youtube',
                  sourceId: 'aaaaaaaaaaa',
                  title: null,
                  creatorName: null,
                  artworkUrl: null,
                  sourceUrl: null,
                  artistUrl: null,
                  durationSeconds: null,
                  expiresAt: null,
                  createdAt: '2026-11-10T00:00:00.000Z',
                },
              ],
            }
          : item,
      ),
    }));
    const container = await mount();
    expect(container.textContent).toContain('Playlist · 1 elemento');
    expect(container.textContent).toContain('Preferiti · 0 elementi');
  });

  it('riapre il menu di una playlist già condivisa senza richiedere un nuovo link', async () => {
    shared = SHARE_ID;
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator('share', share);
    const container = await mount();
    mocks.apiFetch.mockClear();
    await click(buttons(container, 'Condividi')[0]);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(share).toHaveBeenCalledWith({
      title: 'Brani misti',
      url: `${window.location.origin}/playlist/${SHARE_ID}`,
    });
  });
});
