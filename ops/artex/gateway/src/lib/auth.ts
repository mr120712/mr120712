import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { username } from 'better-auth/plugins';

import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Better Auth server instance for the ARTEX gateway.
 *
 * One sign-in method only: username + password. No email relay, no magic
 * links, no passkey — simplest surface that works on any device without
 * device-specific state. The single admin's credentials are seeded at
 * container boot from env vars (see src/lib/seed.ts).
 *
 * disableSignUp is on because there is nothing to sign up for — the admin
 * user is already created by the seed.
 */
const BUILD_FALLBACK_URL = 'http://localhost:3000';
const effectiveUrl = env.GATEWAY_URL ?? BUILD_FALLBACK_URL;

export const auth = betterAuth({
  baseURL: effectiveUrl,
  secret: env.BETTER_AUTH_SECRET ?? 'build-time-placeholder-not-used-at-runtime',
  trustedOrigins: [effectiveUrl],

  database: prismaAdapter(prisma, { provider: 'sqlite' }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 4,
    maxPasswordLength: 128,
    disableSignUp: true,
    autoSignIn: false,
  },

  session: {
    expiresIn: 60 * 60 * 24,
    updateAge: 60 * 60,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  advanced: {
    cookiePrefix: 'artex-gateway',
    useSecureCookies: true,
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: true,
      httpOnly: true,
    },
  },

  plugins: [
    username({
      minUsernameLength: 2,
      maxUsernameLength: 64,
    }),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
