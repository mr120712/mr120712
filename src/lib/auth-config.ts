// @polsia:user-owned — configure better-auth here (spread into betterAuth() by @/lib/auth).
// Add emailAndPassword options, plugins, session, socialProviders, databaseHooks, etc.
// Framework owns db/secret/baseURL/admin() and disables session cookie caching;
// app hooks canonicalize its owner bootstrap to the configured Better Auth User.id.
// Verification delivery through the email module and sendOnSignUp are provided
// by auth.ts. Override emailVerification here only for intentional customization.
// The existing verification flow remains active. Admin access additionally
// requires the server-configured User.id mapping and verified email state.
//
// Welcome email / signup side-effect (install `email`):
//   import { sendEmail } from '@/lib/email/send';
//   databaseHooks: { user: { create: { after: async (user) => {
//     await sendEmail({ to: user.email, subject: 'Welcome', html: '<p>Welcome!</p>' }).catch(() => {});
//   } } } },
// Add a plugin: `plugins: [organization()]` (admin() is added for you).
//
// Per-user fields (a `username`, profile, prefs): don't add a column to `User` (auth.prisma
// is locked) or use `user.additionalFields` (needs that locked column). Make a user-owned
// `prisma/schema/profile.prisma` (model UserProfile { userId String @unique /* fields */ },
// scalar userId) and create the row at signup:
//   import { prisma } from '@/lib/db';
import { unsafeAuthRedirectField } from '@/lib/security/safe-auth-redirect';
//   databaseHooks: { user: { create: { after: async (user) => {
//     await prisma.userProfile.create({ data: { userId: user.id } }).catch(() => {});
//   } } } },

import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { phoneNumber } from 'better-auth/plugins/phone-number';
import { after } from 'next/server';
import { getDesignatedAdminUserId } from '@/lib/business/admin-account-identity';
import { resolveInitialSignupRole } from '@/lib/business/admin-account-policy';
import { resolveAppleClientSecret } from '@/lib/business/apple-client-secret';
import { guardAuthRequest } from '@/lib/business/auth-guards.server';
import { isValidE164, phoneAccountEmail, phoneAccountName } from '@/lib/business/phone-auth';
import { sendResetPasswordEmail } from '@/lib/business/reset-password-email.server';
import { appleOAuthCredentials } from '@/lib/business/social-auth';
import { checkSmsVerification } from '@/lib/business/twilio-verify.server';
import { sendVerificationEmail } from '@/lib/business/verification-email.server';
import { prisma } from '@/lib/db';

// These OAuth values are supplied by the platform as server-side app secrets.
// The provider is omitted until both are configured; neither value reaches the client.
// Either APPLE_CLIENT_SECRET (a pre-made JWT) or APPLE_TEAM_ID + APPLE_KEY_ID + APPLE_PRIVATE_KEY,
// from which Solco signs a fresh secret at startup (Apple caps a secret at 6 months).
const appleCredentials = appleOAuthCredentials(
  process.env.APPLE_CLIENT_ID,
  resolveAppleClientSecret({
    APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID,
    APPLE_CLIENT_SECRET: process.env.APPLE_CLIENT_SECRET,
    APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
    APPLE_KEY_ID: process.env.APPLE_KEY_ID,
    APPLE_PRIVATE_KEY: process.env.APPLE_PRIVATE_KEY,
  }),
);

const MAX_USER_NAME_LENGTH = 80;

async function persistCanonicalRole(user: { id: string; email: string; emailVerified: boolean }) {
  if (resolveInitialSignupRole(user, getDesignatedAdminUserId()) !== 'admin') return;
  if (!user.emailVerified) return;

  await prisma.user.updateMany({
    where: { id: user.id, email: user.email, emailVerified: user.emailVerified },
    data: { role: 'admin' },
  });
}

/**
 * After sign-in, sign-up or email verification better-auth sends people to `callbackURL` (and
 * similar fields). The framework trusts every *.polsia.app / *.polsia.io site, which belong to
 * other apps too: only internal paths and Solco's exact origins are accepted here.
 */
