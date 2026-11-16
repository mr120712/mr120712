// @polsia:user-owned — allineamento del testo UFFICIALE di un brano in evidenza ai tempi dell'audio
// («Ho il testo: allinea» nella pagina admin «Diritti e testi»). SOLO per i brani dichiarati in
// diritti.json con "testo": true: il permesso, i limiti, la cache cifrata e la chiamata al motore
// sono quelli della trascrizione (transcribeFeaturedTrack): per ogni altro brano la risposta è lo
// stesso 404. L'allineamento in sé (lyrics-align.ts) non costa nulla e non chiama nessuno.
//
// Flusso: il testo incollato si normalizza e si legge col parser dei testi (anche un LRC va bene:
// contano solo le parole; le pause ♪ e le righe vuote si saltano); poi la trascrizione del brano
// (conservata, o nuova con l'inizio del testo come suggerimento al modello, così le parole escono
// scritte giuste), da cui si prendono le parole con tempo; infine l'allineamento, che produce un
// Enhanced LRC con le parole del testo e i tempi dell'audio. Il testo fornito non si conserva da
// nessuna parte e non compare nei log.
import 'server-only';
import type {
  TranscribeResponse,
  TranscriptionLanguage,
} from '@/lib/contracts/lyrics-transcription';
import { LYRICS_INSTRUMENTAL, normalizeLyricsInput, parseLyrics } from '@/lib/music/lyrics';
import {
  ALIGN_MAX_LYRICS_WORDS,
  type AlignmentResult,
  alignLyrics,
  timedWordsFromLyrics,
  tokenizeLyricsLine,
} from '@/lib/music/lyrics-align';
import {
  type TranscriptionRefusal,
  transcribeFeaturedTrack,
} from '@/lib/music/lyrics-transcription.server';

/** Caratteri del testo passati al modello come suggerimento (Whisper lo taglia comunque a 400). */
export const ALIGN_HINT_CHARS = 300;

export const ALIGN_EMPTY_MESSAGE =
  'Il testo è vuoto: incolla il testo del brano, una riga per verso.';

export type AlignInput = {
  pathname: string;
  lyrics: string;
  language?: TranscriptionLanguage;
  /** Identità dell'admin per i limiti della trascrizione, es. "user:<id>". */
  identity: string;
  /** Interruzione della richiesta (l'admin annulla). */
  signal?: AbortSignal;
};

export type AlignOutcome =
  | { ok: true; result: TranscribeResponse }
  | { ok: false; refusal: TranscriptionRefusal };

export type OfficialLyrics =
  | { ok: true; lines: string[]; words: number; hint: string }
  | { ok: false; refusal: TranscriptionRefusal };

/**
 * Le righe del testo fornito (LRC o semplice: contano solo le parole), con il conteggio delle
 * parole e l'inizio del testo da dare al modello; oppure il rifiuto (testo vuoto o troppo lungo).
 */
export function officialLyricsLines(lyrics: string): OfficialLyrics {
  const parsed = parseLyrics(normalizeLyricsInput(lyrics));
  const lines = (parsed?.lines ?? [])
    .map((line) => line.text)
    .filter((text) => text !== '' && text !== LYRICS_INSTRUMENTAL);
  const words = lines.reduce((count, line) => count + tokenizeLyricsLine(line).length, 0);
  if (words === 0)
    return { ok: false, refusal: { kind: 'align_invalid', message: ALIGN_EMPTY_MESSAGE } };
  if (words > ALIGN_MAX_LYRICS_WORDS) {
    return {
      ok: false,
      refusal: {
        kind: 'align_invalid',
        message: `Il testo ha troppe parole (${words}): al massimo ${ALIGN_MAX_LYRICS_WORDS}, il testo di un brano solo.`,
      },
    };
  }
  return { ok: true, lines, words, hint: lines.join(' ').slice(0, ALIGN_HINT_CHARS) };
}

function alignRefusal(result: Extract<AlignmentResult, { ok: false }>): TranscriptionRefusal {
  switch (result.reason) {
    case 'no_match':
      return { kind: 'align_no_match', coverage: result.stats?.coverage ?? 0 };
    case 'empty_transcript':
      return {
        kind: 'align_invalid',
        message:
          'Solco AI non ha riconosciuto parole con un tempo in questo brano: non c’è nulla a cui allineare il testo.',
      };
    case 'too_long':
      return {
        kind: 'align_invalid',
        message: 'Il testo (o la trascrizione) è troppo lungo per l’allineamento.',
      };
    default:
      return { kind: 'align_invalid', message: ALIGN_EMPTY_MESSAGE };
  }
}

/**
 * Il testo ufficiale allineato ai tempi dell'audio del brano: stesso permesso, limiti e cache della
 * trascrizione; la bozza che torna ha le parole del testo e i tempi dell'audio (`aligned` con
 * copertura e righe senza riscontro). Mai throw.
 */
export async function alignFeaturedTrackLyrics({
  pathname,
  lyrics,
  language,
  identity,
  signal,
}: AlignInput): Promise<AlignOutcome> {
  const official = officialLyricsLines(lyrics);
  if (!official.ok) return official;

  const transcription = await transcribeFeaturedTrack({
    pathname,
    language,
    identity,
    signal,
    lyricsHint: official.hint,
  });
  if (!transcription.ok) return transcription;
  const draft = transcription.result;

  const { words, wordLevel } = timedWordsFromLyrics(parseLyrics(draft.draft));
  const aligned = alignLyrics(official.lines, words, {
    wordLevel,
    durationMs: draft.durationSeconds === null ? null : draft.durationSeconds * 1000,
  });
  if (!aligned.ok) return { ok: false, refusal: alignRefusal(aligned) };

  return {
    ok: true,
    result: {
      draft: aligned.lrc,
      lineCount: parseLyrics(aligned.lrc)?.lines.length ?? 0,
      language: draft.language,
      durationSeconds: draft.durationSeconds,
      droppedSegments: draft.droppedSegments,
      // Le righe incerte erano della trascrizione: qui le parole sono quelle del testo.
      uncertainLines: [],
      wordTimed: aligned.wordTimed,
      fromCache: draft.fromCache,
      cachedAt: draft.cachedAt,
      aligned: aligned.stats,
    },
  };
}
