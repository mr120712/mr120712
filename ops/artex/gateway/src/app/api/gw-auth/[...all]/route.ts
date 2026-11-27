import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '@/lib/auth';

/**
 * Catch-all Better Auth route. Handles sign-in request, magic-link verify,
 * session reads, and sign-out. Nothing else — the gateway's product surface
 * lives under /_proxy via middleware rewrite.
 */
export const { GET, POST } = toNextJsHandler(auth.handler);
