import { randomUUID } from 'node:crypto';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Idempotent startup seed.
 *
 * - Upserts the single admin user (with username).
 * - Inserts OR updates the admin's `credential` account using the hash
 *   function Better Auth's sign-in path verifies against. Better Auth 1.7
 *   requires `accountId === userId` for credential accounts, so we set it.
 * - Password rotation: edit .env + `docker compose up -d --force-recreate
 *   gateway` — the seed re-hashes to whatever env says on every boot.
 *
 * Email is derived from username because Better Auth's User.email column
 * is NOT NULL unique; the derived address never leaves the DB.
 */
export async function seed(): Promise<void> {
  const username = env.GATEWAY_ADMIN_USERNAME.trim().toLowerCase();
  const displayUsername = env.GATEWAY_ADMIN_USERNAME.trim();
  const email = `${username}@gateway.local`;

  let user;
  try {
    user = await prisma.user.upsert({
      where: { email },
      update: { username, displayUsername },
      create: {
        id: randomUUID(),
        email,
        emailVerified: true,
        username,
        displayUsername,
        name: 'ARTEX Admin',
      },
    });
    // eslint-disable-next-line no-console
    console.log(`[gateway:seed] admin user ready: ${username}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to seed admin user:', err);
    return;
  }

  try {
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(env.GATEWAY_ADMIN_PASSWORD);
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
      console.log('[gateway:seed] admin password refreshed');
    } else {
      await prisma.account.create({
        data: {
          id: randomUUID(),
          userId: user.id,
          // Better Auth 1.7 filters credential rows on (userId, providerId,
          // accountId=userId). Don't change this unless upstream does.
          accountId: user.id,
          providerId: 'credential',
          password: hash,
          createdAt: now,
          updatedAt: now,
        },
      });
      // eslint-disable-next-line no-console
      console.log('[gateway:seed] admin password set');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to set admin password:', err);
  }
}
