// @polsia:user-owned

export type AccountRole = 'admin' | 'user';

export type AdminIdentity = {
  id: string;
  email?: string;
  emailVerified: boolean;
  role?: unknown;
};

export type AdminAccessState = 'loading' | 'unauthenticated' | 'forbidden' | 'authorized';

export const REQUESTED_ADMIN_EMAIL = 'francescorogantini9@gmail.com';

type RoleFilter = { id: string };

export type RoleUpdateStore = {
  updateMany: (args: { where: RoleFilter; data: { role: AccountRole } }) => Promise<unknown>;
};

export function resolveInitialSignupRole(
  identity: AdminIdentity,
  designatedAdminUserId: string | undefined,
): AccountRole {
  const trustedUserId = designatedAdminUserId?.trim();

  return identity.emailVerified === true &&
    ((trustedUserId !== undefined && identity.id === trustedUserId) ||
      identity.email === REQUESTED_ADMIN_EMAIL)
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
