import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * Typed env for the ARTEX gateway.
 *
 * Username + password auth, seeded from env. No email relay, no passkey,
 * no magic-link. Simplest possible single-admin console.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // SQLite file path. In compose this is `file:/data/gateway.db`.
    DATABASE_URL: z.string().min(1),

    // Public base URL of the gateway (what Caddy proxies to it).
    GATEWAY_URL: z.string().url(),

    // Random secret that signs Better Auth session cookies. 32 bytes minimum.
    // Rotate with: openssl rand -hex 32. Rotation invalidates every session.
    BETTER_AUTH_SECRET: z.string().min(32),

    // The one admin's username — what you type on /login. Alphanumeric +
    // underscore, 2-64 chars (matches Better Auth username plugin defaults).
    GATEWAY_ADMIN_USERNAME: z.string().min(2).max(64),

    // The one admin's password. 4-128 chars. Rotating this is edit + restart:
    // the seed re-hashes to whatever env says on every boot.
    GATEWAY_ADMIN_PASSWORD: z.string().min(4).max(128),

    // Where ARTEX listens on the compose network.
    ARTEX_UPSTREAM_URL: z.string().url().default('http://artex:8787'),

    // The ARTEX admin password (the one you set on /setup). The gateway uses
    // it to auto-login into ARTEX on behalf of the single authenticated user,
    // so the ARTEX /login screen is never shown. Keep in sync with whatever
    // you typed on /setup, or rotate both at the same time.
    ARTEX_SESSION_PASSWORD: z.string().min(1),
  },

  client: {},

  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    GATEWAY_URL: process.env.GATEWAY_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    GATEWAY_ADMIN_USERNAME: process.env.GATEWAY_ADMIN_USERNAME,
    GATEWAY_ADMIN_PASSWORD: process.env.GATEWAY_ADMIN_PASSWORD,
    ARTEX_UPSTREAM_URL: process.env.ARTEX_UPSTREAM_URL,
    ARTEX_SESSION_PASSWORD: process.env.ARTEX_SESSION_PASSWORD,
  },

  emptyStringAsUndefined: true,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
