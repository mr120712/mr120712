// @polsia:user-owned — on Vercel, route database traffic through Prisma Accelerate's pool.
//
// The direct Prisma Postgres URL (DATABASE_URL) allows only a few connections: when Vercel
// starts several server instances (after a deploy, or on a burst of visitors) the database
// answers "too many connections" and sign-up/sign-in fail. PRISMA_DATABASE_URL (set by the
// Prisma Postgres integration) points at Accelerate, which pools connections for serverless.
// The schema push in the build keeps using the direct DATABASE_URL.
//
// Called first thing in seed(), which the framework runs at server start before any request,
// so @/lib/db is created with the pooled URL. Set SOLCO_DB_DIRECT=1 to switch it off.

const ACCELERATE_URL = /^prisma(\+postgres)?:\/\//i;

export function preferPooledDatabaseUrl(env: Record<string, string | undefined> = process.env) {
  if (env.VERCEL !== '1' || env.SOLCO_DB_DIRECT === '1') return false;
  const pooled = env.PRISMA_DATABASE_URL?.trim();
  if (!pooled || !ACCELERATE_URL.test(pooled) || env.DATABASE_URL === pooled) return false;
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
