import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * Typed env for the ARTEX gateway.
 *
 * All server-only. Zero email — the gateway signs the admin in via WebAuthn
 * passkey on steady state, and uses a one-time magic link PRINTED TO SERVER
 * LOGS (not emailed) for the first-time bootstrap of that passkey.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // SQLite file path. In compose this is `file:/data/gateway.db`.
    DATABASE_URL: z.string().min(1),

    // Public base URL of the gateway. Better Auth uses it to build magic-link
    // URLs, validate request origin, and scope the WebAuthn Relying Party ID.
    // Must match what Caddy proxies to it, protocol included.
    GATEWAY_URL: z.string().url(),

    // Random secret that signs Better Auth session cookies and verification
    // tokens. 32 bytes minimum (hex: 64 chars). Rotate with:
    //   openssl rand -hex 32
    BETTER_AUTH_SECRET: z.string().min(32),

    // The one admin email. Seeded on first boot; used as the identity key
    // for passkeys and for the bootstrap magic-link.
    GATEWAY_ADMIN_EMAIL: z.string().email(),

    // Where ARTEX listens on the compose network.
    ARTEX_UPSTREAM_URL: z.string().url().default('http://artex:8787'),
  },

  client: {},

  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    GATEWAY_URL: process.env.GATEWAY_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    GATEWAY_ADMIN_EMAIL: process.env.GATEWAY_ADMIN_EMAIL,
    ARTEX_UPSTREAM_URL: process.env.ARTEX_UPSTREAM_URL,
  },

  emptyStringAsUndefined: true,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
