// @polsia:user-owned — «Carica su audio.com» lato server (pagina admin /admin/audiocom): un file già
// caricato dal browser nello staging di Vercel Blob va sull'account audio.com collegato.
//
// Passi (POST /api/admin/audiocom/uploads, solo admin):
// 1. L'URL del file deve essere https sull'host ESATTO dello store di Solco (ricavato dal token) e
//    sotto `audiocom-staging/`: nessun URL arbitrario, quindi nessuna richiesta verso host scelti
//    da altri (SSRF). head() conferma dimensione e tipo dichiarati.
// 2. Account audio.com collegato; se è scelta una collection, deve essere dell'account.
// 3. Il file si legge dallo store in memoria (al più 100 MB, byte contati: devono essere ESATTAMENTE
//    `size`), poi POST /v1/audio/create registra il brano e risponde con la policy
//    { audio, url, success, fail }.
// 4. I byte vanno con un PUT all'URL firmato `url` (https, senza credenziali né porta, niente
//    redirect, MAI il token); poi POST a `success`, oppure DELETE a `fail` se qualcosa va storto.
// 5. Con la collection: POST /v1/collection/item/add, poi la cache delle sezioni della Home si svuota.
//
// IL TOKEN DI AUDIO.COM VA SOLO A https://api.audio.com: `success` e `fail` si chiamano col token
// solo se sono https proprio su api.audio.com (altrimenti niente PUT, niente hook e il brano appena
// creato si cancella con /v1/audio/delete, sempre su api.audio.com). Nei log mai token né URL
// firmati: solo il passo e lo stato HTTP o il nome dell'errore. La copia di staging la cancella la
// route alla fine (deleteAudioComStagingBlob), comunque vada.
import 'server-only';
import { isIP } from 'node:net';
import { BlobNotFoundError, del, head } from '@vercel/blob';
import { z } from 'zod';
import {
  AUDIOCOM_UPLOAD_MAX_BYTES,
  AUDIOCOM_UPLOAD_MESSAGES,
  type AudioComUploadInput,
  type AudioComUploadResponse,
  AudioComUploadResponseSchema,
  parseAudioComStagingUrl,
} from '@/lib/contracts/audiocom-upload';
import { env } from '@/lib/env';
import {
  clearAudioComSectionsCache,
  listAudioComCollectionsForAdmin,
} from '@/lib/music/audiocom-collections.server';
import {
  AUDIOCOM_API_ORIGIN,
  type AudioComHttpResult,
  audioComRequest,
  getAudioComAccessToken,
  markAudioComAccessRejected,
} from '@/lib/music/audiocom-connection.server';
import {
  AUDIOCOM_ID_PATTERN,
  audioComPageUrl,
  normalizeAudioComLicense,
} from '@/lib/music/audiocom-license';

export const AUDIOCOM_AUDIO_CREATE_URL = `${AUDIOCOM_API_ORIGIN}/v1/audio/create`;
export const AUDIOCOM_AUDIO_DELETE_URL = `${AUDIOCOM_API_ORIGIN}/v1/audio/delete`;
export const AUDIOCOM_COLLECTION_ITEM_ADD_URL = `${AUDIOCOM_API_ORIGIN}/v1/collection/item/add`;
/** L'UNICO host a cui si manda il token di audio.com. */
export const AUDIOCOM_API_HOST = new URL(AUDIOCOM_API_ORIGIN).hostname;

/** Tempo complessivo dei passi (la route ha maxDuration 120 s): il resto serve a fail e pulizia. */
const UPLOAD_BUDGET_MS = 95_000;
const HEAD_TIMEOUT_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 40_000;
const API_TIMEOUT_MS = 15_000;
const PUT_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 8_000;
/** Ogni passo ha almeno questo tempo, anche a budget quasi finito. */
const MIN_STEP_MS = 2_000;

// ---------------------------------------------------------------------------------------------
// Staging su Vercel Blob

