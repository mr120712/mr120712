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
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  container?.remove();
});

describe('isPublicRoute', () => {
  it('pubbliche: login, signup, legali, link condivisi', () => {
    for (const p of ['/login', '/signup', '/privacy', '/terms', '/playlist/abc', '/login/x']) {
      expect(isPublicRoute(p)).toBe(true);
    }
  });
  it('protette: home e funzionalità', () => {
    for (const p of ['/', '/search', '/radio', '/podcasts', '/library', '/pubblica', '/premi']) {
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

  it('home "/" non loggato → mostra la landing pubblica, senza redirect', () => {
    mocks.pathname = '/';
    mocks.session = { data: null, isPending: false };
    render();
    expect(container.textContent).toContain('LANDING_PUBBLICA');
    expect(container.textContent).not.toContain('CONTENUTO_PROTETTO');
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
