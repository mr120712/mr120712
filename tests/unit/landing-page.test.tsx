// @polsia:user-owned
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

type LandingModule = typeof import('@/components/custom/landing-page');
// Modulo ricaricato a ogni test: la lingua scelta durante una visita resta in memoria al suo interno.
let LandingPage: LandingModule['LandingPage'];

const roots: Array<ReturnType<typeof createRoot>> = [];
let container: HTMLDivElement;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<LandingPage />));
  return container;
}

const languages = vi.spyOn(window.navigator, 'languages', 'get');

beforeEach(async () => {
  vi.resetModules();
  ({ LandingPage } = await import('@/components/custom/landing-page'));
  vi.resetAllMocks();
  languages.mockReturnValue(['it-IT']);
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.documentElement.setAttribute('lang', 'it');
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  container?.remove();
});

function select() {
  const element = container.querySelector<HTMLSelectElement>('select');
  if (!element) throw new Error('menu lingua mancante');
  return element;
}

function choose(value: string) {
  const element = select();
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('LandingPage', () => {
  it('mostra un pulsante di accesso ben visibile verso /login', () => {
    render();
    const loginLinks = Array.from(container.querySelectorAll('a[href="/login"]'));
    expect(loginLinks.length).toBeGreaterThan(0);
    expect(loginLinks.some((a) => /accedi/i.test(a.textContent ?? ''))).toBe(true);
  });

  it('è compatta: nessun video', () => {
    render();
    expect(container.querySelector('video')).toBeNull();
    expect(container.textContent).toContain('Tutta la musica.');
  });

  it('offre anche registrazione e link legali', () => {
    render();
    expect(container.querySelector('a[href="/signup"]')).toBeTruthy();
    expect(container.querySelector('a[href="/terms"]')).toBeTruthy();
    expect(container.querySelector('a[href="/privacy"]')).toBeTruthy();
  });

  it('menu lingua: sei lingue, il cambio traduce la pagina, aggiorna <html lang> e si ricorda', () => {
    render();
    expect(select().getAttribute('aria-label')).toBe('Lingua');
    expect([...select().options].map((option) => option.value)).toEqual([
      'it',
      'en',
      'es',
      'fr',
      'de',
      'pt',
    ]);
    choose('en');
    expect(container.textContent).toContain('All the music.');
    expect(container.textContent).toContain('Choose your plan');
    expect(container.textContent).not.toContain('Tutta la musica.');
    expect(select().getAttribute('aria-label')).toBe('Language');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(window.localStorage.getItem('solco:lang')).toBe('en');
    // I link restano gli stessi (accesso, registrazione, pagine legali).
    expect(container.querySelector('a[href="/signup"]')?.textContent).toBe('Start for free');
    expect(container.querySelector('a[href="/terms"]')?.textContent).toBe('Terms');

    choose('de');
    expect(container.textContent).toContain('Die ganze Musik.');
    expect(container.textContent).toContain('/Monat');
  });

  it('lingua iniziale: ?lang= nel link, poi quella salvata, poi il browser', () => {
    window.history.replaceState(null, '', '/?lang=fr');
    window.localStorage.setItem('solco:lang', 'es');
    render();
    expect(select().value).toBe('fr');
    expect(container.textContent).toContain('Toute la musique.');
    act(() => roots.pop()?.unmount());
    container.remove();

    window.history.replaceState(null, '', '/');
    render();
    expect(select().value).toBe('es');
    act(() => roots.pop()?.unmount());
    container.remove();

    window.localStorage.clear();
    languages.mockReturnValue(['pt-BR', 'en-US']);
    render();
    expect(select().value).toBe('pt');
    expect(container.textContent).toContain('Toda a música.');
  });

  it('uscendo dalla landing (accesso) <html lang> torna quello dell’app', () => {
    render();
    choose('es');
    expect(document.documentElement.getAttribute('lang')).toBe('es');
    act(() => roots.pop()?.unmount());
    expect(document.documentElement.getAttribute('lang')).toBe('it');
  });

  it('la lingua scelta resta anche se la landing viene rimontata e vince su ?lang=', () => {
    window.history.replaceState(null, '', '/?lang=fr');
    render();
    expect(select().value).toBe('fr');
    choose('de');
    expect(window.location.search).toBe('?lang=de');
    act(() => roots.pop()?.unmount());
    container.remove();
    window.localStorage.clear(); // es. navigazione privata: niente storage
    render();
    expect(select().value).toBe('de');
  });

  it('nelle altre lingue avvisa che l’app, dopo l’accesso, è in italiano', () => {
    render();
    expect(container.textContent).not.toContain('in Italian');
    choose('en');
    expect(container.textContent).toContain('The app itself is in Italian for now.');
  });
});
