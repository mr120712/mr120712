// @polsia:user-owned — catalogo degli acquisti in-app (abbonamenti auto-rinnovabili).
//
// Gli ID prodotto sono la SORGENTE unica: devono combaciare ESATTAMENTE con gli ID creati in
// App Store Connect (prodotti in-app → abbonamenti auto-rinnovabili) e in Google Play Console
// (prodotti → abbonamenti). Usiamo lo stesso ID su entrambe le piattaforme per semplicità.
//
// Ogni abbonamento in-app sblocca un piano Solco (`planId`): l'accesso Pro effettivo è identico a
// quello degli abbonamenti web. Il PREZZO lo fissi negli store (Apple/Google trattengono la loro
// quota e gestiscono i listini per paese): qui non vive alcun prezzo.

export type IapPlatform = 'apple' | 'google';

export type IapPlanId = 'premium' | 'premium-plus' | 'family';
export type IapPeriod = 'month' | 'year';

export type IapProduct = {
  /** ID prodotto nello store (identico su Apple e Google). */
  productId: string;
  /** Piano Solco sbloccato. */
  planId: IapPlanId;
  /** Periodo di fatturazione. */
  period: IapPeriod;
  /** Etichetta di riserva per la paywall, se lo store non fornisce il prezzo localizzato. */
  label: string;
};

/**
 * I prodotti in-app offerti nell'app. Per aggiungere un piano (es. "Premium Plus") crea l'abbonamento
 * negli store con QUESTO stesso productId e aggiungi la riga qui: la paywall e la verifica lo seguono.
 */
export const IAP_PRODUCTS: readonly IapProduct[] = [
  {
    productId: 'solco_premium_monthly',
    planId: 'premium',
    period: 'month',
    label: 'Premium · mensile',
  },
  {
    productId: 'solco_premium_yearly',
    planId: 'premium',
    period: 'year',
    label: 'Premium · annuale',
  },
] as const;

/** Tutti gli ID prodotto conosciuti (per interrogare gli store). */
export function iapProductIds(): string[] {
  return IAP_PRODUCTS.map((product) => product.productId);
}

/** Il prodotto per un productId dello store, o null se sconosciuto (acquisto rifiutato). */
export function findIapProduct(productId: string): IapProduct | null {
  const trimmed = productId.trim();
  return IAP_PRODUCTS.find((product) => product.productId === trimmed) ?? null;
}
