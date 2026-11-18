// @polsia:user-owned — funzione «Ho YouTube Premium»: il link apre il video ESATTO su YouTube solo
// con un id valido (niente ricerca di ripiego per il tasto Premium), e la preferenza è spenta di
// default, si accende e si spegne, salvata per dispositivo.
import { afterEach, describe, expect, it } from 'vitest';
import { youtubeWatchUrl } from '@/lib/business/shared-song';
import { getYouTubePremium, setYouTubePremium } from '@/lib/music/youtube-premium';

describe('youtubeWatchUrl', () => {
  it('apre il video esatto su YouTube solo con un id valido', () => {
    expect(youtubeWatchUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(youtubeWatchUrl('aaaaaaaaaaa')).toBe('https://www.youtube.com/watch?v=aaaaaaaaaaa');
  });

  it('niente link (niente ricerca di ripiego) se l’id non è valido', () => {
    expect(youtubeWatchUrl(null)).toBeNull();
    expect(youtubeWatchUrl(undefined)).toBeNull();
    expect(youtubeWatchUrl('')).toBeNull();
    expect(youtubeWatchUrl('troppocorto')).toBe('https://www.youtube.com/watch?v=troppocorto'); // 11 caratteri validi
    expect(youtubeWatchUrl('dodici_carat')).toBeNull(); // 12 caratteri
    expect(youtubeWatchUrl('ha spazi!!!')).toBeNull(); // caratteri non ammessi
  });
});

describe('preferenza «Ho YouTube Premium»', () => {
  afterEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // storage non disponibile nell'ambiente di test: nulla da pulire.
    }
  });

  it('spenta di default; si accende e si spegne', () => {
    expect(getYouTubePremium()).toBe(false);
    setYouTubePremium(true);
    expect(getYouTubePremium()).toBe(true);
    setYouTubePremium(false);
    expect(getYouTubePremium()).toBe(false);
  });
});
