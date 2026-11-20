// @polsia:user-owned — helper della rotta POST /api/admin/featured-rights/transcribe/check, tenuti
// FUORI dal file di rotta. Un file di rotta Next può esportare solo gli handler HTTP (GET/POST/…) e
// la config (dynamic, maxDuration, …): qualunque altro export fa fallire la validazione dei tipi di
// `.next/types` nel build stretto (webpack / Vercel), con «does not satisfy the constraint
// '{ [x: string]: never }'». probeDiagnosis compone la diagnosi per l'amministratore; engineProbe la
// impacchetta nel contratto del motore.
import 'server-only';
import type { TranscriptionEngineProbe } from '@/lib/contracts/lyrics-transcription';
import {
  apiKeyShape,
  type TranscriptionProvider,
  transcriptionEngineLabel,
} from '@/lib/music/transcription-provider.server';
import { probeMessage, type WhisperProbeResult } from '@/lib/music/whisper.server';

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

/** L'esito di un motore nel contratto: tempo di risposta e, se fallisce, la diagnosi. */
export function engineProbe(
  provider: TranscriptionProvider,
  probe: WhisperProbeResult,
): TranscriptionEngineProbe {
  return {
    id: provider.id,
    label: transcriptionEngineLabel(provider),
    ok: probe.ok,
    elapsedMs: probe.elapsedMs,
    message: probe.ok ? null : probeDiagnosis(provider, probe),
  };
}
