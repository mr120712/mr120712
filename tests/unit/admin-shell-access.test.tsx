import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  useRouter: vi.fn(),
  usePathname: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  signOut: mocks.signOut,
  useSession: mocks.useSession,
}));
vi.mock('next/navigation', () => ({
  usePathname: mocks.usePathname,
  useRouter: mocks.useRouter,
}));

import { AdminShell } from '@/components/custom/dashboard/admin-shell';

describe('contenuto dell’area amministrativa', () => {
  beforeEach(() => {
    mocks.usePathname.mockReturnValue('/admin');
    mocks.useRouter.mockReturnValue({ replace: vi.fn() });
  });

  it('non rende il contenuto riservato senza sessione', () => {
    mocks.useSession.mockReturnValue({ data: null, isPending: false });
    const markup = renderToStaticMarkup(
      <AdminShell>
        <p>Contenuto amministrativo riservato</p>
      </AdminShell>,
    );

    expect(markup).toContain('Reindirizzamento all’accesso');
    expect(markup).not.toContain('Contenuto amministrativo riservato');
  });

  it('nega il ruolo utente senza rendere il contenuto riservato', () => {
    mocks.useSession.mockReturnValue({
      data: { user: { role: 'user', emailVerified: true } },
      isPending: false,
    });
    const markup = renderToStaticMarkup(
      <AdminShell>
        <p>Contenuto amministrativo riservato</p>
      </AdminShell>,
    );

    expect(markup).toContain('Accesso amministrazione richiesto');
    expect(markup).not.toContain('Contenuto amministrativo riservato');
    expect(markup.toLowerCase()).not.toContain('password');
  });

  it('nega anche un ruolo admin associato a un indirizzo non verificato', () => {
    mocks.useSession.mockReturnValue({
      data: { user: { role: 'admin', emailVerified: false } },
      isPending: false,
    });
    const markup = renderToStaticMarkup(
      <AdminShell>
        <p>Contenuto amministrativo riservato</p>
      </AdminShell>,
    );

    expect(markup).toContain('Serve un account autorizzato con un indirizzo già verificato.');
    expect(markup).not.toContain('Contenuto amministrativo riservato');
  });

  it('rende il contenuto riservato per entrambi gli account amministrativi verificati', () => {
    const admins = [
      {
        id: 'configured-bestmr12-id',
        email: 'bestmr12 account',
        role: 'admin',
        emailVerified: true,
      },
      {
        id: 'requested-admin-id',
        email: 'francescorogantini9@gmail.com',
        role: 'admin',
        emailVerified: true,
      },
    ];

    for (const user of admins) {
      mocks.useSession.mockReturnValue({ data: { user }, isPending: false });
      const markup = renderToStaticMarkup(
        <AdminShell>
          <p>Contenuto amministrativo riservato</p>
        </AdminShell>,
      );

      expect(markup).toContain('Contenuto amministrativo riservato');
      expect(markup).toContain(user.email);
      expect(markup).toContain('href="/admin/assistente"');
      expect(markup).not.toContain('/admin/music-previews');
    }
  });
});
