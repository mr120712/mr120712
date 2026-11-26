'use client';

import { passkeyClient } from '@better-auth/passkey/client';
import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Client for the login + enroll pages. Same-origin by default.
 */
export const authClient = createAuthClient({
  plugins: [passkeyClient(), magicLinkClient()],
});

export const { signIn, signOut, useSession, passkey } = authClient;
