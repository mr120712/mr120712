// @polsia:user-owned — on Vercel, route database traffic through a pooled/serverless endpoint.
//
// Serverless (Vercel) opens many short-lived instances. A DIRECT Postgres connection then runs
// out of connections ("too many connections" / timeouts) and sign-up/sign-in fail. So at runtime
// we prefer a POOLED connection string, in this order:
//   - PRISMA_DATABASE_URL  → Prisma Accelerate (prisma+postgres://). Also WAKES a paused Prisma
//                            Postgres, which a direct :5432 connection cannot do.
//   - DATABASE_URL_POOLED  → an explicit PgBouncer-style pooled endpoint.
//   - a DATABASE_URL that already points at a transaction pooler (Neon/Supabase "-pooler" host)
//                            → used as-is but with pgbouncer=true, so Prisma skips prepared
//                              statements the pooler can't keep.
// The schema push in the build keeps using the direct DATABASE_URL. We deliberately read ONLY
// these exact names (never a store-prefixed variant such as MY_SOLCO_*), so a leftover variable
// from a previous database provider can never hijack the active DATABASE_URL.
//
// Called first thing in seed(), which the framework runs at server start before any request, so
// @/lib/db is created with the pooled URL. Set SOLCO_DB_DIRECT=1 to switch it off.

const ACCELERATE_URL = /^prisma(\+postgres)?:\/\//i;
const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/** True when the URL's HOST is a transaction pooler (Neon `-pooler`, Supabase `pooler.`). */
function isPoolerHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /-pooler\./i.test(host) || /(^|\.)pooler\./i.test(host);
  } catch {
    return false;
  }
}

/** Append pgbouncer=true unless it's already set. */
function withPgBouncer(url: string): string {
  if (/[?&]pgbouncer=/i.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}pgbouncer=true`;
}

/** Pooled URL to use at runtime: Accelerate, an explicit pooled endpoint, or a pooler DATABASE_URL. */
export function pooledDatabaseUrl(env: Record<string, string | undefined>) {
  const accelerate = env.PRISMA_DATABASE_URL?.trim();
  if (accelerate && ACCELERATE_URL.test(accelerate)) return accelerate;

  const pooled = env.DATABASE_URL_POOLED?.trim();
  if (pooled && POSTGRES_URL.test(pooled) && !pooled.includes('#')) return withPgBouncer(pooled);

  // Neon/Supabase: the integration sets DATABASE_URL to the pooled ("-pooler") host already — make
  // it Prisma-safe. A direct (non-pooler) DATABASE_URL is left untouched.
  const direct = env.DATABASE_URL?.trim();
  if (direct && POSTGRES_URL.test(direct) && !direct.includes('#') && isPoolerHost(direct)) {
    return withPgBouncer(direct);
  }
  return undefined;
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
