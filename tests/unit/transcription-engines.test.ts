// @polsia:user-owned — «Solco AI» con più motori: gli adattatori dei protocolli non in stile OpenAI
// (Deepgram: URL con modello e lingua, Token, byte grezzi, risposta con utterances/parole/lingua
// riconosciuta; ElevenLabs Scribe: multipart con model_id e parole, xi-api-key, parole → righe dalle
// pause e dalla punteggiatura, lingua ISO-639-3 → ISO-639-1, 401 di quota → crediti; Cloudflare
// Workers AI: JSON con audio in base64 e suggerimento, Bearer, risposta con le parole dentro i
// segmenti, 400 di autenticazione → chiave), le righe dalle sole parole (segmentsFromWords), la prova
// di qualunque motore (probeProvider) e il PASSAGGIO AUTOMATICO (transcribeWithFailover: ordine,
// stop sull'audio rifiutato o troppo grande, notSent solo se nessuna richiesta è partita, messaggio
// con tutti i motivi, scadenza, annullamento). Mistral: niente tempi delle parole nella richiesta.
// Mai la chiave nei risultati.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/env', () => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', NEXT_PUBLIC_APP_URL: 'https://solco.test' },
}));

import {
  parseCloudflareResponse,
  postToCloudflare,
  transcribeWithCloudflare,
} from '@/lib/music/cloudflare-ai.server';
import {
  deepgramUrl,
  logprobFromConfidence,
  parseDeepgramResponse,
  postToDeepgram,
  transcribeWithDeepgram,
} from '@/lib/music/deepgram.server';
import {
  elevenLabsLanguage,
  parseElevenLabsResponse,
  postToElevenLabs,
  transcribeWithElevenLabs,
} from '@/lib/music/elevenlabs.server';
import {
  combinedFailure,
  FAILOVER_MIN_ATTEMPT_MS,
  failsOver,
  probeProvider,
  transcribeWithFailover,
  transcribeWithProvider,
} from '@/lib/music/transcription-engines.server';
import {
  type TranscriptionProvider,
  type TranscriptionProviderId,
  transcriptionProviderFor,
} from '@/lib/music/transcription-provider.server';
import { segmentsFromWords, type WhisperFailure } from '@/lib/music/whisper.server';

const GROQ_KEY = `gsk_${'t3stCHIAVEfinta'.repeat(4).slice(0, 52)}`;
const DEEPGRAM_KEY = 'dgfakekey0123456789abcdef0123456789abcd';
const ELEVEN_KEY = 'sk_elevenfake0123456789abcdef0123456789';
const CLOUDFLARE_TOKEN = 'cf_fake_token_0123456789abcdef';
const MISTRAL_KEY = 'mistralfakekey0123456789';
const ENV = {
  GROQ_API_KEY: GROQ_KEY,
  DEEPGRAM_API_KEY: DEEPGRAM_KEY,
  ELEVENLABS_API_KEY: ELEVEN_KEY,
  CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: 'abc123def4567890',
  MISTRAL_API_KEY: MISTRAL_KEY,
};
const SECRETS = [GROQ_KEY, DEEPGRAM_KEY, ELEVEN_KEY, CLOUDFLARE_TOKEN, MISTRAL_KEY];

function provider(id: TranscriptionProviderId): TranscriptionProvider {
  const found = transcriptionProviderFor(id, ENV);
  if (!found) throw new Error(`motore ${id} atteso`);
  return found;
}

const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 9, 9, 9]);

type Call = [string, RequestInit];

function fetcherOf(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push([url, init ?? {}]);
    return respond(url, init ?? {});
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls, mock: fetcher };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

