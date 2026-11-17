// @polsia:user-owned — «Rifinisci con Solco AI»: POST /api/admin/featured-rights/transcribe/refine e il
// modulo server (lyrics-refine.server.ts). Stessa origine e admin verificato; corpo non valido (400 sul
// campo `lrc` o `language`); il cancello è quello della trascrizione (404 identico per un brano non
// ammesso, 503 con lo store giù), nessuna chiamata al modello senza la chiave Anthropic o con i limiti
// finiti; il modello riceve SOLO le righe di testo della bozza (mai i tempi) con le istruzioni che
// vietano di inventare; il risultato si rimette sui tempi della bozza (Enhanced LRC) con `refined`
// (copertura, righe senza riscontro, righe prima/dopo); un testo cambiato troppo, tagliato o gonfiato
// si rifiuta (502, la bozza resta com'era), come un rifiuto del modello o una risposta non valida;
// chiave rifiutata → 503 «non configurata» e nessuna seconda chiamata; servizio occupato → 503 con
// Retry-After; i limiti si restituiscono solo se la richiesta non è mai partita. Mai il testo nei log.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  eligibility: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  consume: vi.fn(),
  release: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/env', () => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', NEXT_PUBLIC_APP_URL: 'https://solco.test' },
}));
// Stessa gerarchia dell'SDK vero (un timeout è un errore di connessione; il 402 non ha una classe).
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status?: number) {
      super('api');
      this.status = status;
    }
  }
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class NotFoundError extends APIError {}
  class RateLimitError extends APIError {}
  class APIConnectionError extends APIError {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  class APIUserAbortError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static PermissionDeniedError = PermissionDeniedError;
    static NotFoundError = NotFoundError;
    static RateLimitError = RateLimitError;
    static APIConnectionError = APIConnectionError;
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIUserAbortError = APIUserAbortError;
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
    beta = { messages: { create: mocks.create } };
    models = { list: mocks.list };
  }
  return { default: Anthropic };
});
vi.mock('@anthropic-ai/sdk/helpers/beta/zod', () => ({
  betaZodOutputFormat: () => ({ type: 'json_schema', schema: {} }),
}));
vi.mock('@/lib/business/rate-limit.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/business/rate-limit.server')>()),
  consumeRateLimit: mocks.consume,
  releaseRateLimit: mocks.release,
}));
vi.mock('@/lib/music/lyrics-transcription.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/lyrics-transcription.server')>()),
  checkTranscriptionEligibility: mocks.eligibility,
}));

import Anthropic from '@anthropic-ai/sdk';
import { POST } from '@/app/api/admin/featured-rights/transcribe/refine/route';
import {
  REFINE_NOT_CONFIGURED_MESSAGE,
  RefineLyricsResponseSchema,
} from '@/lib/contracts/lyrics-transcription';
import { parseLyrics } from '@/lib/music/lyrics';
import { ALIGN_MAX_LYRICS_WORDS } from '@/lib/music/lyrics-align';
import {
  checkRefinedLyrics,
  cleanRefinedLines,
  draftForRefinement,
  REFINE_EMPTY_MESSAGE,
  REFINE_MODEL,
  REFINE_NO_TIMES_MESSAGE,
  REFINE_SYSTEM_PROMPT,
  refineFeaturedTrackLyrics,
  refinementMessage,
  trackNameOf,
} from '@/lib/music/lyrics-refine.server';
import { NOT_ELIGIBLE_MESSAGE } from '@/lib/music/lyrics-transcription.server';

/** Le classi d'errore dell'SDK finto, costruibili col solo stato (il tipo vero vuole più argomenti). */
type ErrorClass = new (status?: number) => Error;
const Errors = Anthropic as unknown as Record<
  'APIError' | 'RateLimitError' | 'APIConnectionError' | 'APIConnectionTimeoutError',
  ErrorClass
>;

const ORIGIN = 'https://solco.test';
const SONG = 'Cantautori/Autrice - Canzone.mp3';
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

/** La bozza di Solco AI (Enhanced LRC) con due refusi: «celo» e «me». */
const DRAFT = [
  '[00:12.00] <00:12.00>sotto <00:12.40>il <00:12.80>celo <00:13.20>di <00:13.60>roma',
  '[00:14.00] <00:14.00>canto <00:14.40>per <00:14.80>me <00:15.20>stasera',
  '[00:15.60] <00:15.60>e <00:16.00>la <00:16.40>luna <00:16.80>ci <00:17.20>guarda',
].join('\n');
/** Quel che il modello dovrebbe restituire: refusi corretti, maiuscole, punteggiatura. */
const REFINED = ['Sotto il cielo di Roma,', 'canto per te stasera', 'e la luna ci guarda.'];

