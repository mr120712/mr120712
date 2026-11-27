import { randomUUID } from 'node:crypto';

import { hashPassword } from 'better-auth/crypto';

import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Idempotent startup seed.
 *
 * - Upserts the single admin user (by derived email, with username set).
 * - Inserts OR updates the admin's `credential` account with
 *   hashPassword(env.GATEWAY_ADMIN_PASSWORD). Every container boot refreshes
 *   the hash to whatever the env says, so password rotation is just
 *   `edit .env + docker compose up -d --force-recreate gateway`.
 *
 * Better Auth's User.email column is NOT NULL unique, so we derive an
 * internal pseudo-email from the username (user never sees it). The
 * username plugin indexes on username, which is what the client signs in
 * with.
 */
export async function seed(): Promise<void> {
  const username = env.GATEWAY_ADMIN_USERNAME.trim().toLowerCase();
  const email = `${username}@gateway.local`;

  let user;
  try {
    user = await prisma.user.upsert({
      where: { email },
      update: { username, displayUsername: env.GATEWAY_ADMIN_USERNAME.trim() },
      create: {
        id: randomUUID(),
        email,
        emailVerified: true,
        username,
        displayUsername: env.GATEWAY_ADMIN_USERNAME.trim(),
        name: 'ARTEX Admin',
      },
    });
    // eslint-disable-next-line no-console
    console.log(`[gateway:seed] admin user ready: username=${username}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to seed admin user:', err);
    return;
  }

  try {
    const hash = await hashPassword(env.GATEWAY_ADMIN_PASSWORD);
    const existing = await prisma.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
    });
    const now = new Date();
    if (existing) {
      await prisma.account.update({
        where: { id: existing.id },
        data: { password: hash, updatedAt: now },
      });
      // eslint-disable-next-line no-console
      console.log('[gateway:seed] admin password refreshed to env value');
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
      console.log('[gateway:seed] admin password set (first boot)');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to set admin password:', err);
  }
}
