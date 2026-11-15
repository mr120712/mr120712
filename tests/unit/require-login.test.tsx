// @polsia:user-owned
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  pathname: '/' as string,
  session: { data: null as { user?: unknown } | null, isPending: false },
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/lib/auth-client', () => ({
  useSession: () => mocks.session,
}));
vi.mock('@/components/custom/landing-page', () => ({
  LandingPage: () => <div>LANDING_PUBBLICA</div>,
}));

import { isPublicRoute, RequireLogin } from '@/components/custom/require-login';
import { navItems } from '@/lib/nav';
import { seoRoutes } from '@/lib/seo-routes';
import {
  SIGNED_IN_HINT_ATTRIBUTE,
  SIGNED_IN_HINT_KEY,
  SIGNED_IN_HINT_SCRIPT,
} from '@/lib/signed-in-hint';

const roots: Array<ReturnType<typeof createRoot>> = [];
let container: HTMLDivElement;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <RequireLogin>
        <div>CONTENUTO_PROTETTO</div>
      </RequireLogin>,
    ),
  );
  return container;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.pathname = '/';
  mocks.session = { data: null, isPending: false };
  window.localStorage.clear();
  document.documentElement.removeAttribute(SIGNED_IN_HINT_ATTRIBUTE);
  for (const meta of document.querySelectorAll('meta[name="robots"]')) meta.remove();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  container?.remove();
});

describe('isPublicRoute', () => {
  it('pubbliche: login, signup, legali, link condivisi', () => {
    for (const p of [
      '/login',
      '/signup',
      '/privacy',
      '/terms',
      '/playlist/abc',
      '/login/x',
      '/bot',
      '/quiz',
      '/quiz/',
      // Guida per chi inizia: si legge prima di creare l'account.
      '/guida',
      // Link diretto di un brano in evidenza dichiarato: pagina e scheda senza account.
      '/evidenza/AbCdEfGhIjKlMnOpQrStUv',
    ]) {
      expect(isPublicRoute(p)).toBe(true);
    }
  });
  it('protette: home e funzionalità', () => {
    for (const p of [
      '/',
      '/search',
      '/radio',
      '/podcasts',
      '/library',
      '/pubblica',
      '/premi',
      '/flashcards',
      '/quizzone',
      '/quiz-segreto',
      // Solo i link /evidenza/<id> sono pubblici, non un percorso che inizia allo stesso modo.
      '/evidenza',
      '/evidenzaX/abc',
    ]) {
      expect(isPublicRoute(p)).toBe(false);
    }
  });
});

