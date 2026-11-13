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
  it('mostra lo stato generale e i controlli, con i failing/warning evidenziati', async () => {
    mocks.apiFetch.mockResolvedValue({
      status: 'degraded',
      checkedAt: new Date().toISOString(),
      stale: false,
      failing: ['audius'],
      warnings: ['youtube_quota'],
    });
    await mount();

    const text = container.textContent ?? '';
    // Etichetta stato generale (degraded)
    expect(text).toContain('Qualcosa non funziona');
    // Un controllo elencato
    expect(text).toContain('Database');
    // Il controllo in failing è "Non funziona", quello normale "Operativo"
    expect(text).toContain('Non funziona');
    expect(text).toContain('Operativo');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/status', expect.objectContaining({}));
  });

  it('mostra lo stato di errore se la lettura fallisce', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('offline'));
    await mount();
    expect(container.textContent ?? '').toContain('Non riesco a leggere lo stato');
  });

  it('con stato ok mostra «Tutto funziona»', async () => {
    mocks.apiFetch.mockResolvedValue({
      status: 'ok',
      checkedAt: new Date().toISOString(),
      stale: false,
      failing: [],
      warnings: [],
    });
    await mount();
    expect(container.textContent ?? '').toContain('Tutto funziona');
  });
});
