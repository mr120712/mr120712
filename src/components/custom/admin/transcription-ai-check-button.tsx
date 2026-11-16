// @polsia:user-owned — pulsante «Verifica Solco AI» della pagina admin «Diritti e testi»: chiede a
// POST /api/admin/featured-rights/transcribe/check di provare TUTTI i motori di trascrizione
// configurati sul server con un secondo di silenzio (stessa richiesta della trascrizione, costo
// irrisorio) e riferisce con un avviso (toast): il primo motore che funziona con il tempo di
// risposta e, con più motori, l'esito di ciascuno (ok con il tempo, oppure il motivo); altrimenti il
// messaggio del server (chiave non valida, crediti esauriti, limite raggiunto, servizio non
// raggiungibile, nessuna chiave su Vercel). Le chiavi non arrivano mai nel browser.
'use client';

import { KeyRound, LoaderCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  SOLCO_AI_NAME,
  TRANSCRIPTION_CHECK_SUCCESS,
  type TranscriptionCheckResponse,
  TranscriptionCheckResponseSchema,
  type TranscriptionEngineProbe,
} from '@/lib/contracts/lyrics-transcription';

export const TRANSCRIPTION_CHECK_ENDPOINT = '/api/admin/featured-rights/transcribe/check';
const MESSAGE_MAX = 300;

const ERROR_CODE_TEXT: Record<string, string> = {
  unauthorized: 'La sessione è scaduta: accedi di nuovo.',
  forbidden: 'Serve un account amministratore con email verificata.',
  forbidden_origin: 'Richiesta rifiutata: ricarica la pagina e riprova.',
  session_unavailable: 'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
};

const secondsFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

function seconds(elapsedMs: number) {
  return `${secondsFormat.format(elapsedMs / 1000)} s`;
}

/** «Solco AI funziona: … · Solco AI (Groq · whisper-large-v3) · risposta in 1,2 s». */
export function checkSuccessText(result: Pick<TranscriptionCheckResponse, 'engine' | 'elapsedMs'>) {
  return `${TRANSCRIPTION_CHECK_SUCCESS} · ${result.engine} · risposta in ${seconds(result.elapsedMs)}`;
}

/**
 * Con più motori, l'esito di ciascuno nell'ordine in cui la trascrizione li prova: «Deepgram
 * (nova-3): ok in 0,6 s · OpenAI (whisper-1): chiave OpenAI non valida…». Null con un motore solo.
 */
export function checkEnginesText(engines: readonly TranscriptionEngineProbe[]): string | null {
  if (engines.length < 2) return null;
  return engines
    .map((engine) =>
      engine.ok
        ? `${engine.label}: ok in ${seconds(engine.elapsedMs)}`
        : `${engine.label}: ${engine.message ?? 'non risponde'}`,
    )
    .join(' · ');
}

/** Il messaggio del server quando c'è, altrimenti un testo breve in italiano. */
export function checkFailureText(error: unknown): string {
  if (error instanceof ZodError) return 'La risposta del server non è nel formato atteso.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete e riprova.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown; error?: unknown })
      : null;
  if (typeof cause?.message === 'string' && cause.message.trim()) {
    return cause.message.trim().slice(0, MESSAGE_MAX);
  }
  const code = cause?.error;
  if (typeof code === 'string' && Object.hasOwn(ERROR_CODE_TEXT, code)) {
    return ERROR_CODE_TEXT[code] ?? '';
  }
  return `Verifica di ${SOLCO_AI_NAME} non riuscita. Riprova tra poco.`;
}

export function TranscriptionAiCheckButton() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const check = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await apiFetch(TRANSCRIPTION_CHECK_ENDPOINT, {
        method: 'POST',
        schema: TranscriptionCheckResponseSchema,
      });
      const description = checkEnginesText(result.engines);
      if (description) toast.success(checkSuccessText(result), { description });
      else toast.success(checkSuccessText(result));
    } catch (error) {
      toast.error(checkFailureText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => void check()}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      title={`Prova i motori di trascrizione dei testi (${SOLCO_AI_NAME}) con un secondo di silenzio generato dal server: nessun brano, costo irrisorio`}
      className="aria-disabled:cursor-progress aria-disabled:opacity-70"
    >
      {busy ? (
        <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
      ) : (
        <KeyRound aria-hidden="true" />
      )}
      Verifica {SOLCO_AI_NAME}
    </Button>
  );
}
