// @polsia:user-owned — "Cerca con l'AI": quando il server risponde che la ricerca non può
// funzionare (chiave o account Anthropic), il pannello smette di offrire un modulo che fallirebbe.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/custom/music/audius-section', () => ({ AudiusSection: () => null }));
vi.mock('@/components/custom/music/jamendo-section', () => ({ JamendoSection: () => null }));
vi.mock('@/components/custom/music/radio-station-tile', () => ({ StationTile: () => null }));
vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({ isHidden: () => false }),
}));

import { AiMusicSearch } from '@/components/custom/music/ai-music-search';

const roots: Array<ReturnType<typeof createRoot>> = [];

/** GET says the search is on for a Premium listener; POST fails with the given body. */
function server(failure: { error: string; message: string }) {
  mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === '/api/music/ai-search' && init?.method === 'POST') {
      throw new Error('apiFetch /api/music/ai-search failed (503)', { cause: failure });
    }
    return { enabled: true, signedIn: true, premium: true };
  });
}

const posts = () =>
  mocks.apiFetch.mock.calls.filter(([, init]) => (init as { method?: string })?.method === 'POST');

async function mountAndSubmit() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<AiMusicSearch initiallyOpen />));
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(textarea, 'jazz rilassato per una cena');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Cerca con l’AI: ricerca non disponibile', () => {
  it('con "not_configured" toglie il modulo, lo spiega e sposta lì il focus', async () => {
    server({ error: 'not_configured', message: 'La ricerca con l’AI non è ancora attiva.' });
    const container = await mountAndSubmit();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    const notice = container.querySelector('[role="alert"]');
    expect(notice?.textContent).toBe(
      'La ricerca con l’AI non è disponibile in questo momento. Puoi usare la ricerca per titolo o artista.',
    );
    expect(document.activeElement).toBe(notice);
    // Nothing left to send: one request, not one per tap.
    expect(posts()).toHaveLength(1);
  });

  it('un errore passeggero ("busy") lascia il modulo e mostra il messaggio del server', async () => {
    server({
      error: 'busy',
      message: 'L’AI è molto richiesta in questo momento. Riprova tra poco.',
    });
    const container = await mountAndSubmit();
    expect(container.querySelector('textarea')).not.toBeNull();
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'L’AI è molto richiesta in questo momento. Riprova tra poco.',
    );
  });
});
