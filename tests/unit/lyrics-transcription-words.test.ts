// @polsia:user-owned — bozza LRC con i tempi delle parole (karaoke) e righe incerte: le parole di
// Whisper si assegnano al segmento per tempo (consumate una volta sola, margine di 50 ms), la riga
// diventa "[mm:ss.xx] <mm:ss.xx>parola…", le righe senza parole restano semplici, le allucinazioni
// si scartano insieme alle loro parole, oltre 64 KB si torna riga per riga; isUncertainSegment e
// la numerazione delle righe incerte; parole lette dalla risposta; richiesta con granularità
// "word" e suggerimento (titolo e artista) pulito; hasWordTags; il parser rilegge la bozza.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', NEXT_PUBLIC_APP_URL: 'https://solco.test' },
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { TRANSCRIPTION_LRC_MAX_BYTES } from '@/lib/contracts/lyrics-transcription';
import { parseLyrics } from '@/lib/music/lyrics';
import {
  buildDraftLrc,
  DRAFT_BUILDER_VERSION,
  formatLrcTime,
  hasWordTags,
  isUncertainSegment,
  transcriptionPrompt,
} from '@/lib/music/lyrics-transcription.server';
import {
  parseWhisperResponse,
  transcribeWithWhisper,
  type WhisperSegment,
  type WhisperWord,
} from '@/lib/music/whisper.server';

const KEY = 'gsk_test_CHIAVE_finta_0000000000000000000000000000000000';

function segment(
  start: number,
  end: number,
  text: string,
  extra: Partial<WhisperSegment> = {},
): WhisperSegment {
  return {
    start,
    end,
    text,
    avgLogprob: -0.2,
    noSpeechProb: 0.01,
    compressionRatio: 1.2,
    ...extra,
  };
}

function word(start: number, text: string, end = start + 0.3): WhisperWord {
  return { start, end, text };
}

describe('buildDraftLrc con le parole', () => {
  it('assegna le parole ai segmenti per tempo e scrive l’Enhanced LRC', () => {
    const result = buildDraftLrc(
      [segment(12.3, 15, ' Prima strofa cantata'), segment(20, 22, ' Ritornello intero')],
      [
        word(12.3, ' Prima'),
        word(12.8, ' strofa'),
        word(13.4, ' cantata'),
        word(20.0, ' Ritornello'),
        word(20.9, ' intero'),
      ],
    );
    expect(result.draft).toBe(
      [
        '[00:12.30] <00:12.30>Prima <00:12.80>strofa <00:13.40>cantata',
        '[00:20.00] <00:20.00>Ritornello <00:20.90>intero',
      ].join('\n'),
    );
    expect(result).toMatchObject({
      lineCount: 2,
      droppedSegments: 0,
      uncertainLines: [],
      wordTimed: true,
    });
    // Il player rilegge righe e parole.
    const parsed = parseLyrics(result.draft);
    expect(parsed?.lines[0]?.text).toBe('Prima strofa cantata');
    expect(parsed?.lines[0]?.words?.map((w) => w.timeMs)).toEqual([12_300, 12_800, 13_400]);
    expect(DRAFT_BUILDER_VERSION).toBe(2);
    expect(formatLrcTime(61.07)).toBe('01:01.07');
  });

  it('segmento con una parola sola o senza parole → riga semplice; parole fuori tempo ignorate', () => {
    const result = buildDraftLrc(
      [segment(1, 2, 'Solo'), segment(5, 7, 'Due parole qui'), segment(10, 12, 'Niente')],
      [
        word(0.2, 'prima'),
        word(1, 'Solo'),
        word(5, 'Due'),
        word(5.5, 'parole'),
        word(6.1, 'qui'),
        word(20, 'dopo'),
      ],
    );
    expect(result.draft).toBe(
      [
        '[00:01.00] Solo',
        '[00:05.00] <00:05.00>Due <00:05.50>parole <00:06.10>qui',
        '[00:10.00] Niente',
      ].join('\n'),
    );
    expect(result.wordTimed).toBe(true);
    // Senza parole: come prima.
    const plain = buildDraftLrc([segment(1, 2, 'Solo'), segment(5, 7, 'Due parole qui')]);
    expect(plain.draft).toBe('[00:01.00] Solo\n[00:05.00] Due parole qui');
    expect(plain.wordTimed).toBe(false);
    expect(hasWordTags(result.draft)).toBe(true);
    expect(hasWordTags(plain.draft)).toBe(false);
  });

  it('le parole di un segmento scartato non finiscono nella riga dopo; tag finti tolti dalle parole', () => {
    const result = buildDraftLrc(
      [segment(1, 3, ' Sottotitoli a cura di QTSS'), segment(5, 7, ' Vera strofa <00:01.00>qui')],
      [
        word(1, 'Sottotitoli'),
        word(1.5, 'a'),
        word(1.8, 'cura'),
        word(2.1, 'di'),
        word(2.4, 'QTSS'),
        word(5, 'Vera'),
        word(5.6, 'strofa'),
        word(6.2, '<00:01.00>qui'),
      ],
    );
    expect(result.droppedSegments).toBe(1);
    expect(result.draft).toBe('[00:05.00] <00:05.00>Vera <00:05.60>strofa <00:06.20>qui');
  });

  it('oltre 64 KB con le parole: torna riga per riga', () => {
    const segments: WhisperSegment[] = [];
    const words: WhisperWord[] = [];
    // Con le parole ogni riga pesa ~150 byte (75 KB in tutto); riga per riga ~70 (35 KB).
    for (let index = 0; index < 500; index += 1) {
      const start = index * 2;
      const text = Array.from({ length: 8 }, (_, w) => `parola${w}`).join(' ');
      segments.push(segment(start, start + 1.9, text));
      for (let w = 0; w < 8; w += 1) words.push(word(start + w * 0.2, `parola${w}`));
    }
    const result = buildDraftLrc(segments, words);
    expect(result.wordTimed).toBe(false);
    expect(hasWordTags(result.draft)).toBe(false);
    expect(new TextEncoder().encode(result.draft).length).toBeLessThanOrEqual(
      TRANSCRIPTION_LRC_MAX_BYTES,
    );
    expect(result.lineCount).toBe(500);
  });

  it('righe incerte: numerate sulla bozza (i segmenti scartati non contano)', () => {
    const result = buildDraftLrc([
      segment(1, 2, 'Sottotitoli a cura di QTSS'),
      segment(3, 4, 'Sicura'),
      segment(5, 6, 'Dubbia', { avgLogprob: -0.9 }),
      segment(7, 8, 'Forse silenzio', { noSpeechProb: 0.5 }),
      segment(9, 10, 'Ripetitiva ripetitiva', { compressionRatio: 3 }),
      segment(11, 12, 'Senza misure', {
        avgLogprob: null,
        noSpeechProb: null,
        compressionRatio: null,
      }),
    ]);
    expect(result.droppedSegments).toBe(1);
    expect(result.uncertainLines).toEqual([2, 3, 4]);
    expect(
      isUncertainSegment({ avgLogprob: -0.59, noSpeechProb: 0.4, compressionRatio: 2.4 }),
    ).toBe(false);
    expect(
      isUncertainSegment({ avgLogprob: -0.61, noSpeechProb: null, compressionRatio: null }),
    ).toBe(true);
  });
});

