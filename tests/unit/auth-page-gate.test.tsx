// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  session: { data: null as { user: { id: string } } | null, isPending: false },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => mocks.session }));

import { AuthPageGate } from '@/components/custom/auth-page-gate';

const PLAYLIST = '/playlist/AbCdEfGhIjKlMnOpQrStUv';
const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount(path: string) {
  window.history.replaceState({}, '', path);
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <AuthPageGate>
        <p>Modulo di accesso</p>
      </AuthPageGate>,
    ),
  );
  return { container, root };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.replace.mockReset();
  mocks.session = { data: null, isPending: false };
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('AuthPageGate', () => {
  it('quando la sessione compare dopo l’accesso va al callbackURL, mai a /dashboard', async () => {
    const { container, root } = await mount(`/login?callbackURL=${encodeURIComponent(PLAYLIST)}`);
    expect(container.textContent).toContain('Modulo di accesso');
    expect(mocks.replace).not.toHaveBeenCalled();

    // better-auth refetches the session right after signIn.email, while the form navigates.
    mocks.session = { data: { user: { id: 'friend' } }, isPending: false };
    await act(async () =>
      root.render(
        <AuthPageGate>
          <p>Modulo di accesso</p>
        </AuthPageGate>,
      ),
    );
    expect(mocks.replace).toHaveBeenCalledWith(PLAYLIST);
    expect(mocks.replace).not.toHaveBeenCalledWith('/dashboard');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(PLAYLIST);
    expect(link?.textContent).toBe('Continua');
  });

  it('senza callbackURL (o con uno esterno) resta /dashboard', async () => {
    mocks.session = { data: { user: { id: 'friend' } }, isPending: false };
    const { container } = await mount('/login?callbackURL=https%3A%2F%2Fevil.example');
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/dashboard');
    expect(container.textContent).toContain('Apri il diario');
  });
});
