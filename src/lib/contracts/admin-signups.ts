// @polsia:user-owned — contratto condiviso della scheda Iscritti: la route /api/admin/signups e la
// pagina /admin/iscritti importano gli stessi schemi. Solo numeri aggregati: nessun nome, email,
// telefono, id o riga per singolo utente. Gli oggetti sono `strict`: una chiave in più (per
// esempio un campo personale aggiunto per sbaglio) fa fallire il parse sul server e sul client.
import { z } from 'zod';

/** Fuso dei giorni di calendario del grafico e degli orari mostrati. */
export const SIGNUPS_TIME_ZONE = 'Europe/Rome';
/** Giorni del grafico: oggi più i 29 precedenti, dal più vecchio al più recente. */
export const SIGNUPS_DAYS = 30;

const CountSchema = z.number().int().nonnegative();

export const AdminSignupTotalsSchema = z
  .object({
    /** Tutti gli account registrati (bloccati compresi). */
    total: CountSchema,
    /** Account creati nelle ultime 24 ore (finestra mobile fino a `generatedAt`). */
    last24h: CountSchema,
    /** Account creati negli ultimi 7 × 24 ore. */
    last7d: CountSchema,
    /** Account creati negli ultimi 30 × 24 ore. */
    last30d: CountSchema,
    /** Email verificata oppure numero di telefono verificato. */
    verified: CountSchema,
    /** Blocco in corso: `banned` attivo e scadenza assente o futura (come better-auth). */
    banned: CountSchema,
    /** Account con il ruolo 'admin' (anche in una lista di ruoli separati da virgola). */
    admins: CountSchema,
  })
  .strict();

export const AdminSignupDaySchema = z
  .object({
    /** Giorno di calendario in ora italiana, `YYYY-MM-DD`. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    count: CountSchema,
  })
  .strict();

export const AdminSignupsSchema = z
  .object({
    /** Istante del calcolo (ISO 8601, UTC). */
    generatedAt: z.string().datetime(),
    timeZone: z.literal(SIGNUPS_TIME_ZONE),
    totals: AdminSignupTotalsSchema,
    /** Iscrizioni per giorno, zero compresi, dal più vecchio a oggi (oggi è parziale). */
    daily: z.array(AdminSignupDaySchema).length(SIGNUPS_DAYS),
  })
  .strict();

export type AdminSignupTotals = z.infer<typeof AdminSignupTotalsSchema>;
export type AdminSignupDay = z.infer<typeof AdminSignupDaySchema>;
export type AdminSignups = z.infer<typeof AdminSignupsSchema>;
