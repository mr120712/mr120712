// @polsia:user-owned — regole d'accesso allo stream dei brani in evidenza: avvio vs blocco del
// Range; richieste del player (stesso sito, destinazione audio, o senza intestazioni Sec-Fetch)
// contro hotlinking da altri siti e navigazione diretta all'URL; la web app iOS (cross-site ma con
// Referer/Origin di Solco) passa.
import { describe, expect, it } from 'vitest';
import { isFeaturedPlayerRequest, isFeaturedStreamStart } from '@/lib/music/featured-stream-access';

describe('isFeaturedStreamStart', () => {
  it('avvio: nessun Range o Range dal primo byte; blocco: Range da metà', () => {
    expect(isFeaturedStreamStart(null)).toBe(true);
    expect(isFeaturedStreamStart(undefined)).toBe(true);
    expect(isFeaturedStreamStart('bytes=0-')).toBe(true);
    expect(isFeaturedStreamStart('bytes=0-1')).toBe(true);
    expect(isFeaturedStreamStart(' Bytes = 0-65535 ')).toBe(true);
    expect(isFeaturedStreamStart('bytes=1-')).toBe(false);
    expect(isFeaturedStreamStart('bytes=65536-131071')).toBe(false);
    expect(isFeaturedStreamStart('bytes=-500')).toBe(false);
  });
});

describe('isFeaturedPlayerRequest', () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  const OWN = new Set(['https://www.solcomusic.online']);

  it('il player di Solco (stesso sito, destinazione audio) passa', () => {
    expect(
      isFeaturedPlayerRequest(
        headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'audio' }),
      ),
    ).toBe(true);
    expect(
      isFeaturedPlayerRequest(
        headers({ 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'audio' }),
      ),
    ).toBe(true);
    // Richiesta "none" non di navigazione (es. media session / prefetch): passa.
    expect(
      isFeaturedPlayerRequest(headers({ 'sec-fetch-site': 'none', 'sec-fetch-dest': 'audio' })),
    ).toBe(true);
  });

  it('hotlinking da un altro sito e navigazione diretta sono rifiutati', () => {
    expect(
      isFeaturedPlayerRequest(
        headers({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'audio' }),
      ),
    ).toBe(false);
    expect(
      isFeaturedPlayerRequest(
        headers({
          'sec-fetch-site': 'cross-site',
          'sec-fetch-dest': 'audio',
          referer: 'https://altro.example/player',
        }),
        OWN,
      ),
    ).toBe(false);
    expect(
      isFeaturedPlayerRequest(headers({ 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' })),
    ).toBe(false);
    expect(
      isFeaturedPlayerRequest(
        headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' }),
      ),
    ).toBe(false);
  });

  it('la web app iOS (profilo): cross-site ma con Referer o Origin di Solco passa', () => {
    expect(
      isFeaturedPlayerRequest(
        headers({
          'sec-fetch-site': 'cross-site',
          'sec-fetch-dest': 'audio',
          referer: 'https://www.solcomusic.online/',
        }),
        OWN,
      ),
    ).toBe(true);
    expect(
      isFeaturedPlayerRequest(
        headers({
          'sec-fetch-site': 'cross-site',
          'sec-fetch-dest': 'empty',
          origin: 'https://www.solcomusic.online',
        }),
        OWN,
      ),
    ).toBe(true);
    // Senza l'elenco delle origini proprie vale la regola stretta di prima.
    expect(
      isFeaturedPlayerRequest(
        headers({
          'sec-fetch-site': 'cross-site',
          'sec-fetch-dest': 'audio',
          referer: 'https://www.solcomusic.online/',
        }),
      ),
    ).toBe(false);
  });

  it('una navigazione resta rifiutata anche con un Referer di Solco (niente download diretto)', () => {
    expect(
      isFeaturedPlayerRequest(
        headers({
          'sec-fetch-site': 'same-origin',
          'sec-fetch-dest': 'document',
          referer: 'https://www.solcomusic.online/search',
        }),
        OWN,
      ),
    ).toBe(false);
    expect(
      isFeaturedPlayerRequest(
        headers({
          'sec-fetch-site': 'cross-site',
          'sec-fetch-dest': 'document',
          referer: 'https://www.solcomusic.online/',
        }),
        OWN,
      ),
    ).toBe(false);
  });

  it('senza intestazioni Sec-Fetch (browser vecchi) passa: decide la sessione', () => {
    expect(isFeaturedPlayerRequest(headers({}))).toBe(true);
    expect(isFeaturedPlayerRequest(headers({ range: 'bytes=0-' }))).toBe(true);
  });
});
