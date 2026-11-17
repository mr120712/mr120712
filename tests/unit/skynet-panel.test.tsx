// @polsia:user-owned — pannello «Skynet» in /admin/monitoraggio: stato tranquillo, incidente e
// primo giro; come collegare Vercel e Telegram quando mancano; diario con i rapporti; errore.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { agoText, SkynetPanel } from '@/components/custom/monitoring/skynet-panel';
import type { SkynetOverview } from '@/lib/contracts/skynet';

const NOW = new Date('2026-11-17T21:30:00.000Z');
const roots: Array<{ root: Root; container: HTMLElement }> = [];

function overview(overrides: Partial<SkynetOverview> = {}): SkynetOverview {
  return {
    status: 'calm',
    lastRunAt: '2026-11-17T21:29:00.000Z',
    incidentSince: null,
    incidentKeys: [],
    signals: {
      at: '2026-11-17T21:29:00.000Z',
      vercel: {
        configured: true,
        reachable: true,
        anomalies: 0,
        firewallEnabled: true,
        firewallVersion: 14,
        aiBotsActive: true,
        skynetRulesActive: 3,
        attackMode: false,
      },
      site: {
        healthOk: true,
        healthStatus: 200,
        healthMs: 140,
        internal: 'ok',
        internalFailing: [],
      },
    },
    configured: { vercel: true, telegramRecipients: 1, ai: true },
    events: [],
    ...overrides,
  };
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => root.render(<SkynetPanel />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  mocks.apiFetch.mockReset();
});

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

describe('pannello Skynet', () => {
  it('tutto tranquillo: firewall, sito, Telegram e Claude in chiaro', async () => {
    mocks.apiFetch.mockResolvedValue(overview());
    const view = await mount();
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/admin/skynet', expect.anything());
    const text = view.textContent ?? '';
    expect(view.querySelector('output')?.textContent).toContain('Tutto tranquillo');
    expect(text).toContain('Ultimo giro 1 minuto fa');
    expect(text).toContain('Attivo · versione 14 · regole Skynet 3/3 · blocco AI attivo');
    expect(text).toContain('Risponde in 140 ms');
    expect(text).toContain('1 chat collegata');
    expect(text).toContain('Scritti da Claude');
    expect(text).not.toContain('SKYNET_VERCEL_TOKEN');
  });

  it('incidente aperto: problemi in parole e diario con il rapporto', async () => {
    mocks.apiFetch.mockResolvedValue(
      overview({
        status: 'incident',
        incidentSince: '2026-11-17T21:20:00.000Z',
        incidentKeys: ['ddos', 'site-down'],
        events: [
          {
            id: 'e1',
            at: '2026-11-17T21:20:00.000Z',
            kind: 'incident',
            severity: 'critical',
            title: 'Possibile attacco DDoS in corso',
            report: 'Traffico anomalo: valuti la protezione anti-attacco.',
            keys: ['ddos'],
            notified: 1,
          },
        ],
      }),
    );
    const view = await mount();
    const status = view.querySelector('output');
    expect(status?.getAttribute('data-status')).toBe('incident');
    expect(status?.textContent).toContain('Incidente aperto da 10 minuti');
    expect(status?.textContent).toContain('possibile attacco DDoS, sito irraggiungibile');
    expect(view.textContent).toContain('Incidente · 10 minuti fa · inviato su Telegram');
    expect(view.querySelector('details')?.textContent).toContain('Traffico anomalo');
  });

  it('senza token né Telegram: spiega come collegarli, senza mostrare segreti', async () => {
    mocks.apiFetch.mockResolvedValue(
      overview({
        status: 'never',
        lastRunAt: null,
        signals: null,
        configured: { vercel: false, telegramRecipients: 0, ai: false },
      }),
    );
    const view = await mount();
    const text = view.textContent ?? '';
    expect(text).toContain('In attesa del primo giro');
    expect(text).toContain('Manca il token');
    expect(text).toContain('SKYNET_VERCEL_TOKEN');
    expect(text).toContain('Ricevi il codice su Telegram');
    expect(text).toContain('Testo fisso');
  });

  it('errore di rete: messaggio chiaro', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('rete'));
    const view = await mount();
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(
      'Lo stato di Skynet non è disponibile in questo momento.',
    );
  });

  it('tempi relativi in italiano', () => {
    const now = NOW.getTime();
    expect(agoText(null, now)).toBe('mai');
    expect(agoText('2026-11-17T21:29:50.000Z', now)).toBe('adesso');
    expect(agoText('2026-11-17T19:30:00.000Z', now)).toBe('2 ore fa');
  });
});
