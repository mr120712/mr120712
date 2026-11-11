// @polsia:user-owned — primo blocco gratuito dello stream Audius proxato (precaricamento del
// brano successivo senza pause tra un brano e l'altro).
//
// Una richiesta Range che inizia dentro il primo blocco ("bytes=0-", la sonda Safari "bytes=0-1",
// il precaricamento del brano successivo, ma anche la ripresa "bytes=180000-" di un precaricamento
// interrotto da una connessione instabile) riceve al massimo i byte fino a FIRST_CHUNK_BYTES - 1 e
// NON registra l'ascolto: precaricare non consuma mai uno dei 40 ascolti Free. Tutto ciò che va
// oltre (continuazione dopo il primo blocco, seek oltre il blocco, suffisso, più intervalli,
// richiesta senza Range) passa dal percorso di sempre e registra l'ascolto quando l'audio arriva
// davvero. La parte gratuita resta quindi limitata ai primi ~20 s del brano, qualunque intervallo
// chieda il client: ogni byte da FIRST_CHUNK_BYTES in poi richiede una richiesta contata. Un file
// che sta tutto nel primo blocco viene invece contato subito: altrimenti sarebbe gratis per intero.

/** 384 KiB: circa 20 secondi a 160 kbps, il formato degli stream Audius. */
export const FIRST_CHUNK_BYTES = 393_216;

export type StreamRangeRequest =
  /** Nessun header Range (curl, download): corpo intero, ascolto contato. */
  | { kind: 'none' }
  /**
   * Un solo intervallo che inizia dentro il primo blocco (`start` < FIRST_CHUNK_BYTES).
   * `end` null = aperto o oltre ogni file possibile.
   */
  | { kind: 'first_chunk'; start: number; end: number | null }
  /**
   * Inizio >= FIRST_CHUNK_BYTES, suffisso, più intervalli o header non riconosciuto: inoltrato e
   * contato.
   */
  | { kind: 'forward'; header: string };

/**
 * Classifica l'header Range. Solo un intervallo singolo `bytes=S-[fine]` con S nel primo blocco è
 * gratuito; ogni altra forma resta sul percorso contato di sempre, così un header ambiguo non può
 * mai ottenere byte gratis (verso Audius parte comunque un intervallo riscritto dal server).
 */
export function parseStreamRange(header: string | null): StreamRangeRequest {
  if (header === null) return { kind: 'none' };
  const match = /^\s*bytes\s*=\s*(\d+)\s*-\s*(\d*)\s*$/i.exec(header);
  // A start too large for a safe integer is far past the chunk too: counted path.
  const start = match ? Number(match[1]) : Number.NaN;
  if (!match || !(start < FIRST_CHUNK_BYTES)) return { kind: 'forward', header };
  const endText = match[2] ?? '';
  if (!endText) return { kind: 'first_chunk', start, end: null };
  const end = Number(endText);
  // A run of digits too large for a safe integer is beyond any real file: same as open-ended.
  if (!Number.isSafeInteger(end)) return { kind: 'first_chunk', start, end: null };
  // Last byte before the first one: an invalid range (RFC 9110), left on the counted path as before.
  if (end < start) return { kind: 'forward', header };
  return { kind: 'first_chunk', start, end };
}

/** Ultimo byte (incluso) da chiedere ad Audius per una richiesta nel primo blocco: mai oltre. */
export function firstChunkUpstreamEnd(requestedEnd: number | null) {
  return requestedEnd === null
    ? FIRST_CHUNK_BYTES - 1
    : Math.min(requestedEnd, FIRST_CHUNK_BYTES - 1);
}

export type FirstChunkPlan = {
  /** Ultimo byte (incluso) inoltrato al client: Content-Range `bytes start-end/total`. */
  end: number;
  /** Dimensione dell'intero file. */
  total: number;
  /**
   * Byte del corpo di Audius da scartare prima di inoltrare: `start` quando Audius ha ignorato
   * Range e manda il file dal byte 0, altrimenti 0. Sempre < FIRST_CHUNK_BYTES.
   */
  skip: number;
  /** Il file sta tutto nel primo blocco: l'ascolto va registrato come per un download completo. */
  wholeFile: boolean;
};

/**
 * Cosa inoltrare della risposta di Audius a `bytes=start-askedEnd`. Null (= 502, nessun ascolto)
 * quando non si può sapere con certezza la dimensione del file o la risposta non parte da
 * `start`: senza il totale non si può né scrivere un Content-Range corretto né sapere se il
 * blocco è l'intero brano (che andrebbe contato).
 * - 206 `bytes start-Y/TOTALE`: si inoltra fino a min(askedEnd, Y), anche se Audius ha mandato di
 *   più.
 * - 200 senza Content-Range (il server ha ignorato Range): il corpo è il file intero dal byte 0,
 *   TOTALE = Content-Length; si scartano i primi `start` byte e si inoltra fino a
 *   min(askedEnd, TOTALE - 1). Un inizio oltre la fine del file: null.
 * - Totale sconosciuto (`/*`, 200 senza Content-Length valido) o qualsiasi altra forma: null.
 */
export function planFirstChunk(input: {
  start: number;
  askedEnd: number;
  status: number;
  contentRange: string | null;
  contentLength: string | null;
}): FirstChunkPlan | null {
  const { start, askedEnd } = input;
  if (!Number.isSafeInteger(start) || start < 0 || askedEnd < start) return null;
  let available: number;
  let total: number;
  let skip: number;
  if (input.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(input.contentRange?.trim() ?? '');
    if (!match || Number(match[1]) !== start) return null;
    available = Number(match[2]);
    total = Number(match[3]);
    if (
      !Number.isSafeInteger(available) ||
      !Number.isSafeInteger(total) ||
      available < start ||
      available >= total
    ) {
      return null;
    }
    skip = 0;
  } else if (input.status === 200 && input.contentRange === null) {
    const length = input.contentLength?.trim() ?? '';
    if (!/^\d+$/.test(length)) return null;
    total = Number(length);
    if (!Number.isSafeInteger(total) || total <= start) return null;
    available = total - 1;
    skip = start;
  } else {
    return null;
  }
  const end = Math.min(askedEnd, available);
  return { end, total, skip, wholeFile: total <= FIRST_CHUNK_BYTES };
}

/**
 * Scarta i primi `skipBytes` byte di `body`, poi inoltra al massimo `maxBytes` byte e chiude la
 * risposta e la connessione verso la fonte: il limite vale anche se la fonte manda più di quanto
 * chiesto.
 */
export function limitBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  skipBytes = 0,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let skipped = 0;
  let sent = 0;
  const stopUpstream = () => reader.cancel().catch(() => undefined);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Loops only while whole upstream pieces fall inside the skipped prefix.
      for (;;) {
        if (sent >= maxBytes) {
          controller.close();
          await stopUpstream();
          return;
        }
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          controller.error(error);
          return;
        }
        if (result.done) {
          controller.close();
          return;
        }
        let piece = result.value;
        if (skipped < skipBytes) {
          const drop = Math.min(skipBytes - skipped, piece.byteLength);
          skipped += drop;
          piece = piece.subarray(drop);
          if (piece.byteLength === 0) continue;
        }
        const remaining = maxBytes - sent;
        const chunk = piece.byteLength > remaining ? piece.slice(0, remaining) : piece;
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent >= maxBytes) {
          controller.close();
          await stopUpstream();
        }
        return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
