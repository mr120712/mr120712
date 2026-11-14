// @polsia:user-owned — trascrizione IA (OpenAI Whisper) dei testi dei "brani in evidenza", SOLO per
// i brani dichiarati in diritti.json con "testo": true (l'amministratore ha i diritti sul testo).
// Lo store contiene anche file senza licenza: per ogni altro brano la funzione NON esiste, e il
// server risponde sempre con lo stesso 404 (percorso non valido, non audio, non dichiarato,
// "testo" mancante o false, file assente), senza chiamare OpenAI e senza consumare limiti.
//
// Flusso (dalla pagina admin «Diritti e testi»):
// 1. Bozza (transcribeFeaturedTrack): permesso ricontrollato ADESSO (elenco dello store e
//    diritti.json letti freschi, mai dalla cache della ricerca, più head() del file audio),
//    formato accettato da Whisper e dimensione ≤ 25 MB dall'elenco, poi limiti (per admin e
//    dell'intera app, consumati solo se la chiamata a OpenAI parte davvero), lettura dell'audio
//    con il token dello store, Whisper, e una bozza LRC "[mm:ss.xx] testo" per segmento. Si
//    scartano solo le allucinazioni note (crediti dei sottotitoli, "Grazie per la visione"…) e i
//    segmenti quasi certamente silenziosi; i ritornelli ripetuti restano.
// 2. Salvataggio (saveTranscribedLyrics): stesso controllo del permesso, testo validato con il
//    parser dei testi (≤ 64 KB, righe limitate), scritto come "<stessa cartella>/<stesso nome>.lrc"
//    (ricavato SOLO dal pathname validato), sempre PRIVATO, sostituendo un .lrc esistente solo
//    con la conferma.
// Il permesso si nega anche quando diritti.json è pubblico (il CDN potrebbe servirne una copia
// vecchia, con un "testo": true già revocato): va caricato come privato, come dice la guida.
// La bozza torna solo all'amministratore che l'ha chiesta; nessun testo nei log.
import 'server-only';
import {
  BlobAccessError,
  BlobError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
  get,
  type HeadBlobResult,
  head,
  put,
} from '@vercel/blob';
import {
  consumeRateLimit,
  type RateLimitAction,
  type RateLimitDecision,
  rateLimitResponse,
  releaseRateLimit,
} from '@/lib/business/rate-limit.server';
import {
  LRC_EXISTS_MESSAGE,
  TRANSCRIPTION_LRC_MAX_BYTES,
  TRANSCRIPTION_LRC_MAX_LINE_CHARS,
  TRANSCRIPTION_LRC_MAX_LINES,
  TRANSCRIPTION_MAX_AUDIO_BYTES,
  TRANSCRIPTION_NOT_CONFIGURED_MESSAGE,
  type TranscribeResponse,
  type TranscriptionLanguage,
  WHISPER_EXTENSIONS,
} from '@/lib/contracts/lyrics-transcription';
import { env } from '@/lib/env';
import { invalidateFeaturedLyricsCache } from '@/lib/music/featured-lyrics.server';
import {
  declaredTrackEntries,
  lyricsDeclared,
  RIGHTS_MANIFEST_PATHNAME,
  readRightsManifest,
  readUpTo,
} from '@/lib/music/featured-rights.server';
import {
  encodeBlobPathname,
  type HomeStoreFile,
  isHomeAudioBlob,
  isHomeLyricsSidecar,
  isPublicBlobUrl,
  listHomeTrackCatalog,
  lyricsSidecarMatcher,
} from '@/lib/music/home-tracks.server';
import { normalizeLyricsInput, parseLyrics, sanitizeLyricsLine } from '@/lib/music/lyrics';
import {
  openAiApiKey,
  transcribeWithWhisper,
  WHISPER_TIMEOUT_MS,
  type WhisperErrorCode,
  type WhisperSegment,
  whisperExtension,
} from '@/lib/music/whisper.server';