export const safeAuthRedirects: BetterAuthPlugin = {
  id: 'solco-safe-auth-redirects',
  hooks: {
    before: [
      {
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          const field = unsafeAuthRedirectField([
            ctx.body as Record<string, unknown> | undefined,
            ctx.query as Record<string, unknown> | undefined,
          ]);
          if (field) {
            throw new APIError('FORBIDDEN', { message: `Invalid ${field}` });
          }
        }),
      },
    ],
  },
};

/**
 * Controlli prima degli endpoint (src/lib/business/auth-guards.server.ts): chiude gli endpoint del
 * plugin telefono non usati, valida i numeri e applica i limiti condivisi a SMS, verifiche del
 * codice e richieste di recupero password.
 */
export const solcoAuthGuards: BetterAuthPlugin = {
  id: 'solco-auth-guards',
  hooks: {
    before: [
      {
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          const rejected = await guardAuthRequest({
            path: ctx.path,
            body: ctx.body,
            headers: ctx.headers ?? ctx.request?.headers,
          });
          if (rejected) {
            throw new APIError(rejected.status, {
              message: rejected.message,
              ...(rejected.code ? { code: rejected.code } : {}),
            });
          }
        }),
      },
    ],
  },
};

/**
 * Accesso e registrazione col numero di telefono: codice via SMS con Twilio Verify (Twilio genera,
 * fa scadere e limita i tentativi; Solco non conserva il codice). Al primo accesso con un numero
 * nuovo si crea l'account, con un'email provvisoria non consegnabile e un nome generico (mai il
 * numero, che finirebbe in profili e community).
 */
const phoneLogin = phoneNumber({
  // L'SMS parte già in solcoAuthGuards (guardAuthRequest), che aspetta l'esito di Twilio per dire
  // subito all'utente se l'invio non è riuscito. Qui better-auth lo farebbe in background, senza
  // poter segnalare errori. Il codice generato da better-auth è ignorato: lo genera e verifica Twilio.
  sendOTP: () => undefined,
  verifyOTP: async ({ phoneNumber: phone, code }) => checkSmsVerification(phone, code),
  phoneNumberValidator: (phone) => isValidE164(phone),
  signUpOnVerification: {
    getTempEmail: (phone) => phoneAccountEmail(phone),
    getTempName: () => phoneAccountName(),
  },
});

export const authConfig: BetterAuthOptions = {
  plugins: [safeAuthRedirects, solcoAuthGuards, phoneLogin],
  // Apple posts back from https://appleid.apple.com: that origin is listed in
  // BETTER_AUTH_TRUSTED_ORIGINS (the framework owns trustedOrigins).
  ...(appleCredentials ? { socialProviders: { apple: appleCredentials } } : {}),
  // Google verifies the email it returns: an existing Solco account with the same email
  // is linked instead of failing with account_not_linked.
  account: {
    accountLinking: { enabled: true, trustedProviders: ['google'] },
  },
  emailAndPassword: {
    enabled: true,
    // Password dimenticata: link via email, valido 1 ora e usabile una sola volta. Dopo il cambio
    // tutte le sessioni aperte vengono chiuse (se qualcuno era entrato con la vecchia password).
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail({ user, url });
    },
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail,
  },
  // Emails and other side tasks finish after the response: sign-up never waits on the mail service.
  advanced: {
    backgroundTasks: { handler: (promise) => after(promise) },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({
          data: {
            // The framework owner-email hook also runs; create.after below
            // enforces the canonical User.id policy after that hook completes.
            role: 'user',
            // The name is chosen by whoever signs up: keep it short (by code point).
            ...(typeof user.name === 'string'
              ? { name: Array.from(user.name).slice(0, MAX_USER_NAME_LENGTH).join('') }
              : {}),
          },
        }),
        after: async (user) => {
          await persistCanonicalRole(user);
        },
      },
      update: {
        // Do not rewrite roles for unrelated accounts. Reassert a managed admin
        // only after Better Auth has persisted the authoritative identity.
        after: async (user) => {
          await persistCanonicalRole(user);
        },
      },
    },
  },
};
