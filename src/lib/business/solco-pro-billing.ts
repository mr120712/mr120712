// @polsia:user-owned

import { SOLCO_PRO_STRIPE_BUSINESS_ACCOUNT } from '@/lib/business/solco-pro-purchase-policy';
import type {
  SolcoProCheckoutMissingRequirement,
  SolcoProCheckoutStatus,
  SolcoProStripeBusinessAccountStatus,
} from '@/lib/contracts/solco-pro';

export const SOLCO_PRO_PRICE = '24,00 €';
export const SOLCO_PRO_OFFER_SUMMARY = '24,00 EUR una tantum · 1 mese di accesso';
export const SOLCO_PRO_PAYMENT_METHOD = 'Stripe';
export const SOLCO_PRO_BUSINESS_ACCOUNT_STATUS_MESSAGE = describeSolcoProBusinessAccountStatus(
  SOLCO_PRO_STRIPE_BUSINESS_ACCOUNT,
);
export const SOLCO_PRO_CHECKOUT_MISSING_DETAILS = [
  'Limite Polsia: stripe-billing 0.8.0 accetta amountUsd e non dimostra un checkout EUR da 24,00 €.',
  'Il modulo non dimostra la verifica server-side di valuta EUR, pagamento, sessione e associazione ordine/account.',
  'Polsia non conferma che l’accredito raggiunga il conto bancario configurato invece del saldo Polsia.',
] as const;

export const SOLCO_PRO_CHECKOUT_UNAVAILABLE_MESSAGE =
  'L’offerta resta 24,00 EUR una tantum per un mese, senza rinnovo. L’account Stripe Business del titolare esiste, chargesEnabled è true e accountStatus è complete: configurazione e onboarding risultano completati. Il checkout resta bloccato perché stripe-billing 0.8.0 usa importi USD e non prova il checkout o la verifica in EUR né l’accredito sul conto bancario configurato invece che sul saldo Polsia. L’accesso Pro resta bloccato. Non inviare chiavi o segreti tramite questa pagina.';

export const SOLCO_PRO_CANCELLED_MESSAGE =
  'Il pagamento non è stato confermato. Un ritorno dal checkout o una schermata di successo non attivano Solco Pro.';

const missingDescriptions: Record<SolcoProCheckoutMissingRequirement, string> = {
  stripe_configuration: 'Configurazione Stripe del titolare nel widget Business',
  stripe_onboarding: 'Verifica e onboarding Stripe del titolare nel widget Business',
  stripe_eur_checkout:
    'Limite Polsia: stripe-billing 0.8.0 accetta amountUsd e non dimostra un checkout EUR da 24,00 €',
  stripe_eur_verification:
    'Verifica Polsia server-side non dimostrata per valuta EUR, pagamento, sessione e associazione ordine/account',
  stripe_bank_payout:
    'Polsia non conferma l’accredito sul conto bancario configurato invece del saldo Polsia',
};

export function describeSolcoProBusinessAccountStatus(
  account: SolcoProStripeBusinessAccountStatus,
) {
  const setupStatus =
    account.exists && account.chargesEnabled && account.accountStatus === 'complete'
      ? 'Configurazione e onboarding del titolare completati.'
      : 'Configurazione o onboarding del titolare non risultano completati.';
  return `Account Stripe Business: ${account.exists ? 'esistente' : 'non presente'} · chargesEnabled: ${account.chargesEnabled} · accountStatus: ${account.accountStatus}. ${setupStatus}`;
}

export function describeSolcoProMissingRequirement(
  requirement: SolcoProCheckoutMissingRequirement,
) {
  return missingDescriptions[requirement];
}

export function getSolcoProCheckoutStatusMessage(status: SolcoProCheckoutStatus) {
  if (status.state === 'active') {
    return 'Solco Pro è attivo per questo account fino alla scadenza indicata.';
  }
  if (status.state === 'unconfirmed') {
    return 'Il pagamento non risulta confermato dal server. L’accesso Solco Pro resta bloccato.';
  }
  if (status.reason === 'verification_error') {
    return 'Non è stato possibile verificare lo stato dell’account. Nessun accesso viene sbloccato.';
  }

  const missing = status.missing.map(describeSolcoProMissingRequirement).join('; ');
  return `Acquisto non disponibile. Account Stripe Business esistente, chargesEnabled: true e accountStatus: complete; configurazione e onboarding completati. Capacità non verificate: ${missing}. Non inviare credenziali o segreti tramite questa pagina.`;
}
