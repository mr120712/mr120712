// @polsia:user-owned — contratto condiviso di «Utenti del vecchio sito» (/admin/utenti-vecchi): le
// route /api/admin/legacy-users e /api/admin/legacy-users/import e la pagina importano gli stessi
// schemi. Escono solo conteggi, nomi di variabili d'ambiente, un'impronta opaca del database e
// un'indicazione generica del fornitore: mai URL, host, utenti, password, email, hash o id.
// Gli oggetti sono `strict`: una chiave in più fa fallire il parse sul server e sul client.
import { z } from 'zod';

const CountSchema = z.number().int().nonnegative();
const IsoDateSchema = z.string().datetime();

/** Impronta opaca (HMAC) dell'identità di un database: 32 caratteri esadecimali. */
export const LegacySourceKeySchema = z.string().regex(/^[a-f0-9]{32}$/);

/** Nome di una variabile d'ambiente (mai il valore). */
const EnvNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

/** Etichetta di una variabile o di un gruppo "a pezzi" (es. "MY_STR_PG*"). */
const EnvLabelSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}\*?$/);

export const LEGACY_DB_STATUSES = [
  'current',
  'ready',
  'incomplete',
  'error',
  'incompatible',
] as const;
export const LegacyDbStatusSchema = z.enum(LEGACY_DB_STATUSES);
export type LegacyDbStatus = z.infer<typeof LegacyDbStatusSchema>;

export const LegacyErrorKindSchema = z.enum([
  'timeout',
  'auth',
  'ssl',
  'not_found',
  'unreachable',
  'too_large',
  'unknown',
]);
export type LegacyErrorKindValue = z.infer<typeof LegacyErrorKindSchema>;

/** Numeri del piano di trasferimento per un database (calcolati senza scrivere nulla). */
export const LegacyStatsSchema = z
  .object({
    /** Utenti nella tabella "user" del vecchio database. */
    users: CountSchema,
    verified: CountSchema,
    banned: CountSchema,
    /** Utenti con un numero di telefono salvato. */
    withPhone: CountSchema,
    /** Amministratori nel vecchio sito (non lo saranno qui). */
    legacyAdmins: CountSchema,
    oldestAt: IsoDateSchema.nullable(),
    newestAt: IsoDateSchema.nullable(),
    /** Già trasferiti in un passaggio precedente (anche tramite un'altra variabile). */
    alreadyImported: CountSchema,
    /** Email già presente nel database attuale: non si tocca. */
    alreadyPresent: CountSchema,
    /** Stessa email (maiuscole a parte) di un account più vecchio dello stesso database. */
    duplicateInSource: CountSchema,
    /** Email non valida, o email provvisoria del telefono senza un numero trasferibile. */
    invalidEmail: CountSchema,
    /** Account che verranno creati. */
    importable: CountSchema,
    /** Tra i trasferibili: entrano con la stessa password. */
    passwordCompatible: CountSchema,
    /** Tra i trasferibili: password salvata in un formato che qui non si può verificare. */
    passwordIncompatible: CountSchema,
    /** Tra i trasferibili: senza password, entrano con Google/Apple. */
    oauthOnly: CountSchema,
    /** Tra i trasferibili: entrano solo col numero di telefono verificato. */
    phoneOnly: CountSchema,
    /** Tra i trasferibili: dovranno usare «Password dimenticata». */
    needsPasswordReset: CountSchema,
    /** Tra i trasferibili: erano amministratori, qui saranno utenti normali. */
    adminsToDemote: CountSchema,
    /** Tra i trasferibili: numero non copiato (non verificato, non valido o già usato qui). */
    phonesDropped: CountSchema,
    /** Collegamenti Google/Apple non copiati perché già usati da un altro account qui. */
    oauthAccountsSkipped: CountSchema,
    /** Saltati: email a cui il sito dà da solo il ruolo admin (proprietario). Da gestire a mano. */
    reservedAdmin: CountSchema,
  })
  .strict();
export type LegacyStats = z.infer<typeof LegacyStatsSchema>;

export const LegacyTableSchema = z
  .object({
    name: z.string().min(1).max(128),
    rows: CountSchema.nullable(),
  })
  .strict();
export type LegacyTable = z.infer<typeof LegacyTableSchema>;