/** Tempo massimo per chiedere allo store un singolo file (head). */
const HEAD_DEADLINE_MS = 5000;
/** Tempo massimo per leggere il file audio dallo store (al massimo 25 MB). */
const AUDIO_READ_DEADLINE_MS = 30_000;
/** Tempo massimo per scrivere il .lrc. */
const PUT_DEADLINE_MS = 15_000;
/** Tempo complessivo della bozza (la route ha maxDuration 120). */
const TRANSCRIBE_BUDGET_MS = 112_000;
/** Whisper non parte con meno di così: si sprecherebbe una chiamata a pagamento. */
const WHISPER_MIN_TIMEOUT_MS = 20_000;
/** Allucinazione da silenzio: no_speech_prob oltre questa soglia… */
export const NO_SPEECH_PROB_LIMIT = 0.6;
/** …e insieme avg_logprob sotto questa. */
export const AVG_LOGPROB_LIMIT = -1;

const LRC_CONTENT_TYPE = 'text/plain; charset=utf-8';

function abortAfter(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

// ─── Bozza LRC ──────────────────────────────────────────────────────────────────────────────────

/**
 * "[mm:ss.xx]" dall'inizio in secondi: centesimi arrotondati, minuti senza tetto (le ore
 * diventano minuti: 1 h 2 min 5 s → [62:05.00]). Valori non validi o negativi → [00:00.00].
 */
export function formatLrcTimestamp(seconds: number): string {
  const capped = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 24 * 3600) : 0;
  const total = Math.round(capped * 100);
  const minutes = Math.floor(total / 6000);
  const secs = Math.floor((total % 6000) / 100);
  const centiseconds = total % 100;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `[${pad(minutes)}:${pad(secs)}.${pad(centiseconds)}]`;
}

// Un tempo LRC ("[01:02.03]") o un tag parola per parola ("<01:02.03>") dentro il testo di un
// segmento verrebbe letto dal parser come un tempo in più: si toglie.
const TIME_LIKE = /\[\d{1,5}:\d{1,2}(?:[.:]\d{1,3})?\]|<\d{1,5}:\d{1,2}(?:[.:]\d{1,3})?>/g;

/** Testo di un segmento con le regole del parser dei testi (una riga, sicura, ≤ 500 caratteri). */
export function cleanSegmentText(text: string): string {
  return sanitizeLyricsLine(text.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(TIME_LIKE, ' '));
}

/** Minuscole, senza accenti, apostrofi dritti, spazi compressi, senza punteggiatura ai bordi. */
function foldForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
}

/**
 * Frasi che Whisper "inventa" su musica o silenzio perché le ha viste nei sottotitoli con cui è
 * stato addestrato. I crediti ("Sottotitoli a cura di <nome>", "Subtitles by <nome>") si
 * riconoscono dall'INIZIO del segmento (o dall'indirizzo Amara.org ovunque); i saluti ("Grazie per
 * la visione", "Thanks for watching") solo se sono TUTTO il segmento: una riga vera che inizia così
 * ("Thanks for watching over me") resta.
 */
const WHISPER_ARTEFACTS: readonly RegExp[] = [
  /amara\s*\.?\s*org/,
  /^sottotitoli(?: e revisione)? (?:a cura di|creati|realizzati)\b/,
  /^sottotitoli di (?:qtss|amara)\b/,
  /^(?:revisione|traduzione) (?:a cura di|di) (?:qtss|amara)\b/,
  /^grazie (?:a tutti )?per (?:la visione|aver guardato)$/,
  /^thanks? (?:you )?(?:so much |very much )?for watching$/,
  /^subtitles? (?:by|created by|made by)\b/,
  /^untertitel (?:der|von|im auftrag)\b/,
  /^sous-titres? (?:realises|par)\b/,
  /^sous-titrage\b/,
  /^subtitulos? (?:realizados|creados|hechos|por)\b/,
  /^legendas? (?:pela|por|criadas|feitas)\b/,
];

/** True per un segmento che è una nota allucinazione di Whisper (crediti dei sottotitoli…). */
export function isWhisperArtefact(text: string): boolean {
  const folded = foldForMatch(text);
  return folded !== '' && WHISPER_ARTEFACTS.some((pattern) => pattern.test(folded));
}

