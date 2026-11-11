// @polsia:user-owned — due elementi <audio> (attivo + riserva) per passare al brano successivo
// senza silenzio.
//
// Con un solo elemento l'audio del brano successivo veniva richiesto solo all'evento 'ended':
// ~2 s di silenzio tra due brani, e su iOS una pagina bloccata che tace rischia la sospensione.
// Per i brani on-demand Audius e degli album Solco il player tiene due "deck": quello attivo
// suona, quello di riserva carica i primi secondi del successivo ~20 s prima della fine (lo stesso
// momento della preparazione in playback-prefetch.ts). A 'ended' la riserva parte con play() nello
// stesso evento e i ruoli si scambiano; se non è pronta o play() fallisce, il player torna al cambio
// di src sull'elemento che suonava (il percorso a un solo elemento, che non cambia).
//
// Ascolti Free: il precaricamento è una richiesta Range da 0, a cui lo stream risponde con al
// massimo i primi 384 KiB senza contare l'ascolto; il seguito (Range dal byte 393216 in poi) conta.
// Per questo la riserva carica sempre con preload='metadata', mai 'auto': con 'auto' un elemento
// fermo continua a bufferizzare e, finito il primo blocco, chiede da solo il seguito (Chromium lo
// fa subito, AVFoundation su iOS bufferizza in anticipo), consumando un ascolto per un brano che
// forse nessuno sentirà. Con 'metadata' il browser tiene solo poche decine di KB in anticipo e
// sospende la prima risposta molto prima della fine del blocco; il seguito parte solo con play().
//
// Podcast, radio, Jamendo e YouTube restano sul percorso a un solo elemento.
import type { AdvanceDecision } from '@/lib/music/playback-prefetch';

/**
 * Interruttore unico del doppio elemento. false: un solo <audio>, nessun precaricamento, cambio di
 * src a fine brano come prima (per spegnerlo in fretta se un dispositivo si comporta male).
 */
export const GAPLESS_DECKS_ENABLED = true;

/**
 * HTMLMediaElement.readyState: metadati e primi byte già scaricati. Con preload='metadata' un
 * browser può fermarsi qui; play() riparte dai byte in cache, molto prima di un nuovo src.
 */
export const HAVE_METADATA = 1;

/** Brani che la riserva può precaricare: on-demand Audius e album Solco, mai stream aperti o video. */
export function preloadsOnSpare(mode: string | null | undefined) {
  return mode === 'audius' || mode === 'solco';
}

/** Il brano che la riserva sta caricando: posizione nella coda, brano e percorso dello stream. */
export type SpareLoad = { index: number; qualifiedId: string; src: string };

export function sameSpareLoad(held: SpareLoad | null, wanted: SpareLoad) {
  return (
    held !== null &&
    held.index === wanted.index &&
    held.qualifiedId === wanted.qualifiedId &&
    held.src === wanted.src
  );
}

/**
 * Precaricare il successivo sulla riserva? Solo Audius/Solco, solo quando a fine brano partirebbe
 * da solo (diritti già verificati, nessun limite Free previsto: `decideAdvance` dice 'switch') e
 * non con "ripeti brano" (l'elemento va in loop e non passa al successivo).
 */
export function wantsSparePreload(input: {
  enabled: boolean;
  mode: string | null | undefined;
  repeatOne: boolean;
  decision: AdvanceDecision;
}) {
  return (
    input.enabled &&
    !input.repeatOne &&
    preloadsOnSpare(input.mode) &&
    input.decision.kind === 'switch'
  );
}

/** La parte di HTMLMediaElement usata dai deck (in prova bastano oggetti finti). */
export type DeckElement = Pick<
  HTMLMediaElement,
  'getAttribute' | 'removeAttribute' | 'load' | 'pause' | 'readyState' | 'error' | 'preload' | 'src'
>;

/**
 * La riserva contiene esattamente questo brano e ne ha già metadati e primi byte: play() nello
 * stesso evento, senza la richiesta iniziale allo stream. Altrimenti il chiamante usa il percorso
 * a un solo elemento.
 */
export function spareReadyFor(
  deck: DeckElement | null,
  held: SpareLoad | null,
  wanted: SpareLoad,
): boolean {
  if (!deck || !sameSpareLoad(held, wanted)) return false;
  if (deck.getAttribute('src') !== wanted.src || deck.error) return false;
  return deck.readyState >= HAVE_METADATA;
}

/**
 * Inizia a scaricare i primi byte del brano sulla riserva ferma (non la fa mai suonare). Mai
 * preload='auto': vedi l'intestazione sul limite Free.
 */
export function preloadDeck(deck: DeckElement, src: string) {
  deck.preload = 'metadata';
  deck.src = src;
  deck.load();
}

/** Deck liberato: muto, senza sorgente, nessun download in corso. */
export function releaseDeck(deck: DeckElement | null) {
  if (!deck) return;
  deck.pause();
  deck.removeAttribute('src');
  deck.preload = 'none';
  deck.load();
}

/**
 * I due elementi <audio> del player e il ruolo di ciascuno. `current` è sempre quello attivo:
 * tutti i percorsi a un solo elemento (pausa, seek, Media Session, errori, minuti di ascolto) lo
 * usano e seguono quindi gli scambi. `spareDeck` è l'altro (null con l'interruttore spento).
 */
export class AudioDecks<T extends DeckElement = HTMLAudioElement> {
  private readonly slots: [T | null, T | null] = [null, null];
  private activeSlot: 0 | 1 = 0;
  /** Il brano che la riserva sta precaricando (null: riserva ferma). */
  spare: SpareLoad | null = null;

  /** Ref dei due elementi (stabili: non cambiano a ogni render). */
  readonly bindFirst = (element: T | null) => {
    this.slots[0] = element;
  };
  readonly bindSecond = (element: T | null) => {
    this.slots[1] = element;
  };

  get current(): T | null {
    return this.slots[this.activeSlot];
  }

  get spareDeck(): T | null {
    return this.slots[this.activeSlot === 0 ? 1 : 0];
  }

  isActive(element: unknown): boolean {
    return element !== null && element === this.current;
  }

  /** La riserva diventa attiva e viceversa; false (nessuno scambio) se la riserva non esiste. */
  swap(): boolean {
    if (!this.spareDeck) return false;
    this.activeSlot = this.activeSlot === 0 ? 1 : 0;
    return true;
  }
}
