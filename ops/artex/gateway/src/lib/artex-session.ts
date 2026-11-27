import { env } from '@/lib/env';

/**
 * Transparent ARTEX session for the gateway.
 *
 * ARTEX requires its own login (POST /api/auth/login with the fixed username
 * "ARTEX" + the admin password, returns a JWT). The gateway already front-doors
 * every request behind Better Auth, and this is a single-user console, so the
 * ARTEX login screen is pure friction.
 *
 * This module logs into ARTEX once on demand, caches the JWT in memory, and
 * exposes getArtexToken() so the proxy route can inject it as
 *   Authorization: Bearer <jwt>
 * on every forwarded request. If upstream returns 401 (session expired because
 * the password was rotated and auth.password_version bumped), the proxy calls
 * invalidateArtexToken() and tries again; getArtexToken() then re-logs in.
 *
 * Using Bearer (not the artex_token cookie) deliberately sidesteps ARTEX's
 * sameOrigin() check on state-changing requests — cookie sessions MUST match
 * origin, Bearer sessions skip that path (server/auth.go requireAuth).
 *
 * Concurrency: a single in-flight login promise is shared across requests, so
 * N parallel 401s won't trigger N logins.
 */

// A JWT is a short string; the exact bound doesn't matter. We don't parse it.
let cached: { token: string; fetchedAt: number } | null = null;
let inflight: Promise<string> | null = null;

const UPSTREAM_USERNAME = 'ARTEX';

async function loginToArtex(): Promise<string> {
  const base = env.ARTEX_UPSTREAM_URL.replace(/\/+$/, '');
  const url = `${base}/api/auth/login`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: UPSTREAM_USERNAME, password: env.ARTEX_SESSION_PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `ARTEX login failed: status=${res.status} body=${text.slice(0, 200)}. ` +
        'Check ARTEX_SESSION_PASSWORD matches what you set on /setup.',
    );
  }
  const body = (await res.json().catch(() => ({}))) as { token?: unknown };
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error('ARTEX login returned no token field');
  }
  return body.token;
}

export async function getArtexToken(): Promise<string> {
  if (cached) return cached.token;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const token = await loginToArtex();
      cached = { token, fetchedAt: Date.now() };
      return token;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function invalidateArtexToken(): void {
  cached = null;
}
