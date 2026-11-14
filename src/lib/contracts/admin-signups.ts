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

/**
 * Fonti del Premium, nell'ordine della pagina: abbonamenti Stripe e PayPal, acquisti in-app (App
 * Store e Google Play), accesso Solco Pro di un mese e Premium regalato dai premi.
 */
export const ADMIN_PREMIUM_SOURCES = ['stripe', 'paypal', 'inApp', 'solcoPro', 'rewards'] as const;
export type AdminPremiumSource = (typeof ADMIN_PREMIUM_SOURCES)[number];

/** Utenti Pro per fonte. Un utente può avere più fonti: la somma può superare `pro`. */
export const AdminProBySourceSchema = z
  .object({
    stripe: CountSchema,
    paypal: CountSchema,
    inApp: CountSchema,
    solcoPro: CountSchema,
    rewards: CountSchema,
  })
  .strict();

/**
 * Utenti attivi (account non bloccati, stessa regola di `totals.banned`) divisi in Free e Pro.
 * Pro = Premium attivo adesso secondo le stesse regole di hasPremiumAccess, calcolate SOLO sui
 * dati salvati (nessuna verifica in tempo reale con Stripe, PayPal o gli store).
 */
export const AdminPlansSchema = z
  .object({
    /** Utenti attivi senza Premium attivo. */
    free: CountSchema,
    /** Utenti attivi distinti con Premium attivo da almeno una fonte. */
    pro: CountSchema,
    /** Quota dei Pro sugli utenti attivi, in percentuale (0–100, un decimale). */
    proShare: z.number().min(0).max(100),
    proBySource: AdminProBySourceSchema,
  })
  .strict()
  .superRefine((plans, context) => {
    const counts = ADMIN_PREMIUM_SOURCES.map((source) => plans.proBySource[source]);
    if (counts.some((count) => count > plans.pro)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proBySource'],
        message: 'Una fonte non può contare più utenti dei Pro.',
      });
    }
    if (counts.reduce((sum, count) => sum + count, 0) < plans.pro) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proBySource'],
        message: 'Ogni utente Pro ha almeno una fonte.',
      });
    }
    if (plans.free + plans.pro === 0 && plans.proShare !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proShare'],
        message: 'Senza utenti attivi la quota dei Pro è zero.',
      });
    }
  });

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
    /**
     * Utenti attivi divisi in Free e Pro (solo conteggi). null quando le tabelle del Premium non
     * rispondono: i totali e il grafico arrivano comunque.
     */
    plans: AdminPlansSchema.nullable(),
    /** Iscrizioni per giorno, zero compresi, dal più vecchio a oggi (oggi è parziale). */
    daily: z.array(AdminSignupDaySchema).length(SIGNUPS_DAYS),
  })
  .strict();

export type AdminSignupTotals = z.infer<typeof AdminSignupTotalsSchema>;
export type AdminProBySource = z.infer<typeof AdminProBySourceSchema>;
export type AdminPlans = z.infer<typeof AdminPlansSchema>;
export type AdminSignupDay = z.infer<typeof AdminSignupDaySchema>;
export type AdminSignups = z.infer<typeof AdminSignupsSchema>;
