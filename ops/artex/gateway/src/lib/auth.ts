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
const parsedUrl = new URL(env.GATEWAY_URL);
const rpId = parsedUrl.hostname;

export const auth = betterAuth({
  baseURL: env.GATEWAY_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.GATEWAY_URL],

  database: prismaAdapter(prisma, { provider: 'sqlite' }),

  emailAndPassword: { enabled: false },

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
      origin: env.GATEWAY_URL,
    }),

    magicLink({
      expiresIn: 60 * 10,
      disableSignUp: true,

      sendMagicLink: async ({ email, url }) => {
        if (email.trim().toLowerCase() !== env.GATEWAY_ADMIN_EMAIL.toLowerCase()) {
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
