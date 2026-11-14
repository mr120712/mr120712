// @polsia:user-owned — API del «Bot Solco».
//   GET  → stato della quota mensile dell'utente (used / limit / remaining; limit null = Premium).
//   POST → esegue una ricerca Creative Commons (Audius + radio + podcast) e CONSUMA un utilizzo.
// Login richiesto (come gli ascolti); i free hanno 30 ricerche al mese, i Premium illimitati. La
// POST parte da sameOrigin (mutazione) e da un rate-limit anti-abuso, poi dalla quota mensile.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  botQuotaStatus,
  consumeBotUse,
  FREE_MONTHLY_BOT_USES,
} from '@/lib/business/bot-quota.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { readJsonLimited } from '@/lib/business/request-body.server';
import {
  BotCommandRequestSchema,
  BotCommandResponseSchema,
  BotQuotaSchema,
} from '@/lib/contracts/bot';
import { botSearch } from '@/lib/music/bot-search.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
/** La ricerca interroga più fonti in parallelo: lascia margine oltre la fonte più lenta. */
export const maxDuration = 20;

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function fail(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: privateHeaders });
}

async function sessionUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  return session?.user ?? null;
}

export async function GET(request: Request) {
  const user = await sessionUser(request);
  if (!user) return fail('login_required', 401);
  try {
    const status = BotQuotaSchema.parse(await botQuotaStatus(user));
    return NextResponse.json(status, { headers: privateHeaders });
  } catch {
    return fail('status_unavailable', 503);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail('forbidden_origin', 403);
  const user = await sessionUser(request);
  if (!user) return fail('login_required', 401);

  // Anti-abuso a raffica (separato dalla quota mensile): riusa il bucket della ricerca.
  const identity = getRateLimitIdentity(user.id, request.headers);
  if (identity) {
    const limited = await enforceRateLimit('music.search', identity);
    if (limited) {
      limited.headers.set('Cache-Control', 'private, no-store');
      return limited;
    }
  }

  const body = await readJsonLimited(request, 8 * 1024);
  if (!body.ok)
    return NextResponse.json(
      { errors: { query: 'Richiesta non valida.' } },
      { status: 400, headers: privateHeaders },
    );
  const parsed = BotCommandRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { errors: { query: 'Inserisci una ricerca da 1 a 80 caratteri.' } },
      { status: 400, headers: privateHeaders },
    );
  }

  // Consuma un utilizzo in modo atomico (il free è bloccato a 30/mese). botSearch non lancia.
  let decision: Awaited<ReturnType<typeof consumeBotUse>>;
  try {
    decision = await consumeBotUse(user);
  } catch {
    return fail('bot_unavailable', 503);
  }
  if (!decision.allowed) {
    const status = decision.reason === 'login_required' ? 401 : 402;
    return fail(decision.reason, status, {
      used: decision.used,
      limit: decision.limit ?? FREE_MONTHLY_BOT_USES,
      remaining: decision.remaining,
    });
  }

  const results = await botSearch(parsed.data.query);
  const bodyOut = BotCommandResponseSchema.parse({
    query: parsed.data.query,
    results,
    premium: decision.premium,
    used: decision.used,
    limit: decision.limit,
    remaining: decision.remaining,
  });
  return NextResponse.json(bodyOut, { headers: privateHeaders });
}
