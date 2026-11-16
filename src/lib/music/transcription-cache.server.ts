// @polsia:user-owned — cache CIFRATA delle trascrizioni IA (Whisper) dei testi dei brani in evidenza:
// ogni bozza pagata a OpenAI si conserva cifrata nel database e si riusa, così la stessa versione
// dello stesso file audio non si trascrive (e non si paga) due volte, salvo «Rigenera con l'IA».
//
// Chiavi: HKDF-SHA256 da BETTER_AUTH_SECRET (letto da process.env), sale
// "solco-transcription-cache", due info distinte: "aes-256-gcm:v1" per la cifratura e
// "hmac-sha256:v1" per la chiave di ricerca (chiavi separate: l'una non rivela l'altra). Senza
// segreto la cache è spenta: tutto funziona come prima, mai un'eccezione.
// Chiave di ricerca (keyHash): HMAC-SHA256 esadecimale di ["v1", pathname, versione dell'audio
// (etag o dimensione + data di caricamento), lingua chiesta ("auto" o ISO), modello, versione della
// bozza], codificato in JSON (nessuna ambiguità tra i campi). Trova la voce senza rivelare il brano.
// Cifratura: AES-256-GCM, IV casuale di 12 byte a ogni scrittura, dati autenticati = keyHash più i
// metadati in chiaro della riga (versione delle chiavi, modello, lingua, durata, righe, segmenti
// scartati, data): un testo copiato in un'altra riga non si decifra, e righe, lingua o data
// cambiate nel database non arrivano mai all'admin accanto alla bozza. Una voce non decifrabile
// (segreto cambiato, manomissione) vale come assente e si cancella; nei log solo il nome dell'errore.
// Nessun testo, percorso o titolo in chiaro nel database né nei log.
// Scrittura condizionata alla data: una scrittura arrivata in ritardo (database lento) non
// sostituisce mai una voce più recente (es. una rigenerazione nel frattempo).
//
// Richieste identiche contemporanee: nello stesso processo la seconda aspetta la prima e poi
// riguarda la cache (beginTranscription/transcriptionInFlight), anche una rigenerazione (che accetta
// solo una voce scritta dopo la sua richiesta). Tra istanze diverse del server una chiamata doppia
// resta possibile, ma è rara (pagina riservata agli admin, limiti per admin).
import 'server-only';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  TRANSCRIPTION_CACHE_RETENTION_DAYS,
  TranscribeResponseSchema,
} from '@/lib/contracts/lyrics-transcription';
import { prisma } from '@/lib/db';

/** Versione della derivazione delle chiavi: una voce di un'altra versione non si usa. */
export const TRANSCRIPTION_CACHE_KEY_VERSION = 1;
const HKDF_SALT = 'solco-transcription-cache';
const AES_INFO = 'aes-256-gcm:v1';
const HMAC_INFO = 'hmac-sha256:v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Tempo massimo per leggere una voce: oltre, si trascrive come se non ci fosse. */
const READ_DEADLINE_MS = 3000;
/** Tempo massimo per scrivere o aggiornare una voce. */
const WRITE_DEADLINE_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Voci non usate da tanto si cancellano (pulizia giornaliera). */
export const TRANSCRIPTION_CACHE_MAX_IDLE_MS = TRANSCRIPTION_CACHE_RETENTION_DAYS * DAY_MS;
/** Voci cancellate al massimo per esecuzione della pulizia (le altre il giorno dopo). */
export const TRANSCRIPTION_CACHE_PURGE_BATCH = 5000;

const KEY_HASH = /^[0-9a-f]{64}$/;

export type TranscriptionCacheKeys = {
  /** Chiave AES-256-GCM della bozza. */
  aesKey: Buffer;
  /** Chiave HMAC-SHA256 della chiave di ricerca. */
  hmacKey: Buffer;
};

/** Le due chiavi (32 byte ciascuna) derivate dal segreto con HKDF-SHA256 e info distinte. */
export function deriveTranscriptionCacheKeys(secret: string): TranscriptionCacheKeys {
  const material = Buffer.from(secret, 'utf8');
  return {
    aesKey: Buffer.from(hkdfSync('sha256', material, HKDF_SALT, AES_INFO, KEY_BYTES)),
    hmacKey: Buffer.from(hkdfSync('sha256', material, HKDF_SALT, HMAC_INFO, KEY_BYTES)),
  };
}

let derived: { secret: string; keys: TranscriptionCacheKeys } | null = null;

/** Le chiavi del segreto attuale (ricalcolate se cambia), o null se manca: cache spenta. */
function cacheKeys(): TranscriptionCacheKeys | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') return null;
  if (derived?.secret !== secret) derived = { secret, keys: deriveTranscriptionCacheKeys(secret) };
  return derived.keys;
}

