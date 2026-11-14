// @vitest-environment node
// @polsia:user-owned — la paginetta di meta tag che i bot delle anteprime ricevono in modalità
// attacco: contenuto per brano, quiz musicale, playlist e resto del sito, URL assoluti, testo
// scappato e ripulito dagli indirizzi web, nessuno script; per un quiz mai l'artista (la risposta).
import { describe, expect, it } from 'vitest';
import { siteDescription, siteName } from '@/lib/brand';
import {
  sharedSongFromParams,
  sharedSongPagePath,
  songPreviewImagePath,
} from '@/lib/business/social-share';
import {
  QUIZ_DESCRIPTION,
  quizPagePath,
  quizPreviewImagePath,
  songQuizFromParams,
  songQuizUrl,
} from '@/lib/business/song-quiz';
import {
  SHARED_PLAYLIST_DESCRIPTION,
  SHARED_PLAYLIST_IMAGE_ALT,
  SHARED_PLAYLIST_TITLE,
  sharedPlaylistImagePath,
} from '@/lib/music/playlist-share';
import {
  escapeHtml,
  LINK_PREVIEW_CSP,
  linkPreviewFor,
  renderLinkPreviewPage,
  stripUrlLikeText,
} from '@/lib/security/uam-preview';

const BASE = 'https://www.solcomusic.online';
const SHARE_ID = 'AbCdEfGhIjKlMnOpQrStUv';

function previewOf(pathAndQuery: string) {
  return linkPreviewFor(new URL(pathAndQuery, 'https://qualsiasi.host'), BASE);
}

