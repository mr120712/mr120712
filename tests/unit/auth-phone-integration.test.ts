// @polsia:user-owned
// @vitest-environment node
//
// Integrazione con better-auth VERO (database in memoria, Twilio simulato): verifica che i guardiani
// scattino sugli endpoint reali e che l'accesso col telefono crei l'account come previsto.
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { admin } from 'better-auth/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  start: vi.fn(async (_phone: string) => true),
  check: vi.fn(async (_phone: string, code: string) => code === '424242'),
  configured: true,
  consume: vi.fn(async (_action: string, _identity: string | null) => ({ allowed: true })),
  resetEmail: vi.fn(async (_input: { user: { email: string }; url: string }) => undefined),
}));

vi.mock('@/lib/business/twilio-verify.server', () => ({
  startSmsVerification: mocks.start,
  checkSmsVerification: mocks.check,
  isPhoneLoginConfigured: () => mocks.configured,
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  consumeRateLimit: mocks.consume,
  getRateLimitIdentity: (_user: string | null, headers: Headers) => {
    const ip = headers.get('x-real-ip');
    return ip ? `ip:${ip}` : null;
  },
}));
vi.mock('@/lib/business/reset-password-email.server', () => ({
  sendResetPasswordEmail: mocks.resetEmail,
}));
vi.mock('@/lib/business/verification-email.server', () => ({
  sendVerificationEmail: vi.fn(async () => undefined),
}));
vi.mock('@/lib/db', () => ({
  prisma: { user: { updateMany: vi.fn(async () => ({ count: 0 })) } },
}));
vi.mock('next/server', () => ({ after: (promise: Promise<unknown>) => promise }));

import { authConfig } from '@/lib/auth-config';

const BASE = 'http://localhost:3000';
let db: Record<string, Record<string, unknown>[]>;
let auth: ReturnType<typeof makeAuth>;

function makeAuth() {
  // La configurazione vera di Solco (plugin, reset, hook), su un database in memoria.
  const { advanced: _advanced, ...config } = authConfig;
  return betterAuth({
    ...config,
    // Come in src/lib/auth.ts: admin() prima dei plugin di Solco (definisce role/ban).
    plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] }), ...(config.plugins ?? [])],
    database: memoryAdapter(db),
    secret: 'segreto-di-prova-lungo-almeno-32-caratteri!!',
    baseURL: BASE,
    rateLimit: { enabled: false },
  });
}

function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        'x-real-ip': '203.0.113.9',
        ...extra,
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured = true;
  mocks.consume.mockResolvedValue({ allowed: true });
  mocks.check.mockImplementation(async (_phone, code) => code === '424242');
  db = { user: [], session: [], account: [], verification: [] };
  auth = makeAuth();
});

afterEach(() => vi.restoreAllMocks());

