// @polsia:user-owned — pannello «I tuoi brani caricati» (/scarica, libreria pubblica spenta): chi non
// è loggato non fa richieste e non vede nulla; chi è loggato vede SOLO i propri brani (GET /mine)
// con Scarica (link al download del proprio file) e Rimuovi, che chiede conferma prima di
// cancellare (DELETE) e poi toglie la riga; un errore di lettura o di rimozione lo dice.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  signedIn: true,
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({ signedIn: mocks.signedIn }),
}));

import { MyUploadsPanel } from '@/components/custom/music/my-uploads-panel';

const ID_A = 'a'.repeat(25);
const ID_B = 'b'.repeat(25);

function upload(id: string, title: string, artist: string | null = null) {
  return {
    id,
    title,
    artist,
    streamUrl: `https://abc.public.blob.vercel-storage.com/public-uploads/${id}.mp3`,
    durationSeconds: 180,
    playCount: 2,
    createdAt: '2026-11-01T10:00:00.000Z',
    mine: true,
    published: true,
    canPlay: true,
  };
}

/** /mine risponde con questi brani (passati dal contratto, come fa il vero apiFetch). */
function serveMine(items: unknown[]) {
  mocks.apiFetch.mockImplementation(async (path: string, init?: { schema?: ZodType }) => {
    if (path === '/api/music/public-uploads/mine') {
      return init?.schema ? init.schema.parse({ items }) : { items };
    }
    return { ok: true };
  });
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<MyUploadsPanel />));
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === label || element.textContent === label,
  );

/** Un pulsante della finestra di conferma (anche la riga ha un «Rimuovi»). */
const dialogButton = (label: string) =>
  [...document.querySelectorAll('[role="alertdialog"] button')].find(
    (element) => element.textContent === label,
  ) as HTMLButtonElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.signedIn = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('MyUploadsPanel', () => {
  it('senza accesso: nessuna richiesta, niente pannello', async () => {
    mocks.signedIn = false;
    await mount();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('nessun brano caricato: niente pannello', async () => {
    serveMine([]);
    await mount();
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/music/public-uploads/mine',
      expect.objectContaining({ schema: expect.anything() }),
    );
    expect(container.innerHTML).toBe('');
  });

  it('elenca i tuoi brani con Scarica (download del tuo file) e Rimuovi', async () => {
    serveMine([upload(ID_A, 'La mia canzone', 'Io'), upload(ID_B, 'Seconda')]);
    await mount();
    expect(container.querySelector('h2')?.textContent).toBe('I tuoi brani caricati');
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('La mia canzone · Io');
    const download = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Scarica La mia canzone"]',
    );
    expect(download?.getAttribute('href')).toBe(`/api/music/public-uploads/${ID_A}/download`);
    expect(download?.hasAttribute('download')).toBe(true);
    expect(button('Rimuovi Seconda')).toBeDefined();
  });

  it('Rimuovi chiede conferma: Annulla non cancella nulla', async () => {
    serveMine([upload(ID_A, 'La mia canzone')]);
    await mount();
    await act(async () => button('Rimuovi La mia canzone')?.click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Rimuovere «La mia canzone»?',
    );
    await act(async () => dialogButton('Annulla')?.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  it('confermata la rimozione: DELETE del tuo brano, la riga sparisce', async () => {
    serveMine([upload(ID_A, 'La mia canzone'), upload(ID_B, 'Seconda')]);
    await mount();
    await act(async () => button('Rimuovi La mia canzone')?.click());
    await act(async () => dialogButton('Rimuovi')?.click());
    expect(mocks.apiFetch).toHaveBeenCalledWith(`/api/music/public-uploads/${ID_A}`, {
      method: 'DELETE',
    });
    expect(mocks.success).toHaveBeenCalledWith('Brano rimosso.');
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('Seconda');
  });

  it('rimozione fallita: avviso, la riga resta', async () => {
    serveMine([upload(ID_A, 'La mia canzone')]);
    await mount();
    mocks.apiFetch.mockRejectedValueOnce(new Error('apiFetch failed (500)'));
    await act(async () => button('Rimuovi La mia canzone')?.click());
    await act(async () => dialogButton('Rimuovi')?.click());
    expect(mocks.error).toHaveBeenCalledWith('Non è stato possibile rimuovere il brano.');
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  it('elenco non leggibile: lo dice, senza pulsanti', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('apiFetch failed (503)'));
    await mount();
    expect(container.textContent).toContain('Non è stato possibile leggere i tuoi brani caricati');
    expect(container.querySelector('button')).toBeNull();
  });
});
