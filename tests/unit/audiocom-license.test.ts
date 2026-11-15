// @polsia:user-owned — licenze di audio.com: ogni licenza → riproducibile nel player di Solco
// (solo CC0, CC BY, CC BY-SA, CC BY-ND con stream https su audio.com) oppure solo player ufficiale
// di audio.com; le cover mai nel player di Solco; etichette e link al testo della licenza;
// indirizzi solo https su audio.com; il contratto rifiuta uno stream con una licenza non
// riproducibile o per una cover; l'elemento del player porta l'attribuzione, suona con lo stream
// diretto dei file pubblici e ha un id proprio, `audiocom:<id>` (accesso e conteggio Free), in cui
// confluiscono anche gli id storici `upload:audiocom~<id>`.
import { describe, expect, it } from 'vitest';
import { audioComToPlayerTrack } from '@/components/custom/music/audiocom-tracks';
import { type AudioComTrack, AudioComTrackSchema } from '@/lib/contracts/audiocom';
import {
  AUDIOCOM_LICENSE_VALUES,
  type AudioComLicense,
  audioComEmbedUrl,
  audioComIdFromQualifiedId,
  audioComImageUrl,
  audioComLicenseDeedUrl,
  audioComLicenseName,
  audioComLicenseShortLabel,
  audioComPageUrl,
  audioComQualifiedId,
  audioComStreamUrl,
  currentAudioComQualifiedId,
  isAudioComHost,
  isAudioComPageUrl,
  isAudioComPlayable,
  isAudioComPlayableLicense,
  normalizeAudioComLicense,
} from '@/lib/music/audiocom-license';

const STREAM = 'https://s3.audio.com/audio/123.mp3';

function track(license: AudioComLicense, streamUrl: string | null = STREAM): AudioComTrack {
  return {
    id: '123',
    title: 'Notturno',
    authorName: 'Anna Rossi',
    pageUrl: 'https://audio.com/anna-rossi/audio/notturno',
    imageUrl: 'https://s3.audio.com/images/123.jpg',
    streamUrl,
    durationSeconds: 200,
    category: 'music',
    license,
  };
}

describe('licenza → riproducibile in Solco oppure solo player di audio.com', () => {
  const expected: Record<AudioComLicense, boolean> = {
    'cc-0': true,
    'cc-by': true,
    'cc-by-sa': true,
    'cc-by-nd': true,
    'cc-by-nc': false,
    'cc-by-nc-sa': false,
    'cc-by-nc-nd': false,
    arr: false,
    none: false,
    unknown: false,
  };

  it.each(AUDIOCOM_LICENSE_VALUES)('%s', (license) => {
    expect(isAudioComPlayableLicense(license)).toBe(expected[license]);
    expect(isAudioComPlayable(track(license))).toBe(expected[license]);
    const playerTrack = audioComToPlayerTrack(track(license));
    if (expected[license]) {
      expect(playerTrack).not.toBeNull();
    } else {
      // Mai nel player di Solco, nemmeno se uno stream arrivasse comunque.
      expect(playerTrack).toBeNull();
    }
  });

  it.each(['cc-0', 'cc-by', 'cc-by-sa', 'cc-by-nd'] as const)(
    'cover con %s → solo player di audio.com (la licenza non copre la canzone originale)',
    (license) => {
      const cover: AudioComTrack = { ...track(license), category: 'cover' };
      expect(isAudioComPlayableLicense(license)).toBe(true);
      expect(isAudioComPlayable(cover)).toBe(false);
      expect(audioComToPlayerTrack(cover)).toBeNull();
      // Musica originale e basi con la stessa licenza restano riproducibili.
      expect(isAudioComPlayable({ ...track(license), category: 'beats' })).toBe(true);
    },
  );

  it('licenza riproducibile ma senza stream valido → non riproducibile', () => {
    expect(isAudioComPlayable(track('cc-by', null))).toBe(false);
    expect(isAudioComPlayable(track('cc-by', 'http://s3.audio.com/a.mp3'))).toBe(false);
    expect(isAudioComPlayable(track('cc-by', 'https://evil.example/a.mp3'))).toBe(false);
    expect(audioComToPlayerTrack(track('cc-0', null))).toBeNull();
  });

  it('normalizza i valori dell’API (sconosciuti → unknown)', () => {
    expect(normalizeAudioComLicense(' CC-BY ')).toBe('cc-by');
    expect(normalizeAudioComLicense('cc-by-4.0')).toBe('unknown');
    expect(normalizeAudioComLicense('')).toBe('unknown');
    expect(normalizeAudioComLicense(undefined)).toBe('unknown');
  });

  it('etichette in italiano e link al testo CC (deed.it); nessun link per le non-CC', () => {
    expect(audioComLicenseShortLabel('cc-by')).toBe('CC BY');
    expect(audioComLicenseName('cc-by')).toBe('CC BY 4.0');
    expect(audioComLicenseDeedUrl('cc-by')).toBe(
      'https://creativecommons.org/licenses/by/4.0/deed.it',
    );
    expect(audioComLicenseDeedUrl('cc-0')).toBe(
      'https://creativecommons.org/publicdomain/zero/1.0/deed.it',
    );
    expect(audioComLicenseShortLabel('arr')).toBe('Tutti i diritti riservati');
    expect(audioComLicenseDeedUrl('arr')).toBeNull();
    expect(audioComLicenseDeedUrl('none')).toBeNull();
    expect(audioComLicenseDeedUrl('unknown')).toBeNull();
  });
});

