// @polsia:user-owned
// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// Il verificatore JWS è testato a parte: qui "decodifichiamo" trattando la stringa come JSON del
// payload, così possiamo testare la logica di normalizzazione/selezione.
vi.mock('@/lib/business/iap/apple-jws.server', () => ({
  verifyAppleSignedPayload: (jws: string) => JSON.parse(jws),
}));

import {
  getAppleSubscription,
  normalizeAppleStatuses,
} from '@/lib/business/iap/apple-store.server';
import type { AppleIapConfig } from '@/lib/business/iap/config.server';

const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const config: AppleIapConfig = {
  bundleId: 'com.solco.app',
  issuerId: '11111111-2222-3333-4444-555555555555',
  keyId: 'ABC123KEY',
  privateKey,
  rootCas: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
};

/** Mock compatibile con `typeof fetch`: coerce l'input a stringa. */
function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  return vi.fn<typeof fetch>((input, init) => Promise.resolve(handler(String(input), init)));
}

function txn(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    bundleId: 'com.solco.app',
    productId: 'solco_premium_monthly',
    originalTransactionId: 'orig-1',
    transactionId: 'txn-1',
    expiresDate: Date.UTC(2026, 6, 1),
    environment: 'Production',
    appAccountToken: 'acct-uuid',
    ...overrides,
  });
}

function statusBody(lastTransactions: unknown[]) {
  return { environment: 'Production', bundleId: 'com.solco.app', data: [{ lastTransactions }] };
}

describe('normalizeAppleStatuses', () => {
  it('normalizza una transazione attiva del prodotto/bundle giusti', () => {
    const body = statusBody([
      {
        originalTransactionId: 'orig-1',
        status: 1,
        signedTransactionInfo: txn(),
        signedRenewalInfo: JSON.stringify({ autoRenewStatus: 1 }),
      },
    ]);
    const r = normalizeAppleStatuses(
      body,
      config.rootCas,
      'solco_premium_monthly',
      'com.solco.app',
    );
    expect(r).toMatchObject({
      platform: 'apple',
      storeSubId: 'orig-1',
      latestOrderId: 'txn-1',
      state: 'active',
      autoRenew: true,
      environment: 'Production',
      accountToken: 'acct-uuid',
    });
    expect(r?.expiresAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('scarta transazioni di un altro bundleId (difesa)', () => {
    const body = statusBody([
      { status: 1, signedTransactionInfo: txn({ bundleId: 'com.altro.app' }) },
    ]);
    expect(
      normalizeAppleStatuses(body, config.rootCas, 'solco_premium_monthly', 'com.solco.app'),
    ).toBeNull();
  });

  it('scarta transazioni di un altro productId', () => {
    const body = statusBody([{ status: 1, signedTransactionInfo: txn({ productId: 'altro' }) }]);
    expect(
      normalizeAppleStatuses(body, config.rootCas, 'solco_premium_monthly', 'com.solco.app'),
    ).toBeNull();
  });

  it('mappa gli stati 1..5', () => {
    const map: Array<[number, string]> = [
      [1, 'active'],
      [2, 'expired'],
      [3, 'on_hold'],
      [4, 'grace'],
      [5, 'revoked'],
    ];
    for (const [status, expected] of map) {
      const body = statusBody([{ status, signedTransactionInfo: txn() }]);
      expect(
        normalizeAppleStatuses(body, config.rootCas, 'solco_premium_monthly', 'com.solco.app')
          ?.state,
      ).toBe(expected);
    }
  });

  it('sceglie la transazione con la scadenza più recente (nessun ordine garantito)', () => {
    const body = statusBody([
      {
        status: 2,
        signedTransactionInfo: txn({ transactionId: 'old', expiresDate: Date.UTC(2026, 0, 1) }),
      },
      {
        status: 1,
        signedTransactionInfo: txn({ transactionId: 'new', expiresDate: Date.UTC(2026, 11, 1) }),
      },
    ]);
    const r = normalizeAppleStatuses(
      body,
      config.rootCas,
      'solco_premium_monthly',
      'com.solco.app',
    );
    expect(r?.latestOrderId).toBe('new');
    expect(r?.state).toBe('active');
  });

  it('salta transazioni con firma non verificabile', () => {
    const body = statusBody([{ status: 1, signedTransactionInfo: 'non-json' }]);
    expect(
      normalizeAppleStatuses(body, config.rootCas, 'solco_premium_monthly', 'com.solco.app'),
    ).toBeNull();
  });
});

describe('getAppleSubscription', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('interroga la produzione e normalizza', async () => {
    const captured: string[] = [];
    const fetcher = fakeFetch((url, init) => {
      captured.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
      return Response.json(
        statusBody([
          {
            status: 1,
            signedTransactionInfo: txn(),
            signedRenewalInfo: JSON.stringify({ autoRenewStatus: 1 }),
          },
        ]),
      );
    });
    const r = await getAppleSubscription('txn-1', 'solco_premium_monthly', config, {
      allowSandbox: false,
      fetcher,
      now,
    });
    expect(r?.state).toBe('active');
    expect(captured[0]).toBe('https://api.storekit.apple.com/inApps/v1/subscriptions/txn-1');
  });

  it('ripiega sulla sandbox quando la produzione dice 4040010 e la sandbox è permessa', async () => {
    const urls: string[] = [];
    const fetcher = fakeFetch((url) => {
      urls.push(url);
      if (url.startsWith('https://api.storekit.apple.com')) {
        return Response.json({ errorCode: 4040010 }, { status: 404 });
      }
      return Response.json(
        statusBody([{ status: 1, signedTransactionInfo: txn({ environment: 'Sandbox' }) }]),
      );
    });
    const r = await getAppleSubscription('txn-1', 'solco_premium_monthly', config, {
      allowSandbox: true,
      fetcher,
      now,
    });
    expect(r?.environment).toBe('Sandbox');
    expect(urls.some((u) => u.startsWith('https://api.storekit-sandbox.apple.com'))).toBe(true);
  });

  it('NON ripiega sulla sandbox se non permessa', async () => {
    const fetcher = fakeFetch(() => Response.json({ errorCode: 4040010 }, { status: 404 }));
    const r = await getAppleSubscription('txn-1', 'solco_premium_monthly', config, {
      allowSandbox: false,
      fetcher,
      now,
    });
    expect(r).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
