// @polsia:user-owned — pulsante «Verifica chiave OpenAI» della pagina admin «Diritti e testi»: chiede
// a POST /api/admin/featured-rights/transcribe/check di provare OPENAI_API_KEY del server con un
// secondo di silenzio inviato a Whisper (stessa richiesta della trascrizione, costo di circa un
// centesimo di centesimo) e riferisce con un avviso (toast): chiave valida con il tempo di risposta,
// oppure il messaggio del server (chiave non valida, crediti esauriti, limite raggiunto, OpenAI non
// raggiungibile, chiave assente su Vercel). La chiave non arriva mai nel browser.
'use client';

import { KeyRound, LoaderCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  TRANSCRIPTION_CHECK_SUCCESS,
  TranscriptionCheckResponseSchema,
} from '@/lib/contracts/lyrics-transcription';

export const OPENAI_CHECK_ENDPOINT = '/api/admin/featured-rights/transcribe/check';
const MESSAGE_MAX = 300;

const ERROR_CODE_TEXT: Record<string, string> = {
  unauthorized: 'La sessione è scaduta: accedi di nuovo.',
  forbidden: 'Serve un account amministratore con email verificata.',
  forbidden_origin: 'Richiesta rifiutata: ricarica la pagina e riprova.',
  session_unavailable: 'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
};

const secondsFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

/** «Chiave OpenAI valida: … (risposta in 1,2 s)». */
export function checkSuccessText(elapsedMs: number): string {
  return `${TRANSCRIPTION_CHECK_SUCCESS} (risposta in ${secondsFormat.format(elapsedMs / 1000)} s)`;
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
  return 'Verifica della chiave OpenAI non riuscita. Riprova tra poco.';
}

export function OpenAiKeyCheckButton() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const check = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await apiFetch(OPENAI_CHECK_ENDPOINT, {
        method: 'POST',
        schema: TranscriptionCheckResponseSchema,
      });
      toast.success(checkSuccessText(result.elapsedMs));
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
      title="Prova OPENAI_API_KEY del server con un secondo di silenzio inviato a Whisper (costo di circa un centesimo di centesimo) e dice se la trascrizione con l'IA può funzionare"
      className="aria-disabled:cursor-progress aria-disabled:opacity-70"
    >
      {busy ? (
        <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
      ) : (
        <KeyRound aria-hidden="true" />
      )}
      Verifica chiave OpenAI
    </Button>
  );
}
