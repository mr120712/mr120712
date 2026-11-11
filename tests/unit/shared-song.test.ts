// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import { isLinkOnly, parseSharedSong, spotifySearchUrl } from '@/lib/business/shared-song';

describe('ascolta in Solco: testo condiviso', () => {
  it('riconosce il testo di condivisione in italiano e in inglese', () => {
    expect(
      parseSharedSong(
        'Ascolta Strada Nuova di Band Finta su Spotify: https://open.spotify.com/track/abc',
      ),
    ).toEqual({ title: 'Strada Nuova', artist: 'Band Finta' });
    expect(
      parseSharedSong('Listen to Luce del Mattino by Gruppo Inventato on Apple Music'),
    ).toEqual({
      title: 'Luce del Mattino',
      artist: 'Gruppo Inventato',
    });
    expect(parseSharedSong('“Strada Nuova” by Band Finta')).toEqual({
      title: 'Strada Nuova',
      artist: 'Band Finta',
    });
  });

  it('accetta "Artista - Titolo" e un titolo da solo', () => {
    expect(parseSharedSong('Band Finta - Strada Nuova')).toEqual({
      title: 'Strada Nuova',
      artist: 'Band Finta',
    });
    expect(parseSharedSong('Strada Nuova')).toEqual({ title: 'Strada Nuova', artist: null });
  });

  it('riconosce un link senza testo, che non contiene il titolo', () => {
    expect(isLinkOnly('https://open.spotify.com/track/0123456789abcdefghijkl?si=x')).toBe(true);
    expect(isLinkOnly('Band Finta - Strada Nuova https://open.spotify.com/track/x')).toBe(false);
    expect(parseSharedSong('https://open.spotify.com/track/abc')).toBeNull();
  });

  it('apre la ricerca dello stesso brano in Spotify', () => {
    expect(spotifySearchUrl('Strada Nuova', 'Band Finta')).toBe(
      'https://open.spotify.com/search/Band%20Finta%20Strada%20Nuova',
    );
  });
});
