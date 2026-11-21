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

  it('rende il contenuto riservato solo all’account designato; un altro admin non lo vede', () => {
    mocks.useSession.mockReturnValue({
      data: {
        user: { id: 'owner', email: 'bestmr12@icloud.com', role: 'admin', emailVerified: true },
      },
      isPending: false,
    });
    const markup = renderToStaticMarkup(
      <AdminShell>
        <p>Contenuto amministrativo riservato</p>
      </AdminShell>,
    );
    expect(markup).toContain('Contenuto amministrativo riservato');
    expect(markup).toContain('bestmr12@icloud.com');
    expect(markup).toContain('href="/admin/assistente"');
    expect(markup).not.toContain('/admin/music-previews');

    mocks.useSession.mockReturnValue({
      data: {
        user: {
          id: 'other',
          email: 'francescorogantini9@gmail.com',
          role: 'admin',
          emailVerified: true,
        },
      },
      isPending: false,
    });
    const other = renderToStaticMarkup(
      <AdminShell>
        <p>Contenuto amministrativo riservato</p>
      </AdminShell>,
    );
    expect(other).not.toContain('Contenuto amministrativo riservato');
  });

  it('email non verificata: il pulsante per farsi rimandare il link (poi diventa admin da solo)', () => {
    mocks.useSession.mockReturnValue({
      data: { user: { role: 'user', email: 'proprietario@example.com', emailVerified: false } },
      isPending: false,
    });
    const markup = renderToStaticMarkup(
      <AdminShell>
        <p>Contenuto amministrativo riservato</p>
      </AdminShell>,
    );
    expect(markup).toContain('Verifica il tuo indirizzo email');
    expect(markup).toContain('proprietario@example.com');
    expect(markup).toContain('Invia di nuovo il link di verifica');
    expect(markup).not.toContain('Contenuto amministrativo riservato');
  });

  it('email già verificata o account col telefono: nessun link di verifica', () => {
    for (const user of [
      { role: 'user', email: 'utente@example.com', emailVerified: true },
      { role: 'user', email: '393331234567@telefono.solcomusic.invalid', emailVerified: false },
    ]) {
      mocks.useSession.mockReturnValue({ data: { user }, isPending: false });
      const markup = renderToStaticMarkup(
        <AdminShell>
          <p>Contenuto amministrativo riservato</p>
        </AdminShell>,
      );
      expect(markup).toContain('Accesso amministrazione richiesto');
      expect(markup).not.toContain('Invia di nuovo il link di verifica');
    }
  });
});
