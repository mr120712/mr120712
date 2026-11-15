// @polsia:user-owned — proposte di «Crea playlist». Tre modi: una descrizione (solo con l'AI,
// Premium), un brano o artista di partenza e un'atmosfera (catalogo Audius per tutti, arricchito
// dall'AI se chiesto e possibile). Nessuna ricerca YouTube qui: i brani suggeriti dall'AI sono
// "song", cercati solo quando si ascoltano. Mai brani in evidenza.
import 'server-only';
import { NextResponse } from 'next/server';
import { type AiGate, suggestPlaylist } from '@/lib/business/playlist-engine.server';
import { playlistAiConfigured } from '@/lib/business/playlist-engine-ai.server';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { SuggestRequestSchema, SuggestResponseSchema } from '@/lib/contracts/playlist-engine';
import { getSessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// La chiamata ad Anthropic ha una scadenza di 100 s sotto questo limite di 120 s.
export const maxDuration = 120;

const privateHeaders = { 'Cache-Control': 'private, no-store' };

const PREMIUM_MESSAGE =
  'Le proposte con l’AI sono incluse in Premium (provalo gratis per 10 giorni). «Scegli l’atmosfera» funziona anche senza.';
const UNAVAILABLE_MESSAGE =
  'Le proposte con l’AI non sono disponibili in questo momento. «Scegli l’atmosfera» funziona sempre.';

const GENERIC_REQUEST_ERROR = 'Richiesta non valida: ricarica la pagina e riprova.';

/**
 * L'errore di validazione sul campo del modulo a cui appartiene (per applyServerErrors); ciò che
 * l'utente non può correggere dal modulo (quantità, esclusioni, modo) è un errore generico.
 */
function fieldError(path: readonly (string | number)[], message: string): Record<string, string> {
  const [first, second] = path;
  if (first === 'prompt' || first === 'mood' || first === 'genre') return { [first]: message };
  if (first === 'seed' && (second === 'artist' || second === 'title')) return { [second]: message };
  return { request: GENERIC_REQUEST_ERROR };
}

async function limitedMessage(response: Response) {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === 'string'
    ? body.message
    : 'Hai raggiunto il limite. Riprova più tardi.';
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const user = await getSessionUser().catch(() => null);
  if (!user) {
    return NextResponse.json(
      { error: 'login_required', message: 'Accedi per creare una playlist.' },
      { status: 401, headers: privateHeaders },
    );
  }
  // Ogni proposta legge il catalogo Audius condiviso: limite per account prima di leggere il corpo.
  const identity = getRateLimitIdentity(user.id, request.headers);
  const limited = await enforceRateLimit('playlist.engine.suggest', identity);
  if (limited) return limited;

  // Fino a 80 brani da escludere, con titoli e artisti lunghi e non latini.
  const body = await readJsonLimited(request, 160 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = SuggestRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { errors: fieldError(issue?.path ?? [], issue?.message ?? GENERIC_REQUEST_ERROR) },
      { status: 400, headers: privateHeaders },
    );
  }

  // L'AI costa al proprietario di Solco: piani a pagamento, chiave funzionante, limiti per account
  // e per l'intera app. Controllata solo quando la richiesta la usa davvero.
  const aiGate = async (): Promise<AiGate> => {
    if (!(await hasPremiumAccess(user.id))) {
      return {
        ok: false,
        status: 'premium_required',
        message: PREMIUM_MESSAGE,
        response: NextResponse.json(
          { error: 'premium_required', message: PREMIUM_MESSAGE },
          { status: 402, headers: privateHeaders },
        ),
      };
    }
    if (!playlistAiConfigured()) {
      return {
        ok: false,
        status: 'unavailable',
        message: UNAVAILABLE_MESSAGE,
        response: NextResponse.json(
          { error: 'not_configured', message: UNAVAILABLE_MESSAGE },
          { status: 503, headers: privateHeaders },
        ),
      };
    }
    for (const [action, who] of [
      ['playlist.engine.ai', identity],
      ['playlist.engine.ai.global', 'global'],
    ] as const) {
      const denied = await enforceRateLimit(action, who);
      if (denied) {
        return {
          ok: false,
          status: 'rate_limited',
          message: await limitedMessage(denied),
          response: denied,
        };
      }
    }
    return { ok: true };
  };

  try {
    const outcome = await suggestPlaylist(parsed.data, { userId: user.id, aiGate });
    if (!outcome.ok) return outcome.response;
    return NextResponse.json(SuggestResponseSchema.parse(outcome.body), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      {
        error: 'suggest_unavailable',
        message: 'Non sono riuscito a preparare le proposte. Riprova tra poco.',
      },
      { status: 503, headers: privateHeaders },
    );
  }
}
