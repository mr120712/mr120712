// @polsia:user-owned — condivisione sui social: link corretti e sicuri, nessuno script di terzi.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ShareMenu } from '@/components/custom/share-menu';
import { safeAuthDestination } from '@/lib/business/auth-form';
import {
  audiusTrackIdFromQualifiedId,
  publicShareUrl,
  SONG_SHARE_URL_MAX,
  searchParamsRecord,
  shareCardText,
  sharedSongFromParams,
  socialShareLinks,
  songPreviewImagePath,
  songShareImagePath,
  songShareText,
  songShareUrl,
} from '@/lib/business/social-share';

describe('link di condivisione', () => {
  it('WhatsApp, Telegram, X, Facebook ed email con testo e link codificati', () => {
    const links = socialShareLinks({
      url: 'https://www.solcomusic.online/playlist/abc',
      text: 'Ascolta  “Estate & mare” su Solco.',
      title: 'Estate & mare',
    });
    expect(links.map((link) => link.id)).toEqual([
      'whatsapp',
      'telegram',
      'x',
      'facebook',
      'email',
    ]);
    const byId = Object.fromEntries(links.map((link) => [link.id, link.href]));
    expect(byId.whatsapp).toBe(
      `https://wa.me/?text=${encodeURIComponent('Ascolta “Estate & mare” su Solco. https://www.solcomusic.online/playlist/abc')}`,
    );
    expect(byId.telegram).toBe(
      `https://t.me/share/url?url=${encodeURIComponent('https://www.solcomusic.online/playlist/abc')}&text=${encodeURIComponent('Ascolta “Estate & mare” su Solco.')}`,
    );
    expect(byId.x?.startsWith('https://x.com/intent/post?text=')).toBe(true);
    expect(byId.facebook).toBe(
      'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fwww.solcomusic.online%2Fplaylist%2Fabc',
    );
    expect(byId.email?.startsWith('mailto:?subject=Estate%20%26%20mare&body=')).toBe(true);
    // Nessun carattere che possa uscire dal parametro (& e # codificati).
    for (const href of Object.values(byId)) {
      const query = href?.split('?')[1] ?? '';
      expect(query).not.toMatch(/&(?!(url|text|body)=)/);
      expect(query).not.toContain('#');
    }
  });

  it('il link porta sempre al sito ufficiale', () => {
    expect(publicShareUrl('/generi/rock', 'https://www.solcomusic.online')).toBe(
      'https://www.solcomusic.online/generi/rock',
    );
    expect(songShareUrl('Albachiara', 'Vasco Rossi', 'https://www.solcomusic.online')).toBe(
      'https://www.solcomusic.online/search?q=Vasco%20Rossi%20Albachiara&t=Albachiara&a=Vasco%20Rossi',
    );
    expect(songShareUrl('Radio Deejay', null, 'https://www.solcomusic.online')).toBe(
      'https://www.solcomusic.online/search?q=Radio%20Deejay&t=Radio%20Deejay',
    );
  });

  it('titoli con ! ( ) * ~: il link resta valido anche come ritorno dopo l’accesso', () => {
    const url = songShareUrl('Help! (Remastered)', 'The Beatles', 'https://www.solcomusic.online');
    expect(url).toBe(
      'https://www.solcomusic.online/search?q=The%20Beatles%20Help%21%20%28Remastered%29&t=Help%21%20%28Remastered%29&a=The%20Beatles',
    );
    const destination = new URL(url).pathname + new URL(url).search;
    expect(safeAuthDestination(destination)).toBe(destination);
    expect(songShareUrl('P!nk ~ *', null, 'https://x.example')).toBe(
      'https://x.example/search?q=P%21nk%20%7E%20%2A&t=P%21nk%20%7E%20%2A',
    );
  });

  it('emoji tagliate o dati sporchi: nessun errore, nessun carattere spezzato', () => {
    const emojiTitle = `${'a'.repeat(119)}🎵🎵`; // il taglio a 120 cade dentro la prima emoji
    expect(() => songShareText(emojiTitle, null)).not.toThrow();
    expect(() => songShareUrl(`${'b'.repeat(79)}😀`, null, 'https://x.example')).not.toThrow();
    expect(songShareUrl(`${'b'.repeat(79)}😀`, null, 'https://x.example')).toBe(
      `https://x.example/search?q=${'b'.repeat(79)}%F0%9F%98%80&t=${'b'.repeat(79)}%F0%9F%98%80`,
    );
    const broken = 'Titolo \uD83C rotto';
    expect(() =>
      socialShareLinks({ url: 'https://x.example/a', text: songShareText(broken, null) }),
    ).not.toThrow();
    expect(() => songShareUrl(broken, '\uDFFF', 'https://x.example')).not.toThrow();
  });

  it('brano Audius: nel link solo il suo id (au), mai un URL di immagine', () => {
    const url = songShareUrl(
      'Notte Chiara',
      'Artista Uno',
      'https://www.solcomusic.online',
      'J7Xb000',
    );
    expect(url).toBe(
      'https://www.solcomusic.online/search?q=Artista%20Uno%20Notte%20Chiara&t=Notte%20Chiara&a=Artista%20Uno&au=J7Xb000',
    );
    const destination = new URL(url).pathname + new URL(url).search;
    expect(safeAuthDestination(destination)).toBe(destination);
    for (const id of [null, '', 'playlist:abc', 'a b', 'x'.repeat(129), '../x', 'id&img=1']) {
      const link = new URL(songShareUrl('X', null, 'https://x.example', id));
      expect(link.searchParams.has('au'), String(id)).toBe(false);
      expect(link.searchParams.has('img')).toBe(false);
    }
  });

  it('id Audius dal player: solo brani, mai playlist o album', () => {
    expect(audiusTrackIdFromQualifiedId('audius:J7Xb000')).toBe('J7Xb000');
    expect(audiusTrackIdFromQualifiedId('audius:playlist:J7Xb000')).toBeNull();
    expect(audiusTrackIdFromQualifiedId('audius:album:J7Xb000')).toBeNull();
    expect(audiusTrackIdFromQualifiedId('youtube:dQw4w9WgXcQ')).toBeNull();
    expect(audiusTrackIdFromQualifiedId('audius:')).toBeNull();
    expect(audiusTrackIdFromQualifiedId(undefined)).toBeNull();
  });

  it('link lunghi (titoli non latini): sotto ~1800 caratteri, via prima l’artista poi il titolo', () => {
    const base = 'https://www.solcomusic.online';
    const title = 'Ж'.repeat(120);
    // 3 byte UTF-8 per carattere: 9 caratteri nel link per ognuno.
    const artist = '音'.repeat(80);
    const withArtist = songShareUrl(title, 'Ω'.repeat(80), base, 'J7Xb000');
    expect([...new URL(withArtist).searchParams.keys()]).toEqual(['q', 't', 'a', 'au']);
    expect(withArtist.length).toBeLessThanOrEqual(SONG_SHARE_URL_MAX);

    const noArtist = songShareUrl(title, artist, base, 'J7Xb000');
    expect(noArtist.length).toBeLessThanOrEqual(SONG_SHARE_URL_MAX);
    const params = new URL(noArtist).searchParams;
    expect([...params.keys()]).toEqual(['q', 't', 'au']);

    const emoji = '😀'.repeat(120);
    const onlyQuery = songShareUrl(emoji, '😀'.repeat(80), base, 'J7Xb000');
    expect(onlyQuery.length).toBeLessThanOrEqual(SONG_SHARE_URL_MAX);
    expect([...new URL(onlyQuery).searchParams.keys()]).toEqual(['q', 'au']);
    // Sempre accettato come destinazione dopo l'accesso (al massimo 2048 caratteri).
    for (const link of [noArtist, onlyQuery]) {
      const destination = new URL(link).pathname + new URL(link).search;
      expect(safeAuthDestination(destination)).toBe(destination);
    }
  });

  it('dal link alla scheda dell’anteprima: titolo, artista, id; img ignorato', () => {
    expect(
      sharedSongFromParams({
        q: 'Vasco Albachiara',
        t: 'Albachiara',
        a: 'Vasco',
        au: 'J7Xb000',
        img: 'https://evil.example/content/QmAbcdefghijklmnopqrstuvwxyz12/480x480.jpg',
      }),
    ).toEqual({ title: 'Albachiara', artist: 'Vasco', audiusId: 'J7Xb000' });
    // Senza t si usa la ricerca; un id non valido si scarta.
    expect(sharedSongFromParams({ q: 'Solo ricerca', au: 'non valido' })).toEqual({
      title: 'Solo ricerca',
      artist: null,
      audiusId: null,
    });
    expect(sharedSongFromParams({ au: 'J7Xb000' })).toEqual({
      title: '',
      artist: null,
      audiusId: 'J7Xb000',
    });
    expect(sharedSongFromParams({})).toBeNull();
    expect(sharedSongFromParams({ img: 'https://audius.co/x.jpg' })).toBeNull();
    expect(sharedSongFromParams({ t: ['Primo', 'Secondo'] })?.title).toBe('Primo');
    // Niente indirizzi web nel testo libero.
    expect(
      sharedSongFromParams({ t: 'Ascolta https://evil.example/x qui', a: 'www.evil.example' }),
    ).toEqual({ title: 'Ascolta qui', artist: null, audiusId: null });
    expect(sharedSongFromParams({ t: 'http://evil.example' })).toBeNull();
  });

  it('indirizzi web attaccati a una parola, senza schema o che ne formano un altro: tolti', () => {
    const title = (t: string) => sharedSongFromParams({ t, a: 'Artista' })?.title ?? null;
    expect(title('_https://evil.example/login')).toBe('_');
    expect(title('1www.evil.example/x ora')).toBe('ora');
    expect(title('Vaiahttps://evil.example ora')).toBe('Vaia ora');
    expect(title('Brano xhttp://a.b')).toBe('Brano x');
    expect(title('Vai su evil.com subito')).toBe('Vai su subito');
    expect(title('Vai su EVIL.COM')).toBe('Vai su');
    expect(title('Brano sito.example/login')).toBe('Brano');
    // Togliendo un indirizzo ne resterebbe un altro: si toglie anche quello.
    expect(title('Brano a.comhttps://x')).toBe('Brano');
    // Nomi veri con un punto restano.
    for (const name of ['will.i.am', 'Vol.II', 'Mr.Brightside', 'No.1', 'P!nk', 'AC/DC']) {
      expect(title(name), name).toBe(name);
    }
    // Pulire due volte non cambia nulla: l'indirizzo canonico resta lo stesso.
    for (const raw of [
      '_https://evil.example/login',
      'Brano a.comhttps://x',
      'www.a www.b fine',
      `${'a'.repeat(118)} evil.com`,
      `${'b'.repeat(115)} x.it/y`,
    ]) {
      const path = songPreviewImagePath({ title: raw, artist: raw });
      const reread = sharedSongFromParams(
        searchParamsRecord(new URLSearchParams(path.split('?')[1] ?? '')),
      );
      expect(songPreviewImagePath(reread), raw).toBe(path);
    }
  });

  it('titolo e artista di un brano (anche da Audius) per la scheda: niente indirizzi web', () => {
    expect(shareCardText('Solco chiude: vai su https://evil.example/login', 'title')).toBe(
      'Solco chiude: vai su',
    );
    expect(shareCardText('www.evil.example', 'artist')).toBe('');
    expect(shareCardText('  Luci   basse ', 'title')).toBe('Luci basse');
    expect(Array.from(shareCardText('Ω'.repeat(200), 'artist'))).toHaveLength(80);
  });

  it('indirizzo canonico dell’immagine: JPEG, pulito da sé, sempre lo stesso', () => {
    expect(songPreviewImagePath({ title: 'Help!', artist: 'The Beatles' })).toBe(
      '/search/anteprima.jpg?t=Help%21&a=The%20Beatles',
    );
    expect(songPreviewImagePath({ title: '  Help!   ', artist: '  The   Beatles ' })).toBe(
      '/search/anteprima.jpg?t=Help%21&a=The%20Beatles',
    );
    expect(
      songPreviewImagePath({ title: 'Ignorato', artist: 'Ignorato', audiusId: 'J7Xb000' }),
    ).toBe('/search/anteprima.jpg?au=J7Xb000');
    expect(songPreviewImagePath({ title: 'X', audiusId: 'audius:playlist:1' })).toBe(
      '/search/anteprima.jpg?t=X',
    );
    expect(songPreviewImagePath(null)).toBe('/search/anteprima.jpg');
    expect(songPreviewImagePath({ title: 'www.evil.example' })).toBe('/search/anteprima.jpg');
    // Rileggere l'indirizzo canonico dà di nuovo lo stesso indirizzo.
    for (const song of [
      { title: `${'a'.repeat(118)} https://evil.example`, artist: 'Ω'.repeat(100) },
      { title: '😀'.repeat(200), artist: null },
      { title: 'Titolo \uD83C rotto', artist: '\uDFFF' },
      { title: 'P!nk ~ *', artist: "Rock'n'roll (live)" },
    ]) {
      const path = songPreviewImagePath(song);
      const reread = sharedSongFromParams(
        searchParamsRecord(new URLSearchParams(path.split('?')[1] ?? '')),
      );
      expect(songPreviewImagePath(reread)).toBe(path);
    }
  });

  it('immagine del player = og:image della pagina per lo stesso link', () => {
    const link = songShareUrl('Notte Chiara', 'Artista Uno', 'https://www.solcomusic.online');
    expect(songShareImagePath(link)).toBe('/search/anteprima.jpg?t=Notte%20Chiara&a=Artista%20Uno');
    const audius = songShareUrl('Notte', 'Uno', 'https://www.solcomusic.online', 'J7Xb000');
    expect(songShareImagePath(audius)).toBe('/search/anteprima.jpg?au=J7Xb000');
  });

  it('testo di ciò che si ascolta', () => {
    expect(songShareText('Albachiara', 'Vasco Rossi')).toBe(
      'Sto ascoltando «Albachiara» di Vasco Rossi su Solco.',
    );
    expect(songShareText('Albachiara', null)).toBe('Sto ascoltando «Albachiara» su Solco.');
    expect(songShareText('Radio Deejay', null, true)).toBe('Sto ascoltando Radio Deejay su Solco.');
  });
});