const DEEPGRAM_BODY = {
  metadata: { duration: 12.5 },
  results: {
    channels: [
      {
        detected_language: 'it',
        alternatives: [
          {
            transcript: 'Sotto il cielo. Canto per te',
            confidence: 0.98,
            words: [
              { word: 'sotto', start: 0.1, end: 0.4, confidence: 0.99, punctuated_word: 'Sotto' },
              { word: 'il', start: 0.5, end: 0.6, confidence: 0.97 },
              { word: 'cielo', start: 0.7, end: 1.1, confidence: 0.9, punctuated_word: 'cielo.' },
              { word: 'canto', start: 2.5, end: 2.9, confidence: 0.95, punctuated_word: 'Canto' },
              { word: 'per', start: 3.0, end: 3.1, confidence: 0.9 },
              { word: 'te', start: 3.2, end: 3.4, confidence: 0.8 },
            ],
          },
        ],
      },
    ],
    utterances: [
      { start: 0.1, end: 1.1, transcript: 'Sotto il cielo.', confidence: 0.95 },
      { start: 2.5, end: 3.4, transcript: 'Canto per te', confidence: 0.88 },
    ],
  },
};

const ELEVENLABS_BODY = {
  language_code: 'ita',
  language_probability: 0.99,
  text: 'Sotto il cielo. Canto per te',
  words: [
    { text: 'Sotto', start: 0.1, end: 0.4, type: 'word', logprob: -0.1 },
    { text: ' ', start: 0.4, end: 0.5, type: 'spacing' },
    { text: 'il', start: 0.5, end: 0.6, type: 'word', logprob: -0.2 },
    { text: 'cielo.', start: 0.7, end: 1.1, type: 'word', logprob: -0.3 },
    { text: '(musica)', start: 1.1, end: 2.4, type: 'audio_event' },
    { text: 'Canto', start: 2.5, end: 2.9, type: 'word', logprob: -0.1 },
    { text: 'per', start: 3.0, end: 3.1, type: 'word', logprob: -0.1 },
    { text: 'te', start: 3.2, end: 3.4, type: 'word', logprob: -0.7 },
  ],
};

const CLOUDFLARE_BODY = {
  success: true,
  errors: [],
  messages: [],
  result: {
    text: 'Sotto il cielo',
    word_count: 3,
    transcription_info: { language: 'it', language_probability: 0.99, duration: 12.5 },
    segments: [
      {
        start: 0.1,
        end: 1.1,
        text: ' Sotto il cielo',
        temperature: 0,
        avg_logprob: -0.2,
        compression_ratio: 1.1,
        no_speech_prob: 0.01,
        words: [
          { word: 'Sotto', start: 0.1, end: 0.4 },
          { word: 'il', start: 0.5, end: 0.6 },
          { word: 'cielo', start: 0.7, end: 1.1 },
        ],
      },
    ],
  },
};

describe('segmentsFromWords', () => {
  it('riga nuova dopo una pausa lunga, dopo un punto con una pausa breve o oltre 16 parole', () => {
    const words = [
      { start: 0, end: 0.3, text: 'Uno' },
      { start: 0.35, end: 0.6, text: 'due.' },
      { start: 0.9, end: 1.1, text: 'Tre' }, // punto + pausa di 0,3 s → riga nuova
      { start: 1.2, end: 1.4, text: 'quattro' },
      { start: 2.5, end: 2.7, text: 'Cinque' }, // pausa di 1,1 s → riga nuova
    ];
    expect(segmentsFromWords(words).map((segment) => segment.text)).toEqual([
      'Uno due.',
      'Tre quattro',
      'Cinque',
    ]);
    const many = Array.from({ length: 20 }, (_, index) => ({
      start: index * 0.3,
      end: index * 0.3 + 0.2,
      text: `p${index}`,
    }));
    expect(segmentsFromWords(many).map((segment) => segment.text.split(' ').length)).toEqual([
      16, 4,
    ]);
    expect(segmentsFromWords([])).toEqual([]);
    const [only] = segmentsFromWords([
      { start: 1, end: 1.5, text: 'a', logprob: -0.2 },
      { start: 1.6, end: 2, text: 'b', logprob: -0.4 },
    ]);
    expect(only).toMatchObject({ start: 1, end: 2, text: 'a b' });
    expect(only?.avgLogprob).toBeCloseTo(-0.3);
    // Senza le log-probabilità di tutte le parole: null.
    expect(segmentsFromWords([{ start: 1, end: 2, text: 'a' }])[0]?.avgLogprob).toBeNull();
  });
});

