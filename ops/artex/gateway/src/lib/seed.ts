import { randomUUID } from 'node:crypto';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Idempotent startup seed.
 *
 * - Upserts the single admin user (with username).
 * - Inserts OR updates the admin's `credential` account using
 *   `auth.$context.password.hash`, the exact function the sign-in path uses
 *   to verify. Hash compatibility is guaranteed by construction.
 * - Self-tests the roundtrip: hash → store → verify. Logs the result so a
 *   bad env value (hidden whitespace, wrong Zod coercion) fails loudly.
 *
 * Every container boot refreshes the hash to whatever the env says, so
 * password rotation is `edit .env + docker compose up -d --force-recreate gateway`.
 */
export async function seed(): Promise<void> {
  const username = env.GATEWAY_ADMIN_USERNAME.trim().toLowerCase();
  const displayUsername = env.GATEWAY_ADMIN_USERNAME.trim();
  const email = `${username}@gateway.local`;
  const password = env.GATEWAY_ADMIN_PASSWORD;

  // eslint-disable-next-line no-console
  console.log(
    `[gateway:seed] env snapshot: username="${username}" password.length=${password.length} email="${email}"`,
  );

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
    console.log(`[gateway:seed] admin user ready: id=${user.id} username=${user.username}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to seed admin user:', err);
    return;
  }

  // Resolve the Better Auth context — this gives us the SAME hash function
  // the sign-in verifier uses, so there is no way the formats can drift.
  let ctx;
  try {
    ctx = await auth.$context;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to resolve auth context:', err);
    return;
  }

  try {
    const hash = await ctx.password.hash(password);
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

    // Self-test A: raw hash roundtrip at the DB layer.
    const afterWrite = await prisma.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
      select: { password: true },
    });
    const storedHash = afterWrite?.password ?? '';
    const roundTrip = storedHash
      ? await ctx.password.verify({ hash: storedHash, password })
      : false;
    // eslint-disable-next-line no-console
    console.log(
      `[gateway:seed] self-test A: hash.len=${hash.length} stored.len=${storedHash.length} verify=${roundTrip}`,
    );

    // Self-test B: drill into each step of Better Auth's signInUsername to
    // find where it diverges from our Prisma-direct view of the DB.
    try {
      // Step 1: adapter.findOne by username — what the username plugin does.
      const adapter = ctx.adapter;
      const byUsername = await adapter.findOne({
        model: 'user',
        where: [{ field: 'username', value: username }],
      });
      // eslint-disable-next-line no-console
      console.log(
        `[gateway:seed] self-test B/1 adapter.findOne(user, username=${username}): ${
          byUsername ? 'FOUND id=' + (byUsername as { id?: string }).id : 'NOT FOUND'
        }`,
      );

      // Step 2: adapter.findOne by id — rule out the model/schema layer.
      const byId = await adapter.findOne({
        model: 'user',
        where: [{ field: 'id', value: user.id }],
      });
      // eslint-disable-next-line no-console
      console.log(
        `[gateway:seed] self-test B/2 adapter.findOne(user, id=${user.id}): ${
          byId ? 'FOUND username=' + ((byId as { username?: string }).username ?? 'null') : 'NOT FOUND'
        }`,
      );

      // Step 3: internalAdapter.findCredentialAccount.
      const credAcc = await ctx.internalAdapter.findCredentialAccount(user.id);
      // eslint-disable-next-line no-console
      console.log(
        `[gateway:seed] self-test B/3 findCredentialAccount(${user.id}): ${
          credAcc ? 'FOUND hash.len=' + ((credAcc as { password?: string }).password?.length ?? 0) : 'NOT FOUND'
        }`,
      );

      // Step 4: full api call to signInUsername (end-to-end).
      const result = await auth.api.signInUsername({
        body: { username, password },
      });
      // eslint-disable-next-line no-console
      console.log(
        `[gateway:seed] self-test B/4 signInUsername OK, token.length=${(result as { token?: string } | undefined)?.token?.length ?? 0}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[gateway:seed] self-test B stopped with:',
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gateway:seed] failed to set admin password:', err);
  }
}
