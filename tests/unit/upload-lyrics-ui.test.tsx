// @polsia:user-owned — editor del testo dei propri brani in /pubblica: senza la conferma dei
// diritti il testo non parte (errore sotto la casella), con la conferma va in PATCH; un 400 del
// server torna sotto il campo giusto (applyServerErrors); "Rimuovi testo" manda null.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

import { UploadLyricsEditor } from '@/components/custom/music/upload-lyrics';
import { UPLOAD_LYRICS_MAX_CHARS } from '@/lib/contracts/lyrics';
import { LYRICS_FIELD_MESSAGES, type PublicUpload } from '@/lib/contracts/public-uploads';

const UPLOAD: PublicUpload = {
  id: 'c'.repeat(25),
  title: 'Mio brano',
  artist: null,
  streamUrl: null,
  durationSeconds: 100,
  playCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  mine: true,
  published: true,
  canPlay: true,
  lyrics: null,
  lyricsRightsConfirmed: false,
};

let root: Root;
let container: HTMLDivElement;
const onSaved = vi.fn();

async function render(upload: PublicUpload = UPLOAD) {
  await act(async () => root.render(<UploadLyricsEditor upload={upload} onSaved={onSaved} />));
}

function button(label: string) {
  return [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  );
}

async function typeLyrics(value: string) {
  const textarea = container.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: HTMLElement | undefined | null) {
  await act(async () => {
    element?.click();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('UploadLyricsEditor', () => {
  it('senza la conferma il testo non parte: errore sotto la casella', async () => {
    await render();
    await click(button('Aggiungi testo'));
    expect(container.textContent).toContain('Testo (facoltativo)');
    expect(container.textContent).toContain('Il testo è mio o ho il diritto di pubblicarlo');
    await typeLyrics('[00:01.00]Ciao');
    await click(button('Salva testo'));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain(LYRICS_FIELD_MESSAGES.confirm);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.getAttribute('aria-invalid')).toBe('true');
    expect(checkbox?.required).toBe(true);
  });

  it('con la conferma: PATCH del testo, toast e brano aggiornato', async () => {
    const saved = { ...UPLOAD, lyrics: '[00:01.00]Ciao', lyricsRightsConfirmed: true };
    mocks.apiFetch.mockResolvedValue({ upload: saved });
    await render();
    await click(button('Aggiungi testo'));
    await typeLyrics('[00:01.00]Ciao');
    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]'));
    await click(button('Salva testo'));
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      `/api/music/public-uploads/${UPLOAD.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ lyrics: '[00:01.00]Ciao', lyricsRightsConfirmed: true }),
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(mocks.toast.success).toHaveBeenCalledWith('Testo salvato.');
  });

  it('un 400 del server torna sotto il campo (applyServerErrors)', async () => {
    mocks.apiFetch.mockRejectedValue(
      new Error('apiFetch failed (400)', { cause: { errors: { lyrics: 'Errore dal server' } } }),
    );
    await render();
    await click(button('Aggiungi testo'));
    await typeLyrics('Ciao');
    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]'));
    await click(button('Salva testo'));
    expect(container.textContent).toContain('Errore dal server');
    expect(container.querySelector('textarea')?.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('testo troppo lungo: niente taglio silenzioso della casella, errore "troppo lungo" sotto il campo', async () => {
    await render();
    await click(button('Aggiungi testo'));
    const textarea = container.querySelector('textarea');
    // Nessun maxlength: il browser taglierebbe il testo incollato senza dirlo.
    expect(textarea?.hasAttribute('maxlength')).toBe(false);
    const long = Array.from({ length: 1000 }, (_, index) => `Riga numero ${index} del testo`).join(
      '\n',
    );
    expect(long.length).toBeGreaterThan(UPLOAD_LYRICS_MAX_CHARS);
    expect(long.length).toBeLessThan(UPLOAD_LYRICS_MAX_CHARS * 2);
    await typeLyrics(long);
    expect(textarea?.value).toBe(long);
    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]'));
    await click(button('Salva testo'));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain(LYRICS_FIELD_MESSAGES.tooLong);
    expect(textarea?.getAttribute('aria-invalid')).toBe('true');

    // Anche oltre il tetto grezzo del contratto: stesso messaggio, nessun invio.
    await typeLyrics(`${long}\n${long}`);
    await click(button('Salva testo'));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain(LYRICS_FIELD_MESSAGES.tooLong);
  });

  it('"Rimuovi testo" toglie testo e conferma', async () => {
    const withLyrics = { ...UPLOAD, lyrics: 'Vecchio', lyricsRightsConfirmed: true };
    mocks.apiFetch.mockResolvedValue({ upload: { ...UPLOAD } });
    await render(withLyrics);
    await click(button('Testo'));
    expect(container.querySelector('textarea')?.value).toBe('Vecchio');
    await click(button('Rimuovi testo'));
    expect(mocks.apiFetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ lyrics: null, lyricsRightsConfirmed: false }),
    });
    expect(mocks.toast.success).toHaveBeenCalledWith('Testo rimosso.');
  });
});
