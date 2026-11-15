// @polsia:user-owned — contratti condivisi (client + route handler) della «Gestione account»
// (/admin/account: elenco degli account con UID, accesso e Premium; Premium illimitato per email) e
// dell'UID mostrato nei dati del proprio account (/profile).
import { z } from 'zod';
import { ACCOUNT_UID_PATTERN } from '@/lib/account/uid';
import { ADMIN_PREMIUM_SOURCES } from '@/lib/contracts/admin-signups';

/** UID leggibile di un account (es. SOL-7K2M-9QXD). */
export const AccountUidSchema = z.string().regex(ACCOUNT_UID_PATTERN);

/** GET /api/account/uid: l'UID del proprio account. */
export const AccountUidResponseSchema = z.object({ uid: AccountUidSchema }).strict();
export type AccountUidResponse = z.infer<typeof AccountUidResponseSchema>;

/** Account per pagina nell'elenco della «Gestione account». */
export const ADMIN_ACCOUNT_PAGE_SIZE = 25;
/** Lunghezza massima del testo cercato (nome, email o UID). */
export const ADMIN_ACCOUNT_QUERY_MAX = 120;

/** Query di GET /api/admin/accounts. */
export const AdminAccountsQuerySchema = z.object({
  q: z.string().trim().max(ADMIN_ACCOUNT_QUERY_MAX).default(''),
  page: z.coerce.number().int().min(0).max(10_000).default(0),
});

/** Come si accede all'account: Google, email e password, numero di telefono, altro. */
export const ACCOUNT_PROVIDERS = ['google', 'email', 'phone', 'other'] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

/** Un account nell'elenco dell'amministratore. */
export const AdminAccountSchema = z
  .object({
    id: z.string().min(1).max(200),
    /** null solo se l'UID non si è potuto assegnare (in pratica mai). */
    uid: AccountUidSchema.nullable(),
    name: z.string().max(400),
    email: z.string().max(400),
    emailVerified: z.boolean(),
    role: z.enum(['admin', 'user']),
    providers: z.array(z.enum(ACCOUNT_PROVIDERS)).max(ACCOUNT_PROVIDERS.length),
    /** Blocco in corso (come better-auth). */
    banned: z.boolean(),
    /** Le fonti del Premium attive adesso (vuoto = Free), con le regole di hasPremiumAccess. */
    premium: z.array(z.enum(ADMIN_PREMIUM_SOURCES)).max(ADMIN_PREMIUM_SOURCES.length),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminAccount = z.infer<typeof AdminAccountSchema>;

export const AdminAccountsResponseSchema = z
  .object({
    items: z.array(AdminAccountSchema).max(ADMIN_ACCOUNT_PAGE_SIZE),
    /** Account che corrispondono alla ricerca (tutti, senza ricerca). */
    total: z.number().int().nonnegative(),
    page: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();
export type AdminAccountsResponse = z.infer<typeof AdminAccountsResponseSchema>;

/** Lunghezza massima della nota di una concessione. */
export const PREMIUM_GRANT_NOTE_MAX = 200;

/** POST /api/admin/premium-grants: concede (o riattiva) il Premium illimitato a un'email. */
export const PremiumGrantInputSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, 'L’indirizzo email è troppo lungo.')
      .email('Scrivi un indirizzo email valido.'),
    note: z
      .string()
      .trim()
      .max(
        PREMIUM_GRANT_NOTE_MAX,
        `La nota può avere al massimo ${PREMIUM_GRANT_NOTE_MAX} caratteri.`,
      )
      .optional(),
  })
  .strict();
export type PremiumGrantInput = z.input<typeof PremiumGrantInputSchema>;

/**
 * Stato di una concessione: active = account con quell'email verificata, Premium attivo; pending =
 * nessun account con quell'email (si attiva al primo accesso, es. con Google); unverified =
 * l'account esiste ma l'email non è verificata (nessun Premium finché non la verifica o accede con
 * Google); revoked = revocata.
 */
export const PREMIUM_GRANT_STATUSES = ['active', 'pending', 'unverified', 'revoked'] as const;
export type PremiumGrantStatus = (typeof PREMIUM_GRANT_STATUSES)[number];

export const PremiumGrantSchema = z
  .object({
    id: z.string().min(1).max(200),
    email: z.string().max(400),
    note: z.string().max(PREMIUM_GRANT_NOTE_MAX).nullable(),
    createdAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    status: z.enum(PREMIUM_GRANT_STATUSES),
    /** L'account con quell'email, se esiste. */
    account: z
      .object({ uid: AccountUidSchema.nullable(), name: z.string().max(400) })
      .strict()
      .nullable(),
    /** true per una concessione predefinita (creata all'avvio, SEEDED_GRANT_EMAILS). */
    seeded: z.boolean(),
  })
  .strict();
export type PremiumGrant = z.infer<typeof PremiumGrantSchema>;

export const PremiumGrantsResponseSchema = z
  .object({ items: z.array(PremiumGrantSchema).max(1000) })
  .strict();
export const PremiumGrantResponseSchema = z.object({ grant: PremiumGrantSchema }).strict();
