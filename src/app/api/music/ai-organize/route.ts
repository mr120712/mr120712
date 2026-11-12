// @polsia:user-owned — "Organizza con l'AI": Claude Opus 5.5 legge un testo lungo e disordinato con
// la sua finestra da 1M token ed estrae un elenco pulito di brani (titolo + artista). La route
// restituisce i brani e anche le righe "Artista - Titolo" pronte per l'importazione dell'elenco
// brani (POST /api/music/import/track-list), che crea la playlist e risolve i brani su YouTube solo
// quando si ascoltano. Funzione Premium: ogni chiamata è a carico del proprietario di Solco.
import 'server-only';
import { NextResponse } from 'next/server';
import { organizeAvailable, organizeLongText } from '@/lib/business/ai-long-organize.server';
import { currentAccess, hasPremiumAccess } from '@/lib/business/premium-access.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { AiOrganizeRequestSchema, AiOrganizeResultSchema } from '@/lib/contracts/ai-long-organize';
import { getSessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// 300 s è il massimo del piano Vercel Hobby (oltre, la pubblicazione viene rifiutata). La chiamata
// in streaming ha un suo timeout appena sotto (vedi STREAM_TIMEOUT_MS): basta per i testi fino al
// tetto predefinito (400k token); input vicini a 1M richiederebbero un piano con funzioni più lunghe.
export const maxDuration = 300;

// ~4 MB di corpo ≈ 1M token di testo. Il vero tetto di spesa è il conteggio dei token lato server.
const MAX_BODY_BYTES = 4_000_000;

const privateHeaders = { 'Cache-Control': 'private, no-store' };

/**
 * Whether the feature works (a key Anthropic accepts, not merely a key that is set), and whether
 * this listener can use it (paid plans only). Same contract as "Cerca con l'AI".
 */
export async function GET() {
  const enabled = await organizeAvailable();
  const access = enabled ? await currentAccess() : { signedIn: false, premium: false };
  return NextResponse.json({ enabled, ...access }, { headers: privateHeaders });
}

const errorStatus = {
  not_configured: 503,
  refused: 422,
  busy: 503,
  failed: 502,
  empty: 422,
} as const;
const errorMessage = {
  not_configured: 'L’organizzazione con l’AI non è ancora attiva.',
  refused: 'Non posso aiutarti con questo testo. Incolla una scaletta o un elenco di canzoni.',
  busy: 'L’AI è molto richiesta in questo momento. Riprova tra poco.',
  failed: 'Non sono riuscito a leggere il testo. Riprova.',
  empty: 'Non ho trovato brani in questo testo. Incolla una scaletta o un elenco di canzoni.',
} as const;

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  // Every request costs the owner money: paying listeners only, rate limited per account.
  const user = await getSessionUser().catch(() => null);
  if (!user) {
    return NextResponse.json(
      { error: 'login_required', message: 'Accedi per usare l’organizzazione con l’AI.' },
      { status: 401, headers: privateHeaders },
    );
  }
  // Part of the paid plans (Premium, trial and Premium rewards included).
  if (!(await hasPremiumAccess(user.id))) {
    return NextResponse.json(
      {
        error: 'premium_required',
        message: 'L’organizzazione con l’AI è inclusa in Premium. Provala gratis per 10 giorni.',
      },
      { status: 402, headers: privateHeaders },
    );
  }
  const limited = await enforceRateLimit(
    'ai.organize',
    getRateLimitIdentity(user.id, request.headers),
  );
  if (limited) return limited;
  const globallyLimited = await enforceRateLimit('ai.organize.global', 'global');
  if (globallyLimited) return globallyLimited;

  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return limitedJsonError(body);
  const parsed = AiOrganizeRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { errors: { text: parsed.error.issues[0]?.message ?? 'Testo non valido.' } },
      { status: 400, headers: privateHeaders },
    );
  }

  const result = await organizeLongText(parsed.data.text, user.id);
  if (!result.ok) {
    if (result.error === 'too_large') {
      return NextResponse.json(
        {
          error: 'too_large',
          message: `Il testo è troppo lungo da leggere tutto in una volta (${result.inputTokens.toLocaleString('it-IT')} token, massimo ${result.maxInputTokens.toLocaleString('it-IT')}). Accorcialo e riprova.`,
          inputTokens: result.inputTokens,
          maxInputTokens: result.maxInputTokens,
        },
        { status: 413, headers: privateHeaders },
      );
    }
    return NextResponse.json(
      { error: result.error, message: errorMessage[result.error] },
      { status: errorStatus[result.error], headers: privateHeaders },
    );
  }

  return NextResponse.json(
    AiOrganizeResultSchema.parse({
      tracks: result.tracks,
      trackListText: result.trackListText,
      note: result.note,
      inputTokens: result.inputTokens,
      approxUsd: result.approxUsd,
      truncated: result.truncated,
    }),
    { headers: privateHeaders },
  );
}
