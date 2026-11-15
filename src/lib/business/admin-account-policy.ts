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
 * Dal 15/11/2026, su richiesta del proprietario, nessuno: l'account precedente non è più
 * amministratore (vedi REVOKED_ADMIN_EMAILS) e ha solo il Premium illimitato
 * (src/lib/business/premium-grants.server.ts). Per un nuovo admin si mette qui la sua email.
 */
export const REQUESTED_ADMIN_EMAIL: string | null = null;

/**
 * Account che NON devono essere amministratori: all'avvio il loro ruolo torna "user" e alla
 * registrazione non diventano mai admin, qualunque altra regola dica.
 */
export const REVOKED_ADMIN_EMAILS: readonly string[] = ['francescorogantini9@gmail.com'];

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
  designatedAdminUserId: string | undefined,
  requestedAdminEmail: string | null = REQUESTED_ADMIN_EMAIL,
): AccountRole {
  // Un account a cui il ruolo è stato tolto non torna admin per nessuna via.
  if (isRevokedAdminEmail(identity.email)) return 'user';
  const trustedUserId = designatedAdminUserId?.trim();

  return identity.emailVerified === true &&
    ((trustedUserId !== undefined && identity.id === trustedUserId) ||
      (requestedAdminEmail !== null && identity.email === requestedAdminEmail))
    ? 'admin'
    : 'user';
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

export function resolveAdminAccess(
  isPending: boolean,
  user: { role?: string | null; emailVerified?: boolean } | null | undefined,
): AdminAccessState {
  if (isPending) return 'loading';
  if (!user) return 'unauthenticated';
  if (user.emailVerified !== true) return 'forbidden';

  const roles = user.role
    ?.split(',')
    .map((role) => role.trim())
    .filter(Boolean);

  return roles?.includes('admin') ? 'authorized' : 'forbidden';
}
