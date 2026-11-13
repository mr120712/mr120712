// @polsia:user-owned — on Vercel, route database traffic through Prisma Accelerate's pool.
//
// The direct Prisma Postgres URL (DATABASE_URL) allows only a few connections: when Vercel
// starts several server instances (after a deploy, or on a burst of visitors) the database
// answers "too many connections" and sign-up/sign-in fail. PRISMA_DATABASE_URL (set by the
// Prisma Postgres integration) may point at Accelerate; DATABASE_URL_POOLED points at the
// pooled endpoint. Either pools connections for serverless. If those exact names are unset we
// also accept the Vercel integration's prefixed variants (e.g. MY_SOLCO_PRISMA_DATABASE_URL),
// so Accelerate still wakes a paused Prisma Postgres even when only the store-prefixed var exists.
// The schema push in the build keeps using the direct DATABASE_URL.
//
// Called first thing in seed(), which the framework runs at server start before any request,
// so @/lib/db is created with the pooled URL. Set SOLCO_DB_DIRECT=1 to switch it off.

const ACCELERATE_URL = /^prisma(\+postgres)?:\/\//i;
const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/**
 * First usable value among the exact `name` and any prefixed variant `*_name`, whose value
 * matches `scheme`. A Vercel storage integration names its connection strings with the store's
 * prefix (e.g. MY_SOLCO_PRISMA_DATABASE_URL, MY_SOLCO_DATABASE_URL_POOLED). The app reads the
 * unprefixed name; when that is unset we fall back to the integration's own var instead of the
 * direct DATABASE_URL — which, for a paused Prisma Postgres, the direct 5432 connection can't even
 * wake. The exact name always wins; prefixed candidates are scanned in stable alphabetical order
 * so the choice is deterministic.
 */
function firstUrlBySuffix(
  env: Record<string, string | undefined>,
  name: string,
  scheme: RegExp,
): string | undefined {
  const exact = env[name]?.trim();
  if (exact && scheme.test(exact)) return exact;
  const suffix = `_${name}`;
  for (const key of Object.keys(env).sort()) {
    if (!key.endsWith(suffix)) continue;
    const value = env[key]?.trim();
    if (value && scheme.test(value)) return value;
  }
  return undefined;
}

/** Pooled URL to use at runtime: Accelerate, or the PgBouncer-style pooled endpoint. */
export function pooledDatabaseUrl(env: Record<string, string | undefined>) {
  const accelerate = firstUrlBySuffix(env, 'PRISMA_DATABASE_URL', ACCELERATE_URL);
  if (accelerate) return accelerate;
  const pooled = firstUrlBySuffix(env, 'DATABASE_URL_POOLED', POSTGRES_URL);
  if (!pooled || pooled.includes('#')) return undefined;
  // Transaction-mode pooler: Prisma must not use prepared statements.
  if (/[?&]pgbouncer=/i.test(pooled)) return pooled;
  return `${pooled}${pooled.includes('?') ? '&' : '?'}pgbouncer=true`;
}

export function preferPooledDatabaseUrl(env: Record<string, string | undefined> = process.env) {
  if (env.VERCEL !== '1' || env.SOLCO_DB_DIRECT === '1') return false;
  const pooled = pooledDatabaseUrl(env);
  if (!pooled || env.DATABASE_URL === pooled) return false;
  env.DATABASE_URL = pooled;
  return true;
}

/** Scheme and host of each database URL (never credentials), for the server log. */
export function describeDatabaseUrls(env: Record<string, string | undefined> = process.env) {
  const parts = ['DATABASE_URL', 'PRISMA_DATABASE_URL', 'DATABASE_URL_POOLED', 'POSTGRES_URL'].map(
    (key) => {
      const raw = env[key]?.trim();
      if (!raw) return `${key}=unset`;
      try {
        const url = new URL(raw);
        return `${key}=${url.protocol}//${url.hostname}`;
      } catch {
        return `${key}=invalid`;
      }
    },
  );
  return `vercel=${env.VERCEL ?? 'unset'} ${parts.join(' ')}`;
}
