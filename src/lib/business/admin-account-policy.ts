// @polsia:user-owned

export type AccountRole = 'admin' | 'user';

export type AdminIdentity = {
  id: string;
  email?: string;
  emailVerified: boolean;
  role?: unknown;
};

export type AdminAccessState = 'loading' | 'unauthenticated' | 'forbidden' | 'authorized';

/**
 * Email dell'amministratore designato: l'account con questa email VERIFICATA diventa admin alla
 * registrazione e a ogni avvio del server (seed). null = nessun amministratore designato per email.
 * Dal 15/11/2026, su richiesta del proprietario, è il suo account (in minuscolo, come lo salva
 * better-auth). L'account precedente non è più amministratore (vedi REVOKED_ADMIN_EMAILS) e ha solo
 * il Premium illimitato (src/lib/business/premium-grants.server.ts).
 */
export const REQUESTED_ADMIN_EMAIL: string | null = 'bestmr12@icloud.com';

/**
 * Account che NON devono essere amministratori: all'avvio il loro ruolo torna "user" e alla
 * registrazione non diventano mai admin, qualunque altra regola dica.
 */
export const REVOKED_ADMIN_EMAILS: readonly string[] = ['francescorogantini9@gmail.com'];

/**
 * true solo per l'email dell'amministratore designato (REQUESTED_ADMIN_EMAIL), senza maiuscole né
 * spazi. È l'UNICO account che può essere amministratore: nessun'altra via (POLSIA_OWNER_EMAIL,
 * ADMIN_USER_ID, un ruolo scritto nel database, un altro admin) basta da sola.
 */
export function isDesignatedAdminEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  return (
    Boolean(normalized) && REQUESTED_ADMIN_EMAIL !== null && normalized === REQUESTED_ADMIN_EMAIL
  );
}

/** true se il campo role (anche «user,admin») contiene il ruolo admin. */
export function hasAdminRole(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  return role
    .split(',')
    .map((item) => item.trim())
    .includes('admin');
}

/**
 * LA regola dell'amministrazione, usata da ogni controllo (proxy, AdminShell, ogni API admin,
 * Telegram, Skynet): ruolo admin + email verificata + email dell'amministratore designato. Un
 * account con il ruolo admin ma un'altra email NON è amministratore.
 */
export function isAuthorizedAdmin(
  user:
    | { role?: unknown; email?: string | null; emailVerified?: boolean | null }
    | null
    | undefined,
): boolean {
  if (!user || user.emailVerified !== true) return false;
  return hasAdminRole(user.role) && isDesignatedAdminEmail(user.email);
}

/** true per un'email a cui il ruolo admin è stato tolto (confronto senza maiuscole e spazi). */
export function isRevokedAdminEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  return Boolean(normalized) && REVOKED_ADMIN_EMAILS.includes(normalized as string);
}

type RoleFilter = { id: string };

export type RoleUpdateStore = {
  updateMany: (args: { where: RoleFilter; data: { role: AccountRole } }) => Promise<unknown>;
};

export function resolveInitialSignupRole(
  identity: AdminIdentity,
  _designatedAdminUserId?: string | undefined,
  requestedAdminEmail: string | null = REQUESTED_ADMIN_EMAIL,
): AccountRole {
  // Un account a cui il ruolo è stato tolto non torna admin per nessuna via.
  if (isRevokedAdminEmail(identity.email)) return 'user';
  // Solo l'email designata, verificata. ADMIN_USER_ID non concede più nulla da solo: un id non
  // prova di chi sia l'account (il secondo parametro resta per compatibilità e viene ignorato).
  const email = identity.email?.trim().toLowerCase();
  return identity.emailVerified === true &&
    requestedAdminEmail !== null &&
    email === requestedAdminEmail
    ? 'admin'
    : 'user';
}

/** Lo stato dell'account dell'amministratore designato, letto all'avvio (seed). */
export type RequestedAdminAccount = { id: string; emailVerified: boolean };

/**
 * L'id da promuovere ad admin all'avvio: solo un account con l'email VERIFICATA. Chi registrasse
 * l'indirizzo senza poterlo verificare non diventa admin.
 */
export function requestedAdminIdToPromote(
  account: RequestedAdminAccount | null | undefined,
): string | undefined {
  return account?.emailVerified === true ? account.id : undefined;
}

/**
 * Riga di stato all'avvio per l'amministratore designato, senza email né id: se l'account c'è, se
 * l'email è verificata e quindi se ora è amministratore.
 */
export function formatRequestedAdminStatus(
  account: RequestedAdminAccount | null | undefined,
): string {
  if (!account) {
    return '[solco] Amministratore designato: account non ancora creato (diventa amministratore alla registrazione con l’email verificata)';
  }
  return account.emailVerified === true
    ? '[solco] Amministratore designato: account presente, email verificata sì, amministratore sì'
    : '[solco] Amministratore designato: account presente, email verificata no, amministratore no (serve la verifica dell’email)';
}

export async function normalizePersistedAdminRoles(
  store: RoleUpdateStore,
  requestedAdminUserId: string | undefined,
): Promise<void> {
  const id = requestedAdminUserId?.trim();
  if (!id) return;

  await store.updateMany({ where: { id }, data: { role: 'admin' } });
}

export type RoleDemotionStore = {
  updateMany: (args: {
    where: { email: { in: string[] } };
    data: { role: AccountRole };
  }) => Promise<unknown>;
};

/** All'avvio: gli account di REVOKED_ADMIN_EMAILS tornano utenti normali (idempotente). */
export async function demoteRevokedAdmins(store: RoleDemotionStore): Promise<void> {
  if (REVOKED_ADMIN_EMAILS.length === 0) return;
  await store.updateMany({
    where: { email: { in: [...REVOKED_ADMIN_EMAILS] } },
    data: { role: 'user' },
  });
}

export type AdminRoleRow = {
  id: string;
  email: string;
  emailVerified: boolean;
  role: string | null;
};

export type UndesignatedAdminStore = {
  findMany: (args: {
    where: { role: { contains: string } };
    select: { id: true; email: true; emailVerified: true; role: true };
  }) => Promise<AdminRoleRow[]>;
  updateMany: (args: {
    where: { id: { in: string[] } };
    data: { role: AccountRole };
  }) => Promise<unknown>;
};

/**
 * All'avvio (e a ogni scrittura di un account, da auth-config.ts): chi ha il ruolo admin ma non è
 * l'account designato con l'email verificata torna utente normale. Idempotente. Restituisce quanti
 * account ha corretto.
 */
export async function demoteUndesignatedAdmins(store: UndesignatedAdminStore): Promise<number> {
  const rows = await store.findMany({
    where: { role: { contains: 'admin' } },
    select: { id: true, email: true, emailVerified: true, role: true },
  });
  const ids = rows
    .filter((row) => hasAdminRole(row.role))
    .filter((row) => !(row.emailVerified === true && isDesignatedAdminEmail(row.email)))
    .map((row) => row.id);
  if (ids.length === 0) return 0;
  await store.updateMany({ where: { id: { in: ids } }, data: { role: 'user' } });
  return ids.length;
}

export function resolveAdminAccess(
  isPending: boolean,
  user:
    | { role?: string | null; email?: string | null; emailVerified?: boolean | null }
    | null
    | undefined,
): AdminAccessState {
  if (isPending) return 'loading';
  if (!user) return 'unauthenticated';
  return isAuthorizedAdmin(user) ? 'authorized' : 'forbidden';
}
