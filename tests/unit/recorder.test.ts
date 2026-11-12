// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
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
