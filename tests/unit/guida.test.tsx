// @polsia:user-owned — guida per chi inizia (/guida): sezioni e indice, link interni verso pagine
// vere, niente pagine vietate, domande apribili, invito chiudibile in Home, punti d'ingresso
// (menu, landing in 6 lingue, Impostazioni, Home) e accesso senza login.
// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// data-next-link distingue i link fatti con next/link dagli <a> normali (vedi le ancore #…).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} data-next-link="" {...rest}>
      {children}
    </a>
  ),
}));
// Le Impostazioni montano gli interruttori del player e la sezione «Account» (sessione): qui
// interessa solo il link alla guida.
vi.mock('@/components/custom/settings/settings-panel', () => ({ SettingsPanel: () => null }));
vi.mock('@/components/custom/settings/account-email-settings', () => ({
  AccountEmailSettings: () => null,
}));

import GuidaPage, { metadata } from '@/app/(custom)/guida/page';
import ImpostazioniPage from '@/app/(custom)/impostazioni/page';
import { GUIDE_SECTIONS, GUIDE_TOC_ID } from '@/components/custom/guide/guide-sections';
import { isPublicRoute } from '@/components/custom/require-login';
import { LANDING_LOCALES, LANDING_MESSAGES } from '@/lib/i18n/landing';
import { llmsConfig } from '@/lib/llms-config';
import { navItems } from '@/lib/nav';

const roots: Array<ReturnType<typeof createRoot>> = [];
const containers: HTMLElement[] = [];

function render(node: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Rotte delle pagine in src/app (i gruppi tra parentesi non entrano nell'URL). */
function appRoutes(): Set<string> {
  const root = join(process.cwd(), 'src', 'app');
  const routes = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'page.tsx') {
        const segments = relative(root, dir)
          .split(sep)
          .filter((segment) => segment && !segment.startsWith('('));
        routes.add(`/${segments.join('/')}`);
      }
    }
  };
  walk(root);
  return routes;
}

function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('a[href]')).map(
    (link) => link.getAttribute('href') ?? '',
  );
}

