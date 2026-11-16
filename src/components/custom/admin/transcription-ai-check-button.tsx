// @polsia:user-owned — pulsante «Verifica Solco AI» della pagina admin «Diritti e testi»: chiede a
// POST /api/admin/featured-rights/transcribe/check di provare il motore di trascrizione del server
// con un secondo di silenzio (stessa richiesta della trascrizione, costo irrisorio) e riferisce con
// un avviso (toast): motore e modello che hanno risposto con il tempo di risposta, oppure il
// messaggio del server (chiave non valida, crediti esauriti, limite raggiunto, servizio non
// raggiungibile, chiave assente su Vercel). La chiave non arriva mai nel browser.
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

/** «Solco AI funziona: … · Solco AI (Groq · whisper-large-v3) · risposta in 1,2 s». */
export function checkSuccessText(result: Pick<TranscriptionCheckResponse, 'engine' | 'elapsedMs'>) {
  return `${TRANSCRIPTION_CHECK_SUCCESS} · ${result.engine} · risposta in ${secondsFormat.format(result.elapsedMs / 1000)} s`;
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
      toast.success(checkSuccessText(result));
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
      title={`Prova il motore di trascrizione dei testi (${SOLCO_AI_NAME}) con un secondo di silenzio generato dal server: nessun brano, costo irrisorio`}
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