describe('Deepgram', () => {
  it('URL con modello, punteggiatura, segmenti e lingua (scelta o riconosciuta)', () => {
    const auto = new URL(deepgramUrl(provider('deepgram')));
    expect(auto.origin + auto.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(auto.searchParams)).toEqual({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      utterances: 'true',
      detect_language: 'true',
    });
    const chosen = new URL(deepgramUrl(provider('deepgram'), 'it'));
    expect(chosen.searchParams.get('language')).toBe('it');
    expect(chosen.searchParams.get('detect_language')).toBeNull();
  });

  it('risposta → trascrizione comune: segmenti dalle utterances, parole con punteggiatura, lingua, durata', () => {
    const transcript = parseDeepgramResponse(DEEPGRAM_BODY);
    expect(transcript).not.toBeNull();
    if (!transcript) return;
    expect(transcript.text).toBe('Sotto il cielo. Canto per te');
    expect(transcript.language).toBe('it');
    expect(transcript.durationSeconds).toBe(12.5);
    expect(transcript.segments.map((segment) => segment.text)).toEqual([
      'Sotto il cielo.',
      'Canto per te',
    ]);
    expect(transcript.segments[0]?.avgLogprob).toBeCloseTo(Math.log(0.95));
    expect(transcript.segments[0]).toMatchObject({ noSpeechProb: null, compressionRatio: null });
    expect(transcript.words.map((word) => word.text)).toEqual([
      'Sotto',
      'il',
      'cielo.',
      'Canto',
      'per',
      'te',
    ]);
    expect(transcript.words[2]).toEqual({ start: 0.7, end: 1.1, text: 'cielo.' });
    expect(logprobFromConfidence(1)).toBe(0);
    expect(logprobFromConfidence(undefined)).toBeNull();
    expect(logprobFromConfidence(0)).toBeCloseTo(Math.log(1e-6));
  });

  it('senza utterances le righe vengono dalle parole; senza canale la risposta non vale', () => {
    const body = { ...DEEPGRAM_BODY, results: { ...DEEPGRAM_BODY.results, utterances: undefined } };
    const transcript = parseDeepgramResponse(body);
    expect(transcript?.segments.map((segment) => segment.text)).toEqual([
      'Sotto il cielo.',
      'Canto per te',
    ]);
    expect(parseDeepgramResponse({ results: { channels: [] } })).toBeNull();
    expect(parseDeepgramResponse('x')).toBeNull();
  });

  it('richiesta: Token, content-type dall’estensione, byte grezzi, niente nome del file', async () => {
    const { fetcher, calls } = fetcherOf(() => json(DEEPGRAM_BODY));
    const result = await transcribeWithDeepgram(provider('deepgram'), {
      audio: AUDIO,
      extension: 'mp3',
      language: 'it',
      fetcher,
    });
    expect(result.ok).toBe(true);
    const [url, init] = calls[0] as Call;
    expect(url).toContain('language=it');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Token ${DEEPGRAM_KEY}`);
    expect(headers.get('content-type')).toBe('audio/mpeg');
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect([...(init.body as Uint8Array)]).toEqual([...AUDIO]);
    expect(init.cache).toBe('no-store');
  });

  it('errori: 401 chiave, 402 crediti, 429 limite, 413 dimensione, 5xx servizio, rete; mai la chiave', async () => {
    const cases: Array<[Response | Error, string, boolean | undefined]> = [
      [
        json({ err_code: 'INVALID_AUTH', err_msg: `bad ${DEEPGRAM_KEY}` }, 401),
        'invalid_key',
        undefined,
      ],
      [json({ err_msg: 'Insufficient credits' }, 402), 'no_credit', undefined],
      [json({ err_msg: 'Too many requests' }, 429), 'rate_limited', undefined],
      [json({}, 413), 'too_large', undefined],
      [json({}, 503), 'unavailable', undefined],
      [new TypeError('fetch failed'), 'no_response', undefined],
      [
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
        'no_response',
        true,
      ],
    ];
    for (const [respond, code, notSent] of cases) {
      const { fetcher } = fetcherOf(() => {
        if (respond instanceof Error) throw respond;
        return respond;
      });
      const result = await postToDeepgram(provider('deepgram'), {
        audio: AUDIO,
        extension: 'mp3',
        fetcher,
      });
      expect(result.ok, code).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBe(code);
      expect(result.notSent).toBe(notSent);
      expect(result.message).toContain('Deepgram');
      expectNoSecrets(result);
    }
    const empty = await postToDeepgram(provider('deepgram'), {
      audio: new Uint8Array(),
      extension: 'mp3',
    });
    expect(empty).toMatchObject({ ok: false, error: 'rejected' });
  });
});

describe('ElevenLabs Scribe', () => {
  it('lingua ISO-639-3 → codice del player', () => {
    expect(elevenLabsLanguage('ita')).toBe('it');
    expect(elevenLabsLanguage('ENG')).toBe('en');
    expect(elevenLabsLanguage('it')).toBe('it');
    expect(elevenLabsLanguage('')).toBeNull();
    expect(elevenLabsLanguage(undefined)).toBeNull();
  });

  it('risposta → parole (senza spazi ed eventi), righe dalle pause, lingua, durata, log-probabilità', () => {
    const transcript = parseElevenLabsResponse(ELEVENLABS_BODY);
    expect(transcript).not.toBeNull();
    if (!transcript) return;
    expect(transcript.language).toBe('it');
    expect(transcript.durationSeconds).toBe(3.4);
    expect(transcript.words.map((word) => word.text)).toEqual([
      'Sotto',
      'il',
      'cielo.',
      'Canto',
      'per',
      'te',
    ]);
    expect(transcript.words[0]).toEqual({ start: 0.1, end: 0.4, text: 'Sotto' });
    expect(transcript.segments.map((segment) => segment.text)).toEqual([
      'Sotto il cielo.',
      'Canto per te',
    ]);
    expect(transcript.segments[0]?.avgLogprob).toBeCloseTo(-0.2);
    expect(transcript.segments[1]?.avgLogprob).toBeCloseTo(-0.3);
    expect(parseElevenLabsResponse({ text: 'senza parole' })).toBeNull();
    expect(parseElevenLabsResponse({ words: [] })?.segments).toEqual([]);
  });

  it('richiesta: multipart con file, model_id, parole, lingua; xi-api-key', async () => {
    const { fetcher, calls } = fetcherOf(() => json(ELEVENLABS_BODY));
    const result = await transcribeWithElevenLabs(provider('elevenlabs'), {
      audio: AUDIO,
      extension: 'wav',
      language: 'it',
      fetcher,
    });
    expect(result.ok).toBe(true);
    const [url, init] = calls[0] as Call;
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(new Headers(init.headers).get('xi-api-key')).toBe(ELEVEN_KEY);
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    const form = init.body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
    expect(file.size).toBe(AUDIO.length);
    expect(form.get('model_id')).toBe('scribe_v1');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('tag_audio_events')).toBe('false');
    expect(form.get('diarize')).toBe('false');
    expect(form.get('language_code')).toBe('it');
  });

  it('401 di quota → crediti finiti; 401 di chiave → chiave non valida; 422 → audio rifiutato', async () => {
    const quota = fetcherOf(() =>
      json({ detail: { status: 'quota_exceeded', message: 'x' } }, 401),
    );
    expect(
      await postToElevenLabs(provider('elevenlabs'), {
        audio: AUDIO,
        extension: 'mp3',
        fetcher: quota.fetcher,
      }),
    ).toMatchObject({ ok: false, error: 'no_credit', status: 401 });
    const key = fetcherOf(() => json({ detail: { status: 'invalid_api_key' } }, 401));
    expect(
      await postToElevenLabs(provider('elevenlabs'), {
        audio: AUDIO,
        extension: 'mp3',
        fetcher: key.fetcher,
      }),
    ).toMatchObject({ ok: false, error: 'invalid_key', status: 401 });
    const rejected = fetcherOf(() => json({ detail: 'bad audio' }, 422));
    expect(
      await postToElevenLabs(provider('elevenlabs'), {
        audio: AUDIO,
        extension: 'mp3',
        fetcher: rejected.fetcher,
      }),
    ).toMatchObject({ ok: false, error: 'rejected', status: 422 });
  });
});

describe('Cloudflare Workers AI', () => {
  it('risposta → trascrizione comune con le parole dei segmenti; success false non vale', () => {
    const transcript = parseCloudflareResponse(CLOUDFLARE_BODY);
    expect(transcript).not.toBeNull();
    if (!transcript) return;
    expect(transcript.text).toBe('Sotto il cielo');
    expect(transcript.language).toBe('it');
    expect(transcript.durationSeconds).toBe(12.5);
    expect(transcript.segments).toEqual([
      {
        start: 0.1,
        end: 1.1,
        text: ' Sotto il cielo',
        avgLogprob: -0.2,
        noSpeechProb: 0.01,
        compressionRatio: 1.1,
      },
    ]);
    expect(transcript.words.map((word) => word.text)).toEqual(['Sotto', 'il', 'cielo']);
    expect(parseCloudflareResponse({ success: false, errors: [{ code: 10000 }] })).toBeNull();
    expect(parseCloudflareResponse({ success: true, result: 'x' })).toBeNull();
  });

  it('richiesta: JSON con audio in base64, task, lingua e suggerimento; Bearer; endpoint dell’account', async () => {
    const { fetcher, calls } = fetcherOf(() => json(CLOUDFLARE_BODY));
    const result = await transcribeWithCloudflare(provider('cloudflare'), {
      audio: AUDIO,
      extension: 'mp3',
      language: 'it',
      prompt: '  Autrice -   Canzone ',
      fetcher,
    });
    expect(result.ok).toBe(true);
    const [url, init] = calls[0] as Call;
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/abc123def4567890/ai/run/@cf/openai/whisper-large-v3-turbo',
    );
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${CLOUDFLARE_TOKEN}`);
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      audio: Buffer.from(AUDIO).toString('base64'),
      task: 'transcribe',
      vad_filter: false,
      language: 'it',
      initial_prompt: 'Autrice - Canzone',
    });
  });

  it('400 di autenticazione → chiave non valida; altri 400 → audio rifiutato; 429 → limite', async () => {
    const auth = fetcherOf(() =>
      json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 400),
    );
    expect(
      await postToCloudflare(provider('cloudflare'), {
        audio: AUDIO,
        extension: 'mp3',
        fetcher: auth.fetcher,
      }),
    ).toMatchObject({ ok: false, error: 'invalid_key', status: 400 });
    const bad = fetcherOf(() =>
      json({ success: false, errors: [{ code: 3010, message: 'bad audio' }] }, 400),
    );
    expect(
      await postToCloudflare(provider('cloudflare'), {
        audio: AUDIO,
        extension: 'mp3',
        fetcher: bad.fetcher,
      }),
    ).toMatchObject({ ok: false, error: 'rejected', status: 400 });
    const limit = fetcherOf(() => json({ success: false, errors: [{ code: 3040 }] }, 429));
    expect(
      await postToCloudflare(provider('cloudflare'), {
        audio: AUDIO,
        extension: 'mp3',
        fetcher: limit.fetcher,
      }),
    ).toMatchObject({ ok: false, error: 'rate_limited', status: 429 });
  });
});

