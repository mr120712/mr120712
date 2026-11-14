// @polsia:user-owned — trascrizione IA dei testi, parti pure e client Whisper: tempi LRC (centesimi,
// zeri, ore che diventano minuti oltre i 60 minuti), pulizia dei segmenti con le regole del parser,
// filtro conservativo delle allucinazioni (crediti dei sottotitoli, silenzio) che tiene i
// ritornelli ripetuti, validazione del testo da salvare, nome del .lrc a prova di "..", richiesta
// multipart a OpenAI (modello, formato, granularità, estensione originale, lingua), errori mappati
// in italiano senza il testo di OpenAI né la chiave, e svuotamento della cache del testo di UN
// brano.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@vercel/blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vercel/blob')>()),
  get: mocks.get,
}));
vi.mock('@/lib/env', () => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', NEXT_PUBLIC_APP_URL: 'https://solco.test' },
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  clearFeaturedLyricsCacheForTests,
  getFeaturedLyricsAvailability,
  invalidateFeaturedLyricsCache,
} from '@/lib/music/featured-lyrics.server';
import type { FeaturedLyricsSource } from '@/lib/music/featured-search.server';
import { parseLyrics } from '@/lib/music/lyrics';
import {
  buildDraftLrc,
  cleanSegmentText,
  formatLrcTimestamp,
  isLikelySilence,
  isWhisperArtefact,
  lrcPathnameFor,
  validateLrcForSave,
} from '@/lib/music/lyrics-transcription.server';
import {
  isWhisperConfigured,
  parseWhisperResponse,
  transcribeWithWhisper,
  WHISPER_ENDPOINT,
  type WhisperSegment,
  whisperExtension,
} from '@/lib/music/whisper.server';

const KEY = 'sk-test-CHIAVE-SEGRETA-9f3a';
const UPSTREAM_DETAIL =
  'Incorrect API key provided: sk-test-CHIAVE-SEGRETA-9f3a. dettaglio interno';

function segment(start: number, text: string, extra: Partial<WhisperSegment> = {}): WhisperSegment {
  return {
    start,
    end: start + 2,
    text,
    avgLogprob: -0.2,
    noSpeechProb: 0.01,
    compressionRatio: 1.2,
    ...extra,
  };
}

describe('tempi LRC', () => {
  it('[mm:ss.xx] con zeri e centesimi arrotondati', () => {
    expect(formatLrcTimestamp(0)).toBe('[00:00.00]');
    expect(formatLrcTimestamp(1.5)).toBe('[00:01.50]');
    expect(formatLrcTimestamp(12.345)).toBe('[00:12.35]');
    expect(formatLrcTimestamp(59.999)).toBe('[01:00.00]');
    expect(formatLrcTimestamp(61.07)).toBe('[01:01.07]');
  });

  it('oltre i 60 minuti le ore diventano minuti; valori non validi → [00:00.00]', () => {
    expect(formatLrcTimestamp(3600)).toBe('[60:00.00]');
    expect(formatLrcTimestamp(3725.5)).toBe('[62:05.50]');
    expect(formatLrcTimestamp(-3)).toBe('[00:00.00]');
    expect(formatLrcTimestamp(Number.NaN)).toBe('[00:00.00]');
    // Il parser legge lo stesso tempo.
    expect(parseLyrics(`${formatLrcTimestamp(3725.5)} Coda`)?.lines[0]?.timeMs).toBe(3_725_500);
  });
});

describe('pulizia dei segmenti', () => {
  it('una riga sola, senza caratteri di controllo o bidi, senza tempi finti nel testo', () => {
    expect(cleanSegmentText('  Ciao\n  mondo\u202e\u0007  ')).toBe('Ciao mondo');
    expect(cleanSegmentText('[00:12.00] doppio <00:01.00>tempo')).toBe('doppio tempo');
    expect(cleanSegmentText('x'.repeat(900))).toHaveLength(500);
  });
});

