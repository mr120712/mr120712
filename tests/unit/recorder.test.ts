// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  AUDIO_UPLOAD_EXTENSIONS,
  audioUploadMimeType,
  baseMimeType,
  extensionForMime,
  formatClock,
  pickRecorderMimeType,
  recordingFileName,
} from '@/lib/music/recorder';

describe('recorder helpers', () => {
  it('sceglie il primo tipo MIME supportato', () => {
    const supported = new Set(['audio/mp4', 'audio/mpeg']);
    expect(pickRecorderMimeType((type) => supported.has(type))).toBe('audio/mp4');
  });

  it('preferisce webm/opus quando disponibile', () => {
    expect(pickRecorderMimeType(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('ritorna stringa vuota se niente è supportato', () => {
    expect(pickRecorderMimeType(() => false)).toBe('');
  });

  it('non si rompe se isTypeSupported lancia', () => {
    expect(
      pickRecorderMimeType((type) => {
        if (type === 'audio/webm;codecs=opus') throw new Error('nope');
        return type === 'audio/webm';
      }),
    ).toBe('audio/webm');
  });

  it('rimuove i parametri dal tipo MIME', () => {
    expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMimeType('AUDIO/MP4')).toBe('audio/mp4');
  });

  it('mappa il tipo in estensione, con ripiego', () => {
    expect(extensionForMime('audio/webm')).toBe('webm');
    expect(extensionForMime('audio/mp4')).toBe('m4a');
    expect(extensionForMime('audio/qualcosa')).toBe('audio');
  });

  it('genera un nome file sicuro dal titolo', () => {
    expect(recordingFileName('La mia canzone!', 'audio/webm')).toBe('la-mia-canzone.webm');
    expect(recordingFileName('   ', 'audio/mp4')).toBe('registrazione.m4a');
  });

  it('formatta i secondi come mm:ss o h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(3661)).toBe('1:01:01');
  });
});

describe('audioUploadMimeType', () => {
  it('usa il tipo dichiarato dal browser quando è audio', () => {
    expect(audioUploadMimeType('audio/mpeg', 'brano.mp3')).toBe('audio/mpeg');
    expect(audioUploadMimeType('AUDIO/WAV', 'brano.wav')).toBe('audio/wav');
    expect(audioUploadMimeType(' audio/flac ', 'brano.flac')).toBe('audio/flac');
  });

  it('deduce il MIME dall’estensione quando il tipo è vuoto (caso MP3 tipico)', () => {
    expect(audioUploadMimeType('', 'La mia canzone.mp3')).toBe('audio/mpeg');
    expect(audioUploadMimeType('', 'song.MP3')).toBe('audio/mpeg');
    expect(audioUploadMimeType('', 'voce.m4a')).toBe('audio/mp4');
    expect(audioUploadMimeType('', 'loop.wav')).toBe('audio/wav');
    expect(audioUploadMimeType('', 'master.flac')).toBe('audio/flac');
    expect(audioUploadMimeType('', 'podcast.ogg')).toBe('audio/ogg');
    expect(audioUploadMimeType('', 'clip.opus')).toBe('audio/ogg');
  });

  it('deduce il MIME anche quando il browser dichiara application/octet-stream', () => {
    expect(audioUploadMimeType('application/octet-stream', 'traccia.mp3')).toBe('audio/mpeg');
  });

  it('rifiuta file non audio', () => {
    expect(audioUploadMimeType('', 'documento.pdf')).toBeNull();
    expect(audioUploadMimeType('image/png', 'cover.png')).toBeNull();
    expect(audioUploadMimeType('', 'senza-estensione')).toBeNull();
    expect(audioUploadMimeType('video/mp4', 'clip.mov')).toBeNull();
  });

  it('non deduce audio da contenitori anche video (.mp4/.webm) senza tipo audio dichiarato', () => {
    expect(audioUploadMimeType('video/mp4', 'film.mp4')).toBeNull();
    expect(audioUploadMimeType('', 'film.mp4')).toBeNull();
    expect(audioUploadMimeType('video/webm', 'clip.webm')).toBeNull();
    // ma un audio in quei contenitori, se il browser lo dichiara audio, passa
    expect(audioUploadMimeType('audio/mp4', 'traccia.mp4')).toBe('audio/mp4');
    expect(audioUploadMimeType('audio/webm', 'voce.webm')).toBe('audio/webm');
  });

  it('elenca le estensioni audio accettate (incluso mp3)', () => {
    expect(AUDIO_UPLOAD_EXTENSIONS).toContain('mp3');
    expect(AUDIO_UPLOAD_EXTENSIONS).toContain('m4a');
    expect(AUDIO_UPLOAD_EXTENSIONS).toContain('wav');
    expect(AUDIO_UPLOAD_EXTENSIONS).toContain('flac');
  });
});