/** Silenzio trascritto per sbaglio: molto probabilmente nessuna voce E testo poco probabile. */
export function isLikelySilence(segment: Pick<WhisperSegment, 'noSpeechProb' | 'avgLogprob'>) {
  return (
    segment.noSpeechProb !== null &&
    segment.avgLogprob !== null &&
    segment.noSpeechProb > NO_SPEECH_PROB_LIMIT &&
    segment.avgLogprob < AVG_LOGPROB_LIMIT
  );
}

export type DraftLrc = { draft: string; lineCount: number; droppedSegments: number };

/**
 * Bozza LRC dai segmenti di Whisper: una riga "[mm:ss.xx] testo" per segmento, nell'ordine dato.
 * Scarta (e conta) le allucinazioni note e i silenzi; salta i segmenti vuoti; NON toglie le righe
 * ripetute (i ritornelli). Mai oltre 1000 righe né 64 KB: la bozza si può sempre salvare.
 */
export function buildDraftLrc(segments: readonly WhisperSegment[]): DraftLrc {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let bytes = 0;
  let droppedSegments = 0;
  for (const segment of segments) {
    const text = cleanSegmentText(segment.text);
    if (text === '') continue;
    if (isWhisperArtefact(text) || isLikelySilence(segment)) {
      droppedSegments += 1;
      continue;
    }
    const line = `${formatLrcTimestamp(segment.start)} ${text}`;
    const size = encoder.encode(line).length + 1;
    if (lines.length >= TRANSCRIPTION_LRC_MAX_LINES || bytes + size > TRANSCRIPTION_LRC_MAX_BYTES) {
      break;
    }
    lines.push(line);
    bytes += size;
  }
  const draft = lines.join('\n');
  return { draft, lineCount: parseLyrics(draft)?.lines.length ?? 0, droppedSegments };
}

// ─── Validazione del testo da salvare ─────────────────────────────────────────────────────────────

export type LrcValidation = { ok: true; content: string } | { ok: false; message: string };

/**
 * Il testo da salvare come .lrc: normalizzato (niente caratteri di controllo o override bidi,
 * spazi in coda tolti, al massimo una riga vuota di fila), deve essere leggibile dal parser
 * (sincronizzato o semplice), con al massimo 1000 righe, 1000 caratteri per riga e 64 KB.
 */
export function validateLrcForSave(input: string): LrcValidation {
  const normalized = normalizeLyricsInput(input);
  if (!normalized || !parseLyrics(normalized)) {
    return { ok: false, message: 'Il testo è vuoto: scrivi almeno una riga.' };
  }
  const lines = normalized.split('\n');
  if (lines.filter((line) => line.trim() !== '').length > TRANSCRIPTION_LRC_MAX_LINES) {
    return { ok: false, message: `Il testo supera ${TRANSCRIPTION_LRC_MAX_LINES} righe.` };
  }
  const long = lines.findIndex((line) => [...line].length > TRANSCRIPTION_LRC_MAX_LINE_CHARS);
  if (long >= 0) {
    return {
      ok: false,
      message: `La riga ${long + 1} è troppo lunga (al massimo ${TRANSCRIPTION_LRC_MAX_LINE_CHARS} caratteri).`,
    };
  }
  const content = `${normalized}\n`;
  if (new TextEncoder().encode(content).length > TRANSCRIPTION_LRC_MAX_BYTES) {
    return { ok: false, message: 'Il testo supera 64 KB: accorcialo prima di salvarlo.' };
  }
  return { ok: true, content };
}

/** Messaggio quando il testo inviato supera già il tetto del contratto. */
export const LRC_TOO_LARGE_MESSAGE = 'Il testo supera 64 KB: accorcialo prima di salvarlo.';

// ─── Permesso (ricontrollato a ogni richiesta) ──────────────────────────────────────────────────

/**
 * "<stessa cartella>/<stesso nome>.lrc" del brano, ricavato SOLO da un pathname già valido (audio
 * in evidenza, niente "..", niente public-uploads/); null altrimenti.
 */
