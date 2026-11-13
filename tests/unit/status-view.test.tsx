// @polsia:user-owned
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Abilita il supporto a act() in questo ambiente di test (silenzia il warning di React).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { StatusView } from '@/components/custom/status/status-view';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  mocks.apiFetch.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(<StatusView />);
  });
  // flush the apiFetch resolution + state update
  await act(async () => {
    await Promise.resolve();
  });
}

describe('StatusView', () => {
  it('mostra solo i controlli core, con il fallimento core evidenziato', async () => {
    mocks.apiFetch.mockResolvedValue({
      status: 'down',
      checkedAt: new Date().toISOString(),
      stale: false,
      failing: ['database'],
      warnings: [],
      ok: ['signup_write', 'auth_config', 'google_signin'],
    });
    await mount();

    const text = container.textContent ?? '';
    // Un fallimento core → stato generale "down"
    expect(text).toContain('Solco non è utilizzabile');
    // Controlli core elencati; il failing core è "Non funziona", gli altri "Operativo"
    expect(text).toContain('Database');
    expect(text).toContain('Non funziona');
    expect(text).toContain('Operativo');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/status', expect.objectContaining({}));
  });

  it('un problema su integrazioni esterne NON intacca lo stato API né appare in lista', async () => {
    // audius/youtube_quota sono non-core: lo stato API resta operativo e non vengono mostrati.
    mocks.apiFetch.mockResolvedValue({
      status: 'degraded',
      checkedAt: new Date().toISOString(),
      stale: false,
      failing: ['audius'],
      warnings: ['youtube_quota'],
      ok: ['database', 'signup_write', 'auth_config', 'google_signin'],
    });
    await mount();
    const text = container.textContent ?? '';
    expect(text).toContain('Tutto funziona'); // overall calcolato solo sui core → ok
    expect(text).not.toContain('Audius');
    expect(text).not.toContain('YouTube');
  });

  it('mostra lo stato di errore se la lettura fallisce', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('offline'));
    await mount();
    expect(container.textContent ?? '').toContain('Non riesco a leggere lo stato');
  });

  it('con tutti i core ok mostra «Tutto funziona»', async () => {
    mocks.apiFetch.mockResolvedValue({
      status: 'ok',
      checkedAt: new Date().toISOString(),
      stale: false,
      failing: [],
      warnings: [],
      ok: ['database', 'signup_write', 'auth_config', 'google_signin'],
    });
    await mount();
    expect(container.textContent ?? '').toContain('Tutto funziona');
  });
});
