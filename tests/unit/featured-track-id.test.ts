// @polsia:user-owned — l'id del player dei brani in evidenza (`upload:<pathname>`): si riconosce
// dal pathname con le regole del server (cartelle sicure, estensione audio, mai public-uploads/),
// mai un upload utente (cuid) né l'id storico di audio.com.
import { describe, expect, it } from 'vitest';
import {
  FEATURED_QUALIFIED_PREFIX,
  featuredPathnameFromQualifiedId,
  featuredQualifiedId,
  isFeaturedPathname,
  isFeaturedPlayId,
} from '@/lib/music/featured-track-id';

describe('isFeaturedPathname', () => {
  it('accetta i file audio dello store, cartelle comprese, con qualsiasi maiuscola', () => {
    for (const pathname of [
      'a.mp3',
      'Pop/Autrice - Canzone.mp3',
      'Rock/mia canzone.M4A',
      'spotifydown.com - Aura..mp3',
      'Hip hop/sotto/cartella/brano.flac',
      'brano.opus',
      'brano.weba',
    ]) {
      expect(isFeaturedPathname(pathname), pathname).toBe(true);
    }
  });

  it('rifiuta percorsi non sicuri, upload degli utenti e file non audio', () => {
    for (const pathname of [
      '',
      '/a.mp3',
      'public-uploads/x.mp3',
      '../x.mp3',
      'a/../b.mp3',
      'a/./b.mp3',
      'a//b.mp3',
      'a\\b.mp3',
      'diritti.json',
      'titoli.json',
      'x.lrc',
      'copertina.png',
      '.mp3',
      'Pop/.mp3',
      'x.mp3\n',
      'x\u0000.mp3',
      `${'a'.repeat(1025)}.mp3`,
      'c'.repeat(25),
      'audiocom~111',
    ]) {
      expect(isFeaturedPathname(pathname), JSON.stringify(pathname)).toBe(false);
    }
  });
});

describe('id del player', () => {
  it('upload:<pathname> va e torna; gli altri id upload: non sono brani in evidenza', () => {
    expect(FEATURED_QUALIFIED_PREFIX).toBe('upload:');
    const pathname = 'Pop/Autrice - Canzone.mp3';
    const id = featuredQualifiedId(pathname);
    expect(id).toBe('upload:Pop/Autrice - Canzone.mp3');
    expect(featuredPathnameFromQualifiedId(id)).toBe(pathname);
    expect(isFeaturedPlayId(id)).toBe(true);
    for (const other of [
      `upload:${'c'.repeat(25)}`,
      'upload:audiocom~111',
      'upload:public-uploads/x.mp3',
      'upload:',
      'audius:track',
      'local:abc',
      'audiocom:111',
      'Pop/Autrice - Canzone.mp3',
    ]) {
      expect(featuredPathnameFromQualifiedId(other), other).toBeNull();
      expect(isFeaturedPlayId(other), other).toBe(false);
    }
  });
});
