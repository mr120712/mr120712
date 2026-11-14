// @polsia:user-owned
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ sendEmail: vi.fn(), sendWithResend: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/email/resend-relay.server', () => ({ sendWithResend: mocks.sendWithResend }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  consumeRateLimit: vi.fn(async () => ({ allowed: true })),
}));

import {
  sendVerificationEmail,
  verificationEmailContent,
} from '@/lib/business/verification-email.server';

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.sendEmail.mockReset();
  mocks.sendWithResend.mockReset();
});

describe('email di verifica', () => {
  it('è in italiano, non contiene il nome scelto da chi si registra ed evita HTML nel link', () => {
    const content = verificationEmailContent('https://x.test/v?a=1&b=2');
    expect(content.subject).toBe('Conferma la tua email su Solco');
    expect(content.html.startsWith('<p>Ciao,</p>')).toBe(true);
    expect(content.html).toContain('a=1&amp;b=2');
    expect(content.text).toContain('https://x.test/v?a=1&b=2');
  });

  it('usa Resend direttamente quando è configurato', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    mocks.sendWithResend.mockResolvedValue({ ok: true, id: 'm1' });
    await sendVerificationEmail({ user: { email: 'a@example.test', name: 'A' }, url: 'https://x' });
    expect(mocks.sendWithResend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@example.test' }),
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('account col telefono: nessuna email verso l’indirizzo provvisorio', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    await sendVerificationEmail({
      user: { email: '393331234567@telefono.solcomusic.invalid' },
      url: 'https://x',
    });
    expect(mocks.sendWithResend).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('non blocca la registrazione se l’invio fallisce', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.sendEmail.mockRejectedValue(new Error('email proxy send failed: 503'));
    await expect(
      sendVerificationEmail({ user: { email: 'a@example.test' }, url: 'https://x' }),
    ).resolves.toBeUndefined();
  });
});