/** Host pubblico dello store Vercel Blob di Solco, dal token (vercel_blob_rw_<storeId>_<…>). */
export function audioComStagingStoreHost(
  token: string | undefined = env.BLOB_READ_WRITE_TOKEN,
): string | null {
  if (!token) return null;
  const storeId = token.split('_')[3] ?? '';
  if (!/^[A-Za-z0-9-]{1,100}$/.test(storeId)) return null;
  return `${storeId.toLowerCase()}.public.blob.vercel-storage.com`;
}

/** Il caricamento è possibile solo con lo store Vercel Blob configurato. */
export function isAudioComUploadConfigured(): boolean {
  return audioComStagingStoreHost() !== null;
}

/** URL di staging valido E sull'host dello store di Solco, oppure null. */
export function stagedAudioComBlobUrl(
  raw: unknown,
  storeHost: string | null = audioComStagingStoreHost(),
): URL | null {
  const url = parseAudioComStagingUrl(raw);
  if (!url || !storeHost || url.hostname !== storeHost) return null;
  return url;
}

/** Cancella la copia di staging (best effort: se fallisce resta la scadenza di un giorno). */
export async function deleteAudioComStagingBlob(url: URL): Promise<void> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return;
  try {
    await del(url.toString(), { token, abortSignal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
  } catch (error) {
    logStep('cancellazione dello staging non riuscita', errorName(error));
  }
}

type StagedMeta =
  | { kind: 'ok'; size: number; contentType: string }
  | { kind: 'missing' }
  | { kind: 'unknown' };

async function headStaged(url: URL, token: string): Promise<StagedMeta> {
  try {
    const meta = await head(url.toString(), {
      token,
      abortSignal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    return { kind: 'ok', size: meta.size, contentType: baseType(meta.contentType) };
  } catch (error) {
    if (error instanceof BlobNotFoundError) return { kind: 'missing' };
    // Store lento o non raggiungibile: decide la lettura del file, che conta i byte uno per uno.
    logStep('head dello staging non riuscito', errorName(error));
    return { kind: 'unknown' };
  }
}

type Downloaded =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'mismatch' | 'not_audio' | 'unavailable' };

/**
 * Il tipo servito dallo store sembra audio (o manca). Il tipo ESATTO lo confronta head(): il token di
 * staging ammette solo i formati di audio.com, quindi qui basta escludere ciò che audio non è.
 */
function looksLikeAudio(contentType: string): boolean {
  return (
    contentType === '' || contentType.startsWith('audio/') || contentType === 'application/ogg'
  );
}

/** Legge il file di staging in memoria: esattamente `size` byte (né uno di più né uno di meno). */
async function downloadStaged(url: URL, size: number, timeoutMs: number): Promise<Downloaded> {
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { 'accept-encoding': 'identity' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    logStep('lettura dello staging non riuscita', errorName(error));
    return { ok: false, reason: 'unavailable' };
  }
  const cancel = () => response.body?.cancel().catch(() => undefined);
  if (!response.ok || !response.body) {
    await cancel();
    logStep('lettura dello staging rifiutata', String(response.status));
    return { ok: false, reason: response.status === 404 ? 'mismatch' : 'unavailable' };
  }
  if (!looksLikeAudio(baseType(response.headers.get('content-type')))) {
    await cancel();
    return { ok: false, reason: 'not_audio' };
  }
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared !== size) {
    await cancel();
    return { ok: false, reason: 'mismatch' };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.byteLength > size) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'mismatch' };
      }
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch (error) {
    logStep('lettura dello staging interrotta', errorName(error));
    return { ok: false, reason: 'unavailable' };
  }
  return offset === size ? { ok: true, bytes } : { ok: false, reason: 'mismatch' };
}

// ---------------------------------------------------------------------------------------------
// Indirizzi che arrivano da audio.com

/**
 * Hook `success`/`fail` della policy: https ESATTAMENTE su api.audio.com, senza credenziali né
 * porta (un percorso relativo vale come percorso di api.audio.com). Solo qui va il token.
 */
