// @polsia:user-owned — POST /api/admin/featured-rights/transcribe/align (testo ufficiale allineato
// ai tempi dell'audio) e il modulo server dell'allineamento: stessa origine e admin verificato;
// corpo non valido (400 sul campo `lyrics` o `language`); permesso, limiti e cache sono quelli della
// trascrizione (il rifiuto passa com'è: 404 per un brano non ammesso); il testo fornito fa da
// suggerimento al modello (inizio del testo) e non finisce nei log; bozza allineata con le parole
// del testo, i tempi dell'audio e `aligned` (copertura, righe senza riscontro); testo vuoto, troppo
// lungo o senza riscontro → 400 sul campo; risposte mai in cache.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/env', () => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', NEXT_PUBLIC_APP_URL: 'https://solco.test' },
}));
vi.mock('@/lib/music/lyrics-transcription.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/lyrics-transcription.server')>()),
  transcribeFeaturedTrack: mocks.transcribe,
}));

import { POST } from '@/app/api/admin/featured-rights/transcribe/align/route';
import {
  type TranscribeResponse,
  TranscribeResponseSchema,
} from '@/lib/contracts/lyrics-transcription';
import { parseLyrics } from '@/lib/music/lyrics';
import { ALIGN_MAX_LYRICS_WORDS } from '@/lib/music/lyrics-align';
import {
  ALIGN_EMPTY_MESSAGE,
  ALIGN_HINT_CHARS,
  alignFeaturedTrackLyrics,
  officialLyricsLines,
} from '@/lib/music/lyrics-align.server';
import { NOT_ELIGIBLE_MESSAGE } from '@/lib/music/lyrics-transcription.server';

const ORIGIN = 'https://solco.test';
const SONG = 'Cantautori/Autrice - Canzone.mp3';
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

const OFFICIAL = 'Sotto il cielo di Roma\ncanto per te stasera\n\ne la luna ci guarda';

/** La bozza di Solco AI (Enhanced LRC) con due refusi: «celo» e «me». */
const TRANSCRIBED: TranscribeResponse = {
  draft: [
    '[00:12.00] <00:12.00>sotto <00:12.40>il <00:12.80>celo <00:13.20>di <00:13.60>roma',
    '[00:14.00] <00:14.00>canto <00:14.40>per <00:14.80>me <00:15.20>stasera',
    '[00:15.60] <00:15.60>e <00:16.00>la <00:16.40>luna <00:16.80>ci <00:17.20>guarda',
  ].join('\n'),
  lineCount: 3,
  language: 'italian',
  durationSeconds: 184.4,
  droppedSegments: 1,
  uncertainLines: [2],
  wordTimed: true,
  fromCache: true,
  cachedAt: '2026-11-16T15:00:00.000Z',
};

let errors: MockInstance<typeof console.error>;

function request(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return new Request(`${ORIGIN}/api/admin/featured-rights/transcribe/align`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.transcribe.mockReset();
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.transcribe.mockResolvedValue({ ok: true, result: TRANSCRIBED });
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errors.mockRestore();
});

describe('accesso', () => {
  it('senza la stessa origine: 403, nessuna trascrizione', async () => {
    const response = await POST(request({ pathname: SONG, lyrics: OFFICIAL }, {}));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_origin' });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it('senza sessione 401; utente non admin o admin senza email verificata 403', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await POST(request({ pathname: SONG, lyrics: OFFICIAL }))).status).toBe(401);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, role: 'user' } });
    expect((await POST(request({ pathname: SONG, lyrics: OFFICIAL }))).status).toBe(403);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, emailVerified: false } });
    expect((await POST(request({ pathname: SONG, lyrics: OFFICIAL }))).status).toBe(403);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});

