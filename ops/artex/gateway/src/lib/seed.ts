import { randomUUID } from 'node:crypto';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Idempotent startup seed.
 *
 * Creates the one admin user row that Better Auth needs to issue a sign-in
 * link or match a passkey. When GATEWAY_ADMIN_PIN is set, also creates a
 * `credential` account row with that PIN as the password (Better Auth hashes
 * it via its internal signUpEmail path so we never store the PIN in plain
 * text or write our own crypto).
 *
 * Idempotency rules:
 *   - user row: upsert on email
 *   - credential account: created ONLY on first boot where no credential
 *     account yet exists for the admin. Rotating the PIN later requires
 *     deleting the credential account row and restarting, documented in
 *     the README.
 *
 * All failures are logged and swallowed so the server still boots; the
 * operator can fix env.GATEWAY_ADMIN_PIN and restart.
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

  // Only set the PIN when there is no credential account yet. Rotating the
  // PIN after the first boot is a manual DB op (documented) so an operator
  // can't accidentally lock themselves out by typo'ing GATEWAY_ADMIN_PIN.
  const existingCredential = await prisma.account.findFirst({
    where: { userId: user.id, providerId: 'credential' },
  });
  if (existingCredential) {
    // eslint-disable-next-line no-console
    console.log('[gateway:seed] admin PIN already set (credential account exists)');
    return;
  }

  try {
    // auth.api bypasses the public endpoint's disableSignUp guard; it uses
    // the same internal hashing (scrypt by default) that user-facing sign-in
    // verifies against.
    await auth.api.signUpEmail({
      body: {
        email,
        password: env.GATEWAY_ADMIN_PIN,
        name: 'ARTEX Admin',
      },
    });
    // eslint-disable-next-line no-console
    console.log('[gateway:seed] admin PIN set (first boot)');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to set admin PIN:', err);
  }
}
