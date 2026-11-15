// @polsia:user-owned — pagina admin «audio.com»: stato collegato (nome dell'account, data, ultimo
// problema), «Scollega» con DELETE, «Collega audio.com» quando manca il collegamento, spiegazione
// quando non è configurato e messaggio del ritorno da audio.com (poi l'indirizzo torna pulito).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { AudioComAdmin } from '@/components/custom/music/audiocom-admin';

const base = {
  configured: true,
  connected: false,
  needsReconnect: false,
  clientRegistered: false,
  accountName: null,
  connectedAt: null,
  lastError: null,
  lastErrorAt: null,
  redirectUri: 'https://solco.test/api/admin/audiocom/callback',
};

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<AudioComAdmin />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
  window.history.replaceState(null, '', '/admin/audiocom');
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('AudioComAdmin', () => {
  it('non collegato: link «Collega audio.com» alla route di avvio', async () => {
    mocks.apiFetch.mockResolvedValue(base);
    const container = await mount();
    const link = [...container.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Collega audio.com'),
    );
    expect(link?.getAttribute('href')).toBe('/api/admin/audiocom/login');
    expect(container.textContent).toContain('Nessun account audio.com collegato');
    expect(container.textContent).toContain('termini d’uso dell’API di audio.com');
  });

  it('collegato: nome dell’account, ultimo problema; «Scollega» manda DELETE e ricarica', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      // Con l'account collegato compare anche il pannello «In evidenza nella Home».
      url === '/api/admin/audiocom/collections'
        ? { status: 'ok', collections: [], featuredIds: [] }
        : init?.method === 'DELETE'
          ? { disconnected: true }
          : {
              ...base,
              connected: true,
              clientRegistered: true,
              accountName: 'Solco Official',
              connectedAt: '2026-11-14T09:00:00.000Z',
              lastError: 'rate_limited',
              lastErrorAt: '2026-11-15T08:00:00.000Z',
            },
    );
    const container = await mount();
    expect(container.textContent).toContain('Collegato come Solco Official');
    expect(container.textContent).toContain('troppe richieste');
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Scollega'),
    );
    await act(async () => button?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/admin/audiocom', { method: 'DELETE' });
    expect(mocks.success).toHaveBeenCalled();
  });

  it('non configurato: spiega cosa serve (nessuna chiave di audio.com)', async () => {
    mocks.apiFetch.mockResolvedValue({ ...base, configured: false, redirectUri: null });
    const container = await mount();
    expect(container.textContent).toContain('NEXT_PUBLIC_APP_URL');
    expect(container.textContent).toContain('BETTER_AUTH_SECRET');
    expect(container.querySelector('a[href="/api/admin/audiocom/login"]')).toBeNull();
  });

  it('ritorno da audio.com: messaggio e indirizzo ripulito', async () => {
    window.history.replaceState(null, '', '/admin/audiocom?audiocom=error&reason=denied');
    mocks.apiFetch.mockResolvedValue(base);
    await mount();
    expect(mocks.error).toHaveBeenCalledWith('Hai annullato l’autorizzazione su audio.com.');
    expect(window.location.search).toBe('');
  });
});
