// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  BLOCKED_AUTH_PATHS,
  guardAuthRequest,
  networkIdentity,
  SMS_NOT_SENT,
} from '@/lib/business/auth-guards.server';
import type { RateLimitAction, RateLimitDecision } from '@/lib/business/rate-limit.server';

const ALLOWED: RateLimitDecision = { allowed: true };
const LIMITED: RateLimitDecision = {
  allowed: false,
  retryAfterSeconds: 60,
  status: 429,
  error: 'rate_limited',
  message: 'Hai raggiunto il limite per questa azione. Riprova tra 60 secondi.',
};

const consume = vi.fn(
  async (_action: RateLimitAction, _identity: string | null): Promise<RateLimitDecision> => ALLOWED,
);
const sendSms = vi.fn(async (_phone: string) => true);
const isKnownPhone = vi.fn(async (_phone: string) => false);
const deps = { consume, phoneConfigured: () => true, sendSms, isKnownPhone };
const headers = new Headers({ 'x-real-ip': '203.0.113.7' });

beforeEach(() => {
  consume.mockReset().mockResolvedValue(ALLOWED);
  sendSms.mockReset().mockResolvedValue(true);
  isKnownPhone.mockReset().mockResolvedValue(false);
});

describe('guardAuthRequest', () => {
  it('lascia passare gli altri endpoint senza consumare limiti', async () => {
    for (const path of ['/sign-in/email', '/sign-up/email', '/get-session', '/reset-password']) {
      expect(await guardAuthRequest({ path, body: {}, headers }, deps)).toBeNull();
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it('chiude gli endpoint del telefono non usati (reset password via SMS compreso)', async () => {
    for (const path of BLOCKED_AUTH_PATHS) {
      const result = await guardAuthRequest(
        { path, body: { phoneNumber: '+393331234567', otp: '000000', newPassword: 'x' } },
        deps,
      );
      expect(result?.status).toBe('NOT_FOUND');
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it('telefono non configurato: send-otp e verify chiusi', async () => {
    const off = { consume, phoneConfigured: () => false, sendSms, isKnownPhone };
    for (const path of ['/phone-number/send-otp', '/phone-number/verify']) {
      const result = await guardAuthRequest(
        { path, body: { phoneNumber: '+393331234567', code: '123456' }, headers },
        off,
      );
      expect(result?.status).toBe('NOT_FOUND');
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it('numero non E.164: 400 prima di qualsiasi limite (nessun costo)', async () => {
    for (const phoneNumber of ['3331234567', '+39 333', 123, null]) {
      const result = await guardAuthRequest(
        { path: '/phone-number/send-otp', body: { phoneNumber }, headers },
        deps,
      );
      expect(result?.status).toBe('BAD_REQUEST');
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it('send-otp: limiti per IP, poi per numero, poi globale; poi l’SMS', async () => {
    const result = await guardAuthRequest(
      { path: '/phone-number/send-otp', body: { phoneNumber: '+393331234567' }, headers },
      deps,
    );
    expect(result).toBeNull();
    expect(consume.mock.calls).toEqual([
      ['auth.phone_otp.ip', 'ip:203.0.113.7'],
      ['auth.phone_otp', 'phone:+393331234567'],
      ['auth.phone_otp.global', 'global'],
    ]);
    expect(sendSms).toHaveBeenCalledWith('+393331234567');
  });

  it('send-otp: se Twilio non invia, l’utente lo sa subito (502 SMS_NOT_SENT)', async () => {
    sendSms.mockResolvedValueOnce(false);
    const result = await guardAuthRequest(
      { path: '/phone-number/send-otp', body: { phoneNumber: '+393331234567' }, headers },
      deps,
    );
    expect(result).toEqual(SMS_NOT_SENT);
    expect(result?.status).toBe('BAD_GATEWAY');
  });

  it('send-otp: un numero con account non dipende dal tetto globale (niente lockout)', async () => {
    isKnownPhone.mockResolvedValueOnce(true);
    const result = await guardAuthRequest(
      { path: '/phone-number/send-otp', body: { phoneNumber: '+393331234567' }, headers },
      deps,
    );
    expect(result).toBeNull();
    expect(consume.mock.calls.map(([action]) => action)).toEqual([
      'auth.phone_otp.ip',
      'auth.phone_otp',
    ]);
    expect(sendSms).toHaveBeenCalled();
  });

  it('send-otp: oltre un limite nessun SMS', async () => {
    consume
      .mockResolvedValueOnce(ALLOWED)
      .mockResolvedValueOnce(ALLOWED)
      .mockResolvedValueOnce(LIMITED);
    const result = await guardAuthRequest(
      { path: '/phone-number/send-otp', body: { phoneNumber: '+393331234567' }, headers },
      deps,
    );
    expect(result?.status).toBe('TOO_MANY_REQUESTS');
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('send-otp da IPv6: il limite di rete vale per l’intero /64', async () => {
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:fffe']) {
      await guardAuthRequest(
        {
          path: '/phone-number/send-otp',
          body: { phoneNumber: '+393331234567' },
          headers: new Headers({ 'x-real-ip': ip }),
        },
        deps,
      );
    }
    const networks = consume.mock.calls
      .filter(([action]) => action === 'auth.phone_otp.ip')
      .map(([, identity]) => identity);
    expect(networks).toEqual(['ip6:2001:db8:1:2::/64', 'ip6:2001:db8:1:2::/64']);
  });

  it('il numero di telefono non si imposta fuori dalla verifica SMS', async () => {
    const victim = '+393331234567';
    for (const [path, body] of [
      ['/sign-up/email', { email: 'a@b.it', password: 'x', name: 'x', phoneNumber: victim }],
      ['/sign-up/email', { email: 'a@b.it', password: 'x', name: 'x', phoneNumberVerified: true }],
      ['/update-user', { phoneNumber: victim }],
      ['/update-user', { phoneNumber: null }],
      ['/admin/create-user', { email: 'a@b.it', data: { phoneNumber: victim } }],
      ['/admin/update-user', { userId: 'u1', data: { phoneNumber: victim } }],
    ] as const) {
      const result = await guardAuthRequest({ path, body, headers }, deps);
      expect(result?.status).toBe('BAD_REQUEST');
      expect(result?.code).toBe('PHONE_NUMBER_NOT_ALLOWED');
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it('send-otp: un IP bloccato non consuma la quota del numero né quella globale', async () => {
    consume.mockResolvedValueOnce(LIMITED);
    const result = await guardAuthRequest(
      { path: '/phone-number/send-otp', body: { phoneNumber: '+393331234567' }, headers },
      deps,
    );
    expect(result).toEqual({ status: 'TOO_MANY_REQUESTS', message: LIMITED.message });
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('send-otp: numero oltre il limite → 429, il globale non viene toccato', async () => {
    consume.mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(LIMITED);
    const result = await guardAuthRequest(
      { path: '/phone-number/send-otp', body: { phoneNumber: '+393331234567' }, headers },
      deps,
    );
    expect(result?.status).toBe('TOO_MANY_REQUESTS');
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('senza IP affidabile il limitatore risponde 503 (nessun SMS)', async () => {
    consume.mockImplementation(async (_action, identity) =>
      identity === null
        ? {
            allowed: false,
            retryAfterSeconds: 60,
            status: 503,
            error: 'rate_limit_identity_unavailable',
            message: 'non identificabile',
          }
        : ALLOWED,
    );
    const result = await guardAuthRequest(
      { path: '/phone-number/send-otp', body: { phoneNumber: '+393331234567' }, headers: null },
      deps,
    );
    expect(result?.status).toBe('SERVICE_UNAVAILABLE');
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('verify: limite per IP; collegare il numero alla sessione non è previsto', async () => {
    expect(
      await guardAuthRequest(
        {
          path: '/phone-number/verify',
          body: { phoneNumber: '+393331234567', code: '123456' },
          headers,
        },
        deps,
      ),
    ).toBeNull();
    expect(consume).toHaveBeenCalledWith('auth.phone_verify.ip', 'ip:203.0.113.7');

    consume.mockClear();
    const linked = await guardAuthRequest(
      {
        path: '/phone-number/verify',
        body: { phoneNumber: '+393331234567', code: '123456', updatePhoneNumber: true },
        headers,
      },
      deps,
    );
    expect(linked?.status).toBe('NOT_FOUND');
    expect(consume).not.toHaveBeenCalled();
  });

  it('il dominio email riservato ai telefoni non si può registrare né impostare', async () => {
    const reserved = ' 393331234567@TELEFONO.solcomusic.invalid ';
    for (const [path, body] of [
      ['/sign-up/email', { email: reserved, password: 'x', name: 'x' }],
      ['/change-email', { newEmail: reserved }],
      ['/admin/create-user', { email: reserved }],
      ['/send-verification-email', { email: reserved }],
    ] as const) {
      const result = await guardAuthRequest({ path, body, headers }, deps);
      expect(result?.status).toBe('BAD_REQUEST');
    }
    // Email normali: passano, senza consumare limiti.
    expect(
      await guardAuthRequest(
        { path: '/sign-up/email', body: { email: 'mario@example.com' }, headers },
        deps,
      ),
    ).toBeNull();
    expect(consume).not.toHaveBeenCalled();
  });

  it('richiesta di recupero password: limite per IP', async () => {
    consume.mockResolvedValueOnce(LIMITED);
    const result = await guardAuthRequest(
      { path: '/request-password-reset', body: { email: 'a@b.it' }, headers },
      deps,
    );
    expect(result?.status).toBe('TOO_MANY_REQUESTS');
    expect(consume).toHaveBeenCalledWith('auth.reset_request.ip', 'ip:203.0.113.7');
  });
});

describe('networkIdentity', () => {
  const at = (ip: string) => networkIdentity(new Headers({ 'x-real-ip': ip }));
  it('IPv4 invariato, IPv6 ridotto al /64, IPv4 mappato riportato a IPv4', () => {
    expect(at('203.0.113.7')).toBe('ip:203.0.113.7');
    expect(at('2001:DB8:0:0:1:2:3:4')).toBe('ip6:2001:db8:0:0::/64');
    expect(at('2001:db8::1')).toBe('ip6:2001:db8:0:0::/64');
    expect(at('::1')).toBe('ip6:0:0:0:0::/64');
    expect(at('fe80::1:2:3:4')).toBe('ip6:fe80:0:0:0::/64');
    expect(at('::ffff:198.51.100.4')).toBe('ip:198.51.100.4');
    expect(networkIdentity(new Headers())).toBeNull();
    expect(networkIdentity(null)).toBeNull();
  });
});
