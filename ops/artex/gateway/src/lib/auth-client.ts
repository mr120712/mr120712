'use client';

import { usernameClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Client for the /login page. Same-origin by default.
 * Only method exposed: username + password.
 */
export const authClient = createAuthClient({
  // Keep in sync with auth.ts basePath.
  basePath: '/api/gw-auth',
  plugins: [usernameClient()],
});

export const { signIn, signOut, useSession } = authClient;