/** True se la cache cifrata è attiva (BETTER_AUTH_SECRET presente). */
export function isTranscriptionCacheEnabled(): boolean {
  return cacheKeys() !== null;
}

export type TranscriptionCacheKeyInput = {
  /** Pathname esatto del file audio (già validato dal controllo del permesso). */
  pathname: string;
  /** Versione del file audio: cambia se il file viene sostituito. */
  audioVersion: string;
  /** Lingua chiesta: "auto" o il codice ISO-639-1. */
  language: string;
  /** Modello di OpenAI (es. "whisper-1"). */
  model: string;
  /** Versione del costruttore della bozza LRC. */
  draftVersion: number;
};

/** keyHash della trascrizione (HMAC-SHA256 esadecimale), o null se la cache è spenta. */
export function transcriptionCacheKey(
  input: TranscriptionCacheKeyInput,
  keys: TranscriptionCacheKeys | null = cacheKeys(),
): string | null {
  if (!keys) return null;
  const material = JSON.stringify([
    'v1',
    input.pathname,
    input.audioVersion,
    input.language,
    input.model,
    input.draftVersion,
  ]);
  return createHmac('sha256', keys.hmacKey).update(material, 'utf8').digest('hex');
}

export type SealedTranscript = { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array };

/** I metadati in chiaro di una voce, autenticati insieme alla bozza (dati autenticati di GCM). */
export type CacheEntryMetadata = {
  keyVersion: number;
  model: string;
  language: string | null;
  durationSeconds: number | null;
  lineCount: number;
  droppedSegments: number;
  createdAt: Date;
};

/**
 * Dati autenticati della voce: keyHash e metadati in JSON canonico (ordine fisso). La bozza si
 * decifra solo nella SUA riga e solo se nessuno di questi campi è stato cambiato.
 */
export function cacheEntryAssociatedData(keyHash: string, meta: CacheEntryMetadata): string {
  return JSON.stringify([
    'v1',
    keyHash,
    meta.keyVersion,
    meta.model,
    meta.language,
    meta.durationSeconds,
    meta.lineCount,
    meta.droppedSegments,
    meta.createdAt.toISOString(),
  ]);
}

/**
 * Cifra la bozza con AES-256-GCM (IV casuale), legata ai dati autenticati `associatedData` (la
 * voce: cacheEntryAssociatedData).
 */
export function sealTranscript(
  plaintext: string,
  associatedData: string,
  aesKey: Uint8Array,
): SealedTranscript {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    authTag: new Uint8Array(cipher.getAuthTag()),
  };
}

export type OpenedTranscript = { ok: true; plaintext: string } | { ok: false; error: string };

/**
 * Decifra una bozza di sealTranscript. Chiave diversa, dati autenticati diversi (altra voce o
 * metadati cambiati), tag o testo manomessi, lunghezze sbagliate o UTF-8 non valido →
 * { ok: false } col solo nome dell'errore.
 */