describe('indirizzi solo https su audio.com', () => {
  it('host audio.com e sottodomini, mai somiglianti', () => {
    expect(isAudioComHost('audio.com')).toBe(true);
    expect(isAudioComHost('s3.audio.com')).toBe(true);
    expect(isAudioComHost('evilaudio.com')).toBe(false);
    expect(isAudioComHost('audio.com.evil.example')).toBe(false);
  });

  it('stream e copertina: https, niente credenziali né porte, host audio.com', () => {
    expect(audioComStreamUrl(STREAM)).toBe(STREAM);
    expect(audioComStreamUrl('http://s3.audio.com/a.mp3')).toBeNull();
    expect(audioComStreamUrl('https://user:pw@s3.audio.com/a.mp3')).toBeNull();
    expect(audioComStreamUrl('https://s3.audio.com:8443/a.mp3')).toBeNull();
    expect(audioComStreamUrl('javascript:alert(1)')).toBeNull();
    expect(audioComStreamUrl('')).toBeNull();
    expect(audioComImageUrl('https://cdn.example/a.jpg')).toBeNull();
  });

  it('pagina del brano e player ufficiale costruiti da parti validate', () => {
    expect(audioComPageUrl('anna-rossi', 'notturno')).toBe(
      'https://audio.com/anna-rossi/audio/notturno',
    );
    expect(audioComPageUrl('anna/../x', 'notturno')).toBeNull();
    expect(audioComPageUrl('', 'notturno')).toBeNull();
    expect(isAudioComPageUrl('https://audio.com/anna-rossi/audio/notturno')).toBe(true);
    expect(isAudioComPageUrl('https://evil.example/anna/audio/x')).toBe(false);
    expect(audioComEmbedUrl('123')).toBe('https://audio.com/embed/v2/audio/123?theme=dark');
    expect(audioComEmbedUrl('12a')).toBeNull();
  });
});

describe('contratto del brano', () => {
  it('rifiuta uno stream con una licenza non riproducibile', () => {
    expect(AudioComTrackSchema.safeParse(track('cc-by')).success).toBe(true);
    expect(AudioComTrackSchema.safeParse(track('arr', null)).success).toBe(true);
    expect(AudioComTrackSchema.safeParse(track('arr')).success).toBe(false);
    expect(AudioComTrackSchema.safeParse(track('cc-by-nc')).success).toBe(false);
    // Una cover non porta mai lo stream, nemmeno con una licenza CC ammessa.
    expect(AudioComTrackSchema.safeParse({ ...track('cc-by'), category: 'cover' }).success).toBe(
      false,
    );
    expect(
      AudioComTrackSchema.safeParse({ ...track('cc-by', null), category: 'cover' }).success,
    ).toBe(true);
    expect(
      AudioComTrackSchema.safeParse({ ...track('cc-by'), streamUrl: 'https://evil.example/a.mp3' })
        .success,
    ).toBe(false);
  });
});

describe('elemento del player', () => {
  it('stream diretto (via generica upload) con attribuzione nella riga della fonte', () => {
    expect(audioComToPlayerTrack(track('cc-by-sa'))).toEqual({
      qualifiedId: 'audiocom:123',
      title: 'Notturno',
      artistName: 'Anna Rossi',
      artworkUrl: 'https://s3.audio.com/images/123.jpg',
      sourceLabel: 'audio.com · CC BY-SA 4.0',
      sourceUrl: 'https://audio.com/anna-rossi/audio/notturno',
      sourceUrlLabel: 'Il brano su audio.com',
      durationSeconds: 200,
      streamUrl: STREAM,
      playbackMode: 'upload',
    });
  });
});

describe('id del brano nel player e nel registro degli ascolti', () => {
  it('audiocom:<id>, con l’id numerico di audio.com', () => {
    expect(audioComQualifiedId('123')).toBe('audiocom:123');
    expect(audioComIdFromQualifiedId('audiocom:123')).toBe('123');
    expect(audioComIdFromQualifiedId(`audiocom:${'9'.repeat(24)}`)).toBe('9'.repeat(24));
    for (const invalid of [
      'audiocom:',
      'audiocom:12a',
      'audiocom:-1',
      `audiocom:${'9'.repeat(25)}`,
      'audiocom:1/2',
      'upload:audiocom~123',
      'audius:123',
    ]) {
      expect(audioComIdFromQualifiedId(invalid), invalid).toBeNull();
    }
  });

  it('gli id storici upload:audiocom~<id> diventano audiocom:<id>, gli altri restano', () => {
    expect(currentAudioComQualifiedId('upload:audiocom~123')).toBe('audiocom:123');
    expect(currentAudioComQualifiedId('audiocom:123')).toBe('audiocom:123');
    // Un upload pubblico, un brano in evidenza o un id storico malformato non cambiano.
    expect(currentAudioComQualifiedId(`upload:${'c'.repeat(25)}`)).toBe(`upload:${'c'.repeat(25)}`);
    expect(currentAudioComQualifiedId('upload:Pop/A - B.mp3')).toBe('upload:Pop/A - B.mp3');
    expect(currentAudioComQualifiedId('upload:audiocom~abc')).toBe('upload:audiocom~abc');
    expect(currentAudioComQualifiedId('audius:track')).toBe('audius:track');
  });
});