describe('pagina /guida', () => {
  it('metadata: titolo «Guida per iniziare», descrizione semplice e canonical', () => {
    expect(metadata.title).toBe('Guida per iniziare');
    expect(typeof metadata.description).toBe('string');
    expect((metadata.description ?? '').length).toBeGreaterThan(40);
    expect(metadata.alternates?.canonical).toBe('/guida');
  });

  it('mostra il titolo, «In breve» e tutte le sezioni, con i titoli in ordine', () => {
    const container = render(<GuidaPage />);
    const h1 = container.querySelectorAll('h1');
    expect(h1).toHaveLength(1);
    expect(h1[0]?.textContent).toBe('Guida per iniziare');
    const h2 = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent ?? '');
    expect(h2).toContain('In breve');
    expect(h2).toContain('In questa guida');
    for (const section of GUIDE_SECTIONS) {
      const element = container.querySelector(`section#${section.id}`);
      expect(element, section.id).not.toBeNull();
      expect(element?.querySelector('h2')?.textContent, section.id).toBe(section.title);
    }
    // Ogni sezione finisce con un pulsante per provare e il ritorno all'indice.
    for (const section of GUIDE_SECTIONS) {
      const element = container.querySelector(`section#${section.id}`);
      const links = Array.from(element?.querySelectorAll('a') ?? []);
      expect(
        links.some((link) => link.textContent === 'Torna all’indice'),
        section.id,
      ).toBe(true);
    }
    // Titoli in ordine: nessun salto da h2 a h4.
    const levels = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) =>
      Number(h.tagName.slice(1)),
    );
    for (let i = 1; i < levels.length; i += 1) {
      expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
    }
  });

  it('indice: un link per sezione, ancore uguali agli id e id unici nella pagina', () => {
    const container = render(<GuidaPage />);
    const toc = container.querySelector(`nav#${GUIDE_TOC_ID}`);
    expect(toc).not.toBeNull();
    const tocTargets = Array.from(toc?.querySelectorAll('a') ?? []).map((link) =>
      (link.getAttribute('href') ?? '').replace(/^#/, ''),
    );
    expect(tocTargets).toEqual(GUIDE_SECTIONS.map((section) => section.id));

    const ids = Array.from(container.querySelectorAll('[id]')).map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Tutte le ancore interne della guida portano a un elemento che esiste.
    for (const href of hrefs(container).filter((value) => value.startsWith('#'))) {
      expect(container.querySelector(`[id="${href.slice(1)}"]`), href).not.toBeNull();
    }
  });

  it('ogni link interno porta a una pagina che esiste in src/app', () => {
    const container = render(<GuidaPage />);
    const routes = appRoutes();
    const internal = hrefs(container).filter((href) => href.startsWith('/'));
    expect(internal.length).toBeGreaterThan(15);
    for (const href of internal) {
      const path = href.split(/[?#]/)[0] ?? '';
      expect(routes.has(path), href).toBe(true);
    }
    // Gli altri link sono solo ancore o l'email di contatto.
    for (const href of hrefs(container).filter((value) => !value.startsWith('/'))) {
      expect(href.startsWith('#') || href.startsWith('mailto:'), href).toBe(true);
    }
  });

  it('nessun link o richiamo a pagine spente, riservate o in revisione', () => {
    const container = render(<GuidaPage />);
    const forbidden = [
      '/pubblica',
      '/cartella',
      '/evidenza',
      '/artista',
      '/admin',
      '/dashboard',
      '/scarica',
    ];
    for (const href of hrefs(container)) {
      for (const prefix of forbidden) {
        expect(href === prefix || href.startsWith(`${prefix}/`), href).toBe(false);
      }
    }
    const text = container.textContent ?? '';
    for (const phrase of ['In evidenza', 'Mostra tutti', 'Scarica da URL', 'Amministrazione']) {
      expect(text, phrase).not.toContain(phrase);
    }
  });

  it('«Problemi comuni» sono <details> con <summary>, chiusi all’inizio', () => {
    const container = render(<GuidaPage />);
    const section = container.querySelector('section#problemi');
    const items = Array.from(section?.querySelectorAll('details') ?? []);
    expect(items.length).toBeGreaterThanOrEqual(10);
    for (const item of items) {
      expect(item.firstElementChild?.tagName).toBe('SUMMARY');
      expect(item.open).toBe(false);
      expect((item.textContent ?? '').length).toBeGreaterThan(40);
    }
  });

  it('glossario «Parole utili» con le parole difficili spiegate', () => {
    const container = render(<GuidaPage />);
    const terms = Array.from(container.querySelectorAll('section#parole dt')).map(
      (dt) => dt.textContent,
    );
    for (const term of [
      'Playlist',
      'Coda',
      'Libreria',
      'App',
      'APK',
      'Profilo (iPhone)',
      'Premium',
      'Account',
    ]) {
      expect(terms, term).toContain(term);
    }
  });

  it('i pulsanti verso un’ancora (#…) sono <a> normali: il Tab successivo entra nella sezione', () => {
    const container = render(<GuidaPage />);
    const anchors = Array.from(container.querySelectorAll('a[href^="#"]'));
    expect(anchors.length).toBeGreaterThan(15);
    for (const link of anchors) {
      expect(link.hasAttribute('data-next-link'), link.getAttribute('href') ?? '').toBe(false);
    }
    // Compresi i pulsanti in alto «Inizia dai primi passi» e «Ho un problema».
    const header = container.querySelector('header');
    expect(header?.querySelector('a[href="#primi-passi"]')?.textContent).toContain(
      'Inizia dai primi passi',
    );
    expect(header?.querySelector('a[href="#problemi"]')?.textContent).toContain('Ho un problema');
  });

  it('il colore dei link nel testo non scavalca quello dei pulsanti (contrasto)', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/components/custom/guide/guide.module.css'),
      'utf8',
    );
    // Nessuna regola generica su «.content a» che ricolori anche i pulsanti-collegamento.
    expect(css).not.toMatch(/\.content a(:hover)?\s*\{/);
    expect(css).toMatch(/\.content a:where\(:not\(\.actionButton\)\)\s*\{[^}]*color:/);
    expect(css).not.toMatch(/\.actionButton:hover\s*\{[^}]*color:\s*inherit/);
  });

  it('dove c’è solo un’icona, il testo dice anche il nome del pulsante (lettori di schermo)', () => {
    const container = render(<GuidaPage />);
    const copy = container.cloneNode(true) as HTMLElement;
    for (const hidden of Array.from(copy.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
    const text = (copy.textContent ?? '').replace(/\s+/g, ' ');
    // «tocca» seguito subito da una preposizione o da un segno vuol dire che manca l'oggetto.
    expect(text).not.toMatch(/\btocca\s*(per|nel|nella|sulla|sul|accanto|:|\.|,)(\s|$)/i);
    expect(text).not.toMatch(/\boppure\s+accanto\b/i);
    expect(text).toContain('tocca Play per ripartire');
    expect(text).toContain('Tocca Play sulla stazione');
    expect(text).toContain('il simbolo dell’infinito');
  });

  it('dice le cose come stanno: Spotify limitato, ascolti usati, punto ricordato, piè di pagina', () => {
    const container = render(<GuidaPage />);
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    // Importa da Spotify: solo account abilitati; l'elenco scritto funziona per tutti.
    expect(text).toContain('solo con gli account Spotify che Solco ha abilitato');
    expect(text).toContain('non è ancora tra gli utenti autorizzati');
    // Il contatore del lettore mostra gli ascolti già usati, non quelli rimasti.
    expect(text).toContain('quanti ascolti hai già usato');
    expect(text).not.toContain('quanti ascolti ti restano');
    // Dopo un ricaricamento i video YouTube ripartono dall'inizio.
    expect(text).toContain('I video YouTube e i brani importati ricominciano dall’inizio');
    // Impostazioni e Stato non sono nel menu ma nel piè di pagina.
    expect(text).not.toContain('Le trovi nel menu.');
    expect(text).toContain(
      'Impostazioni e Stato invece sono in fondo a pagine come Cerca o Libreria',
    );
  });

  it('«Primi passi»: un’azione per passo, niente APK o profilo spiegati a metà', () => {
    const container = render(<GuidaPage />);
    const section = container.querySelector('section#primi-passi');
    const text = section?.textContent ?? '';
    expect(text).not.toContain('APK');
    expect(text).not.toContain('Scarica il profilo');
    expect(text).not.toContain('oppure apri un genere');
    // L'APK e il profilo dell'iPhone sono spiegati dove servono.
    const app = container.querySelector('section#app')?.textContent ?? '';
    expect(app).toContain('L’APK è il file che installa l’app di Solco su Android.');
    expect(app).toContain('Non c’entra con il tuo Profilo di Solco.');
  });
});

describe('invito alla guida nella Home', () => {
  type CardModule = typeof import('@/components/custom/guide/guide-home-card');
  let card: CardModule;

  beforeEach(async () => {
    // Modulo ricaricato: la chiusura fatta durante una visita resta in memoria al suo interno.
    vi.resetModules();
    card = await import('@/components/custom/guide/guide-home-card');
    window.localStorage.clear();
  });

  function closeButton(container: HTMLElement) {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Chiudi l’invito alla guida"]',
    );
    if (!button) throw new Error('pulsante di chiusura mancante');
    return button;
  }

  it('si vede con il link alla guida e sparisce dopo la chiusura, anche alla visita dopo', async () => {
    const { GuideHomeCard, GUIDE_CARD_STORAGE_KEY } = card;
    const container = render(<GuideHomeCard />);
    expect(container.textContent).toContain('Nuovo su Solco?');
    const link = container.querySelector('a[href="/guida"]');
    expect(link?.textContent).toBe('Apri la guida passo per passo');

    act(() => closeButton(container).click());
    expect(container.textContent).not.toContain('Nuovo su Solco?');
    expect(window.localStorage.getItem(GUIDE_CARD_STORAGE_KEY)).toBe('1');
    // Il focus non cade su <body>: va sulla riga che dice dove ritrovare la guida.
    const note = container.querySelector('p[tabindex="-1"]');
    expect(note?.textContent).toContain('«Guida»');
    expect(document.activeElement).toBe(note);

    // Nuova visita (modulo nuovo): la scelta salvata la tiene chiusa.
    vi.resetModules();
    const fresh = await import('@/components/custom/guide/guide-home-card');
    const again = render(<fresh.GuideHomeCard />);
    expect(again.textContent).toBe('');
  });

  it('con localStorage che lancia errori si vede lo stesso e si chiude per questa visita', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage bloccato');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage bloccato');
    });
    const { GuideHomeCard } = card;
    const container = render(<GuideHomeCard />);
    expect(container.textContent).toContain('Nuovo su Solco?');
    act(() => closeButton(container).click());
    expect(container.textContent).not.toContain('Nuovo su Solco?');
    // Rimontato nella stessa visita (es. tornando alla Home): resta chiuso, senza la riga.
    const again = render(<GuideHomeCard />);
    expect(again.textContent).toBe('');
  });

  it('chiuso in un’altra scheda: sparisce anche qui', () => {
    const { GuideHomeCard, GUIDE_CARD_STORAGE_KEY } = card;
    const container = render(<GuideHomeCard />);
    expect(container.textContent).toContain('Nuovo su Solco?');
    act(() => {
      window.localStorage.setItem(GUIDE_CARD_STORAGE_KEY, '1');
      window.dispatchEvent(new StorageEvent('storage', { key: GUIDE_CARD_STORAGE_KEY }));
    });
    expect(container.textContent).toBe('');
  });

  it('la Home monta l’invito e ha «Guida» nel suo piè di pagina', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/(setup)/page.tsx'), 'utf8');
    expect(source).toContain('<GuideHomeCard />');
    expect(source).toContain('<Link href="/guida">Guida</Link>');
  });
});

