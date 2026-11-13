// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  audioMimeType,
  blobPublicUrl,
  PUBLIC_UPLOAD_MAX_PER_USER,
  PublicUploadCreateSchema,
  PublicUploadSchema,
} from '@/lib/contracts/public-uploads';

describe('limite brani pubblici per utente', () => {
  it('ogni utente può pubblicare al massimo 3 brani', () => {
    expect(PUBLIC_UPLOAD_MAX_PER_USER).toBe(3);
  });
});

describe('blobPublicUrl', () => {
  it('accetta solo URL https su *.blob.vercel-storage.com', () => {
    expect(
      blobPublicUrl.safeParse('https://abc123.public.blob.vercel-storage.com/public-uploads/x.mp3')
        .success,
    ).toBe(true);
  });

  it('rifiuta host diversi, http e URL non validi', () => {
    expect(blobPublicUrl.safeParse('https://evil.example.com/x.mp3').success).toBe(false);
    // L'host API nudo non è un URL di file pubblico (i file stanno su *.public.blob…).
    expect(blobPublicUrl.safeParse('https://blob.vercel-storage.com/x.mp3').success).toBe(false);
    expect(blobPublicUrl.safeParse('http://abc.public.blob.vercel-storage.com/x.mp3').success).toBe(
      false,
    );
    expect(blobPublicUrl.safeParse('not-a-url').success).toBe(false);
    // Nessun suffisso ingannevole: deve finire con .blob.vercel-storage.com
    expect(blobPublicUrl.safeParse('https://blob.vercel-storage.com.evil.com/x.mp3').success).toBe(
      false,
    );
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

  it('accetta un URL Blob valido quando canPlay è true', () => {
    expect(
      PublicUploadSchema.safeParse({
        ...base,
        streamUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/x.mp3',
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
    blobUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/x.mp3',
    blobPathname: 'public-uploads/x.mp3',
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

  it('rifiuta un blobUrl non su Blob', () => {
    expect(
      PublicUploadCreateSchema.safeParse({ ...valid, blobUrl: 'https://evil.com/x.mp3' }).success,
    ).toBe(false);
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