describe('RequireLogin', () => {
  it('rotta pubblica senza sessione → mostra il contenuto', () => {
    mocks.pathname = '/login';
    render();
    expect(container.textContent).toContain('CONTENUTO_PROTETTO');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('quiz musicale condiviso senza sessione → la carta si vede, nessun rimando al login', () => {
    mocks.pathname = '/quiz';
    mocks.session = { data: null, isPending: true };
    render();
    expect(container.textContent).toContain('CONTENUTO_PROTETTO');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('rotta protetta con sessione → mostra il contenuto', () => {
    mocks.pathname = '/search';
    mocks.session = { data: { user: { id: 'u1' } }, isPending: false };
    render();
    expect(container.textContent).toContain('CONTENUTO_PROTETTO');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('rotta protetta, sessione in verifica → caricamento, nessun redirect, contenuto nascosto', () => {
    mocks.pathname = '/search';
    mocks.session = { data: null, isPending: true };
    render();
    expect(container.textContent).not.toContain('CONTENUTO_PROTETTO');
    expect(container.textContent).toContain('Verifica dell’accesso');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('rotta protetta, non loggato → reindirizza a /login conservando la destinazione', () => {
    mocks.pathname = '/radio';
    mocks.session = { data: null, isPending: false };
    render();
    expect(container.textContent).not.toContain('CONTENUTO_PROTETTO');
    expect(mocks.replace).toHaveBeenCalledWith('/login?callbackURL=%2Fradio');
  });

  it('link condiviso con una ricerca: dopo l’accesso si torna alla stessa ricerca', () => {
    window.history.replaceState(null, '', '/search?q=Vasco%20Rossi%20Albachiara');
    mocks.pathname = '/search';
    mocks.session = { data: null, isPending: false };
    try {
      render();
      expect(mocks.replace).toHaveBeenCalledWith(
        `/login?callbackURL=${encodeURIComponent('/search?q=Vasco%20Rossi%20Albachiara')}`,
      );
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('query che better-auth rifiuterebbe: si conserva almeno la ricerca, ricodificata', () => {
    window.history.replaceState(null, '', '/search?q=Help!&x=~');
    mocks.pathname = '/search';
    mocks.session = { data: null, isPending: false };
    try {
      render();
      expect(mocks.replace).toHaveBeenCalledWith(
        `/login?callbackURL=${encodeURIComponent('/search?q=Help%21')}`,
      );
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('link condiviso troppo lungo per il ritorno: si conserva solo q, non una ricerca vuota', () => {
    // Un vecchio link con titolo, artista e copertina lunghi: oltre i 2048 caratteri ammessi.
    const q = encodeURIComponent('Artista Brano');
    const long = encodeURIComponent('音'.repeat(120));
    window.history.replaceState(null, '', `/search?q=${q}&t=${long}&a=${long}&img=${long}`);
    mocks.pathname = '/search';
    mocks.session = { data: null, isPending: false };
    try {
      render();
      expect(mocks.replace).toHaveBeenCalledWith(
        `/login?callbackURL=${encodeURIComponent('/search?q=Artista%20Brano')}`,
      );
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('senza una ricerca utilizzabile: solo il percorso', () => {
    window.history.replaceState(null, '', `/radio?x=${'~'.repeat(10)}`);
    mocks.pathname = '/radio';
    mocks.session = { data: null, isPending: false };
    try {
      render();
      expect(mocks.replace).toHaveBeenCalledWith('/login?callbackURL=%2Fradio');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('home "/" non loggato → mostra la landing pubblica, senza redirect', () => {
    mocks.pathname = '/';
    mocks.session = { data: null, isPending: false };
    render();
    expect(container.textContent).toContain('LANDING_PUBBLICA');
    expect(container.textContent).not.toContain('CONTENUTO_PROTETTO');
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

describe('Home "/" per Google e per chi non ha la sessione', () => {
  it('sessione in verifica: la landing c’è già (HTML del server), accanto al riquadro di attesa', () => {
    mocks.session = { data: null, isPending: true };
    render();
    const landing = container.querySelector('[data-solco-root-landing]');
    expect(landing?.textContent).toBe('LANDING_PUBBLICA');
    expect(landing?.hasAttribute('data-pending')).toBe(true);
    expect(container.querySelector('[data-solco-root-gate]')?.textContent).toContain(
      'Verifica dell’accesso…',
    );
    expect(container.textContent).not.toContain('CONTENUTO_PROTETTO');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('sessione nota senza utente: la stessa landing, senza riquadro né data-pending', () => {
    mocks.session = { data: null, isPending: false };
    render();
    const landing = container.querySelector('[data-solco-root-landing]');
    expect(landing?.textContent).toBe('LANDING_PUBBLICA');
    expect(landing?.hasAttribute('data-pending')).toBe(false);
    expect(container.querySelector('[data-solco-root-gate]')).toBeNull();
  });

  it('con la sessione: l’app, e l’indizio per il prossimo avvio', () => {
    mocks.session = { data: { user: { id: 'u1' } }, isPending: false };
    render();
    expect(container.textContent).toContain('CONTENUTO_PROTETTO');
    expect(container.textContent).not.toContain('LANDING_PUBBLICA');
    expect(window.localStorage.getItem(SIGNED_IN_HINT_KEY)).toBe('1');
    expect(document.documentElement.hasAttribute(SIGNED_IN_HINT_ATTRIBUTE)).toBe(true);
  });

  it('senza sessione l’indizio sparisce; in verifica non si tocca', () => {
    window.localStorage.setItem(SIGNED_IN_HINT_KEY, '1');
    document.documentElement.setAttribute(SIGNED_IN_HINT_ATTRIBUTE, '');
    mocks.session = { data: null, isPending: true };
    render();
    expect(window.localStorage.getItem(SIGNED_IN_HINT_KEY)).toBe('1');
    for (const root of roots.splice(0)) act(() => root.unmount());
    mocks.session = { data: null, isPending: false };
    render();
    expect(window.localStorage.getItem(SIGNED_IN_HINT_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute(SIGNED_IN_HINT_ATTRIBUTE)).toBe(false);
  });

  it('rotta protetta senza sessione: noindex per i motori di ricerca', () => {
    mocks.pathname = '/radio';
    mocks.session = { data: null, isPending: true };
    render();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    expect(container.textContent).not.toContain('CONTENUTO_PROTETTO');
  });

  it('rotta pubblica: nessun noindex aggiunto dal muro', () => {
    mocks.pathname = '/guida';
    mocks.session = { data: null, isPending: true };
    render();
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
    expect(container.textContent).toContain('CONTENUTO_PROTETTO');
  });
});

describe('indizio di sessione prima del primo disegno (head-content)', () => {
  it('segna <html> solo con l’indizio, senza mai lanciare errori', () => {
    new Function(SIGNED_IN_HINT_SCRIPT)();
    expect(document.documentElement.hasAttribute(SIGNED_IN_HINT_ATTRIBUTE)).toBe(false);
    window.localStorage.setItem(SIGNED_IN_HINT_KEY, '1');
    new Function(SIGNED_IN_HINT_SCRIPT)();
    expect(document.documentElement.hasAttribute(SIGNED_IN_HINT_ATTRIBUTE)).toBe(true);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage bloccato');
    });
    try {
      expect(() => new Function(SIGNED_IN_HINT_SCRIPT)()).not.toThrow();
    } finally {
      getItem.mockRestore();
    }
  });
});

describe('sitemap: solo le pagine che Google può leggere senza account', () => {
  it('ogni voce del menu senza requiresAuth è una rotta pubblica (o la Home)', () => {
    const exposed = navItems.filter((item) => !item.requiresAuth).map((item) => item.href);
    expect(exposed.length).toBeGreaterThan(0);
    for (const href of exposed) {
      expect(href === '/' || isPublicRoute(href), href).toBe(true);
    }
  });

  it('le pagine dei generi (dietro il login) non sono nella sitemap', async () => {
    expect(await seoRoutes()).toEqual([]);
  });
});
