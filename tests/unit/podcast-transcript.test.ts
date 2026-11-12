// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseTranscript } from '@/lib/music/podcast-transcript';

describe('parseTranscript', () => {
  it('analizza il WebVTT con i tempi', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Ciao e benvenuti

2
00:00:04.500 --> 00:00:07.000
<v Host>Oggi parliamo di musica.`;
    const r = parseTranscript(vtt, 'text/vtt');
    expect(r.timed).toBe(true);
    expect(r.cues).toEqual([
      { startSeconds: 1, text: 'Ciao e benvenuti' },
      { startSeconds: 4.5, text: 'Oggi parliamo di musica.' },
    ]);
  });

  it('analizza il SubRip (SRT) con virgola e ore', () => {
    const srt = `1
01:00:01,000 --> 01:00:03,000
Prima riga

2
01:00:03,200 --> 01:00:05,000
Seconda riga`;
    const r = parseTranscript(srt, 'application/x-subrip');
    expect(r.timed).toBe(true);
    expect(r.cues[0]).toEqual({ startSeconds: 3601, text: 'Prima riga' });
    expect(r.cues[1]?.startSeconds).toBe(3603.2);
  });

  it('analizza il JSON di Podcasting 2.0', () => {
    const json = JSON.stringify({
      version: '1.0.0',
      segments: [
        { startTime: 0.5, endTime: 2, speaker: 'A', body: 'Benvenuti' },
        { startTime: 2.5, body: 'alla puntata' },
      ],
    });
    const r = parseTranscript(json, 'application/json');
    expect(r.timed).toBe(true);
    expect(r.cues).toEqual([
      { startSeconds: 0.5, text: 'Benvenuti' },
      { startSeconds: 2.5, text: 'alla puntata' },
    ]);
  });

  it('analizza il testo semplice senza tempi (paragrafi)', () => {
    const plain = 'Primo paragrafo.\n\nSecondo paragrafo.';
    const r = parseTranscript(plain, 'text/plain');
    expect(r.timed).toBe(false);
    expect(r.cues.map((c) => c.text)).toEqual(['Primo paragrafo.', 'Secondo paragrafo.']);
    expect(r.cues.every((c) => c.startSeconds === null)).toBe(true);
  });

  it('riconosce il formato dal contenuto quando il MIME è generico', () => {
    const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nSolo contenuto';
    const r = parseTranscript(vtt, 'application/octet-stream');
    expect(r.timed).toBe(true);
    expect(r.cues[0]).toEqual({ startSeconds: 2, text: 'Solo contenuto' });
  });

  it('pulisce i tag inline e le entità', () => {
    const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c>Rock &amp; roll</c>';
    const r = parseTranscript(vtt, 'text/vtt');
    expect(r.cues[0]?.text).toBe('Rock & roll');
  });
});
