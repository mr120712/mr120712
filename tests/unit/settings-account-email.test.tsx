// @polsia:user-owned — Impostazioni › «Account»: solo con l'accesso e per gli account con email;
// l'email con «Verificata» o «Non verificata» e, se non è verificata, il pulsante per farsi rimandare
// il link (ritorno a /impostazioni), con il titolo h3 sotto l'h2 «Account»; il link al profilo.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { data: null as unknown, isPending: false },
}));

vi.mock('@/lib/auth-client', () => ({
  useSession: () => mocks.session,
  authClient: { sendVerificationEmail: vi.fn() },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AccountEmailSettings } from '@/components/custom/settings/account-email-settings';

function signedIn(email: string, emailVerified: boolean) {
  mocks.session = {
    data: { user: { id: 'u1', name: 'Prova', email, emailVerified } },
    isPending: false,
  };
}

beforeEach(() => {
  mocks.session = { data: null, isPending: false };
});

describe('Impostazioni › Account', () => {
  it('email non verificata: «Non verificata» e il pulsante per il link di verifica', () => {
    signedIn('proprietario@example.com', false);
    const markup = renderToStaticMarkup(<AccountEmailSettings />);
    expect(markup).toContain('Account');
    expect(markup).toContain('proprietario@example.com');
    expect(markup).toContain('Non verificata');
    expect(markup).toContain('Invia di nuovo il link di verifica');
    expect(markup).toMatch(/<h3[^>]*>Verifica il tuo indirizzo email<\/h3>/);
    expect(markup).toContain('href="/profile"');
  });

  it('email verificata: «Verificata», nessun pulsante', () => {
    signedIn('proprietario@example.com', true);
    const markup = renderToStaticMarkup(<AccountEmailSettings />);
    expect(markup).toContain('Verificata');
    expect(markup).not.toContain('Non verificata');
    expect(markup).not.toContain('Invia di nuovo il link di verifica');
  });

  it('ospite, sessione in caricamento o account col telefono: niente', () => {
    expect(renderToStaticMarkup(<AccountEmailSettings />)).toBe('');
    mocks.session = { data: null, isPending: true };
    expect(renderToStaticMarkup(<AccountEmailSettings />)).toBe('');
    signedIn('393331234567@telefono.solcomusic.invalid', false);
    expect(renderToStaticMarkup(<AccountEmailSettings />)).toBe('');
  });
});
