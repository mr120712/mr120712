import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Idempotent startup seed.
 *
 * Creates the one admin user row that the magic-link plugin needs to issue a
 * sign-in link (we set disableSignUp: true, so anything not already a user is
 * silently refused). Running this twice is a no-op. A failure is logged and
 * swallowed so the server still boots — the operator can fix the admin email
 * and restart.
 */
export async function seed(): Promise<void> {
  const email = env.GATEWAY_ADMIN_EMAIL.trim().toLowerCase();
  try {
    await prisma.user.upsert({
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
  }
}