export const LegacyDbGroupSchema = z
  .object({
    source: LegacySourceKeySchema,
    /** true = è il database che il sito usa adesso (DATABASE_URL): da qui non si importa mai. */
    current: z.boolean(),
    status: LegacyDbStatusSchema,
    /** Es. "Neon · eu-central-1", "AWS RDS", "Supabase", "altro": mai l'host. */
    providerHint: z.string().min(1).max(80),
    envVars: z.array(EnvNameSchema).max(40),
    /** Variabili o gruppi senza password (non ci si può collegare con quelli). */
    incompleteVars: z.array(EnvLabelSchema).max(20),
    errorKind: LegacyErrorKindSchema.nullable(),
    /** Solo per il database in uso: quanti utenti ha adesso. */
    currentUsers: CountSchema.nullable(),
    /** Se manca la tabella "user" di better-auth: nome di un'altra tabella utenti trovata. */
    otherUsersTable: z.string().max(128).nullable(),
    stats: LegacyStatsSchema.nullable(),
    /** Altre tabelle del vecchio database, solo per informazione: NON vengono trasferite. */
    otherTables: z.array(LegacyTableSchema).max(60),
    /** true = righe stimate da Postgres (il conteggio esatto non è riuscito). */
    otherTablesApproximate: z.boolean(),
  })
  .strict();
export type LegacyDbGroup = z.infer<typeof LegacyDbGroupSchema>;

export const LegacySkippedVarSchema = z
  .object({
    name: EnvNameSchema,
    reason: z.enum(['invalid', 'unsupported']),
  })
  .strict();

export const LegacyUsersDiagnosticSchema = z
  .object({
    generatedAt: IsoDateSchema,
    /** Account creati a ogni «Continua». */
    batchSize: z.number().int().positive(),
    /** false = non riesco a riconoscere il database in uso: nessun gruppo è segnato «in uso». */
    currentDetected: z.boolean(),
    groups: z.array(LegacyDbGroupSchema).max(30),
    skippedVars: z.array(LegacySkippedVarSchema).max(40),
  })
  .strict();
export type LegacyUsersDiagnostic = z.infer<typeof LegacyUsersDiagnosticSchema>;

/** Gettone firmato dell'anteprima (base64url "corpo.firma"); non contiene dati leggibili. */
export const LegacyPreviewTokenSchema = z
  .string()
  .min(20)
  .max(200_000)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

export const LegacyImportRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), source: LegacySourceKeySchema }).strict(),
  z
    .object({
      action: z.literal('import'),
      source: LegacySourceKeySchema,
      previewToken: LegacyPreviewTokenSchema,
    })
    .strict(),
]);
export type LegacyImportRequest = z.infer<typeof LegacyImportRequestSchema>;

export const LegacyPreviewResponseSchema = z
  .object({
    action: z.literal('preview'),
    source: LegacySourceKeySchema,
    stats: LegacyStatsSchema,
    /** null quando non c'è nulla da trasferire. */
    previewToken: LegacyPreviewTokenSchema.nullable(),
    expiresAt: IsoDateSchema.nullable(),
    batchSize: z.number().int().positive(),
  })
  .strict();
export type LegacyPreviewResponse = z.infer<typeof LegacyPreviewResponseSchema>;

export const LegacyBatchSchema = z
  .object({
    /** Account creati in questo passaggio. */
    imported: CountSchema,
    /** Saltati in questo passaggio perché nel frattempo l'email è comparsa qui. */
    conflicts: CountSchema,
    /** Nel piano: email già presenti qui (o doppie nel vecchio database). */
    skippedExisting: CountSchema,
    /** Nel piano: email non valide. */
    skippedInvalidEmail: CountSchema,
    /** Totale degli account trasferiti finora da questo database. */
    totalImported: CountSchema,
    /** Account ancora da trasferire (premi «Continua»). */
    remaining: CountSchema,
    done: z.boolean(),
  })
  .strict();
export type LegacyBatch = z.infer<typeof LegacyBatchSchema>;

export const LegacyImportResponseSchema = z
  .object({
    action: z.literal('import'),
    source: LegacySourceKeySchema,
    batch: LegacyBatchSchema,
  })
  .strict();
export type LegacyImportResponse = z.infer<typeof LegacyImportResponseSchema>;

export const LegacyImportPostResponseSchema = z.discriminatedUnion('action', [
  LegacyPreviewResponseSchema,
  LegacyImportResponseSchema,
]);
export type LegacyImportPostResponse = z.infer<typeof LegacyImportPostResponseSchema>;

/** Corpo delle risposte di errore: codice e messaggio in italiano. */
export const LegacyErrorBodySchema = z
  .object({
    error: z.string().min(1).max(64),
    message: z.string().max(500),
    kind: LegacyErrorKindSchema.optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();
export type LegacyErrorBody = z.infer<typeof LegacyErrorBodySchema>;
