// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.SKIP_ENV_VALIDATION = '1';
});
vi.mock('server-only', () => ({}));

import { authConfig } from '@/lib/auth-config';
import {
  demoteRevokedAdmins,
  isRevokedAdminEmail,
  normalizePersistedAdminRoles,
  REQUESTED_ADMIN_EMAIL,
  REVOKED_ADMIN_EMAILS,
  type RoleUpdateStore,
  resolveAdminAccess,
  resolveInitialSignupRole,
} from '@/lib/business/admin-account-policy';

vi.mock('@/lib/db', () => ({
  prisma: { user: { updateMany: vi.fn() } },
}));

const bestmr12UserId = 'better-auth-user-id-for-bestmr12';
const requestedUserId = 'better-auth-user-id-for-requested-admin';
/** Email di prova per il meccanismo dell'admin designato per email (oggi nessuno in produzione). */
const DESIGNATED_EMAIL = 'admin-designato@example.com';
/** L'account a cui il proprietario ha tolto il ruolo di amministratore (15/11/2026). */
const REVOKED_EMAIL = 'francescorogantini9@gmail.com';

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
        { id: requestedUserId, email: DESIGNATED_EMAIL, emailVerified: true },
        bestmr12UserId,
        DESIGNATED_EMAIL,
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
        { id: requestedUserId, email: DESIGNATED_EMAIL, emailVerified: false },
        bestmr12UserId,
        DESIGNATED_EMAIL,
      ),
    ).toBe('user');
  });
});

describe('nessun amministratore designato per email; ruolo tolto a un account', () => {
  it('REQUESTED_ADMIN_EMAIL è null: nessuna email diventa admin da sola', () => {
    expect(REQUESTED_ADMIN_EMAIL).toBeNull();
    for (const email of [REVOKED_EMAIL, DESIGNATED_EMAIL, 'chiunque@example.com']) {
      expect(
        resolveInitialSignupRole({ id: 'nuovo-utente', email, emailVerified: true }, undefined),
      ).toBe('user');
    }
  });

  it('l’account a cui è stato tolto il ruolo non torna admin per nessuna via', () => {
    expect(REVOKED_ADMIN_EMAILS).toEqual([REVOKED_EMAIL]);
    expect(isRevokedAdminEmail(REVOKED_EMAIL)).toBe(true);
    expect(isRevokedAdminEmail('  FrancescoRogantini9@Gmail.com ')).toBe(true);
    expect(isRevokedAdminEmail('francescorogantini9+altro@gmail.com')).toBe(false);
    expect(isRevokedAdminEmail(undefined)).toBe(false);
    // Né come email designata né come id designato.
    expect(
      resolveInitialSignupRole(
        { id: 'id-francesco', email: REVOKED_EMAIL, emailVerified: true },
        'id-francesco',
        REVOKED_EMAIL,
      ),
    ).toBe('user');
  });

  it('all’avvio il suo ruolo torna «user» (una scrittura, idempotente)', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await demoteRevokedAdmins({ updateMany });
    await demoteRevokedAdmins({ updateMany });
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { email: { in: [REVOKED_EMAIL] } },
      data: { role: 'user' },
    });
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
        email: DESIGNATED_EMAIL,
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
    // Solo le opzioni volute: accesso con email e recupero password (link via email, 1 ora,
    // sessioni chiuse dopo il cambio). Qualsiasi altra chiave (es. credenziali predefinite) fallisce.
    expect(authConfig.emailAndPassword).toEqual({
      enabled: true,
      sendResetPassword: expect.any(Function),
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
    });
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
