// @polsia:user-owned — POST /api/admin/featured-rights/transcribe/check: «Verifica Solco AI» dalla
// pagina admin «Diritti e testi». Prova OGNI motore configurato (Groq, Deepgram, ElevenLabs, OpenAI,
// Fireworks, Mistral, Cloudflare: quelli con la chiave su Vercel, nell'ordine in cui la trascrizione
// li usa) con un secondo di silenzio generato sul server (nessun brano dello store, costo irrisorio)
// e la stessa richiesta della trascrizione. Risponde 200 se almeno un motore funziona (modello e
// motore del primo che risponde, più l'esito di tutti in `engines`), 503 transcription_not_configured
// se nessuna chiave è su Vercel, altrimenti l'errore del primo motore con i motivi di tutti
// (transcription_invalid_key, transcription_no_credit, transcription_rate_limited,
// transcription_unavailable, transcription_no_response: gli stessi codici della trascrizione, mai la
// chiave né il testo della risposta). Solo admin con email verificata, stessa origine, limite
// 'lyrics.transcribe.check' per admin (consumato solo con almeno una chiave); risposta privata.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { consumeRateLimit, rateLimitResponse } from '@/lib/business/rate-limit.server';
import { TranscriptionCheckResponseSchema } from '@/lib/contracts/lyrics-transcription';
import { transcriptionRefusalResponse } from '@/lib/music/lyrics-transcription.server';
import { engineProbe } from '@/lib/music/transcription-check-probe.server';
import { probeProvider } from '@/lib/music/transcription-engines.server';
import { configuredTranscriptionProviders } from '@/lib/music/transcription-provider.server';
import type { WhisperProbeResult } from '@/lib/music/whisper.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
/** Le prove ai servizi partono insieme e durano al massimo 20 secondi. */
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
    if (!isAuthorizedAdmin(session.user)) {
      return { allowed: false, response: failure('forbidden', 403) };
    }
    return { allowed: true, userId: session.user.id };
  } catch {
    return { allowed: false, response: failure('session_unavailable', 503) };
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;

  const providers = configuredTranscriptionProviders();
  if (providers.length === 0) return transcriptionRefusalResponse({ kind: 'not_configured' });

  const decision = await consumeRateLimit('lyrics.transcribe.check', `user:${access.userId}`);
  if (!decision.allowed) {
    const response = rateLimitResponse('lyrics.transcribe.check', decision);
    response.headers.set('Vary', 'Cookie');
    return response;
  }

  // Tutti insieme: la risposta arriva nel tempo del motore più lento, non della somma.
  const probes = await Promise.all(
    providers.map((provider) => probeProvider(provider, { signal: request.signal })),
  );
  const engines = providers.map((provider, index) => {
    const probe = probes[index] as WhisperProbeResult;
    if (!probe.ok) {
      // Solo motore e codice nei log: niente chiave, niente testo della risposta.
      // biome-ignore lint/suspicious/noConsole: log del server con il solo codice dell'esito.
      console.warn(`[admin/featured-rights/transcribe/check] ${provider.id}: ${probe.error}`);
    }
    return { provider, probe, summary: engineProbe(provider, probe) };
  });

  const working = engines.find((engine) => engine.probe.ok);
  if (!working || !working.probe.ok) {
    const [first] = engines;
    const failed = first && !first.probe.ok ? first.probe : null;
    const reasons = engines.map((engine) => engine.summary.message ?? '').filter(Boolean);
    return transcriptionRefusalResponse({
      kind: 'whisper',
      error: failed?.error ?? 'unavailable',
      message:
        reasons.length === 1
          ? (reasons[0] ?? '')
          : `Nessun motore di Solco AI funziona. ${reasons.join(' ')}`,
    });
  }
  return NextResponse.json(
    TranscriptionCheckResponseSchema.parse({
      ok: true,
      model: working.probe.model,
      engine: working.probe.engine,
      elapsedMs: working.probe.elapsedMs,
      checkedAt: new Date().toISOString(),
      engines: engines.map((engine) => engine.summary),
    }),
    { headers: privateHeaders },
  );
}
