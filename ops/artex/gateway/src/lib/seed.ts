import { randomUUID } from 'node:crypto';

import { hashPassword } from 'better-auth/crypto';

import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Idempotent startup seed.
 *
 * - Upserts the single admin user (by email).
 * - When GATEWAY_ADMIN_PIN is set, inserts or UPDATES the admin's credential
 *   account with that PIN hashed via Better Auth's own crypto helper. A PIN
 *   change in the env takes effect on the next container restart — simple
 *   rotation story, no DB surgery needed.
 *
 * We deliberately do NOT call auth.api.signUpEmail here: with
 * emailAndPassword.disableSignUp:true (and with the user already upserted),
 * sign-up fails. Hashing + writing the row directly is the stable path and
 * uses the same scrypt parameters that Better Auth verifies against on login.
 *
 * All failures are logged and swallowed so the server still boots.
 */
export async function seed(): Promise<void> {
  const email = env.GATEWAY_ADMIN_EMAIL.trim().toLowerCase();

  let user;
  try {
    user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        id: randomUUID(),
        email,
        emailVerified: true,
        name: 'ARTEX Admin',
      },
    });
    // eslint-disable-next-line no-console
    console.log(`[gateway:seed] admin user ready for ${email}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to seed admin user:', err);
    return;
  }

  if (!env.GATEWAY_ADMIN_PIN) return;

  try {
    const hash = await hashPassword(env.GATEWAY_ADMIN_PIN);
    const existing = await prisma.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
    });
    const now = new Date();
    if (existing) {
      // Rotate the PIN on each restart to whatever env says — the cost is one
      // hash per boot and it means "edit .env + restart" is all it takes.
      await prisma.account.update({
        where: { id: existing.id },
        data: { password: hash, updatedAt: now },
      });
      // eslint-disable-next-line no-console
      console.log('[gateway:seed] admin PIN refreshed to env value');
    } else {
      await prisma.account.create({
        data: {
          id: randomUUID(),
          userId: user.id,
          accountId: email,
          providerId: 'credential',
          password: hash,
          createdAt: now,
          updatedAt: now,
        },
      });
      // eslint-disable-next-line no-console
      console.log('[gateway:seed] admin PIN set (first boot)');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to set admin PIN:', err);
  }
}
