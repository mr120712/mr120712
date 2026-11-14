// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  checkSmsVerification,
  isPhoneLoginConfigured,
  startSmsVerification,
} from '@/lib/business/twilio-verify.server';

const SID = `AC${'a'.repeat(32)}`;
const SERVICE = `VA${'b'.repeat(32)}`;
const KEYS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID'] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function configure() {
  process.env.TWILIO_ACCOUNT_SID = SID;
  process.env.TWILIO_AUTH_TOKEN = 'segreto-di-prova';
  process.env.TWILIO_VERIFY_SERVICE_SID = SERVICE;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  for (const key of KEYS) Reflect.deleteProperty(process.env, key);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of KEYS) {
    if (original[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = original[key];
  }
  vi.restoreAllMocks();
});

describe('configurazione Twilio Verify', () => {
  it('spento senza tutte e tre le variabili o con id malformati', () => {
    expect(isPhoneLoginConfigured()).toBe(false);
    configure();
    expect(isPhoneLoginConfigured()).toBe(true);
    process.env.TWILIO_VERIFY_SERVICE_SID = 'non-un-id';
    expect(isPhoneLoginConfigured()).toBe(false);
    configure();
    process.env.TWILIO_AUTH_TOKEN = '  ';
    expect(isPhoneLoginConfigured()).toBe(false);
  });

  it('non configurato: nessuna chiamata di rete', async () => {
    const fetcher = vi.fn();
    expect(await startSmsVerification('+393331234567', fetcher)).toBe(false);
    expect(await checkSmsVerification('+393331234567', '123456', fetcher)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('invio del codice', () => {
  it('chiama Verifications con autenticazione Basic e canale SMS', async () => {
    configure();
    const fetcher = vi.fn(async () => jsonResponse({ sid: 'VE1', status: 'pending' }, 201));
    expect(await startSmsVerification('+393331234567', fetcher)).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://verify.twilio.com/v2/Services/${SERVICE}/Verifications`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${SID}:segreto-di-prova`).toString('base64')}`,
    );
    const body = new URLSearchParams(String(init.body));
    expect(body.get('To')).toBe('+393331234567');
    expect(body.get('Channel')).toBe('sms');
  });

  it('errore Twilio o di rete: false, mai un’eccezione, il numero non finisce nei log', async () => {
    configure();
    const warn = vi.mocked(console.warn);
    expect(
      await startSmsVerification(
        '+393331234567',
        vi.fn(async () => jsonResponse({ code: 60203 }, 429)),
      ),
    ).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('3331234567');
    expect(
      await startSmsVerification(
        '+393331234567',
        vi.fn(async () => {
          throw new Error('rete');
        }),
      ),
    ).toBe(false);
  });
});

describe('controllo del codice', () => {
  it('valido solo con status "approved"', async () => {
    configure();
    const approved = vi.fn(async () => jsonResponse({ status: 'approved' }));
    expect(await checkSmsVerification('+393331234567', '123456', approved)).toBe(true);
    const [url] = approved.mock.calls[0] as unknown as [string];
    expect(url).toBe(`https://verify.twilio.com/v2/Services/${SERVICE}/VerificationCheck`);

    const pending = vi.fn(async () => jsonResponse({ status: 'pending' }));
    expect(await checkSmsVerification('+393331234567', '000000', pending)).toBe(false);
    const notFound = vi.fn(async () => jsonResponse({ code: 20404 }, 404));
    expect(await checkSmsVerification('+393331234567', '123456', notFound)).toBe(false);
  });

  it('codice malformato: rifiutato senza chiamare Twilio', async () => {
    configure();
    const fetcher = vi.fn();
    for (const bad of ['', '12', 'abcdef', '1234567890123', '12 34']) {
      expect(await checkSmsVerification('+393331234567', bad, fetcher)).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