describe('allucinazioni di Whisper', () => {
  it('riconosce i crediti dei sottotitoli e i saluti da video, in più lingue', () => {
    for (const text of [
      'Sottotitoli a cura di QTSS',
      'Sottotitoli creati dalla comunità Amara.org',
      'Sottotitoli e revisione a cura di QTSS',
      'Grazie per la visione!',
      'Grazie a tutti per la visione.',
      'Thanks for watching!',
      'Thank you for watching.',
      'Subtitles by the Amara.org community',
      'Untertitel der Amara.org-Community',
      'Sous-titres réalisés par la communauté d’Amara.org',
      'Subtítulos realizados por la comunidad de Amara.org',
      '« Sottotitoli a cura di QTSS »',
    ]) {
      expect(isWhisperArtefact(text), text).toBe(true);
    }
  });

  it('non scarta righe vere che contengono parole simili', () => {
    for (const text of [
      'Grazie mille amore mio',
      'Ho letto i sottotitoli a cura di te',
      'Thanks for everything',
      'La visione di te',
      'Ritornello',
      // Righe vere che INIZIANO come un saluto o un credito: restano.
      'Thank you for watching over me',
      'Thanks for watching me fall',
      'Grazie per aver guardato le stelle con me',
      'Sottotitoli di una vita',
      'I said thanks for watching over me',
    ]) {
      expect(isWhisperArtefact(text), text).toBe(false);
    }
  });

  it('una riga vera che inizia come un saluto resta nella bozza', () => {
    const result = buildDraftLrc([
      segment(1, 'Thank you for watching over me'),
      segment(5, 'Thanks for watching!'),
      segment(9, 'Sottotitoli di una vita'),
    ]);
    expect(result.draft).toBe(
      '[00:01.00] Thank you for watching over me\n[00:09.00] Sottotitoli di una vita',
    );
    expect(result.droppedSegments).toBe(1);
  });

  it('silenzio solo con no_speech_prob > 0.6 E avg_logprob < -1', () => {
    expect(isLikelySilence({ noSpeechProb: 0.9, avgLogprob: -1.5 })).toBe(true);
    expect(isLikelySilence({ noSpeechProb: 0.9, avgLogprob: -0.5 })).toBe(false);
    expect(isLikelySilence({ noSpeechProb: 0.5, avgLogprob: -1.5 })).toBe(false);
    expect(isLikelySilence({ noSpeechProb: 0.6, avgLogprob: -1.01 })).toBe(false);
    expect(isLikelySilence({ noSpeechProb: null, avgLogprob: -3 })).toBe(false);
  });
});

describe('bozza LRC', () => {
  it('una riga per segmento, ritornelli ripetuti tenuti, allucinazioni e silenzi scartati', () => {
    const result = buildDraftLrc([
      segment(0.4, 'Sottotitoli creati dalla comunità Amara.org'),
      segment(12.3, ' Prima strofa '),
      segment(20, 'Ritornello'),
      segment(28, 'Ritornello'),
      segment(31, '...', { noSpeechProb: 0.95, avgLogprob: -1.8 }),
      segment(40, '   '),
      segment(3725.5, 'Ritornello'),
      segment(3730, 'Grazie per la visione'),
    ]);
    expect(result.draft).toBe(
      [
        '[00:12.30] Prima strofa',
        '[00:20.00] Ritornello',
        '[00:28.00] Ritornello',
        '[62:05.50] Ritornello',
      ].join('\n'),
    );
    expect(result.droppedSegments).toBe(3);
    expect(result.lineCount).toBe(4);
    expect(parseLyrics(result.draft)?.kind).toBe('synced');
  });

  it('mai oltre 1000 righe né 64 KB: si può sempre salvare', () => {
    const many = Array.from({ length: 1500 }, (_, index) => segment(index, `Riga ${index}`));
    const lines = buildDraftLrc(many);
    expect(lines.draft.split('\n')).toHaveLength(1000);
    expect(validateLrcForSave(lines.draft).ok).toBe(true);

    const long = Array.from({ length: 400 }, (_, index) => segment(index, 'è'.repeat(400)));
    const bytes = buildDraftLrc(long);
    expect(new TextEncoder().encode(bytes.draft).length).toBeLessThanOrEqual(64 * 1024);
    expect(validateLrcForSave(bytes.draft).ok).toBe(true);
  });

  it('nessun segmento utile → bozza vuota, zero righe', () => {
    expect(buildDraftLrc([segment(1, 'Thanks for watching!')])).toEqual({
      draft: '',
      lineCount: 0,
      droppedSegments: 1,
    });
  });
});