describe('suggerimento al modello', () => {
  it('artista e titolo dal nome del file, o solo il titolo', () => {
    expect(transcriptionPrompt('Cantautori/Autrice - Canzone.mp3')).toBe('Autrice - Canzone');
    expect(transcriptionPrompt('Pop/Solo titolo.flac')).toBe('Solo titolo');
  });
});

describe('client: parole e suggerimento', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chiede le parole e manda il suggerimento pulito; senza richiesta niente parole', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ segments: [] }), { status: 200 }));
    await transcribeWithWhisper({
      audio: new Uint8Array([1, 2, 3]),
      extension: 'mp3',
      apiKey: KEY,
      prompt: `  Autrice  -\n Canzone ${'x'.repeat(600)}`,
      wordTimestamps: true,
    });
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.getAll('timestamp_granularities[]')).toEqual(['segment', 'word']);
    const prompt = form.get('prompt') as string;
    expect(prompt.startsWith('Autrice - Canzone x')).toBe(true);
    expect(prompt.length).toBe(400);

    await transcribeWithWhisper({
      audio: new Uint8Array([1]),
      extension: 'mp3',
      apiKey: KEY,
      prompt: '   ',
    });
    const plain = (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as FormData;
    expect(plain.getAll('timestamp_granularities[]')).toEqual(['segment']);
    expect(plain.has('prompt')).toBe(false);
  });

  it('legge le parole della risposta in modo tollerante', () => {
    const transcript = parseWhisperResponse({
      text: 'Ciao mondo',
      segments: [{ start: 0, end: 1, text: ' Ciao mondo' }],
      words: [
        { word: ' Ciao', start: 0.1, end: 0.4 },
        { word: 'mondo', start: 0.5, end: 0.9, extra: true },
        { word: '', start: 1, end: 1.1 },
        { word: 'rotto', start: 'x', end: 2 },
        null,
      ],
    });
    expect(transcript?.words).toEqual([
      { start: 0.1, end: 0.4, text: 'Ciao' },
      { start: 0.5, end: 0.9, text: 'mondo' },
    ]);
    expect(parseWhisperResponse({ segments: [] })?.words).toEqual([]);
  });
});