export function audioComApiHookUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw, AUDIOCOM_API_ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (url.hostname !== AUDIOCOM_API_HOST) return null;
  url.hash = '';
  return url;
}

/**
 * URL firmato del PUT (`url` della policy): https assoluto, senza credenziali né porta, su un nome
 * di dominio pubblico (niente indirizzi IP, localhost o nomi interni). Il token NON ci va mai.
 */
export function audioComPresignedUploadUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || isIP(host.replace(/^\[|\]$/g, '')) !== 0) {
    return null;
  }
  if (/(?:^|\.)(?:localhost|local|internal|localdomain)$/.test(host)) return null;
  return url;
}

// ---------------------------------------------------------------------------------------------
// Risposte di audio.com

const optionalText = z.string().max(2_000).nullish();

const RawAudioSchema = z
  .object({
    id: z
      .union([z.string(), z.number().int().nonnegative()])
      .transform(String)
      .pipe(z.string().regex(AUDIOCOM_ID_PATTERN)),
    title: optionalText,
    slug: optionalText,
    username: optionalText,
    license: optionalText,
    is_listed: z.boolean().nullish(),
  })
  .passthrough();
type RawAudio = z.infer<typeof RawAudioSchema>;

const UploadPolicySchema = z
  .object({
    audio: RawAudioSchema,
    url: z.string().min(1).max(8_192),
    success: z.string().min(1).max(4_096),
    fail: z.string().min(1).max(4_096),
  })
  .passthrough();

/** Solo l'id dell'audio creato (per cancellarlo se la policy non è utilizzabile). */
const CreatedIdSchema = z.object({ audio: z.object({ id: RawAudioSchema.shape.id }) });

