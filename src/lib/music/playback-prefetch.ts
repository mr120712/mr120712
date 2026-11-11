// @polsia:user-owned — passaggio al brano successivo senza pause di rete (ascolto in background).
//
// iOS sospende una pagina bloccata o in background poco dopo che l'audio si ferma, e Chrome
// rallenta i timer delle pagine nascoste. Il passaggio al brano successivo quindi deve avvenire
// nello stesso evento 'ended', senza attese di rete: ~20 secondi prima della fine il player
// prepara il successivo (scelta congelata, anche in casuale; verifica dei diritti e del limite Free
// con richieste che NON consumano ascolti; copertina in cache). Per Audius e gli album Solco un
// secondo elemento <audio> ne carica anche i primi secondi e a fine brano parte subito (vedi
// audio-decks.ts); altrimenti si cambia src sullo stesso elemento e si chiama play().
//
// Mai consumare un ascolto in anticipo: niente POST /api/music/plays prima che il brano parta. Il
// precaricamento chiede allo /stream solo un Range da 0, servito come primo blocco che non conta.
import { countsTowardFreeQuota, REPLAY_WINDOW_MS } from '@/lib/business/play-quota';

/** Quanti secondi prima della fine si prepara il brano successivo. */
export const PREFETCH_LEAD_SECONDS = 20;

export function shouldPrefetchNext(input: {
  duration: number;
  currentTime: number;
  live: boolean;
}) {
  if (input.live || !Number.isFinite(input.duration) || input.duration <= 0) return false;
  return input.duration - input.currentTime <= PREFETCH_LEAD_SECONDS;
}

/** YouTube (e i brani importati, che diventano video YouTube) non suonano mai a pagina nascosta. */
export function playsWhileHidden(mode: string | null | undefined) {
  return mode !== 'youtube' && mode !== 'song';
}

/** Fonti che il server autorizza brano per brano (GET …/playback, senza consumare ascolti). */
export function needsRightsCheck(mode: string | null | undefined) {
  return mode === 'audius' || mode === 'solco';
}

/**
 * Indice del prossimo elemento della coda. A pagina nascosta salta i video YouTube verso il primo
 * elemento ascoltabile in background; se non ce n'è restituisce il successivo normale (il player
 * lo rimanda a quando Solco torna visibile).
 */
export function pickNextIndex(input: {
  modes: ReadonlyArray<string | null | undefined>;
  index: number;
  shuffle: boolean;
  wrap: boolean;
  hidden: boolean;
  random?: () => number;
}): number | null {
  const length = input.modes.length;
  if (length === 0 || input.index < 0 || input.index >= length) return null;
  const audible = (candidate: number) => playsWhileHidden(input.modes[candidate]);
  if (input.shuffle && length > 1) {
    const others = Array.from({ length }, (_, item) => item).filter((item) => item !== input.index);
    const hiddenPool = input.hidden ? others.filter(audible) : [];
    const pool = hiddenPool.length > 0 ? hiddenPool : others;
    const random = input.random ?? Math.random;
    const pick = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    return pool[Math.max(0, pick)] ?? null;
  }
  const order: number[] = [];
  for (let item = input.index + 1; item < length; item += 1) order.push(item);
  // Repeat-all wraps to the start, the current item included (a one-item queue replays itself).
  if (input.wrap) for (let item = 0; item <= input.index; item += 1) order.push(item);
  if (input.hidden) {
    const found = order.find(audible);
    if (found !== undefined) return found;
  }
  return order[0] ?? null;
}

export type AccessSnapshot = {
  signedIn: boolean;
  premium: boolean;
  playsUsed: number | null;
  playsLimit: number | null;
};

/** Vero se lo stesso brano è partito entro la finestra di riascolto (il server non lo riconta). */
export function isReplay(
  startedAt: ReadonlyMap<string, number>,
  qualifiedId: string,
  nowMs: number,
) {
  const started = startedAt.get(qualifiedId);
  // One minute of margin: the server window starts when its row is written, a bit later.
  return started !== undefined && nowMs - started < REPLAY_WINDOW_MS - 60_000;
}

/** Ricorda la partenza di un brano (solo il primo avvio della finestra: è quello che conta). */
export function rememberStart(startedAt: Map<string, number>, qualifiedId: string, nowMs: number) {
  if (isReplay(startedAt, qualifiedId, nowMs)) return;
  startedAt.set(qualifiedId, nowMs);
  if (startedAt.size > 500) {
    for (const [id, at] of startedAt) {
      if (nowMs - at >= REPLAY_WINDOW_MS) startedAt.delete(id);
    }
  }
}

export type PredictedBlock = 'login_required' | 'monthly_limit';

/** Il server rifiuterebbe questo avvio? (stesse regole di decidePlay, dai dati di /api/music/access). */
export function predictPlayBlock(
  access: AccessSnapshot | null,
  input: { qualifiedId: string; replay: boolean },
): PredictedBlock | null {
  if (!access) return null;
  if (!access.signedIn) return 'login_required';
  if (access.premium || input.replay || !countsTowardFreeQuota(input.qualifiedId)) return null;
  if (
    access.playsLimit !== null &&
    access.playsUsed !== null &&
    access.playsUsed >= access.playsLimit
  ) {
    return 'monthly_limit';
  }
  return null;
}

export type RightsVerdict = 'pending' | 'allowed' | 'denied';

/** Rifiuti temporanei o globali: non dicono nulla del brano, decide il percorso normale. */
const TRANSIENT_DENIALS = new Set([
  'rate_limited',
  'catalog_unavailable',
  'source_inactive',
  'entitlement_unavailable',
  'access_unknown',
  'state_unknown',
]);

/**
 * Esito della verifica anticipata dal motivo di rifiuto del server. Solo un rifiuto che riguarda
 * il brano stesso (non trasmissibile, diritti, abbonamento) lo fa saltare; errori di rete o
 * temporanei restano 'pending' e il brano segue il percorso normale con il messaggio esatto.
 */
export function rightsVerdictFromReason(reason: unknown): RightsVerdict {
  if (typeof reason !== 'string' || reason.length === 0 || TRANSIENT_DENIALS.has(reason)) {
    return 'pending';
  }
  return 'denied';
}

export type AdvanceDecision =
  /** Avvio sincrono nello stesso evento: deck di riserva già pronto o nuovo src sull'elemento attivo. */
  | { kind: 'switch' }
  /** Percorso normale con verifiche di rete (video YouTube, diritti non ancora verificati). */
  | { kind: 'async' }
  /** Il server rifiuterebbe l'avvio: mostra l'invito invece di una richiesta destinata al 402. */
  | { kind: 'blocked'; reason: PredictedBlock }
  /** Diritti negati dalla verifica anticipata: si salta al successivo. */
  | { kind: 'denied' };

export function decideAdvance(input: {
  mode: string | null | undefined;
  qualifiedId: string;
  rights: RightsVerdict | null;
  access: AccessSnapshot | null;
  replay: boolean;
}): AdvanceDecision {
  if (!playsWhileHidden(input.mode)) return { kind: 'async' };
  if (input.rights === 'denied') return { kind: 'denied' };
  if (needsRightsCheck(input.mode) && input.rights !== 'allowed') return { kind: 'async' };
  const blocked = predictPlayBlock(input.access, {
    qualifiedId: input.qualifiedId,
    replay: input.replay,
  });
  return blocked ? { kind: 'blocked', reason: blocked } : { kind: 'switch' };
}
