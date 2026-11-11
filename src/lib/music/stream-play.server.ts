// @polsia:user-owned — limite Free sulle route di stream: verifica prima dell'audio, registra
// l'ascolto solo quando la fonte ha risposto davvero con audio (un brano fallito non costa nulla).
import 'server-only';
import type { PlayDecision } from '@/lib/business/play-quota';
import { consumePlay, decidePlayFor } from '@/lib/business/play-quota.server';
import { getSessionUser } from '@/lib/require-auth';

export type StreamPlayCheck = {
  user: { id: string } | null;
  qualifiedId: string;
  decision: PlayDecision;
};

/**
 * La decisione di `consumePlay` senza scrivere nulla (stessa funzione, `decidePlayFor`): ospiti e
 * account Free oltre i 40 ascolti vengono fermati qui, prima di qualsiasi richiesta alla fonte
 * o byte audio, con la stessa risposta di prima (`playDeniedResponse`). Usata anche dal permesso
 * del player (POST /api/music/plays), che quindi non consuma mai un ascolto.
 */
export async function checkStreamPlay(
  qualifiedId: string,
  now = new Date(),
): Promise<StreamPlayCheck> {
  const user = await getSessionUser().catch(() => null);
  return { user, qualifiedId, decision: await decidePlayFor(user, qualifiedId, now) };
}

/**
 * True when a new Free play will be written once the audio starts. False for Premium, exempt
 * sources and a replay/seek/Range request of a track already counted within REPLAY_WINDOW_MS.
 */
export function willCountStreamPlay(check: StreamPlayCheck) {
  return check.decision.allowed && check.decision.counted;
}

/**
 * Registra l'ascolto: da chiamare solo dopo che la fonte ha risposto con audio, subito prima di
 * restituirlo. `consumePlay` rifà il controllo e scrive la riga: due richieste ravvicinate dello
 * stesso brano (Range) contano una volta sola e, se il limite è stato raggiunto nel frattempo,
 * la decisione torna un rifiuto (da inoltrare con `playDeniedResponse`, senza audio).
 */
export async function recordStreamPlay(check: StreamPlayCheck): Promise<PlayDecision> {
  if (!willCountStreamPlay(check)) return check.decision;
  return consumePlay(check.user, check.qualifiedId);
}
