// @polsia:user-owned — profilo (/profile): con l'email non ancora verificata, sotto l'email c'è il
// pulsante per farsi rimandare il link di verifica (ritorno al profilo); con l'email verificata o per
// un account creato col telefono, nessun pulsante.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: null as unknown,
}));

vi.mock('@/lib/auth-client', () => ({
  useSession: () => ({ data: mocks.session, isPending: false }),
  authClient: { sendVerificationEmail: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));
vi.mock('@/lib/music/player-session', () => ({
  SIGN_OUT_FAILED_MESSAGE: 'Uscita non riuscita.',
  signOutAndStopMusic: vi.fn(async () => true),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/custom/community/community-settings', () => ({
  CommunitySettingsPanel: () => null,
}));
vi.mock('@/components/custom/account-deletion-panel', () => ({
  AccountDeletionPanel: () => null,
}));

import ProfilePage from '@/app/(auth)/profile/page';

function user(email: string, emailVerified: boolean) {
  return { user: { id: 'u1', name: 'Prova', email, emailVerified } };
}

beforeEach(() => {
  mocks.session = null;
});

describe('profilo: verifica dell’email', () => {
  it('email non verificata: il pulsante per il link di verifica', () => {
    mocks.session = user('proprietario@example.com', false);
    const markup = renderToStaticMarkup(<ProfilePage />);
    expect(markup).toContain('Verifica il tuo indirizzo email');
    expect(markup).toContain('Invia di nuovo il link di verifica');
  });

  it('email verificata o account col telefono: nessun pulsante', () => {
    for (const session of [
      user('proprietario@example.com', true),
      user('393331234567@telefono.solcomusic.invalid', false),
    ]) {
      mocks.session = session;
      const markup = renderToStaticMarkup(<ProfilePage />);
      expect(markup).toContain('Dati dell’account');
      expect(markup).not.toContain('Invia di nuovo il link di verifica');
    }
  });
});
