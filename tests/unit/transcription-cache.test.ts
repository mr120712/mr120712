// @polsia:user-owned — cache CIFRATA delle trascrizioni IA: chiavi derivate con HKDF (AES e HMAC
// separate), chiave di ricerca HMAC che cambia con ogni campo, AES-256-GCM con IV casuale e dati
// autenticati = keyHash + metadati (un testo spostato in un'altra riga o righe/lingua/data cambiate
// non si decifrano), tag o testo manomessi → voce assente e cancellata, segreto mancante → cache
// spenta senza errori, nessun testo né percorso nei dati scritti o nei log, scrittura lenta = "non
// confermata", scrittura in ritardo che non copre una voce più recente, pulizia a lotti delle voci
// ferme da 180 giorni.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    lyricsTranscriptionCache: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
      findMany: mocks.findMany,
    },
  },
}));

import {
  beginTranscription,
  type CacheEntryMetadata,
  cacheEntryAssociatedData,
  clearTranscriptionCacheForTests,
  deriveTranscriptionCacheKeys,
  isTranscriptionCacheEnabled,
  openTranscript,
  purgeStaleTranscriptions,
  readCachedTranscription,
  sealTranscript,
  storeCachedTranscription,
  TRANSCRIPTION_CACHE_KEY_VERSION,
  TRANSCRIPTION_CACHE_PURGE_BATCH,
  type TranscriptionCacheKeyInput,
  transcriptionCacheKey,
  transcriptionInFlight,
} from '@/lib/music/transcription-cache.server';

const SECRET = 'segreto-di-prova-0123456789abcdef-0123456789';
const OTHER_SECRET = 'un-altro-segreto-0123456789abcdef-987654321';
const DAY = 24 * 60 * 60 * 1000;
const PATHNAME = 'Cantautori/Autrice - Canzone.mp3';
const LYRICS = '[00:12.30] Prima strofa segreta\n[00:20.00] Ritornello';

const KEY_INPUT: TranscriptionCacheKeyInput = {
  pathname: PATHNAME,
  audioVersion: 'etag:"abc"',
  language: 'auto',
  model: 'whisper-1',
  draftVersion: 1,
};

type Row = {
  id: string;
  keyHash: string;
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
  lastUsedAt: Date;
};

let rows: Row[] = [];
let warns: MockInstance<typeof console.warn>;

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** Database finto con le stesse regole di Postgres per i filtri usati dal modulo. */
function installFakeDb() {
  let next = 0;
  mocks.findUnique.mockImplementation(async ({ where }: { where: { keyHash: string } }) => {
    const row = rows.find((candidate) => candidate.keyHash === where.keyHash);
    return row ? { ...row } : null;
  });
  mocks.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { keyHash: string; createdAt?: { lte: Date } };
      create: Omit<Row, 'id'>;
      update: Partial<Row>;
    }) => {
      const index = rows.findIndex((row) => row.keyHash === where.keyHash);
      if (index >= 0) {
        const current = rows[index] as Row;
        // Come Prisma: la riga c'è ma non passa il filtro → prova a crearla → P2002.
        if (where.createdAt && !(current.createdAt <= where.createdAt.lte)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        rows[index] = { ...current, ...update };
        return { id: current.id };
      }
      next += 1;
      const row = { id: `row-${next}`, ...create } as Row;
      rows.push(row);
      return { id: row.id };
    },
  );
  mocks.updateMany.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      let count = 0;
      rows = rows.map((row) => {
        if (row.id !== where.id) return row;
        count += 1;
        return { ...row, ...data };
      });
      return { count };
    },
  );
  mocks.deleteMany.mockImplementation(
    async ({
      where,
    }: {
      where: { id?: string | { in: string[] }; iv?: Uint8Array; lastUsedAt?: { lt: Date } };
    }) => {
      const before = rows.length;
      rows = rows.filter((row) => {
        const idMatch =
          where.id === undefined ||
          (typeof where.id === 'string' ? row.id === where.id : where.id.in.includes(row.id));
        const ivMatch = where.iv === undefined || sameBytes(row.iv, where.iv);
        const ageMatch = where.lastUsedAt === undefined || row.lastUsedAt < where.lastUsedAt.lt;
        return !(idMatch && ivMatch && ageMatch);
      });
      return { count: before - rows.length };
    },
  );
  mocks.findMany.mockImplementation(
    async ({ where, take }: { where: { lastUsedAt: { lt: Date } }; take: number }) =>
      rows
        .filter((row) => row.lastUsedAt < where.lastUsedAt.lt)
        .sort((a, b) => a.lastUsedAt.getTime() - b.lastUsedAt.getTime())
        .slice(0, take)
        .map((row) => ({ id: row.id })),
  );
}

