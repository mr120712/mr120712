import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { magicLink } from 'better-auth/plugins';

import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/**
 * Better Auth server instance for the ARTEX gateway.
 *
 * Steady-state auth: WebAuthn passkey (FaceID, TouchID, Windows Hello,
 * YubiKey). Zero password, zero email, zero network dependency once a
 * passkey is enrolled.
 *
 * Bootstrap (one time): the magic-link plugin is also enabled, but its
 * `sendMagicLink` callback prints the URL to STDOUT instead of sending it
 * over email. The admin (who already has SSH to the VPS by definition)
 * reads it from `docker compose logs gateway`, clicks it once, and uses
 * the resulting session to register their first passkey. No email relay,
 * no SMTP, no third-party, no leaked credential beyond what any shell on
 * the VPS can already see.
 *
 * Both plugins apply the GATEWAY_ADMIN_EMAIL allowlist:
 *   - magicLink: `disableSignUp: true` + a second-line check inside
 *     sendMagicLink suppresses any URL for an address other than the
 *     admin (no user enumeration either way).
 *   - passkey: register/authenticate always require an existing User row,
 *     and the only seeded row is the admin's.
 */
// `next build` loads this module with SKIP_ENV_VALIDATION=1, so env.GATEWAY_URL
// is undefined at build time (the real URL is injected only at container start).
// A bare `new URL(undefined)` would crash `page-data` collection for every route
// that imports the auth module. The fallback below keeps the build green; at
// runtime the real URL is always present (env validation re-runs without SKIP).
const BUILD_FALLBACK_URL = 'http://localhost:3000';
const effectiveUrl = env.GATEWAY_URL ?? BUILD_FALLBACK_URL;
const rpId = (() => {
  try {
    return new URL(effectiveUrl).hostname;
  } catch {
    return 'localhost';
  }
})();

export const auth = betterAuth({
  baseURL: effectiveUrl,
  secret: env.BETTER_AUTH_SECRET ?? 'build-time-placeholder-not-used-at-runtime',
  trustedOrigins: [effectiveUrl],

  database: prismaAdapter(prisma, { provider: 'sqlite' }),

  // PIN fallback: when GATEWAY_ADMIN_PIN is set in the env, the seed creates a
  // Better Auth credential account for the admin whose password is that PIN.
  // The /login page exposes an email+PIN form as a third sign-in option behind
  // passkey. We lower minPasswordLength because a PIN is on purpose short; PIN
  // brute-force is mitigated by the single-user allowlist and standard rate
  // limiting. Disable sign-up outright — only the seed path creates accounts.
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 4,
    maxPasswordLength: 64,
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
    passkey({
      rpName: 'ARTEX Gateway',
      rpID: rpId,
      origin: effectiveUrl,
    }),

    magicLink({
      expiresIn: 60 * 10,
      disableSignUp: true,

      sendMagicLink: async ({ email, url }) => {
        const adminEmail = env.GATEWAY_ADMIN_EMAIL;
        if (!adminEmail || email.trim().toLowerCase() !== adminEmail.toLowerCase()) {
          return;
        }
        // No email relay. The admin has SSH to the VPS; emit the URL to
        // stdout so `docker compose logs gateway` can surface it. The box
        // around it makes it easy to grep and copy-paste.
        const banner = '='.repeat(70);
        // eslint-disable-next-line no-console
        console.log(
          [
            '',
            banner,
            'ARTEX GATEWAY — one-time bootstrap sign-in link',
            'Valid for 10 minutes. Open this URL in a browser on the device',
            'where you want to register the passkey:',
            '',
            url,
            '',
            banner,
            '',
          ].join('\n'),
        );
      },
    }),

    nextCookies(),
  ],
});

export type Auth = typeof auth;
