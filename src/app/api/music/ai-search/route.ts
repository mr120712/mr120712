// @polsia:user-owned — "Cerca con l'AI": Claude Opus 5.5 trasforma una descrizione in ricerche.
import 'server-only';
import { NextResponse } from 'next/server';
import { aiSearchConfigured, planMusicSearch } from '@/lib/business/ai-music-search.server';
import { currentAccess, hasPremiumAccess } from '@/lib/business/premium-access.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { AiSearchRequestSchema } from '@/lib/contracts/ai-music-search';
import { getSessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// Opus 5.5 at high effort usually answers in seconds; leave room for a slow turn.
export const maxDuration = 120;

const privateHeaders = { 'Cache-Control': 'private, no-store' };

/** Whether the AI search is on, and whether this listener can use it (paid plans only). */
export async function GET() {
  const enabled = aiSearchConfigured();
  const access = enabled ? await currentAccess() : { signedIn: false, premium: false };
  return NextResponse.json({ enabled, ...access }, { headers: privateHeaders });
}

const errorStatus = { not_configured: 503, refused: 422, busy: 503, failed: 502 } as const;
const errorMessage = {
  not_configured: 'La ricerca con l’AI non è ancora attiva.',
  refused: 'Non posso aiutarti con questa richiesta. Prova a descrivere la musica che cerchi.',
  busy: 'L’AI è molto richiesta in questo momento. Riprova tra poco.',
  failed: 'La ricerca con l’AI non è riuscita. Riprova.',
} as const;

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  // Every request costs the owner money: paying listeners only, rate limited per account.
  const user = await getSessionUser().catch(() => null);
  if (!user) {
    return NextResponse.json(
      { error: 'login_required', message: 'Accedi per usare la ricerca con l’AI.' },
      { status: 401, headers: privateHeaders },
    );
  }
  // Part of the paid plans (Premium, trial and Premium rewards included).
  if (!(await hasPremiumAccess(user.id))) {
    return NextResponse.json(
      {
        error: 'premium_required',
        message: 'La ricerca con l’AI è inclusa in Premium. Provala gratis per 10 giorni.',
      },
      { status: 402, headers: privateHeaders },
    );
  }
  const limited = await enforceRateLimit(
    'music.ai_search',
    getRateLimitIdentity(user.id, request.headers),
  );
  if (limited) return limited;
  const globallyLimited = await enforceRateLimit('music.ai_search.global', 'global');
  if (globallyLimited) return globallyLimited;

  const body = await readJsonLimited(request, 4_096);
  if (!body.ok) return limitedJsonError(body);
  const parsed = AiSearchRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { errors: { prompt: parsed.error.issues[0]?.message ?? 'Descrizione non valida.' } },
      { status: 400, headers: privateHeaders },
    );
  }

  const result = await planMusicSearch(parsed.data.prompt, user.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: errorMessage[result.error] },
      { status: errorStatus[result.error], headers: privateHeaders },
    );
  }
  return NextResponse.json(
    { plan: result.plan, cached: result.cached },
    { headers: privateHeaders },
  );
}