export function lrcPathnameFor(pathname: string): string | null {
  if (!isHomeAudioBlob(pathname)) return null;
  const slash = pathname.lastIndexOf('/');
  const dot = pathname.lastIndexOf('.');
  if (dot <= slash + 1) return null;
  const target = `${pathname.slice(0, dot)}.lrc`;
  return isHomeLyricsSidecar(target) && target !== pathname ? target : null;
}

export type EligibleTrack = {
  /** Pathname ESATTO del file audio nello store. */
  pathname: string;
  /** true = audio pubblico (CDN), false = privato (letto con il token). */
  audioPublic: boolean;
  /** Dimensione del file audio secondo lo store. */
  size: number;
  /** Dove si salva il testo: stessa cartella, stesso nome, estensione .lrc. */
  lrcPathname: string;
  /** I .lrc già accanto al brano nell'elenco (maiuscole o forma Unicode diverse comprese). */
  listedLrc: HomeStoreFile[];
};

export type Eligibility =
  | { status: 'eligible'; track: EligibleTrack }
  /** Brano non ammesso o inesistente: sempre la stessa risposta. */
  | { status: 'not_found' }
  /** Store o diritti.json non leggibili ora: non si sa. */
  | { status: 'unavailable' }
  /**
   * diritti.json è PUBBLICO: passa dal CDN di Vercel Blob (useCache:false vale solo per i file
   * privati), quindi una revoca di "testo" potrebbe non valere subito. Nel dubbio, nessun brano.
   */
  | { status: 'manifest_public' };

const NOT_FOUND: Eligibility = { status: 'not_found' };
const UNAVAILABLE: Eligibility = { status: 'unavailable' };
const MANIFEST_PUBLIC: Eligibility = { status: 'manifest_public' };

/** head() entro la scadenza: il file, null se lo store dice che non c'è, undefined se non risponde. */
async function headWithin(
  token: string,
  pathname: string,
): Promise<HeadBlobResult | null | undefined> {
  const lookup = head(pathname, { token, abortSignal: abortAfter(HEAD_DEADLINE_MS) }).then(
    (blob): HeadBlobResult | null | undefined => blob,
    (error: unknown) => (error instanceof BlobNotFoundError ? null : undefined),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), HEAD_DEADLINE_MS);
  });
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Il brano si può trascrivere SOLO se, adesso: il pathname è un brano in evidenza valido, lo
 * store lo elenca, diritti.json (letto fresco, stesse regole della ricerca) lo dichiara con
 * "testo": true e il file audio esiste (head). Mai dalla cache dell'indice della ricerca. Non fa
 * mai throw.
 */
export async function checkTranscriptionEligibility(pathname: string): Promise<Eligibility> {
  if (typeof pathname !== 'string' || !isHomeAudioBlob(pathname)) return NOT_FOUND;
  const lrcPathname = lrcPathnameFor(pathname);
  if (!lrcPathname) return NOT_FOUND;
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return UNAVAILABLE;
  try {
    const catalog = await listHomeTrackCatalog([RIGHTS_MANIFEST_PATHNAME]);
    if (!catalog) return UNAVAILABLE;
    const manifestFile = catalog.files.get(RIGHTS_MANIFEST_PATHNAME) ?? null;
    // Elenco interrotto prima di vedere il manifest: non si sa se c'è.
    if (!manifestFile) return catalog.complete ? NOT_FOUND : UNAVAILABLE;
    // Un manifest pubblico si leggerebbe dalla cache del CDN: la verifica non sarebbe "adesso".
    // Vale per ogni brano allo stesso modo (prima di guardare il brano chiesto).
    if (isPublicBlobUrl(manifestFile.url)) return MANIFEST_PUBLIC;
    const audioPathnames = catalog.tracks.map((track) => track.id);
    if (!audioPathnames.includes(pathname)) return NOT_FOUND;

    const rights = await readRightsManifest(token, manifestFile);
    if (rights.status === 'unavailable') return UNAVAILABLE;
    if (rights.status !== 'ok') return NOT_FOUND;
    const entry = declaredTrackEntries(rights.entries, audioPathnames).get(pathname);
    if (!entry || !lyricsDeclared(entry)) return NOT_FOUND;

    const blob = await headWithin(token, pathname);
    if (blob === undefined) return UNAVAILABLE;
    if (blob === null || blob.pathname !== pathname) return NOT_FOUND;

    const listedLrc = lyricsSidecarMatcher(catalog.sidecars)(pathname).filter((file) =>
      file.pathname.toLowerCase().endsWith('.lrc'),
    );
    return {
      status: 'eligible',
      track: {
        pathname,
        audioPublic: isPublicBlobUrl(blob.url),
        size: blob.size,
        lrcPathname,
        listedLrc,
      },
    };
  } catch {
    return UNAVAILABLE;
  }
}

