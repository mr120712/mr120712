// @polsia:user-owned — unit del verificatore Play Integrity: lettura dei verdetti (funzione pura) e
// decodifica del token via API (fetch finto, nessuna rete reale).
// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { GooglePlayConfig } from '@/lib/business/iap/config.server';
import {
  readIntegrityVerdict,
  verifyPlayIntegrityToken,
} from '@/lib/business/iap/play-integrity.server';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const config: GooglePlayConfig = {
  packageName: 'com.solco.app',
  clientEmail: 'sa@solco.iam.gserviceaccount.com',
  privateKey,
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DECODE_URL = 'https://playintegrity.googleapis.com/v1/com.solco.app:decodeIntegrityToken';
const now = new Date('2026-06-01T00:00:00.000Z');

function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
  captured?: Request[],
) {
  return vi.fn<typeof fetch>((input, init) => {
    const url = String(input);
    captured?.push(new Request(input, init));
    return Promise.resolve(handler(url, init));
  });
}

/** Un payload di verdetti con valori configurabili; di default tutto positivo e fresco. */
function payload(over: Record<string, unknown> = {}) {
  return {
    requestDetails: {
      requestPackageName: 'com.solco.app',
      timestampMillis: String(now.getTime()),
      ...((over.requestDetails as object) ?? {}),
    },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: 'com.solco.app',
      ...((over.appIntegrity as object) ?? {}),
    },
    deviceIntegrity: {
      deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
      ...((over.deviceIntegrity as object) ?? {}),
    },
    accountDetails: { appLicensingVerdict: 'LICENSED', ...((over.accountDetails as object) ?? {}) },
  };
}

describe('readIntegrityVerdict', () => {
  it('accetta app riconosciuta + dispositivo integro', () => {
    const r = readIntegrityVerdict(payload(), 'com.solco.app', now);
    expect(r).toEqual({
      ok: true,
      verdict: {
        appRecognized: true,
        deviceIntegrity: true,
        licensed: true,
        packageName: 'com.solco.app',
      },
    });
  });

  it('respinge (hard) un pacchetto diverso', () => {
    const r = readIntegrityVerdict(
      payload({ requestDetails: { requestPackageName: 'com.altro.app' } }),
      'com.solco.app',
      now,
    );
    expect(r).toEqual({ ok: false, hard: true, reason: 'package_mismatch' });
  });

  it('respinge (hard) un token vecchio', () => {
    const old = new Date(now.getTime() - 20 * 60 * 1000);
    const r = readIntegrityVerdict(
      payload({ requestDetails: { timestampMillis: String(old.getTime()) } }),
      'com.solco.app',
      now,
    );
    expect(r).toEqual({ ok: false, hard: true, reason: 'stale_token' });
  });

  it('respinge (hard) un’app non riconosciuta', () => {
    const r = readIntegrityVerdict(
      payload({ appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } }),
      'com.solco.app',
      now,
    );
    expect(r).toEqual({ ok: false, hard: true, reason: 'app_unrecognized' });
  });

  it('respinge (hard) un dispositivo non integro', () => {
    const r = readIntegrityVerdict(
      payload({ deviceIntegrity: { deviceRecognitionVerdict: [] } }),
      'com.solco.app',
      now,
    );
    expect(r).toEqual({ ok: false, hard: true, reason: 'device_untrusted' });
  });

  it('accetta MEETS_STRONG_INTEGRITY', () => {
    const r = readIntegrityVerdict(
      payload({ deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_STRONG_INTEGRITY'] } }),
      'com.solco.app',
      now,
    );
    expect(r.ok).toBe(true);
  });
});

describe('verifyPlayIntegrityToken', () => {
  it('senza token è un esito soft "absent" (non blocca)', async () => {
    const r = await verifyPlayIntegrityToken(
      null,
      config,
      fakeFetch(() => Response.json({})),
      now,
    );
    expect(r).toEqual({ ok: false, hard: false, reason: 'absent' });
  });

  it('scambia il JWT e decodifica il token con Bearer', async () => {
    const captured: Request[] = [];
    const fetcher = fakeFetch((url) => {
      if (url === TOKEN_URL) return Response.json({ access_token: 'at-xyz', expires_in: 3600 });
      return Response.json({ tokenPayloadExternal: payload() });
    }, captured);
    const r = await verifyPlayIntegrityToken('itoken', config, fetcher, now);
    expect(r.ok).toBe(true);
    const decode = captured.find((req) => req.url === DECODE_URL);
    expect(decode?.method).toBe('POST');
    expect(decode?.headers.get('authorization')).toBe('Bearer at-xyz');
    expect(await decode?.text()).toContain('integrity_token');
  });

  it('verdetto negativo genuino dalla decodifica è hard', async () => {
    const fetcher = fakeFetch((url) =>
      url === TOKEN_URL
        ? Response.json({ access_token: 'at', expires_in: 3600 })
        : Response.json({
            tokenPayloadExternal: payload({
              deviceIntegrity: { deviceRecognitionVerdict: [] },
            }),
          }),
    );
    const r = await verifyPlayIntegrityToken('itoken', config, fetcher, now);
    expect(r).toEqual({ ok: false, hard: true, reason: 'device_untrusted' });
  });

  it('un errore di decodifica (HTTP non ok) è soft (non blocca)', async () => {
    const fetcher = fakeFetch((url) =>
      url === TOKEN_URL
        ? Response.json({ access_token: 'at', expires_in: 3600 })
        : Response.json({ error: 'bad token' }, { status: 400 }),
    );
    const r = await verifyPlayIntegrityToken('itoken', config, fetcher, now);
    expect(r).toEqual({ ok: false, hard: false, reason: 'decode_failed' });
  });

  it('un token senza payload è soft "empty_payload"', async () => {
    const fetcher = fakeFetch((url) =>
      url === TOKEN_URL
        ? Response.json({ access_token: 'at', expires_in: 3600 })
        : Response.json({}),
    );
    const r = await verifyPlayIntegrityToken('itoken', config, fetcher, now);
    expect(r).toEqual({ ok: false, hard: false, reason: 'empty_payload' });
  });

  it('credenziali rifiutate → soft "auth_unavailable" (non blocca)', async () => {
    const fetcher = fakeFetch((url) =>
      url === TOKEN_URL
        ? Response.json({ error: 'invalid_grant' }, { status: 401 })
        : Response.json({}),
    );
    const r = await verifyPlayIntegrityToken('itoken', config, fetcher, now);
    expect(r).toEqual({ ok: false, hard: false, reason: 'auth_unavailable' });
  });
});
