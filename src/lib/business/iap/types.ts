// @polsia:user-owned — forma normalizzata di un abbonamento in-app, comune ad Apple e Google.
// I client store traducono le rispettive risposte in questo tipo; il livello entitlement decide
// accesso e piano da qui, senza conoscere i dettagli di ciascuno store.

/** Stato normalizzato. 'active' e 'grace' danno accesso; 'canceled' dà accesso fino a expiresAt. */
export type NormalizedIapState =
  | 'active'
  | 'grace'
  | 'canceled'
  | 'on_hold'
  | 'paused'
  | 'pending'
  | 'expired'
  | 'revoked';

export type NormalizedIapSubscription = {
  platform: 'apple' | 'google';
  /** Identità stabile presso lo store: Apple originalTransactionId, Google purchaseToken. */
  storeSubId: string;
  /** Ultima transazione/ordine (Apple transactionId, Google latestOrderId); diagnostica. */
  latestOrderId: string | null;
  /** productId dello store. */
  productId: string;
  state: NormalizedIapState;
  autoRenew: boolean;
  /** 'Production' | 'Sandbox' (Apple) o 'production' | 'test' (Google). */
  environment: string;
  /** Token che lega l'acquisto all'account (Apple appAccountToken / Google obfuscated id). */
  accountToken: string | null;
  /** Fine dell'accesso corrente (expiresDate Apple / expiryTime Google). */
  expiresAt: Date | null;
  /** Google: l'acquisto risulta confermato (acknowledge). Apple: sempre true (non serve). */
  acknowledged: boolean;
};

/** Gli stati normalizzati che concedono accesso adesso (a patto che expiresAt sia nel futuro). */
export const ACCESS_GRANTING_IAP_STATES: ReadonlySet<NormalizedIapState> = new Set([
  'active',
  'grace',
  'canceled',
]);

/** Errore nel parlare con lo store (rete, credenziali, acquisto non trovato, risposta inattesa). */
export class IapStoreError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'store_error'
      | 'not_found'
      | 'unexpected_response'
      | 'auth_error',
    message: string,
  ) {
    super(message);
    this.name = 'IapStoreError';
  }
}