describe('testo da salvare', () => {
  it('accetta LRC e testo semplice, normalizzati e con a capo finale', () => {
    expect(validateLrcForSave('[00:01.00] Uno\r\n[00:02.00] Due\u202e  ')).toEqual({
      ok: true,
      content: '[00:01.00] Uno\n[00:02.00] Due\n',
    });
    expect(validateLrcForSave('Strofa\n\n\n\nRitornello')).toEqual({
      ok: true,
      content: 'Strofa\n\nRitornello\n',
    });
  });

  it('rifiuta testo vuoto, troppe righe, righe troppo lunghe, oltre 64 KB', () => {
    expect(validateLrcForSave('   \n  ')).toEqual({
      ok: false,
      message: 'Il testo è vuoto: scrivi almeno una riga.',
    });
    expect(validateLrcForSave('[ar:Solo metadati]')).toMatchObject({ ok: false });
    expect(
      validateLrcForSave(Array.from({ length: 1001 }, (_, index) => `Riga ${index}`).join('\n')),
    ).toEqual({ ok: false, message: 'Il testo supera 1000 righe.' });
    expect(validateLrcForSave(`Uno\n${'a'.repeat(1001)}`)).toEqual({
      ok: false,
      message: 'La riga 2 è troppo lunga (al massimo 1000 caratteri).',
    });
    const big = Array.from({ length: 200 }, () => 'è'.repeat(400)).join('\n');
    expect(validateLrcForSave(big)).toEqual({
      ok: false,
      message: 'Il testo supera 64 KB: accorcialo prima di salvarlo.',
    });
  });
});

describe('nome del .lrc', () => {
  it('stessa cartella, stesso nome, estensione .lrc', () => {
    expect(lrcPathnameFor('Cantautori/Autrice - Canzone.mp3')).toBe(
      'Cantautori/Autrice - Canzone.lrc',
    );
    expect(lrcPathnameFor('Radice.FLAC')).toBe('Radice.lrc');
    expect(lrcPathnameFor('a/b/Nome.con.punti.m4a')).toBe('a/b/Nome.con.punti.lrc');
  });

  it('niente risalite, percorsi assoluti, upload degli utenti o file non audio', () => {
    for (const pathname of [
      '../diritti.json',
      'Cantautori/../diritti.mp3',
      './x.mp3',
      '/assoluto.mp3',
      'a\\b.mp3',
      'public-uploads/utente.mp3',
      'diritti.json',
      'Cantautori/Autrice - Canzone.lrc',
      'https://evil.test/x.mp3',
      '',
    ]) {
      expect(lrcPathnameFor(pathname), pathname).toBeNull();
    }
  });
});

