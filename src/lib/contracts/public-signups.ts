// @polsia:user-owned — contratto zod del contatore PUBBLICO degli iscritti mostrato sulla landing
// (GET /api/public/iscritti). Solo tre campi, tutti aggregati: totale degli account non bloccati,
// nuovi negli ultimi 7 giorni (finestra mobile di 7×24 ore) e l'istante del conteggio. Niente
// nomi, id, bloccati, admin, verificati o grafici: il dettaglio resta nella scheda admin.
// Modulo importabile dal client: solo zod, nessun import lato server.
import { z } from 'zod';

/** Percorso dell'API pubblica (stesso valore per la route e per la landing). */
export const PUBLIC_SIGNUPS_PATH = '/api/public/iscritti';

// `strict`: una chiave in più fa fallire il parse, così la risposta non può allargarsi per errore.
export const PublicSignupsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    last7Days: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type PublicSignups = z.infer<typeof PublicSignupsSchema>;