describe('corpo della richiesta', () => {
  it('testo mancante, non stringa o troppo grande: 400 sul campo lyrics', async () => {
    const missing = await POST(request({ pathname: SONG }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: 'invalid_request',
      errors: { lyrics: 'Incolla il testo del brano, una riga per verso.' },
    });
    const huge = await POST(request({ pathname: SONG, lyrics: 'a'.repeat(64 * 1024 + 1) }));
    expect(huge.status).toBe(400);
    expect((await huge.json()).errors.lyrics).toContain('64 KB');
    const empty = await POST(request({ pathname: SONG, lyrics: '' }));
    expect(empty.status).toBe(400);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it('lingua fuori elenco: 400 sul campo language; JSON rotto o campo in più: 400', async () => {
    const language = await POST(request({ pathname: SONG, lyrics: OFFICIAL, language: 'xx' }));
    expect(language.status).toBe(400);
    expect((await language.json()).errors.language).toContain('Lingua non valida');
    expect((await POST(request('{non json'))).status).toBe(400);
    expect((await POST(request({ pathname: SONG, lyrics: OFFICIAL, extra: 1 }))).status).toBe(400);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});

describe('allineamento', () => {
  it('bozza con le parole del testo e i tempi dell’audio; `aligned` con copertura e righe', async () => {
    const response = await POST(request({ pathname: SONG, lyrics: OFFICIAL, language: 'it' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = TranscribeResponseSchema.parse(await response.json());
    expect(body.aligned).toEqual({
      coverage: 0.929,
      matchedWords: 13,
      totalWords: 14,
      unmatchedLines: [],
    });
    expect(body.wordTimed).toBe(true);
    expect(body.lineCount).toBe(3);
    expect(body.uncertainLines).toEqual([]);
    expect(body.fromCache).toBe(true);
    expect(body.cachedAt).toBe(TRANSCRIBED.cachedAt);
    expect(body.language).toBe('italian');
    // Le parole sono quelle del testo («cielo», «te», maiuscole), i tempi quelli dell'audio.
    expect(body.draft.split('\n')[0]).toBe(
      '[00:12.00] <00:12.00>Sotto <00:12.40>il <00:12.80>cielo <00:13.20>di <00:13.60>Roma',
    );
    expect(body.draft).toContain('<00:14.80>te');
    expect(body.draft).not.toContain('celo');
    const parsed = parseLyrics(body.draft);
    expect(parsed?.lines.map((line) => line.text)).toEqual([
      'Sotto il cielo di Roma',
      'canto per te stasera',
      'e la luna ci guarda',
    ]);

    // La trascrizione riceve lingua, identità, segnale e l'inizio del testo come suggerimento.
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    const input = mocks.transcribe.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.pathname).toBe(SONG);
    expect(input.language).toBe('it');
    expect(input.identity).toBe('user:admin-1');
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.lyricsHint).toBe(
      'Sotto il cielo di Roma canto per te stasera e la luna ci guarda',
    );
    expect(input.regenerate).toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
  });

  it('un LRC incollato va bene: contano solo le parole', async () => {
    const lrc =
      '[00:01.00] Sotto il cielo di Roma\n[00:05.00] canto per te stasera\n[00:09.00] e la luna ci guarda';
    const response = await POST(request({ pathname: SONG, lyrics: lrc }));
    expect(response.status).toBe(200);
    const body = TranscribeResponseSchema.parse(await response.json());
    expect(body.aligned?.coverage).toBe(0.929);
    expect(body.draft.startsWith('[00:12.00] ')).toBe(true);
  });

  it('il rifiuto della trascrizione passa com’è (brano non ammesso → 404 uguale per tutti)', async () => {
    mocks.transcribe.mockResolvedValueOnce({ ok: false, refusal: { kind: 'not_found' } });
    const response = await POST(
      request({ pathname: 'Pop/Ignoto - Copiato.mp3', lyrics: OFFICIAL }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', message: NOT_ELIGIBLE_MESSAGE });
  });

  it('testo di un altro brano: 400 sul campo con la quota di riscontro', async () => {
    const other =
      'Nel blu dipinto di blu\nfelice di stare lassù\nvolare oh oh\ncantare oh oh oh oh';
    const response = await POST(request({ pathname: SONG, lyrics: other }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('align_no_match');
    expect(body.errors.lyrics).toMatch(/riscontro solo nel \d+% delle parole/);
  });

  it('trascrizione senza parole con tempo (testo semplice): 400 sul campo', async () => {
    mocks.transcribe.mockResolvedValueOnce({
      ok: true,
      result: { ...TRANSCRIBED, draft: 'solo testo\nsenza tempi', wordTimed: false },
    });
    const response = await POST(request({ pathname: SONG, lyrics: OFFICIAL }));
    expect(response.status).toBe(400);
    expect((await response.json()).errors.lyrics).toContain(
      'non ha riconosciuto parole con un tempo',
    );
  });

  it('solo pause e righe vuote: 400 senza chiamare la trascrizione', async () => {
    const response = await POST(request({ pathname: SONG, lyrics: '♪\n\n♪' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'align_invalid',
      errors: { lyrics: ALIGN_EMPTY_MESSAGE },
    });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it('un errore imprevisto: 500 generico, nel log solo il nome dell’errore', async () => {
    mocks.transcribe.mockRejectedValueOnce(new RangeError(`segreto ${OFFICIAL}`));
    const response = await POST(request({ pathname: SONG, lyrics: OFFICIAL }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'align_failed',
      message: 'L’allineamento non è riuscito. Riprova tra poco.',
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls[0])).not.toContain('Sotto il cielo');
    expect(errors.mock.calls[0]?.[1]).toBe('RangeError');
  });
});

describe('officialLyricsLines e alignFeaturedTrackLyrics', () => {
  it('righe pulite, pause e vuote saltate, suggerimento con l’inizio del testo', () => {
    const result = officialLyricsLines('  Prima riga \n\n♪\n[00:10.00] Seconda riga\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual(['Prima riga', 'Seconda riga']);
    expect(result.words).toBe(4);
    expect(result.hint).toBe('Prima riga Seconda riga');
  });

  it('il suggerimento è al massimo ALIGN_HINT_CHARS caratteri', () => {
    const long = Array.from({ length: 80 }, (_, index) => `parola${index}`).join(' ');
    const result = officialLyricsLines(long);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hint.length).toBe(ALIGN_HINT_CHARS);
    expect(long.startsWith(result.hint)).toBe(true);
  });

  it('troppe parole: rifiuto sul campo con il conteggio', () => {
    const lines = Array.from(
      { length: ALIGN_MAX_LYRICS_WORDS / 10 + 1 },
      () => 'uno due tre quattro cinque sei sette otto nove dieci',
    );
    const result = officialLyricsLines(lines.join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toEqual({
      kind: 'align_invalid',
      message: `Il testo ha troppe parole (${ALIGN_MAX_LYRICS_WORDS + 10}): al massimo ${ALIGN_MAX_LYRICS_WORDS}, il testo di un brano solo.`,
    });
  });

  it('senza i tag delle parole nella bozza: tempi delle righe, wordTimed false', async () => {
    mocks.transcribe.mockResolvedValueOnce({
      ok: true,
      result: {
        ...TRANSCRIBED,
        draft:
          '[00:12.00] sotto il celo di roma\n[00:14.00] canto per me stasera\n[00:15.60] e la luna ci guarda',
        wordTimed: false,
      },
    });
    const outcome = await alignFeaturedTrackLyrics({
      pathname: SONG,
      lyrics: OFFICIAL,
      identity: 'user:admin-1',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.wordTimed).toBe(false);
    expect(outcome.result.draft.split('\n')).toEqual([
      '[00:12.00] Sotto il cielo di Roma',
      '[00:14.00] canto per te stasera',
      '[00:15.60] e la luna ci guarda',
    ]);
    expect(outcome.result.aligned?.matchedWords).toBe(13);
  });
});