// ─── Rifiuti e risposte ─────────────────────────────────────────────────────────────────────────

type DeniedRateLimit = Exclude<RateLimitDecision, { allowed: true }>;

export type TranscriptionRefusal =
  | { kind: 'not_found' }
  | { kind: 'store_unavailable' }
  | { kind: 'manifest_public' }
  | { kind: 'cancelled' }
  | { kind: 'lrc_private_rejected' }
  | { kind: 'not_configured' }
  | { kind: 'unsupported_format'; extension: string }
  | { kind: 'too_large' }
  | { kind: 'audio_unreadable' }
  | { kind: 'rate_limited'; action: RateLimitAction; decision: DeniedRateLimit }
  | { kind: 'whisper'; error: WhisperErrorCode; message: string }
  | { kind: 'invalid_lrc'; message: string }
  | { kind: 'lrc_exists' }
  | { kind: 'save_failed' };

/** Stessa risposta per ogni brano che non si può trascrivere (nessun indizio sul perché). */
export const NOT_ELIGIBLE_MESSAGE =
  'Trascrizione non disponibile per questo brano: serve una voce di diritti.json con "testo": true e il file audio nello store.';

const FORMAT_LIST = `${WHISPER_EXTENSIONS.slice(0, -1).join(', ')} o ${WHISPER_EXTENSIONS.at(-1)}`;

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function json(status: number, body: Record<string, unknown>, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...privateHeaders, ...headers } });
}

const WHISPER_STATUS: Partial<Record<WhisperErrorCode, number>> = {
  too_large: 413,
  rate_limited: 429,
};

/** La risposta HTTP (privata, mai in cache) di un rifiuto: messaggi italiani, nessun dettaglio. */
export function transcriptionRefusalResponse(refusal: TranscriptionRefusal): Response {
  switch (refusal.kind) {
    case 'not_found':
      return json(404, { error: 'not_found', message: NOT_ELIGIBLE_MESSAGE });
    case 'store_unavailable':
      return json(503, {
        error: 'store_unavailable',
        message:
          'Non riesco a leggere lo store o diritti.json in questo momento: riprova tra poco.',
      });
    case 'manifest_public':
      return json(503, {
        error: 'rights_manifest_public',
        message:
          'Per la trascrizione diritti.json va caricato come privato: da pubblico passa dal CDN e una revoca di "testo" potrebbe non valere subito.',
      });
    case 'cancelled':
      // L'admin ha annullato: nessuno legge questa risposta.
      return json(499, { error: 'cancelled', message: 'Trascrizione annullata.' });
    case 'lrc_private_rejected':
      return json(502, {
        error: 'lrc_private_rejected',
        message:
          'Lo store non ha accettato il .lrc come file privato: il testo non è stato pubblicato. I testi si salvano solo come privati.',
      });
    case 'not_configured':
      return json(503, {
        error: 'transcription_not_configured',
        message: TRANSCRIPTION_NOT_CONFIGURED_MESSAGE,
      });
    case 'unsupported_format':
      return json(415, {
        error: 'unsupported_format',
        message: `Formato .${refusal.extension} non supportato dalla trascrizione: servono file ${FORMAT_LIST}.`,
      });
    case 'too_large':
      return json(413, {
        error: 'audio_too_large',
        message: 'File troppo grande per la trascrizione: al massimo 25 MB.',
      });
    case 'audio_unreadable':
      return json(502, {
        error: 'audio_unreadable',
        message: 'Non riesco a leggere il file audio dallo store: riprova tra poco.',
      });
    case 'rate_limited': {
      const response = rateLimitResponse(refusal.action, refusal.decision);
      response.headers.set('Vary', 'Cookie');
      return response;
    }
    case 'whisper':
      return json(
        WHISPER_STATUS[refusal.error] ?? 502,
        { error: `openai_${refusal.error}`, message: refusal.message },
        refusal.error === 'rate_limited' ? { 'Retry-After': '60' } : {},
      );
    case 'invalid_lrc':
      return json(400, { error: 'invalid_lrc', errors: { lrc: refusal.message } });
    case 'lrc_exists':
      return json(409, { error: 'lrc_exists', errors: { lrc: LRC_EXISTS_MESSAGE } });
    default:
      return json(502, {
        error: 'save_failed',
        message: 'Salvataggio non riuscito: lo store non ha accettato il file. Riprova tra poco.',
      });
  }
}

