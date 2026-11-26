import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { magicLink } from 'better-auth/plugins';

import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { renderMagicLinkEmail, sendMail } from '@/lib/mail';

/**
 * Better Auth server instance for the ARTEX gateway.
 *
 * Auth method: magic link only. No email+password, no OAuth, no passkeys yet.
 * Allowlist: exactly one email (GATEWAY_ADMIN_EMAIL) may request a link. Any
 * other address is rejected inside sendMagicLink so no mail ever goes out.
 *
 * Why the allowlist lives inside sendMagicLink rather than in a middleware:
 *   • the plugin already generates a Verification row before calling us;
 *     throwing here prevents the email, which is the only side-effect that
 *     could leak the existence of other users;
 *   • a request-origin middleware would also work but adds a layer that makes
 *     the auth flow harder to reason about for a single-tenant surface.
 */
export const auth = betterAuth({
  baseURL: env.GATEWAY_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.GATEWAY_URL],

  database: prismaAdapter(prisma, { provider: 'sqlite' }),

  // Disable the built-in email+password flow outright. Everything is magic link.
  emailAndPassword: { enabled: false },

  session: {
    // 24h session, refreshed on every call that lands inside the last hour.
    expiresIn: 60 * 60 * 24,
    updateAge: 60 * 60,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },

  // Cookie policy tuned for a single first-party host served by Caddy over HTTPS.
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
    magicLink({
      // 10 minutes is the Better Auth default; make it explicit.
      expiresIn: 60 * 10,

      // First line of defence: no sign-up via magic link. A link is only ever
      // created for an email that already has a User row — which, thanks to
      // the seed in src/lib/seed.ts, is exactly GATEWAY_ADMIN_EMAIL and
      // nothing else. Attempts for any other address get a 200 (no email
      // enumeration) but no token is generated and no mail is sent.
      disableSignUp: true,

      sendMagicLink: async ({ email, url }) => {
        // Second line: defence in depth. Even if a user row for another
        // address somehow exists, we still silently refuse to mail anyone
        // other than the pinned admin.
        if (email.trim().toLowerCase() !== env.GATEWAY_ADMIN_EMAIL.toLowerCase()) {
          return;
        }
        const { subject, html, text } = renderMagicLinkEmail(url);
        await sendMail({ to: email, subject, html, text });
      },
    }),
    // Must be last — rewrites set-cookie headers on Next.js server responses.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