describe('transcribeWithProvider e probeProvider', () => {
  it('protocollo in stile OpenAI: Mistral non chiede i tempi delle parole, Groq sì', async () => {
    const whisperBody = { text: '', language: 'italian', duration: 1, segments: [], words: [] };
    const mistral = fetcherOf(() => json(whisperBody));
    await transcribeWithProvider(provider('mistral'), {
      audio: AUDIO,
      extension: 'mp3',
      wordTimestamps: true,
      fetcher: mistral.fetcher,
    });
    const [mistralUrl, mistralInit] = mistral.calls[0] as Call;
    expect(mistralUrl).toBe('https://api.mistral.ai/v1/audio/transcriptions');
    expect(new Headers(mistralInit.headers).get('authorization')).toBe(`Bearer ${MISTRAL_KEY}`);
    const mistralForm = mistralInit.body as FormData;
    expect(mistralForm.get('model')).toBe('voxtral-mini-latest');
    expect(mistralForm.getAll('timestamp_granularities[]')).toEqual(['segment']);

    const groq = fetcherOf(() => json(whisperBody));
    await transcribeWithProvider(provider('groq'), {
      audio: AUDIO,
      extension: 'mp3',
      wordTimestamps: true,
      fetcher: groq.fetcher,
    });
    const groqForm = (groq.calls[0] as Call)[1].body as FormData;
    expect(groqForm.getAll('timestamp_granularities[]')).toEqual(['segment', 'word']);
  });

  it('la prova manda un secondo di silenzio WAV a qualunque motore e non legge il corpo', async () => {
    for (const id of ['deepgram', 'elevenlabs', 'cloudflare'] as const) {
      const { fetcher, calls } = fetcherOf(() => new Response('non json {', { status: 200 }));
      const result = await probeProvider(provider(id), { fetcher });
      expect(result).toMatchObject({ ok: true, model: provider(id).model });
      if (!result.ok) continue;
      expect(result.engine).toContain(provider(id).vendor);
      expect(calls).toHaveLength(1);
      const [, init] = calls[0] as Call;
      if (id === 'deepgram') {
        expect(new Headers(init.headers).get('content-type')).toBe('audio/wav');
        expect((init.body as Uint8Array).length).toBe(44 + 32_000);
      } else if (id === 'elevenlabs') {
        expect(((init.body as FormData).get('file') as File).size).toBe(44 + 32_000);
      } else {
        const body = JSON.parse(String(init.body)) as { audio: string };
        expect(Buffer.from(body.audio, 'base64').length).toBe(44 + 32_000);
      }
    }
    const groq = fetcherOf(() => json({ error: { message: `bad ${GROQ_KEY}` } }, 401));
    const refused = await probeProvider(provider('groq'), { fetcher: groq.fetcher });
    expect(refused).toMatchObject({ ok: false, error: 'invalid_key', status: 401 });
    expect(String((groq.calls[0] as Call)[0])).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions',
    );
    expectNoSecrets(refused);
  });
});