function refusalOf(
  eligibility: Exclude<Eligibility, { status: 'eligible' }>,
): TranscriptionRefusal {
  if (eligibility.status === 'unavailable') return { kind: 'store_unavailable' };
  if (eligibility.status === 'manifest_public') return { kind: 'manifest_public' };
  return { kind: 'not_found' };
}

// ─── Bozza ──────────────────────────────────────────────────────────────────────────────────────

async function releaseTranscriptionLimits(identity: string) {
  await Promise.all([
    releaseRateLimit('lyrics.transcribe', identity),
    releaseRateLimit('lyrics.transcribe.global', 'global'),
  ]);
}

/** Prenota una trascrizione: prima il limite dell'admin, poi quello dell'intera app. */
async function reserveTranscription(identity: string): Promise<TranscriptionRefusal | null> {
  const own = await consumeRateLimit('lyrics.transcribe', identity);
  if (!own.allowed) return { kind: 'rate_limited', action: 'lyrics.transcribe', decision: own };
  const global = await consumeRateLimit('lyrics.transcribe.global', 'global');
  if (!global.allowed) {
    await releaseRateLimit('lyrics.transcribe', identity);
    return { kind: 'rate_limited', action: 'lyrics.transcribe.global', decision: global };
  }
  return null;
}

type AudioRead = { ok: true; bytes: Uint8Array } | { ok: false; refusal: TranscriptionRefusal };