describe('punti d’ingresso della guida', () => {
  it('/guida è pubblica nel muro di login', () => {
    expect(isPublicRoute('/guida')).toBe(true);
  });

  it('voce «Guida» nel menu (senza login, fuori dalla barra in alto) e nel piè di pagina', () => {
    const entries = navItems.filter((item) => item.href === '/guida');
    expect(entries.map((item) => item.group).sort()).toEqual(['footer', 'primary']);
    for (const item of entries) {
      expect(item.label).toBe('Guida');
      expect(item.requiresAuth).toBeFalsy();
    }
    // Nel menu principale viene dopo tutte le altre voci: non sposta quelle della barra.
    const primary = entries.find((item) => item.group === 'primary');
    const others = navItems.filter((item) => item.group === 'primary' && item.href !== '/guida');
    for (const other of others) {
      expect(primary?.order ?? 0).toBeGreaterThan(other.order ?? 0);
    }
  });

  it('link della landing in tutte e 6 le lingue; fuori dall’italiano dice che la guida è in italiano', () => {
    const italian = LANDING_MESSAGES.it.guideLink;
    expect(italian).toContain('Come funziona?');
    for (const { code } of LANDING_LOCALES) {
      const label = LANDING_MESSAGES[code].guideLink;
      expect(label.trim(), code).not.toBe('');
      if (code !== 'it') expect(label, code).not.toBe(italian);
    }
    expect(LANDING_MESSAGES.en.guideLink).toMatch(/Italian/);
    expect(LANDING_MESSAGES.es.guideLink).toMatch(/italiano/);
    expect(LANDING_MESSAGES.fr.guideLink).toMatch(/italien/);
    expect(LANDING_MESSAGES.de.guideLink).toMatch(/Italienisch/);
    expect(LANDING_MESSAGES.pt.guideLink).toMatch(/italiano/);
  });

  it('la landing mostra il link alla guida', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    window.localStorage.clear();
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['it-IT']);
    vi.resetModules();
    const { LandingPage } = await import('@/components/custom/landing-page');
    const container = render(<LandingPage />);
    const link = container.querySelector('a[href="/guida"]');
    expect(link?.textContent).toBe(LANDING_MESSAGES.it.guideLink);
  });

  it('le Impostazioni hanno «Guida per iniziare» in alto', () => {
    const container = render(<ImpostazioniPage />);
    const link = container.querySelector('a[href="/guida"]');
    expect(link?.textContent).toContain('Guida per iniziare');
  });

  it('llms.txt descrive la guida', () => {
    expect(llmsConfig.pageDescriptions?.['/guida']).toMatch(/Guida/);
  });
});
