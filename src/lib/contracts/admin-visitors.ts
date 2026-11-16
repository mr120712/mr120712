// @polsia:user-owned — contratto condiviso della scheda Visitatori: la route /api/admin/visitors e
// la pagina /admin/visitatori importano gli stessi schemi. Solo numeri aggregati: nessun indirizzo
// IP, nessun identificativo di visitatore, nessun indirizzo di provenienza intero. Gli oggetti sono
// `strict`: una chiave in più fa fallire il parse sul server e sul client.
import { z } from 'zod';

/** Fuso dei giorni di calendario del grafico e degli orari mostrati. */
export const VISITORS_TIME_ZONE = 'Europe/Rome';
/** Giorni del grafico: oggi più i 29 precedenti, dal più vecchio al più recente. */
export const VISITORS_DAYS = 30;
/** Dopo quanti giorni le righe delle visite vengono cancellate (/api/cron/cleanup). */
export const VISITORS_RETENTION_DAYS = 90;
/** Quante voci al massimo nelle classifiche (pagine, Paesi, provenienze). */
export const VISITORS_TOP_LIMIT = 12;

export const VISIT_DEVICES = ['desktop', 'mobile', 'tablet'] as const;
export type VisitDevice = (typeof VISIT_DEVICES)[number];

const CountSchema = z.number().int().nonnegative();
const DayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Visitatori distinti del periodo e pagine aperte. Nelle finestre di più giorni i visitatori sono la somma dei distinti di ogni giorno (l'impronta cambia ogni giorno). */
export const VisitorWindowSchema = z
  .object({
    visitors: CountSchema,
    views: CountSchema,
  })
  .strict();

export const VisitorDaySchema = z
  .object({
    /** Giorno di calendario in ora italiana, `YYYY-MM-DD`. */
    day: DayKeySchema,
    visitors: CountSchema,
    views: CountSchema,
  })
  .strict();

export const VisitorPageSchema = z
  .object({
    path: z.string().min(1).max(200),
    visitors: CountSchema,
    views: CountSchema,
  })
  .strict();

export const VisitorCountrySchema = z
  .object({
    /** Codice ISO 3166-1 alpha-2 in maiuscolo, oppure "" per sconosciuto. */
    country: z.string().regex(/^([A-Z]{2}|)$/),
    visitors: CountSchema,
  })
  .strict();

export const VisitorReferrerSchema = z
  .object({
    /** Solo l'host (es. "www.google.com"). */
    host: z.string().min(1).max(253),
    visitors: CountSchema,
  })
  .strict();

export const VisitorDeviceSchema = z
  .object({
    device: z.enum(VISIT_DEVICES),
    visitors: CountSchema,
  })
  .strict();

export const AdminVisitorsSchema = z
  .object({
    /** Istante del calcolo (ISO 8601, UTC). */
    generatedAt: z.string().datetime(),
    timeZone: z.literal(VISITORS_TIME_ZONE),
    retentionDays: z.literal(VISITORS_RETENTION_DAYS),
    /** Oggi (giorno di calendario italiano, in corso). */
    today: VisitorWindowSchema,
    /** Oggi e i 6 giorni precedenti. */
    last7d: VisitorWindowSchema,
    /** Oggi e i 29 giorni precedenti: lo stesso periodo del grafico e delle classifiche. */
    last30d: VisitorWindowSchema,
    /** Visite per giorno, zero compresi, dal più vecchio a oggi (oggi è parziale). */
    daily: z.array(VisitorDaySchema).length(VISITORS_DAYS),
    /** Pagine più aperte negli ultimi 30 giorni, dalla più vista. */
    pages: z.array(VisitorPageSchema).max(VISITORS_TOP_LIMIT),
    /** Paesi per visitatori distinti negli ultimi 30 giorni. */
    countries: z.array(VisitorCountrySchema).max(VISITORS_TOP_LIMIT),
    /** Siti di provenienza (solo host) per visitatori negli ultimi 30 giorni; gli accessi diretti non compaiono. */
    referrers: z.array(VisitorReferrerSchema).max(VISITORS_TOP_LIMIT),
    /** Visitatori per tipo di dispositivo negli ultimi 30 giorni. */
    devices: z.array(VisitorDeviceSchema).max(VISIT_DEVICES.length),
  })
  .strict();

export type VisitorWindow = z.infer<typeof VisitorWindowSchema>;
export type VisitorDay = z.infer<typeof VisitorDaySchema>;
export type VisitorPage = z.infer<typeof VisitorPageSchema>;
export type VisitorCountry = z.infer<typeof VisitorCountrySchema>;
export type VisitorReferrer = z.infer<typeof VisitorReferrerSchema>;
export type VisitorDeviceCount = z.infer<typeof VisitorDeviceSchema>;
export type AdminVisitors = z.infer<typeof AdminVisitorsSchema>;