const ELIGIBLE = {
  status: 'eligible',
  track: {
    pathname: SONG,
    audioPublic: false,
    size: 1000,
    audioVersion: 'etag:x',
    lrcPathname: 'Cantautori/Autrice - Canzone.lrc',
    listedLrc: [],
  },
};

let keyCounter = 0;
/** Una chiave nuova per ogni test: la memoria «chiave rifiutata» di un test non pesa sugli altri. */
function freshKey() {
  keyCounter += 1;
  return `sk-ant-api03-test-key-${keyCounter}-0123456789`;
}

function message(lines: unknown, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ lines }) }],
    stop_reason: 'end_turn',
    model: REFINE_MODEL,
    usage: { input_tokens: 10, output_tokens: 10 },
    _request_id: 'req_test',
    ...extra,
  };
}

let errors: MockInstance<typeof console.error>;
let warnings: MockInstance<typeof console.warn>;

function request(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return new Request(`${ORIGIN}/api/admin/featured-rights/transcribe/refine`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function refine(body: Record<string, unknown> = {}) {
  return POST(request({ pathname: SONG, lrc: DRAFT, ...body }));
}

/** Il corpo dell'ultima chiamata al modello. */
function lastCall() {
  const call = mocks.create.mock.calls.at(-1);
  if (!call) throw new Error('Nessuna chiamata al modello.');
  return call as [Record<string, unknown>, Record<string, unknown>];
}

function userContent(): string {
  const [body] = lastCall();
  const messages = body.messages as Array<{ role: string; content: string }>;
  return messages[0]?.content ?? '';
}

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.eligibility.mockReset();
  mocks.create.mockReset();
  mocks.consume.mockReset();
  mocks.release.mockReset();
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.eligibility.mockResolvedValue(ELIGIBLE);
  mocks.create.mockResolvedValue(message(REFINED));
  mocks.consume.mockResolvedValue({ allowed: true });
  mocks.release.mockResolvedValue(undefined);
  process.env.ANTHROPIC_API_KEY = freshKey();
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  errors.mockRestore();
  warnings.mockRestore();
});