export function openTranscript(
  sealed: SealedTranscript,
  associatedData: string,
  aesKey: Uint8Array,
): OpenedTranscript {
  if (sealed.iv.length !== IV_BYTES || sealed.authTag.length !== TAG_BYTES) {
    return { ok: false, error: 'InvalidSealedLength' };
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', aesKey, sealed.iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(sealed.authTag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    return { ok: true, plaintext: new TextDecoder('utf-8', { fatal: true }).decode(plaintext) };
  } catch (error) {
    return { ok: false, error: errorName(error) };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function logProblem(what: string, error: unknown) {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
  console.warn(
    `[transcription-cache] ${what}:`,
    typeof error === 'string' ? error : errorName(error),
  );
}

/** `work` entro `ms`; undefined se non finisce in tempo (il lavoro continua, l'esito si ignora). */
async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** I campi della risposta conservati: stesse regole del contratto (la bozza ≤ 64 KB…). */
const CachedFieldsSchema = TranscribeResponseSchema.pick({
  draft: true,
  lineCount: true,
  language: true,
  durationSeconds: true,
  droppedSegments: true,
  uncertainLines: true,
});

/**
 * Il testo cifrato di una voce: la bozza più le righe incerte, in una busta JSON con versione. Una
 * voce vecchia (solo la bozza) si legge comunque (nessuna riga incerta).
 */
const PLAINTEXT_VERSION = 2;
const PlaintextEnvelopeSchema = z.object({
  v: z.literal(PLAINTEXT_VERSION),
  draft: z.string(),
  uncertainLines: z.array(z.number().int().positive()).optional(),
});

function sealedPlaintext(entry: Pick<TranscriptionToCache, 'draft' | 'uncertainLines'>): string {
  return JSON.stringify({
    v: PLAINTEXT_VERSION,
    draft: entry.draft,
    uncertainLines: entry.uncertainLines ?? [],
  });
}

function openedFields(plaintext: string): { draft: string; uncertainLines: number[] } {
  if (plaintext.startsWith(`{"v":${PLAINTEXT_VERSION},`)) {
    try {
      const parsed = PlaintextEnvelopeSchema.safeParse(JSON.parse(plaintext));
      if (parsed.success) {
        return { draft: parsed.data.draft, uncertainLines: parsed.data.uncertainLines ?? [] };
      }
    } catch {
      // Non è una busta: è una bozza che inizia così.
    }
  }
  return { draft: plaintext, uncertainLines: [] };
}

export type CachedTranscription = {
  draft: string;
  lineCount: number;
  language: string | null;
  durationSeconds: number | null;
  droppedSegments: number;
  /** Righe della bozza incerte (1 = la prima). */
  uncertainLines: number[];
  /** Quando è stata fatta la trascrizione. */
  cachedAt: Date;
};

type CacheRow = {
  id: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
  model: string;
  language: string | null;
  durationSeconds: number | null;
  lineCount: number;
  droppedSegments: number;
  createdAt: Date;
};

/** Toglie una voce inutilizzabile: solo QUELLA scrittura (stesso IV), mai una riscritta nel frattempo. */
async function discardRow(row: CacheRow, reason: string) {
  logProblem('voce non utilizzabile, cancellata', reason);
  try {
    await withinDeadline(
      prisma.lyricsTranscriptionCache.deleteMany({
        where: { id: row.id, iv: new Uint8Array(row.iv) },
      }),
      WRITE_DEADLINE_MS,
    );
  } catch (error) {
    logProblem('cancellazione non riuscita', error);
  }
}

/**
 * La trascrizione conservata per `keyHash`, decifrata, o null (cache spenta, nessuna voce, database
 * lento o giù, voce non decifrabile o non valida: in questi ultimi casi la voce si cancella).
 * Aggiorna lastUsedAt. Non fa mai throw.
 */
export async function readCachedTranscription(
  keyHash: string,
): Promise<CachedTranscription | null> {
  const keys = cacheKeys();
  if (!keys || !KEY_HASH.test(keyHash)) return null;
  try {
    const row: CacheRow | null | undefined = await withinDeadline(
      prisma.lyricsTranscriptionCache.findUnique({ where: { keyHash } }),
      READ_DEADLINE_MS,
    );
    if (!row) return null;
    if (row.keyVersion !== TRANSCRIPTION_CACHE_KEY_VERSION) {
      await discardRow(row, 'KeyVersionMismatch');
      return null;
    }
    if (!(row.createdAt instanceof Date) || Number.isNaN(row.createdAt.getTime())) {
      await discardRow(row, 'InvalidDate');
      return null;
    }
    // I metadati mostrati accanto alla bozza (righe, lingua, durata, data…) sono nei dati
    // autenticati: se qualcuno li ha cambiati nel database, la bozza non si decifra.
    const opened = openTranscript(row, cacheEntryAssociatedData(keyHash, row), keys.aesKey);
    if (!opened.ok) {
      await discardRow(row, opened.error);
      return null;
    }
    const fields = CachedFieldsSchema.safeParse({
      ...openedFields(opened.plaintext),
      lineCount: row.lineCount,
      language: row.language,
      durationSeconds: row.durationSeconds,
      droppedSegments: row.droppedSegments,
    });
    if (!fields.success) {
      await discardRow(row, 'ZodError');
      return null;
    }
    // Ultimo uso (per la pulizia dopo 180 giorni): updateMany non fallisce se la voce non c'è più.
    await withinDeadline(
      prisma.lyricsTranscriptionCache
        .updateMany({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
        .catch((error: unknown) => logProblem('ultimo uso non aggiornato', error)),
      WRITE_DEADLINE_MS,
    );
    return { ...fields.data, cachedAt: row.createdAt };
  } catch (error) {
    logProblem('lettura non riuscita', error);
    return null;
  }
}

export type TranscriptionToCache = {
  draft: string;
  lineCount: number;
  language: string | null;
  durationSeconds: number | null;
  droppedSegments: number;
  /** Righe della bozza incerte (1 = la prima): conservate cifrate con la bozza. */
  uncertainLines: number[];
  model: string;
};

/** Vincolo di unicità violato (Prisma P2002): c'è già una voce con quel keyHash. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Conserva cifrata una trascrizione appena pagata (sostituisce la voce con lo stesso keyHash, ma
 * solo se è più vecchia: una scrittura in ritardo non copre mai una voce più recente). Restituisce
 * quando è stata salvata, o null se il salvataggio NON è confermato (cache spenta, database giù,
 * voce più recente già presente, o database lento: in quest'ultimo caso la scrittura potrebbe
 * arrivare comunque, e la pagina dice solo "non confermato"). Non fa mai throw: la bozza arriva
 * all'admin in ogni caso.
 */
export async function storeCachedTranscription(
  keyHash: string,
  entry: TranscriptionToCache,
): Promise<Date | null> {
  const keys = cacheKeys();
  if (!keys || !KEY_HASH.test(keyHash)) return null;
  try {
    const now = new Date();
    const meta: CacheEntryMetadata = {
      keyVersion: TRANSCRIPTION_CACHE_KEY_VERSION,
      model: entry.model,
      language: entry.language,
      durationSeconds: entry.durationSeconds,
      lineCount: entry.lineCount,
      droppedSegments: entry.droppedSegments,
      createdAt: now,
    };
    const sealed = sealTranscript(
      sealedPlaintext(entry),
      cacheEntryAssociatedData(keyHash, meta),
      keys.aesKey,
    );
    const fields = {
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      ...meta,
      lastUsedAt: now,
    };
    const stored = await withinDeadline(
      prisma.lyricsTranscriptionCache
        .upsert({
          // Si aggiorna solo una voce non più recente di questa; se ce n'è una più recente l'upsert
          // prova a crearla e fallisce sul vincolo di unicità (P2002): quella più recente resta.
          where: { keyHash, createdAt: { lte: now } },
          create: { keyHash, ...fields },
          update: fields,
          select: { id: true },
        })
        .then(
          () => 'stored' as const,
          (error: unknown) => {
            if (isUniqueViolation(error)) return 'superseded' as const;
            throw error;
          },
        ),
      WRITE_DEADLINE_MS,
    );
    if (stored === 'stored') return now;
    // Voce più recente già presente (resta quella), o database lento (la scrittura può ancora
    // arrivare): in entrambi i casi questa bozza non è confermata come conservata.
    logProblem('salvataggio non confermato', stored === 'superseded' ? 'Superseded' : 'Timeout');
    return null;
  } catch (error) {
    logProblem('salvataggio non riuscito', error);
    return null;
  }
}

/**
 * Pulizia giornaliera: cancella al massimo TRANSCRIPTION_CACHE_PURGE_BATCH voci non usate da 180
 * giorni, le più vecchie prima. La cancellazione ricontrolla la data (una voce riusata nel
 * frattempo resta); idempotente. Non fa mai throw: se fallisce si riprova il giorno dopo, senza
 * fermare le altre pulizie.
 */
export async function purgeStaleTranscriptions(now = new Date()): Promise<{ count: number }> {
  const cutoff = new Date(now.getTime() - TRANSCRIPTION_CACHE_MAX_IDLE_MS);
  try {
    const stale = await prisma.lyricsTranscriptionCache.findMany({
      where: { lastUsedAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { lastUsedAt: 'asc' },
      take: TRANSCRIPTION_CACHE_PURGE_BATCH,
    });
    if (stale.length === 0) return { count: 0 };
    const removed = await prisma.lyricsTranscriptionCache.deleteMany({
      where: { id: { in: stale.map((row) => row.id) }, lastUsedAt: { lt: cutoff } },
    });
    return { count: removed.count };
  } catch (error) {
    logProblem('pulizia non riuscita', error);
    return { count: 0 };
  }
}

// ─── Richieste identiche contemporanee (stesso processo) ────────────────────────────────────────

const inFlight = new Map<string, Promise<void>>();

/** La trascrizione già in corso per `keyHash` (si risolve quando finisce, mai rifiutata). */
export function transcriptionInFlight(keyHash: string): Promise<void> | undefined {
  return inFlight.get(keyHash);
}

/**
 * Segna `keyHash` come in corso; la funzione restituita la chiude (anche più volte senza danni).
 * Da chiamare subito dopo aver visto che nessuna è in corso, senza await in mezzo.
 */
export function beginTranscription(keyHash: string): () => void {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  inFlight.set(keyHash, done);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    if (inFlight.get(keyHash) === done) inFlight.delete(keyHash);
    finish();
  };
}

/** Solo per i test: dimentica chiavi derivate e trascrizioni in corso. */
export function clearTranscriptionCacheForTests() {
  derived = null;
  inFlight.clear();
}
