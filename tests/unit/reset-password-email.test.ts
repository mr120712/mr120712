// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  consume: vi.fn(async (_action: string, _identity: string) => ({ allowed: true })),
  resend: vi.fn(async () => ({ ok: true })),
  send: vi.fn(async () => ({ id: 'mail-1' })),
}));

vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consume }));
vi.mock('@/lib/email/resend-relay.server', () => ({ sendWithResend: mocks.resend }));
vi.mock('@/lib/email/send', () => ({ sendEmail: mocks.send }));

import {
  resetPasswordEmailContent,
  sendResetPasswordEmail,
} from '@/lib/business/reset-password-email.server';

const URL_RESET =
  'https://www.solcomusic.online/api/auth/reset-password/tok?callbackURL=%2Freimposta-password';
const originalResend = process.env.RESEND_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consume.mockResolvedValue({ allowed: true });
  Reflect.deleteProperty(process.env, 'RESEND_API_KEY');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  if (originalResend === undefined) Reflect.deleteProperty(process.env, 'RESEND_API_KEY');
  else process.env.RESEND_API_KEY = originalResend;
  vi.restoreAllMocks();
});

describe('email di recupero password', () => {
  it('in italiano, con il link (escapato nell’HTML) e senza il nome dell’utente', () => {
    const content = resetPasswordEmailContent(`${URL_RESET}&x="<b>`);
    expect(content.subject).toContain('password');
    expect(content.text).toContain(URL_RESET);
    expect(content.html).not.toContain('"<b>');
    expect(content.html).toContain('&quot;&lt;b&gt;');
  });

  it('invia con il relay della piattaforma, entro i limiti per destinatario e globali', async () => {
    await sendResetPasswordEmail({ user: { email: 'Mario@Example.com' }, url: URL_RESET });
    expect(mocks.consume.mock.calls).toEqual([
      ['auth.reset_email', 'email:mario@example.com'],
      ['auth.reset_email.global', 'global'],
    ]);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'Mario@Example.com', subject: expect.any(String) }),
    );
  });

  it('usa Resend quando è configurato', async () => {
    process.env.RESEND_API_KEY = 're_test';
    await sendResetPasswordEmail({ user: { email: 'a@b.it' }, url: URL_RESET });
    expect(mocks.resend).toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('oltre il limite: non invia', async () => {
    mocks.consume.mockResolvedValueOnce({ allowed: false });
    await sendResetPasswordEmail({ user: { email: 'a@b.it' }, url: URL_RESET });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('account creati col telefono (email provvisoria): nessun invio e nessun limite consumato', async () => {
    await sendResetPasswordEmail({
      user: { email: '393331234567@telefono.solcomusic.invalid' },
      url: URL_RESET,
    });
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('un errore di invio non si propaga (better-auth risponde comunque in modo neutro)', async () => {
    mocks.send.mockRejectedValueOnce(new Error('smtp'));
    await expect(
      sendResetPasswordEmail({ user: { email: 'a@b.it' }, url: URL_RESET }),
    ).resolves.toBeUndefined();
  });
});