describe('accesso', () => {
  it('senza la stessa origine: 403, nessun cancello né modello', async () => {
    const response = await POST(request({ pathname: SONG, lrc: DRAFT }, {}));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_origin' });
    expect(mocks.eligibility).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('senza sessione 401; utente non admin o admin senza email verificata 403', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await refine()).status).toBe(401);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, role: 'user' } });
    expect((await refine()).status).toBe(403);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, emailVerified: false } });
    expect((await refine()).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('corpo della richiesta', () => {
  it('bozza mancante, non stringa, vuota o troppo grande: 400 sul campo lrc', async () => {
    const missing = await POST(request({ pathname: SONG }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: 'invalid_request',
      errors: { lrc: 'La bozza è vuota: trascrivi il brano prima di rifinirla.' },
    });
    expect((await POST(request({ pathname: SONG, lrc: 12 }))).status).toBe(400);
    expect((await POST(request({ pathname: SONG, lrc: '' }))).status).toBe(400);
    const huge = await POST(request({ pathname: SONG, lrc: 'a'.repeat(64 * 1024 + 1) }));
    expect(huge.status).toBe(400);
    expect((await huge.json()).errors.lrc).toContain('64 KB');
    expect(mocks.eligibility).not.toHaveBeenCalled();
  });

  it('lingua fuori elenco: 400 sul campo language; JSON rotto, campo in più o durata negativa: 400', async () => {
    const language = await refine({ language: 'xx' });
    expect(language.status).toBe(400);
    expect((await language.json()).errors.language).toContain('Lingua non valida');
    expect((await POST(request('{non json'))).status).toBe(400);
    expect((await refine({ extra: 1 })).status).toBe(400);
    expect((await refine({ durationSeconds: -1 })).status).toBe(400);
    expect(mocks.eligibility).not.toHaveBeenCalled();
  });

  it('bozza senza tempi o con sole pause: 400 sul campo, senza cancello né modello', async () => {
    const plain = await refine({ lrc: 'sotto il cielo di roma\ncanto per te stasera' });
    expect(plain.status).toBe(400);
    expect(await plain.json()).toEqual({
      error: 'refine_invalid',
      errors: { lrc: REFINE_NO_TIMES_MESSAGE },
    });
    const empty = await refine({ lrc: '♪\n\n♪' });
    expect(empty.status).toBe(400);
    expect((await empty.json()).errors.lrc).toBe(REFINE_EMPTY_MESSAGE);
    expect(mocks.eligibility).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});

describe('cancello, chiave e limiti', () => {
  it('brano non ammesso: 404 identico alla trascrizione, nessuna chiamata al modello', async () => {
    mocks.eligibility.mockResolvedValueOnce({ status: 'not_found' });
    const response = await refine();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', message: NOT_ELIGIBLE_MESSAGE });
    expect(mocks.eligibility).toHaveBeenCalledWith(SONG);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('store o diritti.json non leggibili: 503; manifest pubblico: 503 dedicato', async () => {
    mocks.eligibility.mockResolvedValueOnce({ status: 'unavailable' });
    const unavailable = await refine();
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toBe('store_unavailable');
    mocks.eligibility.mockResolvedValueOnce({ status: 'manifest_public' });
    const manifest = await refine();
    expect(manifest.status).toBe(503);
    expect((await manifest.json()).error).toBe('rights_manifest_public');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('senza la chiave Anthropic (o con una chiave dalla forma sbagliata): 503 «non configurata»', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const missing = await refine();
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({
      error: 'refine_not_configured',
      message: REFINE_NOT_CONFIGURED_MESSAGE,
    });
    process.env.ANTHROPIC_API_KEY = 'non-una-chiave';
    const wrong = await refine();
    expect(wrong.status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('limite dell’admin finito: 429 senza chiamata; limite globale finito: il proprio si restituisce', async () => {
    mocks.consume.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 1200,
      status: 429,
      error: 'rate_limited',
      message: 'x',
    });
    const own = await refine();
    expect(own.status).toBe(429);
    expect(mocks.create).not.toHaveBeenCalled();

    mocks.consume.mockReset();
    mocks.consume.mockImplementation(async (action: string) =>
      action === 'lyrics.refine.global'
        ? {
            allowed: false,
            retryAfterSeconds: 3600,
            status: 429,
            error: 'rate_limited',
            message: 'x',
          }
        : { allowed: true },
    );
    const global = await refine();
    expect(global.status).toBe(429);
    expect(mocks.release.mock.calls).toEqual([['lyrics.refine', 'user:admin-1']]);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('rifinitura', () => {
  it('bozza ripulita, rimessa sui tempi della bozza (parola per parola), con `refined`', async () => {
    const response = await refine({ language: 'it', durationSeconds: 184.4 });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = RefineLyricsResponseSchema.parse(await response.json());
    expect(body.wordTimed).toBe(true);
    expect(body.lineCount).toBe(3);
    expect(body.refined).toEqual({
      coverage: 0.929,
      matchedWords: 13,
      totalWords: 14,
      unmatchedLines: [],
      linesBefore: 3,
      linesAfter: 3,
    });
    // Le parole sono quelle rifinite («cielo», «te», maiuscole, punteggiatura), i tempi della bozza.
    expect(body.draft.split('\n')[0]).toBe(
      '[00:12.00] <00:12.00>Sotto <00:12.40>il <00:12.80>cielo <00:13.20>di <00:13.60>Roma,',
    );
    expect(body.draft).toContain('<00:14.80>te');
    expect(body.draft).not.toContain('celo');
    expect(parseLyrics(body.draft)?.lines.map((line) => line.text)).toEqual(REFINED);

    // Il modello riceve solo le righe di testo (mai i tempi), il brano e la lingua; limiti consumati.
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const [params, options] = lastCall();
    expect(params.model).toBe(REFINE_MODEL);
    expect(params.max_tokens).toBe(16_000);
    expect(params.output_config).toMatchObject({
      effort: 'medium',
      format: { type: 'json_schema' },
    });
    const system = params.system as Array<{ text: string }>;
    expect(system[0]?.text).toBe(REFINE_SYSTEM_PROMPT);
    expect(REFINE_SYSTEM_PROMPT).toContain('Vietato: aggiungere parole');
    const content = userContent();
    expect(content).toContain('Brano: Autrice - Canzone');
    expect(content).toContain('Lingua del testo: italiano');
    expect(content).toContain('<trascrizione>\nsotto il celo di roma\ncanto per me stasera\n');
    expect(content).not.toContain('00:12');
    expect(content).not.toContain('<00:');
    expect(content).not.toContain('Cantautori/');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.consume.mock.calls).toEqual([
      ['lyrics.refine', 'user:admin-1'],
      ['lyrics.refine.global', 'global'],
    ]);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('senza lingua il messaggio lo dice; i tempi e le etichette ricopiati dal modello si tolgono', async () => {
    mocks.create.mockResolvedValueOnce(
      message([
        '[Ritornello]',
        '[00:12.00] Sotto il cielo di Roma,',
        '',
        '<00:14.00>canto per te stasera',
        '(Strofa 2)',
        'e la luna ci guarda.',
      ]),
    );
    const response = await refine();
    expect(response.status).toBe(200);
    const body = RefineLyricsResponseSchema.parse(await response.json());
    expect(parseLyrics(body.draft)?.lines.map((line) => line.text)).toEqual(REFINED);
    expect(body.refined.linesAfter).toBe(3);
    expect(userContent()).toContain('Lingua del testo: non indicata');
  });

  it('testo inventato: 502 «cambiato troppo», la bozza resta com’era, nel log solo conteggi', async () => {
    mocks.create.mockResolvedValueOnce(
      message(['Nel blu dipinto di blu', 'felice di stare lassù', 'volare oh oh cantare oh']),
    );
    const response = await refine();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe('refine_rejected');
    expect(body.message).toMatch(/cambiato troppo il testo \(solo il \d+% delle parole/);
    expect(body.draft).toBeUndefined();
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('blu');
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('celo');
  });

  it('versi tolti o parole aggiunte in massa: 502 con il conteggio', async () => {
    mocks.create.mockResolvedValueOnce(message(['Sotto il cielo di Roma']));
    const cut = await refine();
    expect(cut.status).toBe(502);
    expect((await cut.json()).message).toContain('ha tolto troppe parole (5 su 14)');

    mocks.create.mockResolvedValueOnce(
      message([...REFINED, 'e poi la notte scende piano su di noi che restiamo qui a cantare']),
    );
    const padded = await refine();
    expect(padded.status).toBe(502);
    expect((await padded.json()).message).toContain('ha aggiunto troppe parole');
  });

  it('rifiuto del modello 502; risposta interrotta o non JSON 502; nessuna riga 502', async () => {
    mocks.create.mockResolvedValueOnce(
      message([], { stop_reason: 'refusal', stop_details: { category: 'x' } }),
    );
    const refused = await refine();
    expect(refused.status).toBe(502);
    expect((await refused.json()).error).toBe('refine_refused');

    mocks.create.mockResolvedValueOnce(message(REFINED, { stop_reason: 'max_tokens' }));
    const cut = await refine();
    expect(cut.status).toBe(502);
    expect((await cut.json()).error).toBe('refine_failed');

    mocks.create.mockResolvedValueOnce({
      ...message(REFINED),
      content: [{ type: 'text', text: 'non json' }],
    });
    expect((await refine()).status).toBe(502);

    mocks.create.mockResolvedValueOnce(message(['', '♪']));
    const empty = await refine();
    expect(empty.status).toBe(502);
    expect((await empty.json()).message).toContain('non ha restituito un testo');
    expect(errors.mock.calls.length + warnings.mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify([...errors.mock.calls, ...warnings.mock.calls])).not.toContain('celo');
  });

  it('chiave rifiutata (401): 503 «non configurata» e la chiamata dopo non riparte', async () => {
    mocks.create.mockRejectedValueOnce(new Errors.APIError(401));
    const first = await refine();
    expect(first.status).toBe(503);
    expect((await first.json()).error).toBe('refine_not_configured');
    const second = await refine();
    expect(second.status).toBe(503);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('servizio occupato (timeout, 529, limite): 503 con Retry-After; i limiti restano consumati dopo un timeout', async () => {
    mocks.create.mockRejectedValueOnce(new Errors.APIConnectionTimeoutError());
    const timeout = await refine();
    expect(timeout.status).toBe(503);
    expect(timeout.headers.get('retry-after')).toBe('30');
    expect((await timeout.json()).error).toBe('refine_busy');
    expect(mocks.release).not.toHaveBeenCalled();

    mocks.create.mockRejectedValueOnce(new Errors.APIError(529));
    expect((await refine()).status).toBe(503);
    mocks.create.mockRejectedValueOnce(new Errors.RateLimitError(429));
    expect((await refine()).status).toBe(503);
  });

  it('richiesta mai partita (connessione rifiutata): 503 occupato e limiti restituiti', async () => {
    mocks.create.mockRejectedValueOnce(new Errors.APIConnectionError());
    const response = await refine();
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('refine_busy');
    expect(mocks.release.mock.calls).toEqual([
      ['lyrics.refine', 'user:admin-1'],
      ['lyrics.refine.global', 'global'],
    ]);
  });

  it('annullata dall’admin prima della chiamata: «cancelled», nessuna chiamata', async () => {
    const outcome = await refineFeaturedTrackLyrics({
      pathname: SONG,
      lrc: DRAFT,
      identity: 'user:admin-1',
      signal: AbortSignal.abort(),
    });
    expect(outcome).toEqual({ ok: false, refusal: { kind: 'cancelled' } });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('un errore imprevisto: 500 generico, nel log solo il nome dell’errore', async () => {
    mocks.eligibility.mockRejectedValueOnce(new RangeError(`segreto ${DRAFT}`));
    const response = await refine();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'refine_failed',
      message: 'La rifinitura non è riuscita. Riprova tra poco.',
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls[0])).not.toContain('celo');
    expect(errors.mock.calls[0]?.[1]).toBe('RangeError');
  });
});

describe('funzioni pure', () => {
  it('draftForRefinement: righe senza tempi, parole con tempo, wordLevel; limiti', () => {
    const wordTimed = draftForRefinement(DRAFT);
    expect(wordTimed.ok).toBe(true);
    if (!wordTimed.ok) return;
    expect(wordTimed.lines).toEqual([
      'sotto il celo di roma',
      'canto per me stasera',
      'e la luna ci guarda',
    ]);
    expect(wordTimed.wordCount).toBe(14);
    expect(wordTimed.wordLevel).toBe(true);
    expect(wordTimed.words[2]).toEqual({ timeMs: 12_800, text: 'celo' });

    const lineTimed = draftForRefinement('[00:12.00] sotto il celo\n\n♪\n[00:14.00] canto per me');
    expect(lineTimed.ok).toBe(true);
    if (!lineTimed.ok) return;
    expect(lineTimed.wordLevel).toBe(false);
    expect(lineTimed.words.map((word) => word.timeMs)).toEqual([
      12_000, 12_000, 12_000, 14_000, 14_000, 14_000,
    ]);

    const tooLong = draftForRefinement(
      Array.from(
        { length: ALIGN_MAX_LYRICS_WORDS / 10 + 1 },
        (_, index) =>
          `[00:${String(index % 60).padStart(2, '0')}.00] uno due tre quattro cinque sei sette otto nove dieci`,
      ).join('\n'),
    );
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.refusal).toMatchObject({ kind: 'refine_invalid' });
    expect((tooLong.refusal as { message: string }).message).toContain('troppe parole');
  });

  it('cleanRefinedLines toglie tempi, etichette e righe vuote; trackNameOf solo il nome del file', () => {
    expect(
      cleanRefinedLines([
        '[00:01.00] Prima',
        ' ',
        '[Intro]',
        '<00:02.00>Seconda  riga',
        '(x2)',
        '♪',
      ]),
    ).toEqual(['Prima', 'Seconda riga']);
    expect(trackNameOf('Cartella/Sotto/Artista - Titolo.flac')).toBe('Artista - Titolo');
    expect(trackNameOf('Titolo.mp3')).toBe('Titolo');
  });

  it('refinementMessage: brano, lingua, conteggio e le righe nel tag', () => {
    const text = refinementMessage(SONG, ['una riga', 'due righe'], 'fr');
    expect(text).toBe(
      'Brano: Autrice - Canzone\nLingua del testo: francese\nRighe della trascrizione: 2\n\n<trascrizione>\nuna riga\ndue righe\n</trascrizione>',
    );
  });

  it('checkRefinedLyrics su una bozza con i tempi delle righe: LRC semplice, wordTimed false', () => {
    const draft = draftForRefinement(
      '[00:12.00] sotto il celo di roma\n[00:14.00] canto per me stasera\n[00:15.60] e la luna ci guarda',
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const checked = checkRefinedLyrics(draft, REFINED, 184.4);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.result.wordTimed).toBe(false);
    expect(checked.result.draft.split('\n')).toEqual([
      '[00:12.00] Sotto il cielo di Roma,',
      '[00:14.00] canto per te stasera',
      '[00:15.60] e la luna ci guarda.',
    ]);
    expect(checked.result.refined.matchedWords).toBe(13);
  });
});