/** Valore di un meta tag nella pagina (null se manca). */
function metaContent(html: string, attribute: 'name' | 'property', key: string): string | null {
  const match = new RegExp(`<meta ${attribute}="${key}" content="([^"]*)">`).exec(html);
  return match ? (match[1] ?? '') : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

describe('linkPreviewFor', () => {
  it('un brano condiviso (/search con i parametri del brano)', () => {
    const path = '/search?q=Mina%20Grande&t=Grande%20grande%20grande&a=Mina';
    const preview = previewOf(path);
    const song = sharedSongFromParams({ q: 'Mina Grande', t: 'Grande grande grande', a: 'Mina' });
    expect(song).not.toBeNull();
    expect(preview).toEqual({
      title: 'Grande grande grande · Mina',
      description: 'Ascoltalo su Solco: musica, radio dal vivo e podcast in un solo player.',
      image: `${BASE}${songPreviewImagePath(song)}`,
      imageAlt: 'Grande grande grande · Mina',
      // og:url: il link canonico del brano, lo stesso della pagina (search/page.tsx).
      url: `${BASE}${sharedSongPagePath(song)}`,
      type: 'music.song',
    });
    expect(preview.url).toBe(
      `${BASE}/search?q=Mina%20Grande%20grande%20grande&t=Grande%20grande%20grande&a=Mina`,
    );
    expect(preview.image.startsWith(`${BASE}/search/anteprima.`)).toBe(true);
  });

  it('un brano con il solo id Audius: og:url è il link richiesto', () => {
    const preview = previewOf('/search?au=J7Xb000');
    expect(preview.type).toBe('music.song');
    expect(preview.url).toBe(`${BASE}/search?au=J7Xb000`);
  });

  it('toglie dal titolo e dall’artista ogni testo che sembra un indirizzo web', () => {
    const preview = previewOf(
      `/search?t=${encodeURIComponent('Ciao https://evil.example/x www.spam.it fine')}&a=${encodeURIComponent('http://a.b Artista')}`,
    );
    expect(preview.type).toBe('music.song');
    expect(preview.title).toBe('Ciao fine · Artista');
    expect(preview.title).not.toMatch(/evil|spam|http/);
    expect(preview.image).not.toMatch(/evil|spam/);
  });

  it('una ricerca senza brano o con solo un indirizzo come titolo mostra la scheda di Solco', () => {
    for (const path of [
      '/search',
      '/search?ai=1',
      `/search?t=${encodeURIComponent('https://x.y')}`,
    ]) {
      const preview = previewOf(path);
      expect(preview.title, path).toBe(siteName);
      expect(preview.image, path).toBe(`${BASE}/opengraph-image`);
    }
  });

  it('un quiz musicale (/quiz?c=…): la domanda, mai la risposta', () => {
    const link = new URL(String(songQuizUrl({ title: 'Grande', artist: 'Mina Mazzini' }, BASE)));
    const path = `${link.pathname}${link.search}`;
    const preview = previewOf(path);
    expect(preview).toEqual({
      title: 'Quiz: chi interpreta «Grande»?',
      description: QUIZ_DESCRIPTION,
      image: `${BASE}/quiz/anteprima.jpg?t=Grande`,
      imageAlt: 'Quiz: chi interpreta «Grande»?',
      url: `${BASE}${path}`,
      type: 'website',
    });
    const quiz = songQuizFromParams(Object.fromEntries(link.searchParams));
    expect(preview.image).toBe(`${BASE}${quizPreviewImagePath(quiz)}`);
    // og:url: lo stesso percorso canonico della pagina (quiz/page.tsx), anche con parametri in più.
    expect(preview.url).toBe(`${BASE}${quizPagePath(quiz)}`);
    expect(previewOf(`${path}&fbclid=abc`).url).toBe(`${BASE}${path}`);
    // L'URL della pagina porta il codice, ma la risposta non è leggibile da nessuna parte.
    expect(JSON.stringify(preview).toLowerCase()).not.toContain('mina');
    const html = renderLinkPreviewPage(preview);
    expect(html.toLowerCase()).not.toContain('mina');
    expect(metaContent(html, 'property', 'og:image')).toBe(`${BASE}/quiz/anteprima.jpg?t=Grande`);
  });

  it('un quiz di un brano Audius: l’immagine porta solo l’id', () => {
    const link = new URL(
      String(
        songQuizUrl({ title: 'Luci basse', artist: 'Artista Audius', audiusId: 'J7Xb000' }, BASE),
      ),
    );
    const preview = previewOf(`${link.pathname}${link.search}`);
    expect(preview.title).toBe('Quiz: chi interpreta «Luci basse»?');
    expect(preview.image).toBe(`${BASE}/quiz/anteprima.jpg?au=J7Xb000`);
    expect(JSON.stringify(preview)).not.toContain('Artista Audius');
  });

  it('un quiz non valido o senza codice: la scheda generica del quiz', () => {
    for (const path of ['/quiz', '/quiz/', '/quiz?c=rotto', '/quiz?t=Brano&a=Mina']) {
      expect(previewOf(path), path).toEqual({
        title: 'Quiz musicale su Solco',
        description: QUIZ_DESCRIPTION,
        image: `${BASE}/quiz/anteprima.jpg`,
        imageAlt: 'Quiz musicale su Solco',
        url: `${BASE}/quiz`,
        type: 'website',
      });
    }
  });

  it('una playlist condivisa (/playlist/<shareId>)', () => {
    for (const path of [`/playlist/${SHARE_ID}`, `/playlist/${SHARE_ID}/`]) {
      // Gli stessi testi dei metadati della pagina (playlist/[shareId]/page.tsx).
      expect(previewOf(path)).toEqual({
        title: SHARED_PLAYLIST_TITLE,
        description: SHARED_PLAYLIST_DESCRIPTION,
        image: `${BASE}${sharedPlaylistImagePath(SHARE_ID)}`,
        imageAlt: SHARED_PLAYLIST_IMAGE_ALT,
        url: `${BASE}/playlist/${SHARE_ID}`,
        type: 'music.playlist',
      });
    }
    expect(previewOf(`/playlist/${SHARE_ID}`).image).toMatch(
      new RegExp(`^${BASE}/playlist/${SHARE_ID}/anteprima\\.(?:png|jpg)$`),
    );
  });

  it('un id di playlist non valido o un altro percorso: la scheda generica', () => {
    for (const path of [
      '/playlist/corto',
      `/playlist/${SHARE_ID}x`,
      `/playlist/${SHARE_ID}/altro`,
    ]) {
      expect(previewOf(path).type, path).toBe('website');
    }
  });

  it('ogni altra pagina usa nome e descrizione del sito e /opengraph-image', () => {
    for (const path of ['/', '/music', '/albums/abc?x=1', '/generi/rock']) {
      const preview = previewOf(path);
      expect(preview, path).toEqual({
        title: siteName,
        description: siteDescription,
        image: `${BASE}/opengraph-image`,
        imageAlt: siteName,
        url: `${BASE}${new URL(path, BASE).pathname}${new URL(path, BASE).search}`,
        type: 'website',
      });
    }
  });

  it('gli URL restano sull’origine canonica anche con un percorso che inizia con //', () => {
    const preview = previewOf('https://qualsiasi.host//evil.example/x');
    expect(preview.url).toBe(`${BASE}//evil.example/x`);
    expect(new URL(preview.url).host).toBe('www.solcomusic.online');
  });

  it('un parametro __proto__ non rompe la lettura del brano', () => {
    const preview = previewOf('/search?__proto__=x&__proto__=y&t=Brano');
    expect(preview.title).toBe('Brano');
  });
});

describe('renderLinkPreviewPage', () => {
  it('ha solo meta tag: titolo, descrizione, immagine assoluta, url, card grande, noindex', () => {
    const preview = previewOf(`/playlist/${SHARE_ID}`);
    const html = renderLinkPreviewPage(preview);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script|<style|<link|<img|<iframe|style=/i);
    expect(metaContent(html, 'property', 'og:title')).toBe('Playlist condivisa');
    expect(metaContent(html, 'property', 'og:image:alt')).toBe('Playlist condivisa su Solco');
    expect(metaContent(html, 'property', 'og:description')).toBe(preview.description);
    expect(metaContent(html, 'property', 'og:image')).toBe(preview.image);
    expect(metaContent(html, 'property', 'og:image')).toMatch(/^https:\/\//);
    expect(metaContent(html, 'property', 'og:url')).toBe(`${BASE}/playlist/${SHARE_ID}`);
    expect(metaContent(html, 'property', 'og:type')).toBe('music.playlist');
    expect(metaContent(html, 'property', 'og:image:width')).toBe('1200');
    expect(metaContent(html, 'property', 'og:image:height')).toBe('630');
    expect(metaContent(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'name', 'twitter:image')).toBe(preview.image);
    expect(metaContent(html, 'name', 'robots')).toBe('noindex');
    expect(html).toContain('<title>Playlist condivisa</title>');
  });

  it('scappa ogni valore (nessun tag o attributo iniettabile)', () => {
    const html = renderLinkPreviewPage({
      title: '"><script>alert(1)</script>',
      description: "<img src=x onerror='x'>",
      image: `${BASE}/x?a="b"&c=<d>`,
      imageAlt: '&',
      url: `${BASE}/"onmouseover="x`,
      type: 'website',
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('"onmouseover');
    expect(decodeEntities(metaContent(html, 'property', 'og:title') ?? '')).toBe(
      '"><script>alert(1)</script>',
    );
    expect(decodeEntities(metaContent(html, 'property', 'og:image') ?? '')).toBe(
      `${BASE}/x?a="b"&c=<d>`,
    );
  });

  it('il brano condiviso dal proxy: query scappata, testo libero senza indirizzi', () => {
    const html = renderLinkPreviewPage(
      previewOf(`/search?t=${encodeURIComponent('A "B" <C> www.x.y')}&a=Z`),
    );
    expect(decodeEntities(metaContent(html, 'property', 'og:title') ?? '')).toBe('A "B" <C> · Z');
    expect(html).not.toContain('<C>');
  });
});

describe('helpers', () => {
  it.each([
    ['Ciao https://evil.example/x mondo', 'Ciao mondo'],
    ['www.spam.it Brano', 'Brano'],
    ['HTTP://A.B/c Brano', 'Brano'],
    ['Brano normale', 'Brano normale'],
    ['https://solo.link', ''],
  ])('stripUrlLikeText(%j) → %j', (input, expected) => {
    expect(stripUrlLikeText(input)).toBe(expected);
  });

  it('escapeHtml', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('la CSP non permette nulla', () => {
    expect(LINK_PREVIEW_CSP).toContain("default-src 'none'");
    expect(LINK_PREVIEW_CSP).not.toMatch(/script-src|unsafe/);
  });
});
