// @polsia:user-owned — contratto del pannello admin «Riserva AI · provider»: lo stato di OGNI provider
// gratuito conosciuto dal router (src/lib/business/ai-reserve-connector.server). Mai segreti: solo se
// la chiave è presente (configured) e se l'upstream risponde (status), mai la chiave né i modelli reali
// oltre a quelli pubblici di default.
import { z } from 'zod';

/** live = chiave presente e upstream ok; failing = chiave presente ma l'upstream non risponde;
 *  not_configured = nessuna chiave nell'ambiente. */
export const ReserveProviderStatusSchema = z.enum(['live', 'failing', 'not_configured']);
export type ReserveProviderStatusName = z.infer<typeof ReserveProviderStatusSchema>;

export const ReserveProviderViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Nome della variabile d'ambiente con la chiave (da impostare su Vercel), mai il valore. */
  keyVar: z.string(),
  /** Dove ottenere una chiave gratuita. */
  signupUrl: z.string(),
  /** Modelli che il provider proverebbe in ordine (default pubblici). */
  models: z.array(z.string()),
  configured: z.boolean(),
  status: ReserveProviderStatusSchema,
  /** HTTP della sonda /models dell'upstream (null se non interrogato o irraggiungibile). */
  httpStatus: z.number().int().nullable(),
});
export type ReserveProviderView = z.infer<typeof ReserveProviderViewSchema>;

export const ReserveProvidersOverviewSchema = z.object({
  providers: z.array(ReserveProviderViewSchema),
  /** Provider con chiave presente E upstream ok. */
  liveCount: z.number().int().nonnegative(),
  /** Provider con chiave presente (a prescindere dall'esito della sonda). */
  configuredCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  checkedAt: z.string(),
});
export type ReserveProvidersOverview = z.infer<typeof ReserveProvidersOverviewSchema>;