describe('transcribeWithFailover', () => {
  const whisperOk = { text: 'ciao', language: 'italian', duration: 3, segments: [], words: [] };

  it('passa al motore dopo su chiave rifiutata; dice chi ha trascritto e i tentativi falliti', async () => {
    const { fetcher, calls } = fetcherOf((url) =>
      url.startsWith('https://api.groq.com') ? json({ error: 'nope' }, 401) : json(DEEPGRAM_BODY),
    );
    const result = await transcribeWithFailover([provider('groq'), provider('deepgram')], {
      audio: AUDIO,
      extension: 'mp3',
      fetcher,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.id).toBe('deepgram');
    expect(result.transcript.words).toHaveLength(6);
    expect(result.attempts.map((attempt) => [attempt.provider.id, attempt.failure.error])).toEqual([
      ['groq', 'invalid_key'],
    ]);
    expect(calls).toHaveLength(2);
  });

  it('non passa oltre quando il problema è l’audio (troppo grande o rifiutato)', async () => {
    const { fetcher, calls } = fetcherOf(() => json({}, 413));
    const result = await transcribeWithFailover([provider('groq'), provider('deepgram')], {
      audio: AUDIO,
      extension: 'mp3',
      fetcher,
    });
    expect(result).toMatchObject({ ok: false, failure: { error: 'too_large' } });
    expect(calls).toHaveLength(1);
    expect(failsOver('too_large')).toBe(false);
    expect(failsOver('rejected')).toBe(false);
    expect(failsOver('invalid_key')).toBe(true);
    expect(failsOver('no_response')).toBe(true);
  });

  it('tutti falliti: codice del primo, motivi di tutti, notSent solo se nessuna richiesta è partita', async () => {
    const down = fetcherOf((url) =>
      url.startsWith('https://api.groq.com')
        ? json({ error: 'nope' }, 401)
        : json({ err_msg: 'Insufficient credits' }, 402),
    );
    const result = await transcribeWithFailover([provider('groq'), provider('deepgram')], {
      audio: AUDIO,
      extension: 'mp3',
      fetcher: down.fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.error).toBe('invalid_key');
    expect(result.failure.status).toBe(401);
    expect(result.failure.notSent).toBeUndefined();
    expect(result.failure.message).toBe(
      'Trascrizione non riuscita con tutti i motori (Groq: chiave Groq non valida (controlla GROQ_API_KEY su Vercel); Deepgram: crediti Deepgram esauriti o fatturazione non attiva (controlla il piano su console.deepgram.com)).',
    );
    expect(result.attempts).toHaveLength(2);
    expectNoSecrets(result);

    const offline = fetcherOf(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });
    const unsent = await transcribeWithFailover([provider('groq'), provider('deepgram')], {
      audio: AUDIO,
      extension: 'mp3',
      fetcher: offline.fetcher,
    });
    expect(unsent).toMatchObject({ ok: false, failure: { error: 'no_response', notSent: true } });

    const single = await transcribeWithFailover([provider('groq')], {
      audio: AUDIO,
      extension: 'mp3',
      fetcher: down.fetcher,
    });
    expect(single).toMatchObject({
      ok: false,
      failure: {
        error: 'invalid_key',
        message:
          'Trascrizione non riuscita: chiave Groq non valida (controlla GROQ_API_KEY su Vercel).',
      },
    });
    expect(combinedFailure([])).toMatchObject({ ok: false, error: 'unavailable' });
  });

  it('senza tempo per un secondo tentativo o dopo l’annullamento si ferma al primo', async () => {
    const { fetcher, calls } = fetcherOf(() => json({ error: 'nope' }, 401));
    const late = await transcribeWithFailover(
      [provider('groq'), provider('deepgram')],
      { audio: AUDIO, extension: 'mp3', fetcher },
      { deadline: Date.now() + FAILOVER_MIN_ATTEMPT_MS - 1_000 },
    );
    expect(late).toMatchObject({ ok: false, failure: { error: 'invalid_key' } });
    expect(calls).toHaveLength(1);

    const controller = new AbortController();
    const aborting = fetcherOf(() => {
      controller.abort();
      return json({ error: 'nope' }, 401);
    });
    const cancelled = await transcribeWithFailover([provider('groq'), provider('deepgram')], {
      audio: AUDIO,
      extension: 'mp3',
      fetcher: aborting.fetcher,
      signal: controller.signal,
    });
    expect(cancelled.ok).toBe(false);
    expect(aborting.calls).toHaveLength(1);

    const first = fetcherOf(() => json(whisperOk));
    const direct = await transcribeWithFailover([provider('groq'), provider('deepgram')], {
      audio: AUDIO,
      extension: 'mp3',
      fetcher: first.fetcher,
    });
    expect(direct).toMatchObject({ ok: true, provider: { id: 'groq' }, attempts: [] });
    expect(first.calls).toHaveLength(1);
    const failure: WhisperFailure = { ok: false, error: 'unavailable', message: 'x' };
    expect(combinedFailure([{ provider: provider('groq'), failure, elapsedMs: 1 }])).toBe(failure);
  });
});