describe('menu "Condividi"', () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    toast.success.mockReset();
    toast.error.mockReset();
  });

  async function open(element: React.ReactElement) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(element));
    const trigger = container.querySelector('button');
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    return trigger;
  }

  const props = {
    title: 'Albachiara',
    text: 'Sto ascoltando «Albachiara» di Vasco Rossi su Solco.',
    url: 'https://www.solcomusic.online/search?q=Vasco%20Rossi%20Albachiara',
  };

  it('link esterni sicuri, email e copia del link', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const trigger = await open(<ShareMenu {...props} ariaLabel="Condividi Albachiara" />);
    expect(trigger?.getAttribute('aria-label')).toBe('Condividi Albachiara');
    const anchors = [...document.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.textContent?.split(' (')[0])).toEqual([
      'WhatsApp',
      'Telegram',
      'X',
      'Facebook',
      'Email',
    ]);
    for (const anchor of anchors.slice(0, 4)) {
      expect(anchor.target).toBe('_blank');
      expect(anchor.rel).toBe('noopener noreferrer');
    }
    expect(anchors[4]?.getAttribute('href')?.startsWith('mailto:')).toBe(true);
    // Il menu del telefono non c'è senza navigator.share.
    expect(document.body.textContent).not.toContain('Altre app');

    const copy = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('Copia link'),
    );
    await act(async () => {
      copy?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith(props.url);
    expect(toast.success).toHaveBeenCalledWith('Link copiato.');
  });

  it('sul telefono offre anche il menu di sistema (Instagram, TikTok…)', async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, share });
    await open(<ShareMenu {...props} />);
    const native = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('Altre app'),
    );
    expect(native).toBeTruthy();
    await act(async () => {
      native?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(share).toHaveBeenCalledWith({ title: props.title, text: props.text, url: props.url });
  });

  function jpegFetch() {
    return vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
          headers: { 'content-type': 'image/jpeg' },
        }),
    );
  }

  async function tapNative() {
    const native = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('Altre app'),
    );
    await act(async () => {
      native?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  }

  it('sul telefono allega la scheda del brano come immagine (preparata all’apertura del menu)', async () => {
    const share = vi.fn(async (_data: ShareData) => undefined);
    const canShare = vi.fn((_data?: ShareData) => true);
    vi.stubGlobal('navigator', { ...navigator, share, canShare });
    vi.stubGlobal('fetch', jpegFetch());
    await open(<ShareMenu {...props} imageUrl="/search/anteprima.jpg?t=Albachiara" />);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    await tapNative();
    const payload = share.mock.calls[0]?.[0] as ShareData | undefined;
    expect(payload).toBeDefined();
    if (!payload) return;
    expect(payload.url).toBe(props.url);
    expect(payload.files?.[0]?.name).toBe('solco.jpg');
    expect(payload.files?.[0]?.type).toBe('image/jpeg');
    // Il controllo riguarda il contenuto intero (titolo, testo, link e immagine insieme).
    expect(canShare).toHaveBeenCalledWith({
      title: props.title,
      text: props.text,
      url: props.url,
      files: payload.files,
    });
  });

  it('se il sistema non accetta il contenuto intero con l’immagine, condivide solo il link', async () => {
    const share = vi.fn(async (_data: ShareData) => undefined);
    // Accetta i file da soli ma non insieme al testo e al link (come alcune versioni di Android).
    const canShare = vi.fn((data?: ShareData) => Boolean(data?.files && !data.url));
    vi.stubGlobal('navigator', { ...navigator, share, canShare });
    vi.stubGlobal('fetch', jpegFetch());
    await open(<ShareMenu {...props} imageUrl="/search/anteprima.jpg?t=Albachiara" />);
    await settle();
    await tapNative();
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ title: props.title, text: props.text, url: props.url });
  });

  it('condivisione rifiutata: nessun secondo tentativo, suggerisce «Copia link»', async () => {
    const share = vi.fn(async (_data: ShareData) => {
      throw Object.assign(new Error('rifiutato'), { name: 'NotAllowedError' });
    });
    vi.stubGlobal('navigator', { ...navigator, share, canShare: () => true });
    vi.stubGlobal('fetch', jpegFetch());
    await open(<ShareMenu {...props} imageUrl="/search/anteprima.jpg?t=Albachiara" />);
    await settle();
    await tapNative();
    await settle();
    expect(share).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0]?.[0])).toContain('Copia link');
  });

  it('chiusa dall’utente (AbortError): nessun messaggio, nessun secondo tentativo', async () => {
    const share = vi.fn(async (_data: ShareData) => {
      throw Object.assign(new Error('chiuso'), { name: 'AbortError' });
    });
    vi.stubGlobal('navigator', { ...navigator, share, canShare: () => true });
    vi.stubGlobal('fetch', jpegFetch());
    await open(<ShareMenu {...props} imageUrl="/search/anteprima.jpg?t=Albachiara" />);
    await settle();
    await tapNative();
    await settle();
    expect(share).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('immagine di un altro sito o sistema senza file: si condivide solo il link', async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, share, canShare: () => false });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
      ),
    );
    await open(<ShareMenu {...props} imageUrl="https://evil.example/x.png" />);
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(fetch).not.toHaveBeenCalled();
    const native = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('Altre app'),
    );
    await act(async () => {
      native?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(share).toHaveBeenCalledWith({ title: props.title, text: props.text, url: props.url });
  });
});