describe('accesso col telefono (better-auth reale)', () => {
  it('nuovo numero: SMS via Twilio, poi account creato senza esporre il numero nel nome', async () => {
    const sent = await post('/phone-number/send-otp', { phoneNumber: '+393331234567' });
    expect(sent.status).toBe(200);
    expect(mocks.start).toHaveBeenCalledWith('+393331234567');
    expect(mocks.consume.mock.calls.map(([action]) => action)).toEqual([
      'auth.phone_otp.ip',
      'auth.phone_otp',
      'auth.phone_otp.global',
    ]);

    const verified = await post('/phone-number/verify', {
      phoneNumber: '+393331234567',
      code: '424242',
    });
    expect(verified.status).toBe(200);
    expect(verified.headers.get('set-cookie')).toMatch(/session_token=/);
    const user = db.user?.[0] as Record<string, unknown>;
    expect(user.phoneNumber).toBe('+393331234567');
    expect(user.phoneNumberVerified).toBe(true);
    expect(user.email).toBe('393331234567@telefono.solcomusic.invalid');
    expect(user.emailVerified).toBe(false);
    expect(String(user.name)).not.toMatch(/\d/);
    expect(user.role).toBe('user');

    // Secondo accesso con lo stesso numero: stesso account, nessun duplicato.
    await post('/phone-number/send-otp', { phoneNumber: '+393331234567' });
    const again = await post('/phone-number/verify', {
      phoneNumber: '+393331234567',
      code: '424242',
    });
    expect(again.status).toBe(200);
    expect(db.user).toHaveLength(1);
  });

  it('nessuno può occupare l’email provvisoria di un numero altrui', async () => {
    const squat = await post('/sign-up/email', {
      email: '393331234567@telefono.solcomusic.invalid',
      password: 'occupoIlNumero1',
      name: 'Intruso',
    });
    expect(squat.status).toBe(400);
    expect(db.user).toHaveLength(0);

    // Il titolare del numero entra normalmente.
    await post('/phone-number/send-otp', { phoneNumber: '+393331234567' });
    const owner = await post('/phone-number/verify', {
      phoneNumber: '+393331234567',
      code: '424242',
    });
    expect(owner.status).toBe(200);
    expect(db.user).toHaveLength(1);
    expect(db.user?.[0]?.phoneNumber).toBe('+393331234567');
  });

  it('nessuno può prenotare il numero di un altro registrandosi con email e password', async () => {
    // Senza il guardiano better-auth salverebbe phoneNumber dal corpo di /sign-up/email: il
    // titolare del numero, entrando col telefono, finirebbe nell'account dell'attaccante.
    const squat = await post('/sign-up/email', {
      email: 'attaccante@example.com',
      password: 'prenotoIlNumero1',
      name: 'Intruso',
      phoneNumber: '+393331234567',
    });
    expect(squat.status).toBe(400);
    expect(db.user).toHaveLength(0);

    // Né lo si aggiunge dopo, a un account già aperto.
    const signup = await post('/sign-up/email', {
      email: 'attaccante@example.com',
      password: 'prenotoIlNumero1',
      name: 'Intruso',
    });
    expect(signup.status).toBe(200);
    const cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const update = await post('/update-user', { phoneNumber: '+393331234567' }, { cookie });
    expect(update.status).toBe(400);
    expect(db.user?.[0]?.phoneNumber ?? null).toBeNull();

    // Il titolare entra col telefono in un account suo, nuovo.
    await post('/phone-number/send-otp', { phoneNumber: '+393331234567' });
    const owner = await post('/phone-number/verify', {
      phoneNumber: '+393331234567',
      code: '424242',
    });
    expect(owner.status).toBe(200);
    expect(db.user).toHaveLength(2);
    const phoneUser = db.user?.find((user) => user.phoneNumber === '+393331234567');
    expect(phoneUser?.email).toBe('393331234567@telefono.solcomusic.invalid');
  });

  it('SMS non partito: errore subito, nessun "codice inviato"', async () => {
    mocks.start.mockResolvedValueOnce(false);
    const res = await post('/phone-number/send-otp', { phoneNumber: '+393331234567' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe('SMS_NOT_SENT');
  });

  it('codice sbagliato: nessun account, nessuna sessione', async () => {
    const res = await post('/phone-number/verify', {
      phoneNumber: '+393331234567',
      code: '000000',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/session_token=/);
    expect(db.user).toHaveLength(0);
    expect(db.session).toHaveLength(0);
  });

  it('numero non E.164: rifiutato prima di Twilio e dei limiti', async () => {
    const res = await post('/phone-number/send-otp', { phoneNumber: '3331234567' });
    expect(res.status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('oltre il limite: 429 e nessun SMS', async () => {
    mocks.consume.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 60,
      status: 429,
      error: 'rate_limited',
      message: 'Hai raggiunto il limite per questa azione. Riprova tra 60 secondi.',
    } as never);
    const res = await post('/phone-number/send-otp', { phoneNumber: '+393331234567' });
    expect(res.status).toBe(429);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('Twilio non configurato: endpoint del telefono chiusi', async () => {
    mocks.configured = false;
    expect((await post('/phone-number/send-otp', { phoneNumber: '+393331234567' })).status).toBe(
      404,
    );
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('endpoint non usati chiusi: reset password via SMS, login telefono+password, collegamento', async () => {
    const victim = { phoneNumber: '+393331234567' };
    expect((await post('/phone-number/request-password-reset', victim)).status).toBe(404);
    expect(
      (
        await post('/phone-number/reset-password', {
          ...victim,
          otp: '123456',
          newPassword: 'presaDiPossesso1',
        })
      ).status,
    ).toBe(404);
    expect((await post('/sign-in/phone-number', { ...victim, password: 'x' })).status).toBe(404);
    expect(
      (await post('/phone-number/verify', { ...victim, code: '424242', updatePhoneNumber: true }))
        .status,
    ).toBe(404);
    // Nessun codice di reset generato e conservato.
    expect(db.verification).toHaveLength(0);
  });
});

describe('recupero password (better-auth reale)', () => {
  it('email esistente: link inviato; email sconosciuta: stessa risposta, nessun invio', async () => {
    const signup = await post('/sign-up/email', {
      email: 'mario@example.com',
      password: 'vecchiaPassword1',
      name: 'Mario',
    });
    expect(signup.status).toBe(200);

    const known = await post('/request-password-reset', {
      email: 'mario@example.com',
      redirectTo: '/reimposta-password',
    });
    const unknown = await post('/request-password-reset', {
      email: 'nessuno@example.com',
      redirectTo: '/reimposta-password',
    });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    expect(mocks.resetEmail).toHaveBeenCalledTimes(1);
    const url = mocks.resetEmail.mock.calls[0]?.[0].url ?? '';
    expect(url).toContain('/reset-password/');
    expect(url).toContain('callbackURL=%2Freimposta-password');
  });

  it('il token cambia la password una sola volta e chiude le sessioni', async () => {
    await post('/sign-up/email', {
      email: 'mario@example.com',
      password: 'vecchiaPassword1',
      name: 'Mario',
    });
    expect(db.session?.length ?? 0).toBeGreaterThan(0);
    await post('/request-password-reset', { email: 'mario@example.com', redirectTo: '/' });
    const token = /reset-password\/([^?]+)/.exec(
      mocks.resetEmail.mock.calls[0]?.[0].url ?? '',
    )?.[1];
    expect(token).toBeTruthy();

    const reset = await post('/reset-password', { token, newPassword: 'nuovaPassword1' });
    expect(reset.status).toBe(200);
    expect(db.session).toHaveLength(0); // revokeSessionsOnPasswordReset
    const reuse = await post('/reset-password', { token, newPassword: 'altraPassword2' });
    expect(reuse.status).toBe(400);

    expect(
      (await post('/sign-in/email', { email: 'mario@example.com', password: 'nuovaPassword1' }))
        .status,
    ).toBe(200);
    expect(
      (await post('/sign-in/email', { email: 'mario@example.com', password: 'vecchiaPassword1' }))
        .status,
    ).toBe(401);
  });

  it('redirect esterno nel link di reset: rifiutato', async () => {
    const res = await post('/request-password-reset', {
      email: 'mario@example.com',
      redirectTo: 'https://evil.example/rubare',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.resetEmail).not.toHaveBeenCalled();
  });

  it('troppe richieste dallo stesso IP: 429', async () => {
    mocks.consume.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 60,
      status: 429,
      error: 'rate_limited',
      message: 'Hai raggiunto il limite per questa azione. Riprova tra 60 secondi.',
    } as never);
    const res = await post('/request-password-reset', { email: 'a@b.it', redirectTo: '/' });
    expect(res.status).toBe(429);
  });
});
