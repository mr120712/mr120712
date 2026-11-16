// @polsia:user-owned — pulsante «Verifica Solco AI» della pagina admin «Diritti e testi»: una sola
// richiesta POST per volta (aria-busy, il secondo clic non parte), avviso di riuscita con motore e
// tempo di risposta, avviso di errore con il messaggio del server (chiave non valida, crediti
// finiti, chiave assente) o con un testo per i codici noti; risposta non valida e rete gestite.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({
  toast: Object.assign(mocks.toast, { success: mocks.success, error: mocks.error }),
}));

import {
  checkEnginesText,
  checkFailureText,
  checkSuccessText,
  TRANSCRIPTION_CHECK_ENDPOINT,
  TranscriptionAiCheckButton,
} from '@/components/custom/admin/transcription-ai-check-button';
import {
  TRANSCRIPTION_CHECK_SUCCESS,
  TRANSCRIPTION_NOT_CONFIGURED_MESSAGE,
  TranscriptionCheckResponseSchema,
} from '@/lib/contracts/lyrics-transcription';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENGINE = 'Solco AI (Groq · whisper-large-v3)';
const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => root.render(<TranscriptionAiCheckButton />));
  await flush();
  const button = container.querySelector('button');
  if (!button) throw new Error('Pulsante non trovato.');
  return button;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await flush();
}

function apiError(status: number, body: Record<string, unknown>) {
  return new Error(`apiFetch ${TRANSCRIPTION_CHECK_ENDPOINT} failed (${status})`, { cause: body });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

describe('TranscriptionAiCheckButton', () => {
  it('chiede la verifica al server e conferma con motore e tempo di risposta', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.apiFetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const button = await mount();
    expect(button.textContent).toContain('Verifica Solco AI');
    expect(button.textContent).not.toContain('OpenAI');
    expect(button.getAttribute('aria-busy')).toBeNull();

    await click(button);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith(TRANSCRIPTION_CHECK_ENDPOINT, {
      method: 'POST',
      schema: TranscriptionCheckResponseSchema,
    });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');

    // Un secondo clic durante la verifica non parte.
    await click(button);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({
        ok: true,
        model: 'whisper-large-v3',
        engine: ENGINE,
        elapsedMs: 1234,
        checkedAt: '2026-11-16T13:00:00.000Z',
        engines: [{ id: 'groq', label: ENGINE, ok: true, elapsedMs: 1234, message: null }],
      });
    });
    await flush();
    expect(mocks.success).toHaveBeenCalledWith(
      checkSuccessText({ engine: ENGINE, elapsedMs: 1234 }),
    );
    expect(checkSuccessText({ engine: ENGINE, elapsedMs: 1234 })).toBe(
      `${TRANSCRIPTION_CHECK_SUCCESS} · ${ENGINE} · risposta in 1,2 s`,
    );
    expect(mocks.error).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('con più motori l’avviso elenca l’esito di ciascuno', async () => {
    const reason = 'Chiave Groq non valida (controlla GROQ_API_KEY su Vercel).';
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      model: 'nova-3',
      engine: 'Deepgram (nova-3)',
      elapsedMs: 600,
      checkedAt: '2026-11-16T13:00:00.000Z',
      engines: [
        { id: 'groq', label: ENGINE, ok: false, elapsedMs: 300, message: reason },
        { id: 'deepgram', label: 'Deepgram (nova-3)', ok: true, elapsedMs: 600, message: null },
      ],
    });
    const button = await mount();
    await click(button);
    expect(mocks.success).toHaveBeenCalledWith(
      checkSuccessText({ engine: 'Deepgram (nova-3)', elapsedMs: 600 }),
      { description: `${ENGINE}: ${reason} · Deepgram (nova-3): ok in 0,6 s` },
    );
    expect(checkEnginesText([])).toBeNull();
  });

  it('errore: il messaggio del server (chiave, crediti, chiave assente) in un avviso', async () => {
    const button = await mount();
    for (const [status, body] of [
      [
        502,
        {
          error: 'transcription_invalid_key',
          message: 'Chiave Groq non valida (controlla GROQ_API_KEY su Vercel).',
        },
      ],
      [
        402,
        {
          error: 'transcription_no_credit',
          message: 'Crediti Groq esauriti o fatturazione non attiva.',
        },
      ],
      [
        503,
        { error: 'transcription_not_configured', message: TRANSCRIPTION_NOT_CONFIGURED_MESSAGE },
      ],
    ] as Array<[number, { error: string; message: string }]>) {
      mocks.apiFetch.mockRejectedValueOnce(apiError(status, body));
      await click(button);
      expect(mocks.error).toHaveBeenLastCalledWith(body.message);
    }
    expect(mocks.success).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('testi per i codici senza messaggio, risposta non valida e rete', () => {
    expect(checkFailureText(apiError(401, { error: 'unauthorized' }))).toBe(
      'La sessione è scaduta: accedi di nuovo.',
    );
    expect(checkFailureText(apiError(403, { error: 'forbidden' }))).toContain('amministratore');
    expect(checkFailureText(apiError(403, { error: 'forbidden_origin' }))).toContain('ricarica');
    expect(checkFailureText(apiError(500, { error: 'boh' }))).toBe(
      'Verifica di Solco AI non riuscita. Riprova tra poco.',
    );
    expect(checkFailureText(new ZodError([]))).toContain('formato atteso');
    expect(checkFailureText(new TypeError('fetch failed'))).toContain('Connessione non riuscita');
    expect(checkFailureText(apiError(502, { message: `  ${'x'.repeat(400)}  ` }))).toHaveLength(
      300,
    );
  });
});