const ENTRY = {
  draft: LYRICS,
  lineCount: 2,
  language: 'italian',
  durationSeconds: 184.4,
  droppedSegments: 1,
  uncertainLines: [2],
  model: 'whisper-1',
};

function keyHash(input: Partial<TranscriptionCacheKeyInput> = {}) {
  const hash = transcriptionCacheKey({ ...KEY_INPUT, ...input });
  if (!hash) throw new Error('Cache spenta.');
  return hash;
}

/** Tutti i testi di un payload, con i byte letti come testo in più codifiche. */
function textsOf(value: unknown): string[] {
  if (value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    return [buffer.toString('utf8'), buffer.toString('latin1'), buffer.toString('utf16le')];
  }
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...textsOf(inner)]);
  }
  return [];
}

beforeEach(() => {
  vi.resetAllMocks();
  clearTranscriptionCacheForTests();
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  rows = [];
  installFakeDb();
  warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('chiavi', () => {
  it('HKDF: chiave AES e chiave HMAC di 32 byte, diverse tra loro, stabili per segreto', () => {
    const keys = deriveTranscriptionCacheKeys(SECRET);
    expect(keys.aesKey).toHaveLength(32);
    expect(keys.hmacKey).toHaveLength(32);
    expect(keys.aesKey.equals(keys.hmacKey)).toBe(false);
    // Nessuna delle due è il segreto (o un suo prefisso).
    expect(keys.aesKey.toString('utf8')).not.toContain(SECRET.slice(0, 16));
    const again = deriveTranscriptionCacheKeys(SECRET);
    expect(again.aesKey.equals(keys.aesKey)).toBe(true);
    expect(again.hmacKey.equals(keys.hmacKey)).toBe(true);
    const other = deriveTranscriptionCacheKeys(OTHER_SECRET);
    expect(other.aesKey.equals(keys.aesKey)).toBe(false);
    expect(other.hmacKey.equals(keys.hmacKey)).toBe(false);
  });

  it('keyHash: HMAC esadecimale, non rivela il percorso, cambia con ogni campo', () => {
    const base = keyHash();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(base).not.toContain('Autrice');
    expect(keyHash()).toBe(base);
    const variants = [
      keyHash({ pathname: 'Cantautori/Autrice - Ballata.mp3' }),
      keyHash({ audioVersion: 'etag:"def"' }),
      keyHash({ language: 'it' }),
      keyHash({ model: 'whisper-2' }),
      keyHash({ draftVersion: 2 }),
    ];
    expect(new Set([base, ...variants]).size).toBe(6);
    // Campi codificati senza ambiguità: un separatore nel percorso non crea collisioni.
    expect(keyHash({ pathname: 'a|b', audioVersion: 'c' })).not.toBe(
      keyHash({ pathname: 'a', audioVersion: 'b|c' }),
    );
    // Con un altro segreto la stessa trascrizione ha un'altra chiave.
    vi.stubEnv('BETTER_AUTH_SECRET', OTHER_SECRET);
    expect(keyHash()).not.toBe(base);
  });

  it('segreto mancante o vuoto → cache spenta, nessuna eccezione', () => {
    for (const value of ['', '   ']) {
      vi.stubEnv('BETTER_AUTH_SECRET', value);
      expect(isTranscriptionCacheEnabled()).toBe(false);
      expect(transcriptionCacheKey(KEY_INPUT)).toBeNull();
    }
    vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
    expect(isTranscriptionCacheEnabled()).toBe(true);
  });
});

describe('cifratura AES-256-GCM', () => {
  const { aesKey } = deriveTranscriptionCacheKeys(SECRET);
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);

  it('andata e ritorno; IV casuale di 12 byte e tag di 16 a ogni scrittura', () => {
    const first = sealTranscript(LYRICS, hashA, aesKey);
    const second = sealTranscript(LYRICS, hashA, aesKey);
    expect(first.iv).toHaveLength(12);
    expect(first.authTag).toHaveLength(16);
    expect(sameBytes(first.iv, second.iv)).toBe(false);
    expect(sameBytes(first.ciphertext, second.ciphertext)).toBe(false);
    expect(Buffer.from(first.ciphertext).toString('utf8')).not.toContain('Prima strofa');
    expect(openTranscript(first, hashA, aesKey)).toEqual({ ok: true, plaintext: LYRICS });
    expect(openTranscript(second, hashA, aesKey)).toEqual({ ok: true, plaintext: LYRICS });
    // Anche una bozza vuota (nessuna parola riconosciuta).
    expect(openTranscript(sealTranscript('', hashA, aesKey), hashA, aesKey)).toEqual({
      ok: true,
      plaintext: '',
    });
  });

  it('dati autenticati = keyHash: un testo spostato in un’altra voce non si decifra', () => {
    const rowA = sealTranscript(LYRICS, hashA, aesKey);
    const rowB = sealTranscript('[00:01.00] Altro brano', hashB, aesKey);
    expect(openTranscript(rowA, hashB, aesKey).ok).toBe(false);
    // Ciphertext di B (con IV e tag di B) messo nella riga di A.
    expect(openTranscript(rowB, hashA, aesKey).ok).toBe(false);
    // Ciphertext scambiati, IV e tag lasciati al loro posto.
    expect(openTranscript({ ...rowA, ciphertext: rowB.ciphertext }, hashA, aesKey).ok).toBe(false);
  });

  it('dati autenticati della voce: keyHash e OGNI metadato in chiaro (righe, lingua, data…)', () => {
    const meta: CacheEntryMetadata = {
      keyVersion: 1,
      model: 'whisper-1',
      language: 'italian',
      durationSeconds: 184.4,
      lineCount: 2,
      droppedSegments: 1,
      createdAt: new Date('2026-11-14T10:00:00.000Z'),
    };
    const sealed = sealTranscript(LYRICS, cacheEntryAssociatedData(hashA, meta), aesKey);
    expect(openTranscript(sealed, cacheEntryAssociatedData(hashA, { ...meta }), aesKey)).toEqual({
      ok: true,
      plaintext: LYRICS,
    });
    const changed: Array<Partial<CacheEntryMetadata>> = [
      { keyVersion: 2 },
      { model: 'whisper-2' },
      { language: 'english' },
      { language: null },
      { durationSeconds: 1 },
      { durationSeconds: null },
      { lineCount: 999 },
      { droppedSegments: 42 },
      { createdAt: new Date('2026-11-14T10:00:00.001Z') },
    ];
    for (const patch of changed) {
      const aad = cacheEntryAssociatedData(hashA, { ...meta, ...patch });
      expect(openTranscript(sealed, aad, aesKey).ok).toBe(false);
    }
    expect(openTranscript(sealed, cacheEntryAssociatedData(hashB, meta), aesKey).ok).toBe(false);
  });

  it('tag, testo o IV manomessi, chiave sbagliata o lunghezze errate → errore col solo nome', () => {
    const sealed = sealTranscript(LYRICS, hashA, aesKey);
    const flip = (bytes: Uint8Array, index = 0) => {
      const copy = new Uint8Array(bytes);
      copy[index] = (copy[index] ?? 0) ^ 0x01;
      return copy;
    };
    const cases = [
      { ...sealed, authTag: flip(sealed.authTag) },
      { ...sealed, ciphertext: flip(sealed.ciphertext, 3) },
      { ...sealed, iv: flip(sealed.iv) },
    ];
    for (const tampered of cases) {
      const opened = openTranscript(tampered, hashA, aesKey);
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error).toMatch(/^[A-Za-z]+$/);
    }
    const otherKey = deriveTranscriptionCacheKeys(OTHER_SECRET).aesKey;
    expect(openTranscript(sealed, hashA, otherKey).ok).toBe(false);
    expect(openTranscript({ ...sealed, iv: sealed.iv.slice(0, 8) }, hashA, aesKey)).toEqual({
      ok: false,
      error: 'InvalidSealedLength',
    });
    expect(
      openTranscript({ ...sealed, authTag: sealed.authTag.slice(0, 4) }, hashA, aesKey).ok,
    ).toBe(false);
  });
});

