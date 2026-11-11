import { type AnchorHTMLAttributes, act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), useSession: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/auth-client', () => ({ useSession: mocks.useSession }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { SolcoProCheckoutStart } from '@/components/custom/solco-pro-checkout-start';
import { SolcoProCheckoutStatus } from '@/components/custom/solco-pro-checkout-status';
import { SolcoProPurchase } from '@/components/custom/solco-pro-purchase';

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset().mockResolvedValue({
    state: 'unavailable',
    missing: ['stripe_eur_checkout', 'stripe_eur_verification', 'stripe_bank_payout'],
    businessAccount: { exists: true, chargesEnabled: true, accountStatus: 'complete' },
  });
  mocks.useSession.mockReturnValue({ data: null, isPending: false });
  window.history.replaceState({}, '', '/');
});

async function render(node: ReactNode) {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root?.render(node));
  await act(async () => Promise.resolve());
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('percorso d’acquisto Solco Pro', () => {
  it('mostra 24,00 EUR, Stripe, pagamento singolo e un mese senza link o CTA abilitati', async () => {
    await render(<SolcoProPurchase />);

    expect(container.textContent).toContain('24,00 €');
    expect(container.textContent).toContain('24,00 EUR una tantum · 1 mese di accesso');
    expect(container.textContent).toContain('un pagamento · un mese');
    expect(container.textContent).toContain('Stripe');
    expect(container.textContent).toContain('Nessun rinnovo automatico');
    expect(container.textContent).toContain('chargesEnabled: true');
    expect(container.textContent).toContain('accountStatus: complete');
    expect(container.textContent).toContain('Configurazione e onboarding del titolare completati');
    expect(container.textContent).toContain('Checkout non disponibile');
    expect(container.textContent).toContain('Limite Polsia: stripe-billing 0.8.0');
    expect(container.textContent).toContain('accredito sul conto bancario configurato');
    expect(container.textContent).not.toContain('Stripe del titolare nel widget Business');
    expect(container.textContent).not.toContain('PayPal');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('rende disponibile la CTA Stripe solo quando il server segnala pronto e l’utente è autenticato', async () => {
    mocks.apiFetch.mockResolvedValue({
      state: 'ready',
      businessAccount: { exists: true, chargesEnabled: true, accountStatus: 'complete' },
    });
    mocks.useSession.mockReturnValue({ data: { user: { id: 'user-a' } }, isPending: false });
    await render(<SolcoProPurchase />);

    expect(container.textContent).toContain('Acquista Solco Pro · 24,00 EUR');
    expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(false);
    expect(container.textContent).not.toContain('PayPal');
  });

  it('mostra l’indisponibilità sul percorso checkout aperto direttamente', async () => {
    await render(<SolcoProCheckoutStart />);

    expect(container.textContent).toContain('24,00 €');
    expect(container.textContent).toContain('una tantum');
    expect(container.textContent).toContain('Stripe');
    expect(container.textContent).toContain('chargesEnabled: true');
    expect(container.textContent).toContain('accountStatus: complete');
    expect(container.textContent).toContain('Limite Polsia: stripe-billing 0.8.0');
    expect(container.textContent).toContain('accredito sul conto bancario configurato');
    expect(container.textContent).toContain('Il checkout EUR non è ancora disponibile');
    expect(container.textContent).not.toContain('PayPal');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(
      [...container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href')),
    ).toEqual(['/#piani']);
  });

  it('mostra attivo e scadenza solo dopo la risposta server-side', async () => {
    window.history.replaceState({}, '', '/checkout/success?session_id=cs_test_solco_a');
    mocks.apiFetch.mockResolvedValue({
      state: 'active',
      validUntil: '2027-02-28T12:00:00.000Z',
    });
    await render(<SolcoProCheckoutStatus />);

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/solco-pro/purchase/verify',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('Solco Pro è attivo');
    expect(container.textContent).toContain('28 febbraio 2027');
  });

  it('mantiene distinti pagamento non confermato, configurazione mancante ed errore di verifica', async () => {
    window.history.replaceState({}, '', '/checkout/success?session_id=cs_test_solco_a');
    mocks.apiFetch.mockResolvedValueOnce({
      state: 'unconfirmed',
      reason: 'authoritative_confirmation_missing',
    });
    await render(<SolcoProCheckoutStatus />);
    expect(container.textContent).toContain('Accesso non confermato');
    expect(container.textContent).not.toContain('Solco Pro è attivo');

    await act(async () => root?.unmount());
    root = null;
    mocks.apiFetch.mockReset().mockResolvedValueOnce({
      state: 'unavailable',
      reason: 'configuration_missing',
      missing: ['stripe_eur_checkout', 'stripe_eur_verification', 'stripe_bank_payout'],
    });
    await render(<SolcoProCheckoutStatus />);
    expect(container.textContent).toContain('Acquisto non disponibile');
    expect(container.textContent).not.toContain('Solco Pro è attivo');

    await act(async () => root?.unmount());
    root = null;
    mocks.apiFetch.mockReset().mockRejectedValueOnce(new Error('verification unavailable'));
    await render(<SolcoProCheckoutStatus />);
    expect(container.textContent).toContain('Verifica non disponibile');
    expect(container.textContent).not.toContain('Solco Pro è attivo');
  });
});
