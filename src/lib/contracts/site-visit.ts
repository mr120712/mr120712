// @polsia:user-owned — contratto del segnale di visita (POST /api/visits): il beacon del browser
// (src/components/custom/visit-beacon.tsx) e la route importano lo stesso schema. Porta solo il
// percorso della pagina e, alla prima pagina, l'indirizzo di provenienza: niente cookie, niente
// identificativi, niente dati personali.
import { z } from 'zod';

export const VISIT_PATH_MAX_LENGTH = 200;
export const VISIT_REFERRER_MAX_LENGTH = 2048;

export const SiteVisitBeaconSchema = z
  .object({
    /** Percorso della pagina (solo pathname, senza query né frammento). */
    path: z.string().min(1).max(VISIT_PATH_MAX_LENGTH),
    /** `document.referrer` della prima pagina della visita; il server ne tiene solo l'host. */
    referrer: z.string().max(VISIT_REFERRER_MAX_LENGTH).optional(),
  })
  .strict();

export type SiteVisitBeacon = z.infer<typeof SiteVisitBeaconSchema>;
