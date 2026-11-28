// @polsia:user-owned — pagina /contatti: metadata (titolo, canonical, nessun noindex), voce nel
// footer e quindi in sitemap, e il contenuto: frase sul titolare, cinque motivi di contatto con
// mailto e oggetto, canale Telegram, link a privacy, termini, stato, piani, guida, eliminazione
// account e security.txt; nessuna frase da bozza nelle pagine legali.
// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ContattiPage, { metadata } from '@/app/(custom)/contatti/page';
import PrivacyPage from '@/app/(custom)/privacy/page';
import TermsPage from '@/app/(custom)/terms/page';
import { legalContact, socialLinks } from '@/lib/brand';
import { CONTACT_SUBJECTS } from '@/lib/legal-contact';
import { navItems } from '@/lib/nav';

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

describe('pagina /contatti', () => {
  it('metadata: titolo, descrizione, canonical, nessun noindex', () => {
    expect(metadata.title).toBe('Contatti');
    expect((metadata.description ?? '').length).toBeGreaterThan(40);
    expect(metadata.alternates?.canonical).toBe('/contatti');
    expect(metadata.robots).toBeUndefined();
  });

  it('è nel footer senza login richiesto (quindi in sitemap e llms.txt)', () => {
    const item = navItems.find((entry) => entry.href === '/contatti');
    expect(item).toMatchObject({ label: 'Contatti', group: 'footer' });
    expect(item?.requiresAuth).toBeUndefined();
  });

  it('mostra chi gestisce il servizio e un mailto con oggetto per ogni motivo di contatto', () => {
    const root = render(<ContattiPage />);
    expect(root.querySelector('h1')?.textContent).toBe('Contatti e gestore del servizio');
    expect(root.textContent).toContain(legalContact.email);
    expect(root.textContent).toContain(legalContact.responseTime);
    expect(root.textContent).toContain(legalContact.country);
    const mailtos = [...root.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]')].map((a) =>
      a.getAttribute('href'),
    );
    expect(mailtos).toContain(`mailto:${legalContact.email}`);
    for (const subject of Object.values(CONTACT_SUBJECTS)) {
      expect(mailtos, subject).toContain(
        `mailto:${legalContact.email}?subject=${encodeURIComponent(subject)}`,
      );
    }
  });

  it('collega canale Telegram, documenti, stato, piani, eliminazione account e security.txt', () => {
    const root = render(<ContattiPage />);
    const hrefs = new Set(
      [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => a.getAttribute('href')),
    );
    for (const href of [
      socialLinks.telegram,
      '/privacy',
      '/terms',
      '/stato',
      '/piani',
      '/guida',
      '/delete-account',
      '/.well-known/security.txt',
    ]) {
      expect(hrefs.has(href), href).toBe(true);
    }
    expect(root.textContent).not.toMatch(/Bozza per revisione|da confermare/i);
  });
});

describe('pagine legali senza frasi da bozza', () => {
  it('privacy e termini riportano il titolare, i contatti e la data di aggiornamento', () => {
    for (const [name, element] of [
      ['privacy', <PrivacyPage key="p" />],
      ['terms', <TermsPage key="t" />],
    ] as const) {
      const text = render(element).textContent ?? '';
      // «bozza» da sola no: la privacy parla legittimamente della bozza di una playlist.
      expect(text, name).not.toMatch(
        /Bozza per revisione|proprietario deve|prima della pubblicazione|da confermare|devono essere confermat/i,
      );
      expect(text, name).toContain(legalContact.email);
      // La privacy è stata aggiornata per la chat di assistenza con Claude.
      expect(text, name).toContain(name === 'privacy' ? '28 novembre 2026' : '16 novembre 2026');
      expect(text, name).toMatch(/servizio indipendente|Solco è gestito da/);
    }
    const privacy = render(<PrivacyPage />);
    expect(privacy.querySelector('a[href="/contatti"]')).not.toBeNull();
    expect(privacy.textContent).toContain('www.solcomusic.online/delete-account');
    expect(privacy.textContent).not.toContain('solcomusic.app/delete-account');
  });
});
