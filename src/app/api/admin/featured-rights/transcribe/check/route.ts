// @polsia:user-owned — POST /api/admin/featured-rights/transcribe/check: «Verifica Solco AI» dalla
// pagina admin «Diritti e testi». Invia al motore di trascrizione configurato (Groq, modello Whisper
// large-v3 a pesi aperti; OpenAI solo se LYRICS_AI_PROVIDER=openai) un secondo di silenzio generato
// sul server (nessun brano dello store, costo irrisorio) con la stessa richiesta della trascrizione
// e risponde se funziona (200 con modello e motore), se la chiave manca su Vercel (503
// transcription_not_configured) o perché no (transcription_invalid_key, transcription_no_credit,
// transcription_rate_limited, transcription_unavailable, transcription_no_response: gli stessi
// codici della trascrizione, mai la chiave né il testo della risposta). Solo admin con email
// verificata, stessa origine, limite 'lyrics.transcribe.check' per admin (consumato solo con la
// chiave presente); risposta privata, mai in cache.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { consumeRateLimit, rateLimitResponse } from '@/lib/business/rate-limit.server';
import { TranscriptionCheckResponseSchema } from '@/lib/contracts/lyrics-transcription';
import { transcriptionRefusalResponse } from '@/lib/music/lyrics-transcription.server';
import {
  apiKeyShape,
  type TranscriptionProvider,
  transcriptionProvider,
} from '@/lib/music/transcription-provider.server';
import { probeMessage, probeTranscription } from '@/lib/music/whisper.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
/** La prova al servizio dura al massimo 20 secondi. */
export const maxDuration = 30;

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: privateHeaders });
}

type AdminAccess = { allowed: true; userId: string } | { allowed: false; response: Response };

async function requireAdmin(request: Request): Promise<AdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { allowed: false, response: failure('unauthorized', 401) };
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
      return { allowed: false, response: failure('forbidden', 403) };
    }
    return { allowed: true, userId: session.user.id };
  } catch {
    return { allowed: false, response: failure('session_unavailable', 503) };
  }
}

/**
 * Il messaggio della prova con la diagnosi che serve all'amministratore: lo stato HTTP del
 * servizio e, per una chiave rifiutata, com'è fatta la chiave su Vercel (lunghezza, prefisso,
 * caratteri estranei), mai la chiave stessa.
 */
export function probeDiagnosis(
  provider: TranscriptionProvider,
  probe: { error: string; message: string; status?: number },
): string {
  const base = probeMessage(probe.message);
  const http = probe.status === undefined ? 'nessuna risposta HTTP' : `HTTP ${probe.status}`;
  if (probe.error === 'invalid_key') {
    return `${base} ${provider.vendor} ha risposto ${http}; la chiave su Vercel: ${apiKeyShape(provider)}.`;
  }
  return probe.status === undefined ? base : `${base} (${provider.vendor}: ${http})`;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;

  const provider = transcriptionProvider();
  if (!provider) return transcriptionRefusalResponse({ kind: 'not_configured' });

  const decision = await consumeRateLimit('lyrics.transcribe.check', `user:${access.userId}`);
  if (!decision.allowed) {
    const response = rateLimitResponse('lyrics.transcribe.check', decision);
    response.headers.set('Vary', 'Cookie');
    return response;
  }

  const probe = await probeTranscription({ provider, signal: request.signal });
  if (!probe.ok) {
    // Solo motore e codice nei log: niente chiave, niente testo della risposta.
    // biome-ignore lint/suspicious/noConsole: log del server con il solo codice dell'esito.
    console.warn(`[admin/featured-rights/transcribe/check] ${provider.id}: ${probe.error}`);
    return transcriptionRefusalResponse({
      kind: 'whisper',
      error: probe.error,
      message: probeDiagnosis(provider, probe),
    });
  }
  return NextResponse.json(
    TranscriptionCheckResponseSchema.parse({
      ok: true,
      model: probe.model,
      engine: probe.engine,
      elapsedMs: probe.elapsedMs,
      checkedAt: new Date().toISOString(),
    }),
    { headers: privateHeaders },
  );
}