/** Scadenza `ms` unita all'interruzione del chiamante (l'admin annulla). */
function abortAfterOr(ms: number, signal?: AbortSignal): AbortSignal | undefined {
  const deadline = abortAfter(ms);
  if (!signal) return deadline;
  if (!deadline) return signal;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * I byte del file audio (≤ 25 MB), letti con il token dello store come il proxy di streaming. Se
 * l'admin annulla, la lettura si ferma subito (`signal`).
 */
async function readAudio(
  token: string,
  track: EligibleTrack,
  signal?: AbortSignal,
): Promise<AudioRead> {
  try {
    const result = await get(encodeBlobPathname(track.pathname), {
      access: track.audioPublic ? 'public' : 'private',
      token,
      abortSignal: abortAfterOr(AUDIO_READ_DEADLINE_MS, signal),
    });
    if (!result) return { ok: false, refusal: { kind: 'not_found' } };
    if (result.statusCode !== 200 || !result.stream) {
      return { ok: false, refusal: { kind: 'audio_unreadable' } };
    }
    const declared = Number(result.headers.get('content-length') ?? '0');
    if (declared > TRANSCRIPTION_MAX_AUDIO_BYTES) {
      await result.stream.cancel().catch(() => undefined);
      return { ok: false, refusal: { kind: 'too_large' } };
    }
    const bytes = await readUpTo(result.stream, TRANSCRIPTION_MAX_AUDIO_BYTES + 1);
    if (bytes.length > TRANSCRIPTION_MAX_AUDIO_BYTES) {
      return { ok: false, refusal: { kind: 'too_large' } };
    }
    if (bytes.length === 0) return { ok: false, refusal: { kind: 'audio_unreadable' } };
    return { ok: true, bytes };
  } catch {
    return { ok: false, refusal: { kind: 'audio_unreadable' } };
  }
}

export type TranscribeInput = {
  pathname: string;
  language?: TranscriptionLanguage;
  /** Identità dell'admin per il limite personale, es. "user:<id>". */
  identity: string;
  /** Interruzione della richiesta (l'admin annulla): ferma anche la chiamata a OpenAI. */
  signal?: AbortSignal;
};

export type TranscribeOutcome =
  | { ok: true; result: TranscribeResponse }
  | { ok: false; refusal: TranscriptionRefusal };

/**
 * La bozza LRC di un brano dichiarato con "testo": true. Ordine dei controlli: chiave OpenAI,
 * permesso (fresco), formato, dimensione dall'elenco; solo allora si consumano i limiti, si legge
 * l'audio e si chiama Whisper. Se la lettura fallisce, l'admin annulla prima dell'invio o la
 * richiesta non raggiunge OpenAI, i limiti si restituiscono. Mai throw.
 */
export async function transcribeFeaturedTrack({
  pathname,
  language,
  identity,
  signal,
}: TranscribeInput): Promise<TranscribeOutcome> {
  const startedAt = Date.now();
  const apiKey = openAiApiKey();
  if (!apiKey) return { ok: false, refusal: { kind: 'not_configured' } };

  const eligibility = await checkTranscriptionEligibility(pathname);
  if (eligibility.status !== 'eligible') return { ok: false, refusal: refusalOf(eligibility) };
  const { track } = eligibility;
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { ok: false, refusal: { kind: 'store_unavailable' } };

  const extension = whisperExtension(track.pathname);
  if (!extension) {
    const raw = track.pathname.slice(track.pathname.lastIndexOf('.') + 1).toLowerCase();
    return { ok: false, refusal: { kind: 'unsupported_format', extension: raw } };
  }
  if (track.size > TRANSCRIPTION_MAX_AUDIO_BYTES) {
    return { ok: false, refusal: { kind: 'too_large' } };
  }

  const limited = await reserveTranscription(identity);
  if (limited) return { ok: false, refusal: limited };

  const audio = await readAudio(token, track, signal);
  if (signal?.aborted) {
    // L'admin ha annullato durante la lettura: OpenAI non viene chiamato, i limiti non pesano.
    await releaseTranscriptionLimits(identity);
    return { ok: false, refusal: { kind: 'cancelled' } };
  }
  if (!audio.ok) {
    // Nessuna chiamata a OpenAI: i limiti non pesano.
    await releaseTranscriptionLimits(identity);
    return { ok: false, refusal: audio.refusal };
  }

  const remaining = startedAt + TRANSCRIBE_BUDGET_MS - Date.now();
  if (remaining < WHISPER_MIN_TIMEOUT_MS) {
    // Store troppo lento: Whisper non farebbe in tempo, meglio non spendere la chiamata.
    await releaseTranscriptionLimits(identity);
    return { ok: false, refusal: { kind: 'store_unavailable' } };
  }
  const whisper = await transcribeWithWhisper({
    audio: audio.bytes,
    extension,
    language,
    apiKey,
    timeoutMs: Math.min(WHISPER_TIMEOUT_MS, remaining),
    signal,
  });
  if (!whisper.ok) {
    // La richiesta non è arrivata a OpenAI (annullata prima dell'invio, DNS, connessione
    // rifiutata): i limiti si restituiscono. Una chiamata partita conta sempre.
    if (whisper.notSent) {
      await releaseTranscriptionLimits(identity);
      if (signal?.aborted) return { ok: false, refusal: { kind: 'cancelled' } };
    }
    return {
      ok: false,
      refusal: { kind: 'whisper', error: whisper.error, message: whisper.message },
    };
  }

  const draft = buildDraftLrc(whisper.transcript.segments);
  const duration = whisper.transcript.durationSeconds;
  return {
    ok: true,
    result: {
      draft: draft.draft,
      lineCount: draft.lineCount,
      language: whisper.transcript.language,
      durationSeconds: duration === null ? null : Math.round(duration * 10) / 10,
      droppedSegments: draft.droppedSegments,
    },
  };
}

// ─── Salvataggio ────────────────────────────────────────────────────────────────────────────────

export type SaveInput = {
  pathname: string;
  lrc: string;
  overwrite: boolean;
  identity: string;
};

export type SaveOutcome = { ok: true } | { ok: false; refusal: TranscriptionRefusal };

/** True per l'errore dello store "esiste già" (put senza allowOverwrite su un file esistente). */
function alreadyExists(error: unknown): boolean {
  return error instanceof BlobError && /already exists/i.test(error.message);
}

/** True se lo store ha rifiutato la scrittura come file privato (store che non li ammette). */
function privateRejected(error: unknown): boolean {
  return (
    error instanceof BlobAccessError ||
    (error instanceof BlobError && /private/i.test(error.message))
  );
}

/**
 * Salva il testo come .lrc accanto al brano: testo validato, permesso ricontrollato, nome del
 * file ricavato solo dal pathname validato, sostituzione di un .lrc esistente solo con
 * `overwrite` (e solo se nel frattempo non è cambiato: ifMatch). Il .lrc è SEMPRE privato, anche
 * accanto a un audio pubblico: un file pubblico avrebbe un indirizzo ricavabile da quello
 * dell'audio, scavalcherebbe il login del player e resterebbe leggibile dopo una revoca (il player
 * legge ogni file di testo con il suo accesso). Il limite 'lyrics.transcribe.save' si consuma solo
 * subito prima della scrittura (i rifiuti non contano). Poi la cache del testo di quel brano si
 * svuota. Mai throw.
 */
export async function saveTranscribedLyrics({
  pathname,
  lrc,
  overwrite,
  identity,
}: SaveInput): Promise<SaveOutcome> {
  const validated = validateLrcForSave(lrc);
  if (!validated.ok)
    return { ok: false, refusal: { kind: 'invalid_lrc', message: validated.message } };

  const eligibility = await checkTranscriptionEligibility(pathname);
  if (eligibility.status !== 'eligible') return { ok: false, refusal: refusalOf(eligibility) };
  const { track } = eligibility;
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { ok: false, refusal: { kind: 'store_unavailable' } };

  const existing = await headWithin(token, track.lrcPathname);
  if (existing === undefined) return { ok: false, refusal: { kind: 'store_unavailable' } };
  const targetExists = existing !== null;
  if ((targetExists || track.listedLrc.length > 0) && !overwrite) {
    return { ok: false, refusal: { kind: 'lrc_exists' } };
  }

  const decision = await consumeRateLimit('lyrics.transcribe.save', identity);
  if (!decision.allowed) {
    return {
      ok: false,
      refusal: { kind: 'rate_limited', action: 'lyrics.transcribe.save', decision },
    };
  }

  try {
    await put(track.lrcPathname, validated.content, {
      access: 'private',
      token,
      contentType: LRC_CONTENT_TYPE,
      addRandomSuffix: false,
      // Si sostituisce solo il .lrc visto adesso e solo con la conferma; un file comparso nel
      // frattempo fa fallire la scrittura (→ 409, si chiede di nuovo).
      allowOverwrite: targetExists && overwrite,
      ...(targetExists && overwrite && existing.etag ? { ifMatch: existing.etag } : {}),
      cacheControlMaxAge: 60,
      abortSignal: abortAfter(PUT_DEADLINE_MS),
    });
  } catch (error) {
    // Nessuna scrittura: il salvataggio non conta.
    await releaseRateLimit('lyrics.transcribe.save', identity);
    if (error instanceof BlobPreconditionFailedError || alreadyExists(error)) {
      return { ok: false, refusal: { kind: 'lrc_exists' } };
    }
    if (privateRejected(error)) return { ok: false, refusal: { kind: 'lrc_private_rejected' } };
    return { ok: false, refusal: { kind: 'save_failed' } };
  }
  invalidateFeaturedLyricsCache(track.pathname);
  return { ok: true };
}
