// @polsia:user-owned — minuti di ascolto per i premi, contati dal tempo del brano.
//
// Un setInterval da 60 s non basta: Chrome allinea e rallenta i timer delle pagine nascoste,
// iOS li sospende, e ogni cambio di brano o di stato faceva ripartire il timer perdendo il minuto
// parziale. Qui si sommano i secondi realmente avanzati dall'elemento <audio> (eventi timeupdate),
// si scartano i salti (seek, loop) e il resto passa da un brano all'altro.
//
// Il server (/api/rewards, action 'listen') accetta al massimo REWARDS.maxTickSeconds (60) per
// richiesta e ignora richieste a meno di REWARDS.minTickIntervalMs (50 s) l'una dall'altra.

export const LISTEN_TICK_SECONDS = 60;
/** Sopra i 50 s del server, con margine per la latenza di rete. */
export const LISTEN_MIN_INTERVAL_MS = 55_000;
/** Ascolto accumulato ma non ancora inviato (pagina rimasta sospesa a lungo): al massimo 10 minuti. */
export const LISTEN_MAX_BACKLOG_SECONDS = 600;
/** Avanzamento massimo credibile rispetto al tempo reale (velocità ×2 più un secondo e mezzo). */
const MAX_PLAYBACK_RATE = 2;
const JUMP_SLACK_SECONDS = 1.5;

export type ListeningClock = {
  lastPosition: number | null;
  lastWallMs: number | null;
  pendingSeconds: number;
  lastSentMs: number | null;
};

export function createListeningClock(): ListeningClock {
  return { lastPosition: null, lastWallMs: null, pendingSeconds: 0, lastSentMs: null };
}

/**
 * Registra la posizione corrente del brano; restituisce i secondi da inviare adesso (0 o 60).
 * Conta solo gli avanzamenti in avanti compatibili col tempo reale: un seek o il ritorno a zero
 * (loop, nuovo brano) spostano solo il punto di partenza.
 */
export function observeListening(
  clock: ListeningClock,
  sample: { position: number; nowMs: number },
): number {
  const { lastPosition, lastWallMs } = clock;
  if (!Number.isFinite(sample.position)) return 0;
  clock.lastPosition = sample.position;
  clock.lastWallMs = sample.nowMs;
  if (lastPosition !== null && lastWallMs !== null) {
    const mediaDelta = sample.position - lastPosition;
    const wallDelta = Math.max(0, (sample.nowMs - lastWallMs) / 1000);
    if (mediaDelta > 0 && mediaDelta <= wallDelta * MAX_PLAYBACK_RATE + JUMP_SLACK_SECONDS) {
      clock.pendingSeconds = Math.min(
        LISTEN_MAX_BACKLOG_SECONDS,
        clock.pendingSeconds + mediaDelta,
      );
    }
  }
  if (
    clock.pendingSeconds >= LISTEN_TICK_SECONDS &&
    (clock.lastSentMs === null || sample.nowMs - clock.lastSentMs >= LISTEN_MIN_INTERVAL_MS)
  ) {
    clock.pendingSeconds -= LISTEN_TICK_SECONDS;
    clock.lastSentMs = sample.nowMs;
    return LISTEN_TICK_SECONDS;
  }
  return 0;
}

/** Nuovo brano o pausa lunga: il prossimo campione fa solo da punto di partenza. */
export function restartListeningSample(clock: ListeningClock) {
  clock.lastPosition = null;
  clock.lastWallMs = null;
}

/** Invio fallito per rete: i secondi tornano nel conteggio (entro il limite). */
export function restoreListening(clock: ListeningClock, seconds: number) {
  clock.pendingSeconds = Math.min(LISTEN_MAX_BACKLOG_SECONDS, clock.pendingSeconds + seconds);
}
