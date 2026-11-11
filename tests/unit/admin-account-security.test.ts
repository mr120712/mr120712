import { describe, expect, it, vi } from 'vitest';
import { authConfig } from '@/lib/auth-config';
import {
  normalizePersistedAdminRoles,
  REQUESTED_ADMIN_EMAIL,
  type RoleUpdateStore,
  resolveAdminAccess,
  resolveInitialSignupRole,
} from '@/lib/business/admin-account-policy';

vi.mock('@/lib/db', () => ({
  prisma: { user: { updateMany: vi.fn() } },
}));

const bestmr12UserId = 'better-auth-user-id-for-bestmr12';
const requestedUserId = 'better-auth-user-id-for-requested-admin';

describe('identità autorizzate per il ruolo amministratore', () => {
  it('riconosce l’ID Better Auth configurato e l’email richiesta solo dopo verifica', () => {
    expect(
      resolveInitialSignupRole(
        { id: bestmr12UserId, emailVerified: true, role: 'user' },
        bestmr12UserId,
      ),
    ).toBe('admin');
    expect(
      resolveInitialSignupRole(
        { id: requestedUserId, email: REQUESTED_ADMIN_EMAIL, emailVerified: true },
        bestmr12UserId,
      ),
    ).toBe('admin');
  });

  it('non usa il nome visualizzato o email simili per assegnare admin', () => {
    expect(
      resolveInitialSignupRole(
        {
          id: 'different-better-auth-user-id',
          email: 'francescorogantini9+other@gmail.com',
          emailVerified: true,
          role: 'admin',
        },
        bestmr12UserId,
      ),
    ).toBe('user');
    expect(
      resolveInitialSignupRole(
        { id: requestedUserId, email: REQUESTED_ADMIN_EMAIL, emailVerified: false },
        bestmr12UserId,
      ),
    ).toBe('user');
  });
});

describe('normalizzazione persistente dei ruoli', () => {
  it('promuove solo il destinatario e lascia invariati tutti gli altri account e ruoli', async () => {
    const users = [
      {
        id: bestmr12UserId,
        email: 'bestmr12@example.test',
        emailVerified: true,
        role: 'admin',
      },
      {
        id: requestedUserId,
        email: REQUESTED_ADMIN_EMAIL,
        emailVerified: true,
        role: 'user',
      },
      {
        id: 'another-admin',
        email: 'another-admin@example.test',
        emailVerified: true,
        role: 'admin',
      },
      {
        id: 'custom-role',
        email: 'custom@example.test',
        emailVerified: true,
        role: 'moderator',
      },
      {
        id: 'unverified-user',
        email: 'unverified@example.test',
        emailVerified: false,
        role: 'user',
      },
    ];
    const before = users.map((user) => ({ ...user }));
    const calls: Array<{ where: { id: string }; data: { role: 'admin' | 'user' } }> = [];
    const store: RoleUpdateStore = {
      updateMany: async (args) => {
        calls.push(args);
        for (const user of users) {
          if (user.id === args.where.id) user.role = args.data.role;
        }
      },
    };

    await normalizePersistedAdminRoles(store, requestedUserId);

    expect(calls).toEqual([{ where: { id: requestedUserId }, data: { role: 'admin' } }]);
    expect(users).toEqual([
      before[0],
      { ...before[1], role: 'admin' },
      before[2],
      before[3],
      before[4],
    ]);
  });

  it('non modifica record quando manca una mappatura o l’account richiesto non esiste', async () => {
    const updateMany = vi.fn();
    await normalizePersistedAdminRoles({ updateMany }, undefined);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('assegnazione controllata e accesso', () => {
  it('mantiene la verifica email e non aggiunge credenziali amministrative predefinite', () => {
    expect(authConfig.emailVerification?.sendOnSignUp).toBe(true);
    expect(authConfig.emailAndPassword).toEqual({ enabled: true });
    expect(authConfig.emailAndPassword).not.toHaveProperty('defaultPassword');
  });

  it('non forza il ruolo user negli aggiornamenti Better Auth', () => {
    expect(authConfig.databaseHooks?.user?.update?.before).toBeUndefined();
  });

  it('nega sessioni assenti, ruoli user e admin non verificati', () => {
    expect(resolveAdminAccess(false, null)).toBe('unauthenticated');
    expect(resolveAdminAccess(false, { role: 'user', emailVerified: true })).toBe('forbidden');
    expect(resolveAdminAccess(false, { role: 'admin', emailVerified: false })).toBe('forbidden');
  });

  it('consente a entrambi gli account amministrativi verificati di aprire l’area', () => {
    expect(resolveAdminAccess(false, { role: 'admin', emailVerified: true })).toBe('authorized');
    expect(resolveAdminAccess(true, { role: 'admin', emailVerified: true })).toBe('loading');
  });
});
