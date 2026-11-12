// @polsia:user-owned — contratti degli acquisti in-app (Apple App Store / Google Play).
import { z } from 'zod';

export const iapPlatformSchema = z.enum(['apple', 'google']);
export type IapPlatformName = z.infer<typeof iapPlatformSchema>;

/**
 * Corpo inviato dall'app dopo un acquisto. `token` è il transactionId (Apple) o il purchaseToken
 * (Google): il server lo usa per RI-LEGGERE lo stato autorevole dallo store, non si fida del resto.
 */
export const iapVerifyRequestSchema = z
  .object({
    platform: iapPlatformSchema,
    productId: z.string().trim().min(1).max(191),
    token: z.string().trim().min(1).max(4096),
  })
  .strict();
export type IapVerifyRequest = z.infer<typeof iapVerifyRequestSchema>;

export const iapVerifyResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    active: z.boolean(),
    validUntil: z.string().datetime().nullable(),
    planId: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'not_configured',
      'unknown_product',
      'not_found',
      'account_mismatch',
      'sandbox_not_allowed',
      'store_error',
    ]),
  }),
]);
export type IapVerifyResponse = z.infer<typeof iapVerifyResponseSchema>;

export const iapStatusResponseSchema = z.object({
  active: z.boolean(),
  validUntil: z.string().datetime().nullable(),
  planId: z.string().nullable(),
});
export type IapStatusResponse = z.infer<typeof iapStatusResponseSchema>;

export const iapProductSchema = z.object({
  productId: z.string(),
  planId: z.string(),
  period: z.enum(['month', 'year']),
  label: z.string(),
});

/** Catalogo per la paywall dell'app: prodotti, piattaforme disponibili e il token di account. */
export const iapProductsResponseSchema = z.object({
  available: z.boolean(),
  platforms: z.object({ apple: z.boolean(), google: z.boolean() }),
  products: z.array(iapProductSchema),
  /** UUID che l'app passa allo store per legare l'acquisto a questo account. */
  accountToken: z.string(),
});
export type IapProductsResponse = z.infer<typeof iapProductsResponseSchema>;
