// @polsia:user-owned — diagnostica di connessione al database (ops). Protetta da CRON_SECRET, NON
// dalla sessione: se il DB è giù, l'autenticazione basata su DB fallirebbe comunque. Esegue una
// query banale (SELECT 1) con timeout e restituisce l'esito, l'errore Prisma esatto (codice + nome
// + messaggio redatto) e lo scheme/host delle URL DB (senza credenziali), per capire a quale
// database punta davvero. Nessun dato sensibile in output.
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { describeDatabaseUrls } from '@/lib/runtime-database-url';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const QUERY_TIMEOUT_MS = 10_000;

/** Autorizza solo con `Authorization: Bearer <CRON_SECRET>`, in tempo costante. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Toglie eventuali credenziali (user:pass@host) da un messaggio e lo tronca. */
function redact(text: string): string {
  return text.replace(/\/\/[^\s/@]+:[^\s/@]+@/g, '//•••@').slice(0, 300);
}

export async function GET(request: Request) {
  // Endpoint invisibile a chi non ha il secret: 404, non 401.
  if (!authorized(request)) return new NextResponse(null, { status: 404 });

  const startedAt = Date.now();
  const query = prisma.$queryRaw`SELECT 1`;
  // Evita un unhandled rejection se vince il timeout.
  query.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      query,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timeout: il database non ha risposto entro 10s')),
          QUERY_TIMEOUT_MS,
        );
      }),
    ]);
    return NextResponse.json(
      { ok: true, durationMs: Date.now() - startedAt, urls: describeDatabaseUrls() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? redact(error.message) : 'errore sconosciuto';
    return NextResponse.json(
      {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: { code: typeof code === 'string' ? code : null, name, message },
        urls: describeDatabaseUrls(),
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
