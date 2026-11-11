// @polsia:user-owned
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  sendEmail: vi.fn(),
  sendWithResend: vi.fn(),
}));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('@/lib/email/send', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/email/resend-relay.server', () => ({ sendWithResend: mocks.sendWithResend }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('next/server', () => ({ after: vi.fn() }));

import { authConfig } from '@/lib/auth-config';
import {
  sendVerificationEmail,
  verificationEmailContent,
} from '@/lib/business/verification-email.server';

const allowed = { allowed: true } as const;
const limited = {
  allowed: false,
  retryAfterSeconds: 60,
  status: 429,
  error: 'rate_limited',
  message: 'Hai raggiunto il limite per questa azione. Riprova tra 60 secondi.',
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.consumeRateLimit.mockReset();
  mocks.sendEmail.mockReset();
  mocks.sendWithResend.mockReset();
});

describe('contenuto dell’email di verifica', () => {
  it('saluta sempre con "Ciao," e non riporta mai il nome scelto alla registrazione', () => {
    const content = verificationEmailContent('https://x.test/v?a=1&b=2');
    expect(content.subject).toBe('Conferma la tua email su Solco');
    expect(content.text.startsWith('Ciao,\n')).toBe(true);
    expect(content.html.startsWith('<p>Ciao,</p>')).toBe(true);
    expect(content.html).toContain('a=1&amp;b=2');
    expect(content.text).toContain('https://x.test/v?a=1&b=2');
  });

  it('non inserisce il nome dell’utente nemmeno quando l’invio parte', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    mocks.consumeRateLimit.mockResolvedValue(allowed);
    mocks.sendWithResend.mockResolvedValue({ ok: true, id: 'm1' });
    await sendVerificationEmail({
      user: { email: 'a@example.test', name: 'Assistenza Solco: chiama il +39 000' },
      url: 'https://x',
    });
    const sent = mocks.sendWithResend.mock.calls[0]?.[0];
    expect(sent.html).not.toContain('Assistenza');
    expect(sent.text).not.toContain('Assistenza');
  });
});

describe('limiti dell’email di verifica', () => {
  it('controlla prima il destinatario (in minuscolo) e poi il limite globale, poi invia', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    mocks.consumeRateLimit.mockResolvedValue(allowed);
    mocks.sendEmail.mockResolvedValue({ id: 'm1' });
    await sendVerificationEmail({ user: { email: ' A@Example.TEST ' }, url: 'https://x' });
    expect(mocks.consumeRateLimit.mock.calls).toEqual([
      ['auth.verification_email', 'email:a@example.test'],
      ['auth.verification_email.global', 'global'],
    ]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('non invia e non consuma la quota globale se il destinatario ha raggiunto il limite', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.consumeRateLimit.mockResolvedValueOnce(limited);
    await expect(
      sendVerificationEmail({ user: { email: 'a@example.test' }, url: 'https://x' }),
    ).resolves.toBeUndefined();
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.sendWithResend).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('non invia se il limite globale di oggi è esaurito', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.consumeRateLimit.mockResolvedValueOnce(allowed).mockResolvedValueOnce(limited);
    await sendVerificationEmail({ user: { email: 'a@example.test' }, url: 'https://x' });
    expect(mocks.sendWithResend).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('non invia se il controllo dei limiti non è disponibile, senza bloccare la registrazione', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.consumeRateLimit.mockResolvedValue({ ...limited, status: 503 });
    await expect(
      sendVerificationEmail({ user: { email: 'a@example.test' }, url: 'https://x' }),
    ).resolves.toBeUndefined();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('non blocca la registrazione se il controllo dei limiti lancia un errore', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.consumeRateLimit.mockRejectedValue(new Error('db down'));
    await expect(
      sendVerificationEmail({ user: { email: 'a@example.test' }, url: 'https://x' }),
    ).resolves.toBeUndefined();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe('nome salvato alla registrazione', () => {
  type CreateBefore = (
    user: Record<string, unknown>,
    context: unknown,
  ) => Promise<{ data: Record<string, unknown> } | boolean | undefined>;
  const createBefore = authConfig.databaseHooks?.user?.create?.before as unknown as CreateBefore;

  it('tronca il nome a 80 caratteri senza spezzare le emoji', async () => {
    const name = `${'a'.repeat(79)}🎵🎵🎵`;
    const result = await createBefore({ email: 'a@example.test', name }, null);
    expect(result).toEqual({ data: { role: 'user', name: `${'a'.repeat(79)}🎵` } });
  });

  it('lascia invariato un nome corto', async () => {
    const result = await createBefore({ email: 'a@example.test', name: 'Ada' }, null);
    expect(result).toEqual({ data: { role: 'user', name: 'Ada' } });
  });
});
