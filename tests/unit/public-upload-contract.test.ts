// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  audioMimeType,
  PUBLIC_UPLOAD_MAX_PER_USER,
  PublicUploadCreateSchema,
  PublicUploadSchema,
  storagePublicUrl,
} from '@/lib/contracts/public-uploads';

describe('limite brani pubblici per utente', () => {
  it('ogni utente può pubblicare al massimo 3 brani', () => {
    expect(PUBLIC_UPLOAD_MAX_PER_USER).toBe(3);
  });
});

describe('storagePublicUrl', () => {
  it('accetta https su host S3, CloudFront o Vercel Blob', () => {
    expect(
      storagePublicUrl.safeParse('https://bucket.s3.eu-west-1.amazonaws.com/public-uploads/x.mp3')
        .success,
    ).toBe(true);
    expect(
      storagePublicUrl.safeParse('https://d111.cloudfront.net/public-uploads/x.mp3').success,
    ).toBe(true);
    expect(
      storagePublicUrl.safeParse('https://abc.public.blob.vercel-storage.com/public-uploads/x.mp3')
        .success,
    ).toBe(true);
  });

  it('rifiuta host diversi, http e URL non validi', () => {
    expect(storagePublicUrl.safeParse('https://evil.example.com/x.mp3').success).toBe(false);
    expect(
      storagePublicUrl.safeParse('http://bucket.s3.eu-west-1.amazonaws.com/x.mp3').success,
    ).toBe(false);
    expect(storagePublicUrl.safeParse('not-a-url').success).toBe(false);
    // Nessun suffisso ingannevole.
    expect(storagePublicUrl.safeParse('https://amazonaws.com.evil.com/x.mp3').success).toBe(false);
  });
});

describe('audioMimeType', () => {
  it('accetta tipi audio e normalizza', () => {
    expect(audioMimeType.parse('AUDIO/MPEG')).toBe('audio/mpeg');
    expect(audioMimeType.safeParse('audio/flac').success).toBe(true);
  });
  it('rifiuta non audio', () => {
    expect(audioMimeType.safeParse('image/png').success).toBe(false);
    expect(audioMimeType.safeParse('video/mp4').success).toBe(false);
  });
});

describe('PublicUploadSchema (ascolto solo Premium)', () => {
  const base = {
    id: 'c'.repeat(25),
    title: 'Brano',
    artist: null,
    durationSeconds: 100,
    playCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    mine: false,
    published: true,
  };

  it('accetta streamUrl null quando il brano è bloccato (canPlay false)', () => {
    expect(PublicUploadSchema.safeParse({ ...base, streamUrl: null, canPlay: false }).success).toBe(
      true,
    );
  });

  it('accetta un URL S3 valido quando canPlay è true', () => {
    expect(
      PublicUploadSchema.safeParse({
        ...base,
        streamUrl: 'https://bucket.s3.eu-west-1.amazonaws.com/public-uploads/x.mp3',
        canPlay: true,
      }).success,
    ).toBe(true);
  });

  it('richiede il campo canPlay', () => {
    expect(PublicUploadSchema.safeParse({ ...base, streamUrl: null }).success).toBe(false);
  });
});

describe('PublicUploadCreateSchema', () => {
  const valid = {
    title: 'La mia canzone',
    artist: 'Io',
    key: 'public-uploads/la-mia-canzone-ab12cd34ef56.mp3',
    mimeType: 'audio/mpeg',
    byteLength: 1000,
    elapsedSeconds: 120,
  };

  it('accetta un corpo valido', () => {
    expect(PublicUploadCreateSchema.safeParse(valid).success).toBe(true);
  });

  it('richiede un titolo non vuoto', () => {
    expect(PublicUploadCreateSchema.safeParse({ ...valid, title: '  ' }).success).toBe(false);
  });

  it('rifiuta una chiave fuori dal prefisso consentito', () => {
    expect(PublicUploadCreateSchema.safeParse({ ...valid, key: 'altrove/x.mp3' }).success).toBe(
      false,
    );
  });

  it('rifiuta file troppo grandi (oltre 40 MB)', () => {
    expect(
      PublicUploadCreateSchema.safeParse({ ...valid, byteLength: 41 * 1024 * 1024 }).success,
    ).toBe(false);
  });

  it('l’artista è facoltativo', () => {
    const { artist: _artist, ...withoutArtist } = valid;
    expect(PublicUploadCreateSchema.safeParse(withoutArtist).success).toBe(true);
  });
});
