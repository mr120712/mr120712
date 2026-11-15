// @polsia:user-owned — contratto di GET /api/account/premium: se il proprio account è Premium e da
// quale fonte (la prima attiva, nello stesso ordine dei controlli dell'ascolto). Lo usano il badge
// «Premium» del profilo e la riga «Piano» dei «Dati dell'account». Logica pura: client, server, test.
import { z } from 'zod';

/** Le fonti del Premium, nell'ordine in cui premiumAccessSource le controlla. */
export const ACCOUNT_PREMIUM_SOURCES = [
  'solcoPro',
  'rewards',
  'subscription',
  'inApp',
  'unlimited',
] as const;
export type AccountPremiumSource = (typeof ACCOUNT_PREMIUM_SOURCES)[number];

/** Come ogni fonte si legge accanto al badge («Premium · Illimitato»). */
export const ACCOUNT_PREMIUM_SOURCE_LABEL: Record<AccountPremiumSource, string> = {
  solcoPro: 'Solco Pro',
  rewards: 'Premio',
  subscription: 'Abbonamento',
  inApp: 'In-app',
  unlimited: 'Illimitato',
};

/** Una riga che spiega la fonte nella riga «Piano» del profilo. */
export const ACCOUNT_PREMIUM_SOURCE_HINT: Record<AccountPremiumSource, string> = {
  solcoPro: 'Accesso Solco Pro attivo.',
  rewards: 'Premium ottenuto con i premi di Solco.',
  subscription: 'Abbonamento attivo.',
  inApp: 'Abbonamento attivo con un acquisto in-app.',
  unlimited: 'Premium senza scadenza.',
};

/** Premium e fonte vanno insieme: Premium con una fonte, Free senza. */
export const AccountPremiumResponseSchema = z
  .object({
    premium: z.boolean(),
    source: z.enum(ACCOUNT_PREMIUM_SOURCES).nullable(),
  })
  .strict()
  .refine((body) => body.premium === (body.source !== null), {
    message: 'Il Premium ha sempre una fonte; un account Free nessuna.',
  });
export type AccountPremiumResponse = z.infer<typeof AccountPremiumResponseSchema>;