const ValidationErrorSchema = z
  .object({
    message: z.string().max(2_000).optional(),
    errors: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// biome-ignore lint/suspicious/noControlCharactersInRegex: toglie i caratteri di controllo.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Primo messaggio di un 422 di audio.com (testo ripulito e corto), se c'è. */
function validationDetail(body: unknown): string | null {
  const parsed = ValidationErrorSchema.safeParse(body);
  if (!parsed.success) return null;
  for (const value of Object.values(parsed.data.errors ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && cleanText(first, 160)) return cleanText(first, 160);
  }
  return cleanText(parsed.data.message, 160) || null;
}

// ---------------------------------------------------------------------------------------------
// Esito per la route

export type AudioComUploadOutcome =
  | { kind: 'created'; body: AudioComUploadResponse }
  | { kind: 'fields'; errors: Record<string, string> }
  | { kind: 'failed'; status: 409 | 422 | 502 | 503; error: string; message: string };

const failed = (
  status: 409 | 422 | 502 | 503,
  error: string,
  message: string,
): AudioComUploadOutcome => ({ kind: 'failed', status, error, message });

const MESSAGES = {
  disconnected: 'Collega prima l’account audio.com.',
  unavailable: 'audio.com non risponde in questo momento: riprova tra poco.',
  storage: 'Il file caricato non si riesce a leggere dallo storage: riprova tra poco.',
  unauthorized:
    'audio.com ha rifiutato l’accesso dell’account collegato: riprova tra poco; se continua, ricollega audio.com.',
  rateLimited: 'audio.com ha ricevuto troppe richieste: riprova tra qualche minuto.',
  forbidden:
    'audio.com non consente questo caricamento con l’account collegato (permessi o spazio esauriti).',
  payment: 'audio.com chiede un abbonamento attivo per questo caricamento.',
  rejected: 'audio.com ha rifiutato i dati del brano.',
  invalidResponse: 'audio.com ha risposto in un formato inatteso: il brano non è stato caricato.',
  transfer: 'L’invio del file ad audio.com non è riuscito: riprova tra poco.',
  discarded:
    'audio.com ha scartato il file (formato o dimensione non corrispondono): prova con un altro file.',
} as const;

// ---------------------------------------------------------------------------------------------
// Il caricamento

type Bearer = { token: string; version: number };

/** Access token valido (rinnovato se scade entro un minuto): si richiede prima di ogni chiamata. */
async function bearer(): Promise<Bearer | null> {
  const access = await getAudioComAccessToken();
  return access.ok ? { token: access.token, version: access.version } : null;
}

function jsonHeaders(auth: Bearer): Record<string, string> {
  return {
    authorization: `Bearer ${auth.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

/** Chiamata autenticata ad api.audio.com (l'host si ricontrolla QUI, prima di mettere il token). */
async function apiCall(
  url: URL,
  method: 'POST' | 'DELETE',
  auth: Bearer,
  timeoutMs: number,
  body?: unknown,
): Promise<AudioComHttpResult | null> {
  if (url.protocol !== 'https:' || url.hostname !== AUDIOCOM_API_HOST || url.port) return null;
  try {
    const result = await audioComRequest(
      url.toString(),
      {
        method,
        headers: jsonHeaders(auth),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      timeoutMs,
    );
    if (result.status === 401) await markAudioComAccessRejected(auth.version);
    return result;
  } catch (error) {
    logStep(`chiamata ad audio.com non riuscita (${method})`, errorName(error));
    return null;
  }
}

/** DELETE all'hook `fail` (best effort): audio.com scarta il caricamento non riuscito. */
async function reportFailure(failUrl: URL): Promise<void> {
  const auth = await bearer();
  if (!auth) return;
  const result = await apiCall(failUrl, 'DELETE', auth, CLEANUP_TIMEOUT_MS);
  if (!result?.ok) logStep('hook fail non riuscito', String(result?.status ?? 'rete'));
}

/** Cancella su audio.com un brano appena creato ma inutilizzabile (best effort). */
async function deleteCreatedAudio(id: string): Promise<void> {
  const auth = await bearer();
  if (!auth) return;
  const url = new URL(AUDIOCOM_AUDIO_DELETE_URL);
  url.searchParams.set('id', id);
  const result = await apiCall(url, 'POST', auth, CLEANUP_TIMEOUT_MS);
  if (!result?.ok) {
    logStep('cancellazione del brano non riuscita', String(result?.status ?? 'rete'));
  }
}

async function putBytes(
  target: URL,
  bytes: Uint8Array,
  mime: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetch(target.toString(), {
      method: 'PUT',
      // Solo il tipo: il token di audio.com non va MAI all'URL firmato.
      headers: { 'content-type': mime },
      body: bytes,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) logStep('PUT del file rifiutato', String(response.status));
    return response.ok;
  } catch (error) {
    logStep('PUT del file non riuscito', errorName(error));
    return false;
  }
}

/** Errore di POST /v1/audio/create → esito per la route. */
function createFailure(result: AudioComHttpResult | null): AudioComUploadOutcome {
  if (!result) return failed(503, 'audiocom_unavailable', MESSAGES.unavailable);
  logStep('creazione rifiutata', String(result.status));
  switch (result.status) {
    case 401:
      return failed(503, 'audiocom_unauthorized', MESSAGES.unauthorized);
    case 402:
      return failed(409, 'audiocom_payment_required', MESSAGES.payment);
    case 403:
      return failed(409, 'audiocom_forbidden', MESSAGES.forbidden);
    case 429:
      return failed(503, 'audiocom_rate_limited', MESSAGES.rateLimited);
    default: {
      if (result.status >= 500) return failed(503, 'audiocom_unavailable', MESSAGES.unavailable);
      const detail = result.status === 422 ? validationDetail(result.body) : null;
      return failed(
        422,
        'audiocom_rejected',
        detail ? `${MESSAGES.rejected} (${detail})` : MESSAGES.rejected,
      );
    }
  }
}

/** Il brano creato per il client: i dati confermati da audio.com, altrimenti quelli inviati. */
function toResponse(
  created: RawAudio,
  confirmed: RawAudio | null,
  input: AudioComUploadInput,
  collectionAdded: boolean | null,
): AudioComUploadResponse {
  const audio = confirmed ?? created;
  const title = cleanText(audio.title, 300) || cleanText(created.title, 300) || input.title;
  const license = audio.license ? normalizeAudioComLicense(audio.license) : input.license;
  const parsed = AudioComUploadResponseSchema.safeParse({
    audio: {
      id: created.id,
      title,
      pageUrl:
        audioComPageUrl(audio.username, audio.slug) ??
        audioComPageUrl(created.username, created.slug),
      license,
      isListed: typeof audio.is_listed === 'boolean' ? audio.is_listed : input.isListed,
    },
    collectionAdded,
  });
  if (parsed.success) return parsed.data;
  // Il brano è comunque su audio.com: si risponde con i dati inviati (sempre validi), senza pagina.
  return {
    audio: {
      id: created.id,
      title: input.title,
      pageUrl: null,
      license: input.license,
      isListed: input.isListed,
    },
    collectionAdded,
  };
}

/**
 * Manda ad audio.com il file di staging `staged` (URL già controllato con stagedAudioComBlobUrl)
 * con i dati di `input`. Non lancia per gli errori previsti: risponde con l'esito per la route.
 * La copia di staging NON si cancella qui (lo fa la route, comunque vada).
 */
export async function uploadStagedAudioToAudioCom(
  input: AudioComUploadInput,
  staged: URL,
): Promise<AudioComUploadOutcome> {
  const deadline = Date.now() + UPLOAD_BUDGET_MS;
  const within = (maxMs: number) => Math.max(MIN_STEP_MS, Math.min(maxMs, deadline - Date.now()));
  const blobToken = env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) return failed(503, 'not_configured', 'Lo storage dei file non è configurato.');

  // 1. Il file di staging: esiste, ha la dimensione e il tipo dichiarati.
  const meta = await headStaged(staged, blobToken);
  if (meta.kind === 'missing') {
    return { kind: 'fields', errors: { blobUrl: AUDIOCOM_UPLOAD_MESSAGES.blobUrl } };
  }
  if (meta.kind === 'ok') {
    if (meta.size > AUDIOCOM_UPLOAD_MAX_BYTES) {
      return { kind: 'fields', errors: { size: AUDIOCOM_UPLOAD_MESSAGES.fileTooLarge } };
    }
    if (meta.size !== input.size) {
      return { kind: 'fields', errors: { blobUrl: AUDIOCOM_UPLOAD_MESSAGES.blobUrl } };
    }
    if (meta.contentType && meta.contentType !== input.mime) {
      return { kind: 'fields', errors: { mime: AUDIOCOM_UPLOAD_MESSAGES.fileFormat } };
    }
  }

  // 2. Account collegato e, se scelta, collection dell'account.
  const access = await getAudioComAccessToken();
  if (!access.ok) {
    return access.reason === 'disconnected'
      ? failed(503, 'audiocom_disconnected', MESSAGES.disconnected)
      : failed(503, 'audiocom_unavailable', MESSAGES.unavailable);
  }
  if (input.collectionId) {
    const current = await listAudioComCollectionsForAdmin();
    if (current.status === 'disconnected') {
      return failed(503, 'audiocom_disconnected', MESSAGES.disconnected);
    }
    if (current.status !== 'ok') return failed(503, 'audiocom_unavailable', MESSAGES.unavailable);
    if (!current.collections.some((collection) => collection.id === input.collectionId)) {
      return {
        kind: 'fields',
        errors: { collectionId: 'Questa collection non è (più) nel tuo account audio.com.' },
      };
    }
  }

  // 3. Il file in memoria, PRIMA di creare il brano: se lo store non risponde nulla resta a metà.
  const file = await downloadStaged(staged, input.size, within(DOWNLOAD_TIMEOUT_MS));
  if (!file.ok) {
    if (file.reason === 'mismatch') {
      return { kind: 'fields', errors: { blobUrl: AUDIOCOM_UPLOAD_MESSAGES.blobUrl } };
    }
    if (file.reason === 'not_audio') {
      return { kind: 'fields', errors: { mime: AUDIOCOM_UPLOAD_MESSAGES.fileFormat } };
    }
    return failed(503, 'storage_unavailable', MESSAGES.storage);
  }

  // 4. Registrazione del brano su audio.com: la policy di caricamento.
  const created = await apiCall(
    new URL(AUDIOCOM_AUDIO_CREATE_URL),
    'POST',
    { token: access.token, version: access.version },
    within(API_TIMEOUT_MS),
    {
      name: input.name,
      mime: input.mime,
      size: input.size,
      category: input.category,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      license: input.license,
      is_listed: input.isListed,
      is_downloadable: input.isDownloadable,
    },
  );
  if (!created?.ok) return createFailure(created);
  const policy = UploadPolicySchema.safeParse(created.body);
  if (!policy.success) {
    logStep('policy di caricamento non valida', 'schema');
    const id = CreatedIdSchema.safeParse(created.body);
    if (id.success) await deleteCreatedAudio(id.data.audio.id);
    return failed(502, 'audiocom_invalid_response', MESSAGES.invalidResponse);
  }
  const audioId = policy.data.audio.id;
  const target = audioComPresignedUploadUrl(policy.data.url);
  const successUrl = audioComApiHookUrl(policy.data.success);
  const failUrl = audioComApiHookUrl(policy.data.fail);
  if (!target || !successUrl || !failUrl) {
    // Un hook fuori da api.audio.com non riceve MAI il token: niente PUT né hook, il brano appena
    // creato si cancella dall'API ufficiale.
    logStep('policy di caricamento rifiutata', 'host');
    await deleteCreatedAudio(audioId);
    return failed(502, 'audiocom_invalid_response', MESSAGES.invalidResponse);
  }

  // 5. I byte all'URL firmato, poi l'esito ad audio.com.
  const sent = await putBytes(target, file.bytes, input.mime, within(PUT_TIMEOUT_MS));
  if (!sent) {
    await reportFailure(failUrl);
    return failed(503, 'audiocom_transfer_failed', MESSAGES.transfer);
  }
  const auth = await bearer();
  const done = auth ? await apiCall(successUrl, 'POST', auth, within(API_TIMEOUT_MS)) : null;
  if (!done?.ok) {
    logStep('hook success non riuscito', String(done?.status ?? 'rete'));
    await reportFailure(failUrl);
    if (done && (done.status === 400 || done.status === 422)) {
      return failed(422, 'audiocom_upload_rejected', MESSAGES.discarded);
    }
    return failed(503, 'audiocom_transfer_failed', MESSAGES.transfer);
  }
  const confirmed = RawAudioSchema.safeParse(done.body);
  const confirmedAudio = confirmed.success && confirmed.data.id === audioId ? confirmed.data : null;

  // 6. Nella collection scelta (il brano è già su audio.com: un errore qui non lo annulla).
  let collectionAdded: boolean | null = null;
  if (input.collectionId) {
    const addAuth = await bearer();
    const url = new URL(AUDIOCOM_COLLECTION_ITEM_ADD_URL);
    url.searchParams.set('id', input.collectionId);
    const added = addAuth
      ? await apiCall(url, 'POST', addAuth, within(API_TIMEOUT_MS), { audio: [audioId] })
      : null;
    collectionAdded = Boolean(added?.ok);
    if (collectionAdded) clearAudioComSectionsCache();
    else logStep('aggiunta alla collection non riuscita', String(added?.status ?? 'rete'));
  }

  return {
    kind: 'created',
    body: toResponse(policy.data.audio, confirmedAudio, input, collectionAdded),
  };
}

// ---------------------------------------------------------------------------------------------

function baseType(value: string | null | undefined): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function logStep(what: string, detail: string): void {
  // biome-ignore lint/suspicious/noConsole: log del server col solo passo e codice (mai token o URL).
  console.warn(`[admin/audiocom/uploads] ${what}:`, detail);
}
