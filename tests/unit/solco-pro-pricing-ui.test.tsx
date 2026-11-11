import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { SolcoProPlanOptions } from '@/components/custom/solco-pro-plan-options';

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset().mockImplementation((path: string) => {
    if (path === '/api/solco-pro/plans') return Promise.resolve(getSolcoProPricing());
    return Promise.resolve({ selection: null });
  });
});

async function render(node: ReactNode) {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root?.render(node));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

describe('sezione dei prezzi nel dashboard Solco', () => {
  it('mostra i quattro piani nell’ordine richiesto con entrambi i prezzi e le cadenze', async () => {
    await render(<SolcoProPlanOptions />);

    expect(
      [...container.querySelectorAll<HTMLElement>('[data-plan-id]')].map((card) =>
        card.getAttribute('data-plan-id'),
      ),
    ).toEqual(['free', 'premium', 'premium-plus', 'family']);
    expect(container.textContent).toContain('Free');
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toContain(
      'Mensile / Annuale',
    );
    expect(container.textContent).toContain('0 €/mese');
    expect(container.textContent).toContain('0 €/anno');
    expect(container.textContent).toContain('4,99 €/mese');
    expect(container.textContent).toContain('49,99 €/anno');
    expect(container.textContent).toContain('7,99 €/mese');
    expect(container.textContent).toContain('79,99 €/anno');
    expect(container.textContent).toContain('12,99 €/mese');
    expect(container.textContent).toContain('129,99 €/anno');
  });

  it('commuta tra mensile e annuale e mostra confronti e risparmi esatti', async () => {
    await render(<SolcoProPlanOptions />);

    const annual = container.querySelector<HTMLInputElement>('input[value="year"]');
    expect(annual).not.toBeNull();
    expect(annual?.checked).toBe(false);
    await act(async () => annual?.click());

    expect(annual?.checked).toBe(true);
    expect(container.textContent).toContain('0,00 €');
    expect(container.textContent).toContain('Dodici mensilità: 59,88 €');
    expect(container.textContent).toContain('Risparmia con il piano annuale: 9,89 €');
    expect(container.textContent).toContain('Dodici mensilità: 95,88 €');
    expect(container.textContent).toContain('Risparmia con il piano annuale: 15,89 €');
    expect(container.textContent).toContain('Dodici mensilità: 155,88 €');
    expect(container.textContent).toContain('Risparmia con il piano annuale: 25,89 €');
  });

  it('spiega indisponibilità e mappatura benefit assente senza aggiungere azioni di pagamento', async () => {
    await render(<SolcoProPlanOptions />);

    expect(container.textContent).toContain('Prezzi mostrati, non prezzi Stripe confermati.');
    expect(container.textContent).toContain('Non risultano mappature Stripe ricorrenti in EUR.');
    expect(container.textContent).toContain('verifiche legali, fiscali e del provider');
    expect(container.textContent).toContain(
      'Gli acquisti a pagamento e i cambi di piano o cadenza non sono disponibili.',
    );
    expect(container.textContent).toContain(
      'La matrice delle funzionalità e dei limiti per questi quattro piani non è disponibile.',
    );
    const paidPlanActions = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-plan-id="premium"] button, [data-plan-id="premium-plus"] button, [data-plan-id="family"] button',
      ),
    ];
    expect(paidPlanActions).toHaveLength(3);
    expect(paidPlanActions.every((button) => button.disabled)).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-plan-id="free"] button')?.disabled,
    ).toBe(false);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/solco-pro/plans',
      expect.objectContaining({ schema: expect.anything() }),
    );
    expect(container.textContent).toContain('La scelta Free viene salvata solo per il tuo account');
  });

  it('salva la scelta Free con la cadenza esplicitamente selezionata', async () => {
    mocks.apiFetch.mockImplementation(
      (path: string, options?: { method?: string; body?: string }) => {
        if (path === '/api/solco-pro/plans') return Promise.resolve(getSolcoProPricing());
        if (options?.method === 'POST') {
          return Promise.resolve({
            selection: {
              planId: 'free',
              billingPeriod: options.body?.includes('"billingPeriod":"year"') ? 'year' : 'month',
              amountEuroCents: 0,
              currency: 'EUR',
              state: 'active',
              selectedAt: '2026-11-09T12:00:00.000Z',
              renewalAt: null,
            },
          });
        }
        return Promise.resolve({ selection: null });
      },
    );
    await render(<SolcoProPlanOptions />);

    const annual = container.querySelector<HTMLInputElement>('input[value="year"]');
    await act(async () => annual?.click());
    const selectFree = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Scegli Free · annuale'),
    );
    await act(async () => selectFree?.click());

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/solco-pro/plan-selection',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ planId: 'free', billingPeriod: 'year' }),
        schema: expect.anything(),
      }),
    );
    expect(container.textContent).toContain(
      'Piano Free annuale selezionato: 0 €. Nessun rinnovo o addebito.',
    );
  });

  it('ripristina la cadenza Free salvata e allinea il prezzo riepilogato', async () => {
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path === '/api/solco-pro/plans') return Promise.resolve(getSolcoProPricing());
      return Promise.resolve({
        selection: {
          planId: 'free',
          billingPeriod: 'year',
          amountEuroCents: 0,
          currency: 'EUR',
          state: 'active',
          selectedAt: '2026-11-09T12:00:00.000Z',
          renewalAt: null,
        },
      });
    });

    await render(<SolcoProPlanOptions />);

    expect(container.querySelector<HTMLInputElement>('input[value="year"]')?.checked).toBe(true);
    expect(
      container.querySelector('[data-plan-id="free"] p[aria-live="polite"]')?.textContent,
    ).toContain('0 €/anno');
    expect(container.textContent).toContain(
      'Piano Free annuale selezionato: 0 €. Nessun rinnovo o addebito.',
    );
  });
});
