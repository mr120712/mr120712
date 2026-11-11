// @polsia:user-owned
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ sendEmail: vi.fn(), sendWithResend: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/email/resend-relay.server', () => ({ sendWithResend: mocks.sendWithResend }));

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
  it('è in italiano ed evita HTML nel nome e nel link', () => {
    const content = verificationEmailContent('<b>Ada</b>', 'https://x.test/v?a=1&b=2');
    expect(content.subject).toBe('Conferma la tua email su Solco');
    expect(content.html).toContain('&lt;b&gt;Ada&lt;/b&gt;');
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

  it('non blocca la registrazione se l’invio fallisce', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.sendEmail.mockRejectedValue(new Error('email proxy send failed: 503'));
    await expect(
      sendVerificationEmail({ user: { email: 'a@example.test' }, url: 'https://x' }),
    ).resolves.toBeUndefined();
  });
});
