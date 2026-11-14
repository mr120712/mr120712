// @polsia:user-owned — condivisione sui social: link corretti e sicuri, nessuno script di terzi.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ShareMenu } from '@/components/custom/share-menu';
import { safeAuthDestination } from '@/lib/business/auth-form';
import {
  publicShareUrl,
  socialShareLinks,
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
      'https://www.solcomusic.online/search?q=Vasco%20Rossi%20Albachiara',
    );
    expect(songShareUrl('Radio Deejay', null, 'https://www.solcomusic.online')).toBe(
      'https://www.solcomusic.online/search?q=Radio%20Deejay',
    );
  });

  it('titoli con ! ( ) * ~: il link resta valido anche come ritorno dopo l’accesso', () => {
    const url = songShareUrl('Help! (Remastered)', 'The Beatles', 'https://www.solcomusic.online');
    expect(url).toBe(
      'https://www.solcomusic.online/search?q=The%20Beatles%20Help%21%20%28Remastered%29',
    );
    const destination = new URL(url).pathname + new URL(url).search;
    expect(safeAuthDestination(destination)).toBe(destination);
    expect(songShareUrl('P!nk ~ *', null, 'https://x.example')).toBe(
      'https://x.example/search?q=P%21nk%20%7E%20%2A',
    );
  });

  it('emoji tagliate o dati sporchi: nessun errore, nessun carattere spezzato', () => {
    const emojiTitle = `${'a'.repeat(119)}🎵🎵`; // il taglio a 120 cade dentro la prima emoji
    expect(() => songShareText(emojiTitle, null)).not.toThrow();
    expect(() => songShareUrl(`${'b'.repeat(79)}😀`, null, 'https://x.example')).not.toThrow();
    expect(songShareUrl(`${'b'.repeat(79)}😀`, null, 'https://x.example')).toBe(
      `https://x.example/search?q=${'b'.repeat(79)}%F0%9F%98%80`,
    );
    const broken = 'Titolo \uD83C rotto';
    expect(() =>
      socialShareLinks({ url: 'https://x.example/a', text: songShareText(broken, null) }),
    ).not.toThrow();
    expect(() => songShareUrl(broken, '\uDFFF', 'https://x.example')).not.toThrow();
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
});
