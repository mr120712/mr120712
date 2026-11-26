import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * Typed env for the ARTEX gateway.
 *
 * All server-only — no client env on this surface. The gateway's only "pages"
 * are /login and /verify, which don't consume anything from process.env on the
 * client side.
 *
 * The gateway intentionally re-uses Solco's POLSIA_EMAIL_PROXY_URL so the one
 * mail relay Solco already operates serves the magic-link emails too. No
 * credentials beyond the optional bearer are needed.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // SQLite file path. In compose this is `file:/data/gateway.db`.
    DATABASE_URL: z.string().min(1),

    // Public base URL of the gateway. Better Auth uses it to build magic-link URLs
    // and to validate request origin. Must match what Caddy proxies to it.
    GATEWAY_URL: z.string().url(),

    // Random secret that signs Better Auth session cookies and verification tokens.
    // 32 bytes minimum (hex: 64 chars). Rotate with `openssl rand -hex 32`.
    BETTER_AUTH_SECRET: z.string().min(32),

    // The one email that may request a magic link. Everything else is 403.
    GATEWAY_ADMIN_EMAIL: z.string().email(),

    // Where ARTEX listens on the compose network. Default matches the service name.
    ARTEX_UPSTREAM_URL: z.string().url().default('http://artex:8787'),

    // Polsia-managed email relay. See Solco's src/lib/env.ts for the same key.
    POLSIA_EMAIL_PROXY_URL: z.string().url(),
    POLSIA_EMAIL_API_KEY: z.string().min(1).optional(),

    // Human sender identity in the magic-link email. Defaults sane; override per deploy.
    GATEWAY_EMAIL_FROM: z.string().email().default('artex-gateway@solcomusic.online'),
    GATEWAY_EMAIL_FROM_NAME: z.string().default('ARTEX Gateway'),
  },

  client: {},

  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    GATEWAY_URL: process.env.GATEWAY_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    GATEWAY_ADMIN_EMAIL: process.env.GATEWAY_ADMIN_EMAIL,
    ARTEX_UPSTREAM_URL: process.env.ARTEX_UPSTREAM_URL,
    POLSIA_EMAIL_PROXY_URL: process.env.POLSIA_EMAIL_PROXY_URL,
    POLSIA_EMAIL_API_KEY: process.env.POLSIA_EMAIL_API_KEY,
    GATEWAY_EMAIL_FROM: process.env.GATEWAY_EMAIL_FROM,
    GATEWAY_EMAIL_FROM_NAME: process.env.GATEWAY_EMAIL_FROM_NAME,
  },

  emptyStringAsUndefined: true,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