describe('client Whisper', () => {
  const audio = new Uint8Array([1, 2, 3, 4, 5]);
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function okResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('formati accettati e chiave dalla variabile del server', () => {
    expect(whisperExtension('Cartella/Brano.MP3')).toBe('mp3');
    expect(whisperExtension('a.oga')).toBe('oga');
    expect(whisperExtension('a.opus')).toBeNull();
    expect(whisperExtension('a.aac')).toBeNull();
    expect(whisperExtension('a.m4b')).toBeNull();
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(isWhisperConfigured()).toBe(false);
    vi.stubEnv('OPENAI_API_KEY', ` ${KEY} `);
    expect(isWhisperConfigured()).toBe(true);
  });

  it('richiesta multipart: modello, formato, granularità, temperatura, estensione, lingua', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ text: 'x', language: 'italian', duration: 3, segments: [] }),
    );
    const result = await transcribeWithWhisper({
      audio,
      extension: 'flac',
      language: 'it',
      apiKey: KEY,
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WHISPER_ENDPOINT);
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    // Il boundary del multipart lo mette fetch: nessun content-type a mano.
    expect(new Headers(init.headers).get('content-type')).toBeNull();
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['segment']);
    expect(form.get('temperature')).toBe('0');
    expect(form.get('language')).toBe('it');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.flac');
    expect(file.type).toBe('audio/flac');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
  });

  it('senza lingua: riconoscimento automatico (campo assente)', async () => {
    fetchMock.mockResolvedValue(okResponse({ segments: [] }));
    await transcribeWithWhisper({ audio, extension: 'mp3', apiKey: KEY });
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.has('language')).toBe(false);
    expect((form.get('file') as File).name).toBe('audio.mp3');
  });

  it('risposta letta in modo tollerante: campi in più ok, segmenti malformati saltati', () => {
    const transcript = parseWhisperResponse({
      task: 'transcribe',
      text: 'Ciao',
      language: 'Italian',
      duration: 12.5,
      extra: { qualsiasi: true },
      segments: [
        {
          id: 0,
          seek: 0,
          start: 0.5,
          end: 2,
          text: ' Ciao',
          tokens: [1, 2],
          temperature: 0,
          avg_logprob: -0.3,
          compression_ratio: 1.1,
          no_speech_prob: 0.02,
        },
        { start: 'x', end: 2, text: 'rotto' },
        { start: 3, end: 4, text: 'senza probabilità' },
        null,
      ],
    });
    expect(transcript).toEqual({
      text: 'Ciao',
      language: 'italian',
      durationSeconds: 12.5,
      segments: [
        {
          start: 0.5,
          end: 2,
          text: ' Ciao',
          avgLogprob: -0.3,
          noSpeechProb: 0.02,
          compressionRatio: 1.1,
        },
        {
          start: 3,
          end: 4,
          text: 'senza probabilità',
          avgLogprob: null,
          noSpeechProb: null,
          compressionRatio: null,
        },
      ],
    });
    expect(parseWhisperResponse({ text: 'senza segmenti' })).toBeNull();
    expect(parseWhisperResponse('testo')).toBeNull();
    expect(parseWhisperResponse({ segments: [], language: '<script>' })?.language).toBeNull();
  });

  it('errori in italiano, senza il testo di OpenAI né la chiave', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const upstream = (status: number, message = UPSTREAM_DETAIL) =>
      new Response(JSON.stringify({ error: { message, type: 'x', code: 'y' } }), { status });
    const cases: Array<[() => Promise<Response>, string, string]> = [
      [async () => upstream(401), 'invalid_key', 'chiave OpenAI non valida'],
      [async () => upstream(403), 'invalid_key', 'chiave OpenAI non valida'],
      [async () => upstream(429), 'rate_limited', 'limite OpenAI raggiunto, riprova più tardi'],
      [async () => upstream(413), 'too_large', 'file troppo grande'],
      [
        async () => upstream(400, 'Maximum content size limit (26214400) exceeded'),
        'too_large',
        'file troppo grande',
      ],
      [async () => upstream(400), 'rejected', 'non ha accettato il file audio'],
      [async () => upstream(500), 'unavailable', 'OpenAI ha un problema'],
      [async () => upstream(503), 'unavailable', 'OpenAI ha un problema'],
      [
        async () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_DETAIL}`)),
        'no_response',
        'OpenAI non risponde',
      ],
      [async () => new Response('non json {', { status: 200 }), 'invalid_response', 'formato'],
    ];
    for (const [respond, code, text] of cases) {
      fetchMock.mockImplementationOnce(respond);
      const result = await transcribeWithWhisper({ audio, extension: 'mp3', apiKey: KEY });
      expect(result.ok, code).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBe(code);
      expect(result.message).toContain(text);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain('dettaglio interno');
      expect(JSON.stringify(result)).not.toContain('Incorrect API key');
    }
    expect(JSON.stringify([errors.mock.calls, warns.mock.calls])).not.toContain(KEY);
  });

  it('scadenza: la chiamata si interrompe e risponde "OpenAI non risponde"', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const result = await transcribeWithWhisper({
      audio,
      extension: 'mp3',
      apiKey: KEY,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ ok: false, error: 'no_response' });
    // La richiesta era partita: conta.
    expect(result).not.toHaveProperty('notSent');
  });

  it('non partita (annullata prima, DNS, connessione rifiutata) → notSent; altri errori no', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await transcribeWithWhisper({ audio, extension: 'mp3', apiKey: KEY, signal: aborted.signal }),
    ).toMatchObject({ ok: false, error: 'no_response', notSent: true });
    expect(fetchMock).not.toHaveBeenCalled();

    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']) {
      fetchMock.mockRejectedValueOnce(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error(UPSTREAM_DETAIL), { code }),
        }),
      );
      const result = await transcribeWithWhisper({ audio, extension: 'mp3', apiKey: KEY });
      expect(result, code).toMatchObject({ ok: false, error: 'no_response', notSent: true });
      expect(JSON.stringify(result)).not.toContain('dettaglio interno');
    }
    for (const error of [
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
      }),
      new TypeError('fetch failed'),
    ]) {
      fetchMock.mockRejectedValueOnce(error);
      const result = await transcribeWithWhisper({ audio, extension: 'mp3', apiKey: KEY });
      expect(result).toMatchObject({ ok: false, error: 'no_response' });
      expect(result).not.toHaveProperty('notSent');
    }
  });

  it('file vuoto o oltre 25 MB: nessuna chiamata', async () => {
    expect(
      await transcribeWithWhisper({ audio: new Uint8Array(), extension: 'mp3', apiKey: KEY }),
    ).toMatchObject({ ok: false, error: 'rejected' });
    expect(
      await transcribeWithWhisper({
        audio: new Uint8Array(25 * 1000 * 1000 + 1),
        extension: 'mp3',
        apiKey: KEY,
      }),
    ).toMatchObject({ ok: false, error: 'too_large' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('cache del testo di un brano', () => {
  const source = (pathname: string): FeaturedLyricsSource => ({
    pathname,
    holder: 'Autrice',
    audioPublic: false,
    sidecars: [
      {
        pathname: pathname.replace(/\.mp3$/, '.lrc'),
        url: `https://store.private.blob.vercel-storage.com/${encodeURIComponent(pathname)}`,
        size: 30,
        uploadedAt: new Date('2026-11-01T00:00:00Z'),
      },
    ],
  });

  beforeEach(() => {
    clearFeaturedLyricsCacheForTests();
    mocks.get.mockReset();
    mocks.get.mockImplementation(async () => {
      const bytes = new TextEncoder().encode('[00:01.00]Uno\n[00:02.00]Due');
      return {
        statusCode: 200,
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        headers: new Headers({ 'content-length': String(bytes.length) }),
      };
    });
  });

  it('invalidateFeaturedLyricsCache rilegge SOLO il brano indicato', async () => {
    const first = source('Cantautori/Autrice - Canzone.mp3');
    const other = source('Rock/Band - Inno.mp3');
    expect(await getFeaturedLyricsAvailability(first)).toMatchObject({
      status: 'lrc',
      lineCount: 2,
    });
    await getFeaturedLyricsAvailability(other);
    expect(mocks.get).toHaveBeenCalledTimes(2);

    // In cache: nessuna nuova lettura.
    await getFeaturedLyricsAvailability(first);
    await getFeaturedLyricsAvailability(other);
    expect(mocks.get).toHaveBeenCalledTimes(2);

    invalidateFeaturedLyricsCache(first.pathname);
    await getFeaturedLyricsAvailability(first);
    await getFeaturedLyricsAvailability(other);
    expect(mocks.get).toHaveBeenCalledTimes(3);
    expect(mocks.get.mock.calls[2]?.[0]).toBe('Cantautori/Autrice%20-%20Canzone.lrc');
  });
});
