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
//   databaseHooks: { user: { create: { after: async (user) => {
//     await prisma.userProfile.create({ data: { userId: user.id } }).catch(() => {});
//   } } } },

import type { BetterAuthOptions } from 'better-auth';
import { getDesignatedAdminUserId } from '@/lib/business/admin-account-identity';
import { resolveInitialSignupRole } from '@/lib/business/admin-account-policy';
import { resolveAppleClientSecret } from '@/lib/business/apple-client-secret';
import { appleOAuthCredentials } from '@/lib/business/social-auth';
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

async function persistCanonicalRole(user: { id: string; email: string; emailVerified: boolean }) {
  if (resolveInitialSignupRole(user, getDesignatedAdminUserId()) !== 'admin') return;
  if (!user.emailVerified) return;

  await prisma.user.updateMany({
    where: { id: user.id, email: user.email, emailVerified: user.emailVerified },
    data: { role: 'admin' },
  });
}

export const authConfig: BetterAuthOptions = {
  // Apple posts back from https://appleid.apple.com: that origin is listed in
  // BETTER_AUTH_TRUSTED_ORIGINS (the framework owns trustedOrigins).
  ...(appleCredentials ? { socialProviders: { apple: appleCredentials } } : {}),
  emailAndPassword: {
    enabled: true,
  },
  emailVerification: {
    sendOnSignUp: true,
  },
  databaseHooks: {
    user: {
      create: {
        before: async () => ({
          data: {
            // The framework owner-email hook also runs; create.after below
            // enforces the canonical User.id policy after that hook completes.
            role: 'user',
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
