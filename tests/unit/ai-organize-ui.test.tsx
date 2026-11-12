// @polsia:user-owned — "Organizza con l'AI": il pannello Premium estrae i brani da un testo lungo
// con Claude Opus 5.5 e crea la playlist riusando l'importazione dell'elenco brani. Test onesti:
// il gate Premium, l'estrazione con conteggio, la creazione una sola volta, e gli stati di errore
// (not_configured sostituisce il modulo, too_large spiega il limite, busy lascia il modulo).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AiOrganize } from '@/components/custom/music/ai-organize';

const roots: Array<ReturnType<typeof createRoot>> = [];

type Status = { enabled: boolean; signedIn: boolean; premium: boolean };

/** A result the organize route returns for a Premium listener. */
const ORGANIZE_RESULT = {
  tracks: [
    { title: 'Imagine', artist: 'John Lennon' },
    { title: 'One', artist: 'U2' },
  ],
  trackListText: 'John Lennon - Imagine\nU2 - One',
  note: 'Ho estratto 2 brani dalla scaletta.',
  inputTokens: 123_456,
  approxUsd: 0.4932,
  truncated: 0,
};

/**
 * Wires `apiFetch`: GET returns `status`; POST to the organize route runs `organize`
 * (returns a value or throws), POST to the import route runs `trackImport`.
 */
function server(opts: { status: Status; organize?: () => unknown; trackImport?: () => unknown }) {
  mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (path === '/api/music/ai-organize' && method === 'GET') return opts.status;
    if (path === '/api/music/ai-organize' && method === 'POST') {
      return (opts.organize ?? (() => ORGANIZE_RESULT))();
    }
    if (path === '/api/music/import/track-list' && method === 'POST') {
      return (
        opts.trackImport ??
        (() => ({
          collectionId: 'col_1',
          name: 'Dalla scaletta',
          imported: 2,
          skipped: 0,
          format: 'lines' as const,
          truncated: 0,
        }))
      )();
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

/** apiFetch's `Error.cause` carries the route's JSON error body. */
function fail(status: number, body: unknown) {
  return () => {
    throw new Error(`apiFetch failed (${status})`, { cause: body });
  };
}

function setValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<AiOrganize />));
  return container;
}

/** Fill the long-text box (textarea 0) and submit the organize form (form 0). */
async function organize(
  container: HTMLElement,
  text = 'Scaletta del concerto di ieri sera: tanta musica.',
) {
  const textarea = container.querySelectorAll('textarea')[0] as HTMLTextAreaElement;
  await act(async () => setValue(textarea, text));
  await act(async () => {
    container
      .querySelectorAll('form')[0]
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const posts = (path: string) =>
  mocks.apiFetch.mock.calls.filter(
    ([p, init]) => p === path && (init as { method?: string })?.method === 'POST',
  );

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Organizza con l’AI', () => {
  it('a un utente non Premium mostra l’invito a Premium, non il modulo', async () => {
    server({ status: { enabled: true, signedIn: true, premium: false } });
    const container = await mount();
    expect(container.querySelector('textarea')).toBeNull();
    const invite = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/piani',
    );
    expect(invite).toBeTruthy();
  });

  it('a un ospite mostra l’invito ad accedere', async () => {
    server({ status: { enabled: true, signedIn: false, premium: false } });
    const container = await mount();
    expect(container.querySelector('textarea')).toBeNull();
    const login = Array.from(container.querySelectorAll('a')).find((a) =>
      a.getAttribute('href')?.startsWith('/login'),
    );
    expect(login).toBeTruthy();
  });

  it('quando la chiave non funziona (enabled false) non mostra nulla', async () => {
    server({ status: { enabled: false, signedIn: true, premium: true } });
    const container = await mount();
    expect(container.querySelector('details')).toBeNull();
  });

  it('estrae i brani e mostra il conteggio e la stima', async () => {
    server({ status: { enabled: true, signedIn: true, premium: true } });
    const container = await mount();
    await organize(container);
    expect(posts('/api/music/ai-organize')).toHaveLength(1);
    expect(container.textContent).toContain('2 brani estratti');
    // La riga con token + costo stimato è presente.
    expect(container.textContent).toContain('token');
    expect(container.textContent).toContain('costo stimato');
    // L'elenco editabile è precompilato con le righe "Artista - Titolo".
    const lines = container.querySelectorAll('textarea')[1] as HTMLTextAreaElement;
    expect(lines.value).toBe('John Lennon - Imagine\nU2 - One');
  });

  it('"Crea playlist" chiama l’importazione dell’elenco brani una sola volta', async () => {
    server({ status: { enabled: true, signedIn: true, premium: true } });
    const container = await mount();
    await organize(container);
    // Il secondo form è la creazione della playlist.
    await act(async () => {
      container
        .querySelectorAll('form')[1]
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const importCalls = posts('/api/music/import/track-list');
    expect(importCalls).toHaveLength(1);
    const init = importCalls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body).text).toBe('John Lennon - Imagine\nU2 - One');
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    // Esito: link alle playlist dell’utente.
    const toLibrary = Array.from(container.querySelectorAll('a')).find((a) =>
      a.getAttribute('href')?.startsWith('/library'),
    );
    expect(toLibrary).toBeTruthy();
  });

  it('con "not_configured" toglie il modulo e lo spiega', async () => {
    server({
      status: { enabled: true, signedIn: true, premium: true },
      organize: fail(503, {
        error: 'not_configured',
        message: 'L’organizzazione con l’AI non è ancora attiva.',
      }),
    });
    const container = await mount();
    await organize(container);
    expect(container.querySelector('textarea')).toBeNull();
    const notice = container.querySelector('[role="alert"]');
    expect(notice?.textContent).toContain('non è disponibile in questo momento');
    expect(document.activeElement).toBe(notice);
    // Niente da reinviare: una sola richiesta.
    expect(posts('/api/music/ai-organize')).toHaveLength(1);
  });

  it('con "too_large" mostra il limite e i token misurati, lasciando il modulo', async () => {
    server({
      status: { enabled: true, signedIn: true, premium: true },
      organize: fail(413, {
        error: 'too_large',
        message:
          'Il testo è troppo lungo da leggere tutto in una volta (500.000 token, massimo 400.000). Accorcialo e riprova.',
        inputTokens: 500_000,
        maxInputTokens: 400_000,
      }),
    });
    const container = await mount();
    await organize(container);
    // Il modulo resta (il testo si può accorciare) e il messaggio spiega il limite.
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('400.000');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('500.000');
  });

  it('un errore passeggero ("busy") lascia il modulo e mostra il messaggio', async () => {
    server({
      status: { enabled: true, signedIn: true, premium: true },
      organize: fail(503, {
        error: 'busy',
        message: 'L’AI è molto richiesta in questo momento. Riprova tra poco.',
      }),
    });
    const container = await mount();
    await organize(container);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'L’AI è molto richiesta in questo momento. Riprova tra poco.',
    );
  });
});
