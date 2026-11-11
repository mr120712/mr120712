import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { SolcoProSubscription } from '@/components/custom/solco-pro-subscription';

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockImplementation((path: string) => {
    if (path === '/api/solco-pro/subscription') {
      return Promise.resolve({
        state: 'active',
        validUntil: '2026-12-01T12:00:00.000Z',
        purchase: {
          planId: 'solco-pro',
          paymentMode: 'payment',
          amountEuroCents: 2400,
          currency: 'EUR',
          validUntil: '2026-12-01T12:00:00.000Z',
          renewalAt: null,
        },
      });
    }
    if (path === '/api/solco-pro/plans') return Promise.resolve(getSolcoProPricing());
    return Promise.resolve({ selection: null });
  });
});

async function render(node: ReactNode) {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

describe('pannello Abbonamento e pagamenti Solco', () => {
  it('mostra solo il prezzo e il termine dell’acquisto precedente verificato e disattiva il portale', async () => {
    await render(<SolcoProSubscription />);

    expect(container.textContent).toContain(
      'Acquisto precedente Solco Pro confermato: 24,00 € una tantum per un mese, senza rinnovo.',
    );
    expect(container.textContent).toContain('Accesso attivo fino al 1 dicembre 2026.');
    const portalButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Portale di fatturazione non disponibile'),
    );
    expect(portalButton?.disabled).toBe(true);
    expect(container.textContent).toContain(
      'Il portale Stripe e la gestione di metodo di pagamento, fatture o cancellazioni non sono disponibili',
    );
  });
});
