// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import { publicUploadToTrack } from '@/components/custom/music/live-tracks';
import { isOpenStream, trackStreamPath } from '@/components/custom/music/music-player';

const upload = {
  id: 'c'.repeat(25),
  title: 'Brano',
  artist: 'Io' as string | null,
  streamUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/x.mp3',
  durationSeconds: 100,
};

describe('libreria pubblica → player', () => {
  it('publicUploadToTrack mappa su playbackMode "upload" con lo streamUrl', () => {
    const track = publicUploadToTrack(upload);
    expect(track.qualifiedId).toBe(`upload:${upload.id}`);
    expect(track.playbackMode).toBe('upload');
    expect(track.streamUrl).toBe(upload.streamUrl);
  });

  it('trackStreamPath restituisce l’URL Blob per un upload https', () => {
    expect(trackStreamPath(publicUploadToTrack(upload))).toBe(upload.streamUrl);
  });

  it('trackStreamPath rifiuta un upload senza URL https', () => {
    const track = { ...publicUploadToTrack(upload), streamUrl: 'http://x/y' };
    expect(trackStreamPath(track)).toBeNull();
  });

  it('un upload è uno stream aperto (niente permesso/verifica diritti)', () => {
    expect(isOpenStream({ playbackMode: 'upload' })).toBe(true);
  });
});