describe('scrittura e lettura nel database', () => {
  it('scrive solo dati cifrati: nessun testo né percorso nel payload; lettura → bozza in chiaro', async () => {
    const hash = keyHash();
    const before = Date.now();
    const storedAt = await storeCachedTranscription(hash, ENTRY);
    expect(storedAt).toBeInstanceOf(Date);
    expect(storedAt?.getTime()).toBeGreaterThanOrEqual(before);

    expect(mocks.upsert).toHaveBeenCalledOnce();
    const payload = mocks.upsert.mock.calls[0]?.[0] as {
      where: { keyHash: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    // Scrittura condizionata: aggiorna solo una voce non più recente di questa.
    expect(payload.where).toEqual({ keyHash: hash, createdAt: { lte: storedAt } });
    expect(payload.create).toMatchObject({
      keyHash: hash,
      keyVersion: TRANSCRIPTION_CACHE_KEY_VERSION,
      model: 'whisper-1',
      language: 'italian',
      durationSeconds: 184.4,
      lineCount: 2,
      droppedSegments: 1,
    });
    const texts = textsOf(payload).join('\n');
    for (const secret of ['Prima strofa', 'Ritornello', PATHNAME, 'Autrice', 'Canzone']) {
      expect(texts).not.toContain(secret);
    }

    const hit = await readCachedTranscription(hash);
    expect(hit).toEqual({
      draft: LYRICS,
      lineCount: 2,
      language: 'italian',
      durationSeconds: 184.4,
      droppedSegments: 1,
      uncertainLines: [2],
      cachedAt: storedAt,
    });
    // L'ultimo uso si aggiorna (per la pulizia dei 180 giorni).
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('una nuova scrittura sostituisce la voce: nuovo IV, nuovo testo', async () => {
    const hash = keyHash();
    await storeCachedTranscription(hash, ENTRY);
    const firstIv = rows[0]?.iv as Uint8Array;
    await storeCachedTranscription(hash, {
      ...ENTRY,
      draft: '[00:05.00] Rigenerata',
      lineCount: 1,
    });
    expect(rows).toHaveLength(1);
    expect(sameBytes(rows[0]?.iv as Uint8Array, firstIv)).toBe(false);
    expect((await readCachedTranscription(hash))?.draft).toBe('[00:05.00] Rigenerata');
  });

  it('nessuna voce → null; keyHash non valido → null senza interrogare il database', async () => {
    expect(await readCachedTranscription(keyHash())).toBeNull();
    expect(await readCachedTranscription('../x')).toBeNull();
    expect(await storeCachedTranscription('NON-HEX', ENTRY)).toBeNull();
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('tag manomesso → voce assente e cancellata (solo quella scrittura); log col solo nome', async () => {
    const hash = keyHash();
    await storeCachedTranscription(hash, ENTRY);
    const row = rows[0] as Row;
    const tag = new Uint8Array(row.authTag);
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    row.authTag = tag;
    expect(await readCachedTranscription(hash)).toBeNull();
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: row.id, iv: row.iv } });
    expect(rows).toHaveLength(0);
    const logged = JSON.stringify(warns.mock.calls);
    expect(logged).toContain('[transcription-cache]');
    expect(logged).not.toContain('Prima strofa');
    expect(logged).not.toContain(PATHNAME);
    expect(logged).not.toContain(hash);
  });

  it('testo di un’altra voce copiato nella riga → assente e cancellata', async () => {
    const hashA = keyHash();
    const hashB = keyHash({ pathname: 'Cantautori/Autrice - Ballata.mp3' });
    await storeCachedTranscription(hashA, ENTRY);
    await storeCachedTranscription(hashB, { ...ENTRY, draft: '[00:01.00] Ballata' });
    const [rowA, rowB] = rows as [Row, Row];
    rowA.ciphertext = rowB.ciphertext;
    rowA.iv = rowB.iv;
    rowA.authTag = rowB.authTag;
    expect(await readCachedTranscription(hashA)).toBeNull();
    expect(rows.map((row) => row.keyHash)).toEqual([hashB]);
    expect((await readCachedTranscription(hashB))?.draft).toBe('[00:01.00] Ballata');
  });

  it('segreto cambiato → la voce cifrata col vecchio non si decifra: assente e cancellata', async () => {
    const hash = keyHash();
    await storeCachedTranscription(hash, ENTRY);
    vi.stubEnv('BETTER_AUTH_SECRET', OTHER_SECRET);
    expect(await readCachedTranscription(hash)).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('versione delle chiavi diversa o campi non validi → assente e cancellata', async () => {
    const hash = keyHash();
    await storeCachedTranscription(hash, ENTRY);
    (rows[0] as Row).keyVersion = TRANSCRIPTION_CACHE_KEY_VERSION + 1;
    expect(await readCachedTranscription(hash)).toBeNull();
    expect(rows).toHaveLength(0);

    await storeCachedTranscription(hash, ENTRY);
    (rows[0] as Row).lineCount = -3;
    expect(await readCachedTranscription(hash)).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('metadati cambiati nel database (righe, lingua, durata, segmenti, data, modello) → mai serviti: assente e cancellata', async () => {
    const hash = keyHash();
    const patches: Array<Partial<Row>> = [
      { lineCount: 999 },
      { language: 'english' },
      { durationSeconds: 1 },
      { droppedSegments: 42 },
      { createdAt: new Date('2020-01-01T00:00:00Z') },
      { model: 'whisper-2' },
    ];
    for (const patch of patches) {
      await storeCachedTranscription(hash, ENTRY);
      Object.assign(rows[0] as Row, patch);
      expect(await readCachedTranscription(hash)).toBeNull();
      expect(rows).toHaveLength(0);
    }
    // Metadati di un'altra voce copiati insieme al suo testo cifrato: nemmeno.
    const hashB = keyHash({ pathname: 'Cantautori/Autrice - Ballata.mp3' });
    await storeCachedTranscription(hash, ENTRY);
    await storeCachedTranscription(hashB, { ...ENTRY, draft: '[00:01.00] Ballata', lineCount: 1 });
    const [rowA, rowB] = rows as [Row, Row];
    Object.assign(rowA, { ...rowB, id: rowA.id, keyHash: rowA.keyHash });
    expect(await readCachedTranscription(hash)).toBeNull();
    expect(rows.map((row) => row.keyHash)).toEqual([hashB]);
  });

  it('scrittura lenta (oltre 5 s): null = "non confermata", anche se poi arriva', async () => {
    vi.useFakeTimers();
    try {
      const original = mocks.upsert.getMockImplementation();
      let landed = false;
      mocks.upsert.mockImplementationOnce(
        (args: never) =>
          new Promise((resolve) => {
            setTimeout(() => {
              landed = true;
              resolve(original?.(args));
            }, 6000);
          }),
      );
      const stored = storeCachedTranscription(keyHash(), ENTRY);
      await vi.advanceTimersByTimeAsync(5100);
      expect(await stored).toBeNull();
      expect(JSON.stringify(warns.mock.calls)).toContain('Timeout');
      await vi.advanceTimersByTimeAsync(1000);
      expect(landed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('una scrittura in ritardo non sostituisce una voce più recente (es. una rigenerazione)', async () => {
    const hash = keyHash();
    await storeCachedTranscription(hash, { ...ENTRY, draft: '[00:09.00] Rigenerata' });
    // La voce più recente è stata scritta "dopo" (data nel futuro rispetto a questa scrittura).
    const newer = rows[0] as Row;
    const later = new Date(Date.now() + 60_000);
    newer.createdAt = later;
    const sealed = sealTranscript(
      '[00:09.00] Rigenerata',
      cacheEntryAssociatedData(hash, { ...newer, createdAt: later }),
      deriveTranscriptionCacheKeys(SECRET).aesKey,
    );
    Object.assign(newer, sealed);

    expect(await storeCachedTranscription(hash, ENTRY)).toBeNull();
    expect(JSON.stringify(warns.mock.calls)).toContain('Superseded');
    expect(rows).toHaveLength(1);
    expect(await readCachedTranscription(hash)).toMatchObject({
      draft: '[00:09.00] Rigenerata',
      cachedAt: later,
    });
  });

  it('una riscrittura nel frattempo non viene cancellata (filtro sull’IV)', async () => {
    const hash = keyHash();
    await storeCachedTranscription(hash, ENTRY);
    const row = rows[0] as Row;
    const tag = new Uint8Array(row.authTag);
    tag[1] = (tag[1] ?? 0) ^ 0xff;
    row.authTag = tag;
    // Mentre la lettura scopre la voce rotta, un'altra richiesta la riscrive.
    const original = mocks.findUnique.getMockImplementation();
    mocks.findUnique.mockImplementationOnce(async (args: { where: { keyHash: string } }) => {
      const found = await original?.(args);
      await storeCachedTranscription(hash, { ...ENTRY, draft: '[00:09.00] Nuova' });
      return found;
    });
    expect(await readCachedTranscription(hash)).toBeNull();
    expect(rows).toHaveLength(1);
    expect((await readCachedTranscription(hash))?.draft).toBe('[00:09.00] Nuova');
  });

  it('segreto mancante: nessuna lettura né scrittura nel database, nessuna eccezione', async () => {
    const hash = keyHash();
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    expect(await readCachedTranscription(hash)).toBeNull();
    expect(await storeCachedTranscription(hash, ENTRY)).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('database giù → null, mai un’eccezione; nei log solo il nome dell’errore', async () => {
    const hash = keyHash();
    mocks.findUnique.mockRejectedValueOnce(new Error(`connessione a ${PATHNAME} rifiutata`));
    mocks.upsert.mockRejectedValueOnce(new TypeError(`errore con ${LYRICS}`));
    expect(await readCachedTranscription(hash)).toBeNull();
    expect(await storeCachedTranscription(hash, ENTRY)).toBeNull();
    const logged = JSON.stringify(warns.mock.calls);
    expect(logged).toContain('Error');
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain(PATHNAME);
    expect(logged).not.toContain('Prima strofa');
  });

  it('database lento: la lettura si arrende entro qualche secondo (miss)', async () => {
    vi.useFakeTimers();
    try {
      mocks.findUnique.mockImplementationOnce(() => new Promise(() => undefined));
      const read = readCachedTranscription(keyHash());
      await vi.advanceTimersByTimeAsync(3100);
      expect(await read).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pulizia: voci non usate da 180 giorni', () => {
  function seed(now: number, idleDays: number[]) {
    rows = idleDays.map((days, index) => ({
      id: `old-${index}`,
      keyHash: String(index).padStart(64, '0'),
      ciphertext: new Uint8Array([1]),
      iv: new Uint8Array(12),
      authTag: new Uint8Array(16),
      keyVersion: 1,
      model: 'whisper-1',
      language: null,
      durationSeconds: null,
      lineCount: 0,
      droppedSegments: 0,
      createdAt: new Date(now - days * DAY),
      lastUsedAt: new Date(now - days * DAY),
    }));
  }

  it('cancella solo oltre 180 giorni dall’ultimo uso, a lotti limitati; idempotente', async () => {
    const now = new Date('2026-11-14T03:00:00Z');
    seed(now.getTime(), [0, 30, 179, 181, 400]);
    expect(await purgeStaleTranscriptions(now)).toEqual({ count: 2 });
    expect(rows.map((row) => row.id)).toEqual(['old-0', 'old-1', 'old-2']);

    const query = mocks.findMany.mock.calls[0]?.[0] as {
      where: { lastUsedAt: { lt: Date } };
      take: number;
      orderBy: unknown;
      select: unknown;
    };
    expect(now.getTime() - query.where.lastUsedAt.lt.getTime()).toBe(180 * DAY);
    expect(query.take).toBe(TRANSCRIPTION_CACHE_PURGE_BATCH);
    expect(query.take).toBeLessThanOrEqual(5000);
    expect(query.orderBy).toEqual({ lastUsedAt: 'asc' });
    expect(query.select).toEqual({ id: true });
    // La cancellazione ricontrolla la data: una voce riusata nel frattempo resta.
    const removal = mocks.deleteMany.mock.calls[0]?.[0] as {
      where: { id: { in: string[] }; lastUsedAt: { lt: Date } };
    };
    expect(removal.where.id.in).toEqual(['old-4', 'old-3']);
    expect(removal.where.lastUsedAt.lt).toEqual(query.where.lastUsedAt.lt);

    expect(await purgeStaleTranscriptions(now)).toEqual({ count: 0 });
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(3);
  });

  it('voce riusata tra la ricerca e la cancellazione → resta', async () => {
    const now = new Date('2026-11-14T03:00:00Z');
    seed(now.getTime(), [200]);
    const original = mocks.findMany.getMockImplementation();
    mocks.findMany.mockImplementationOnce(async (args: never) => {
      const found = await original?.(args);
      (rows[0] as Row).lastUsedAt = now;
      return found;
    });
    expect(await purgeStaleTranscriptions(now)).toEqual({ count: 0 });
    expect(rows).toHaveLength(1);
  });

  it('errore del database → { count: 0 } senza eccezioni', async () => {
    mocks.findMany.mockRejectedValueOnce(new Error('db giù'));
    await expect(purgeStaleTranscriptions(new Date())).resolves.toEqual({ count: 0 });
  });
});

describe('trascrizioni identiche in corso (stesso processo)', () => {
  it('beginTranscription segna la chiave; la chiusura sveglia chi aspetta, anche due volte', async () => {
    const hash = keyHash();
    expect(transcriptionInFlight(hash)).toBeUndefined();
    const release = beginTranscription(hash);
    const running = transcriptionInFlight(hash);
    expect(running).toBeInstanceOf(Promise);
    let woke = false;
    void running?.then(() => {
      woke = true;
    });
    release();
    release();
    await Promise.resolve();
    expect(woke).toBe(true);
    expect(transcriptionInFlight(hash)).toBeUndefined();
  });
});
