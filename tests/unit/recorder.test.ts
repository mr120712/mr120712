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
  shouldReassignMime,
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

  it('guarda solo l’ultima estensione nei nomi a doppia estensione', () => {
    // fileExtension usa l'ultimo punto: conta solo l'estensione finale.
    expect(audioUploadMimeType('', 'song.txt.mp3')).toBe('audio/mpeg');
    expect(audioUploadMimeType('', 'canzone.backup.flac')).toBe('audio/flac');
    expect(audioUploadMimeType('', 'song.mp3.txt')).toBeNull();
    expect(audioUploadMimeType('', 'traccia.mp3.pdf')).toBeNull();
  });

  it('copre tutte le estensioni dichiarate accettate', () => {
    const expected: Record<string, string> = {
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      m4b: 'audio/mp4',
      aac: 'audio/aac',
      oga: 'audio/ogg',
      ogg: 'audio/ogg',
      opus: 'audio/ogg',
      wav: 'audio/wav',
      flac: 'audio/flac',
      weba: 'audio/webm',
    };
    for (const ext of AUDIO_UPLOAD_EXTENSIONS) {
      expect(audioUploadMimeType('', `file.${ext}`)).toBe(expected[ext]);
    }
    // l'elenco accept è esattamente quello atteso (niente .mp4/.webm)
    expect([...AUDIO_UPLOAD_EXTENSIONS].sort()).toEqual([...Object.keys(expected)].sort());
  });
});

describe('shouldReassignMime (ricostruzione del File prima del caricamento)', () => {
  it('NON ricostruisce quando il browser dichiara già un tipo audio', () => {
    expect(shouldReassignMime('audio/mpeg')).toBe(false);
    expect(shouldReassignMime('AUDIO/WAV')).toBe(false);
    expect(shouldReassignMime('audio/webm;codecs=opus')).toBe(false);
  });

  it('ricostruisce quando il tipo è vuoto o non audio (caso MP3 che rompeva la scelta)', () => {
    expect(shouldReassignMime('')).toBe(true);
    expect(shouldReassignMime('application/octet-stream')).toBe(true);
    expect(shouldReassignMime('video/mp4')).toBe(true);
  });

  it('decisione + MIME insieme producono un File audio con tipo non vuoto', () => {
    // È esattamente ciò che fa pick(): se va ricostruito, usa il MIME dedotto dall'estensione.
    const declaredType = '';
    const name = 'La mia canzone.mp3';
    const mime = audioUploadMimeType(declaredType, name);
    expect(mime).toBe('audio/mpeg');
    expect(shouldReassignMime(declaredType)).toBe(true);
    const rebuilt = new File([new Blob(['xx'])], name, { type: mime ?? '' });
    expect(rebuilt.type).toBe('audio/mpeg'); // non vuoto → uploadPrivateFile non lo rifiuta
  });
});
