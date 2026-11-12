// @polsia:user-owned
// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { GooglePlayConfig } from '@/lib/business/iap/config.server';
import {
  acknowledgePlaySubscription,
  clearGoogleTokenCache,
  getPlaySubscription,
  googleAccessToken,
  normalizePlaySubscription,
} from '@/lib/business/iap/google-play.server';

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

/** Un mock compatibile con `typeof fetch` che smista per host e registra le richieste. */
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

const now = new Date('2026-06-01T00:00:00.000Z');

beforeEach(() => {
  clearGoogleTokenCache();
});

describe('normalizePlaySubscription', () => {
  const base = {
    latestOrderId: 'GPA.1111',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: 'acct-token' },
    lineItems: [
      {
        productId: 'solco_premium_monthly',
        expiryTime: '2026-07-01T00:00:00.000Z',
        autoRenewingPlan: { autoRenewEnabled: true },
      },
    ],
  };

  it('mappa uno stato ACTIVE acknowledged', () => {
    const r = normalizePlaySubscription('tok-1', {
      ...base,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    });
    expect(r).toMatchObject({
      platform: 'google',
      storeSubId: 'tok-1',
      productId: 'solco_premium_monthly',
      state: 'active',
      autoRenew: true,
      accountToken: 'acct-token',
      acknowledged: true,
      environment: 'production',
    });
    expect(r.expiresAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('mappa grace, canceled, on_hold, paused, pending ed expired', () => {
    const cases: Array<[string, string]> = [
      ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'grace'],
      ['SUBSCRIPTION_STATE_CANCELED', 'canceled'],
      ['SUBSCRIPTION_STATE_ON_HOLD', 'on_hold'],
      ['SUBSCRIPTION_STATE_PAUSED', 'paused'],
      ['SUBSCRIPTION_STATE_PENDING', 'pending'],
      ['SUBSCRIPTION_STATE_EXPIRED', 'expired'],
      ['SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', 'expired'],
      ['SUBSCRIPTION_STATE_UNSPECIFIED', 'expired'],
    ];
    for (const [input, expected] of cases) {
      expect(normalizePlaySubscription('t', { ...base, subscriptionState: input }).state).toBe(
        expected,
      );
    }
  });

  it('rileva gli acquisti di test e lo stato non confermato', () => {
    const r = normalizePlaySubscription('t', {
      ...base,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      testPurchase: {},
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    });
    expect(r.environment).toBe('test');
    expect(r.acknowledged).toBe(false);
  });

  it('autoRenew è false se il piano non si auto-rinnova', () => {
    const r = normalizePlaySubscription('t', {
      ...base,
      subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
      lineItems: [
        {
          productId: 'p',
          expiryTime: '2026-07-01T00:00:00.000Z',
          autoRenewingPlan: { autoRenewEnabled: false },
        },
      ],
    });
    expect(r.autoRenew).toBe(false);
  });
});

describe('googleAccessToken', () => {
  it('scambia un JWT per un access token e lo mette in cache', async () => {
    const captured: Request[] = [];
    const fetcher = fakeFetch(
      () => Response.json({ access_token: 'at-xyz', expires_in: 3600 }),
      captured,
    );
    const token = await googleAccessToken(config, fetcher, now);
    expect(token).toBe('at-xyz');
    expect(captured[0]?.url).toBe(TOKEN_URL);
    const body = await captured[0]?.text();
    expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(body).toContain('assertion=');

    await googleAccessToken(config, fetcher, now);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('getPlaySubscription', () => {
  it('chiama subscriptionsv2 con il Bearer e normalizza', async () => {
    const captured: Request[] = [];
    const fetcher = fakeFetch((url) => {
      if (url === TOKEN_URL) {
        return Response.json({ access_token: 'at-xyz', expires_in: 3600 });
      }
      return Response.json({
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
        externalAccountIdentifiers: { obfuscatedExternalAccountId: 'acct' },
        lineItems: [
          {
            productId: 'solco_premium_monthly',
            expiryTime: '2026-07-01T00:00:00.000Z',
            autoRenewingPlan: { autoRenewEnabled: true },
          },
        ],
      });
    }, captured);
    const sub = await getPlaySubscription('purchase-token-9', config, fetcher, now);
    expect(sub.state).toBe('active');
    expect(sub.storeSubId).toBe('purchase-token-9');
    const apiCall = captured.find((r) => r.url.includes('subscriptionsv2'));
    expect(apiCall?.url).toContain(
      'androidpublisher/v3/applications/com.solco.app/purchases/subscriptionsv2/tokens/purchase-token-9',
    );
    expect(apiCall?.headers.get('authorization')).toBe('Bearer at-xyz');
  });

  it('segnala not_found su 404', async () => {
    const fetcher = fakeFetch((url) =>
      url === TOKEN_URL
        ? Response.json({ access_token: 'at', expires_in: 3600 })
        : Response.json({}, { status: 404 }),
    );
    await expect(getPlaySubscription('t', config, fetcher, now)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('acknowledgePlaySubscription', () => {
  it('fa POST sull’endpoint :acknowledge', async () => {
    const captured: Request[] = [];
    const fetcher = fakeFetch(
      (url) =>
        url === TOKEN_URL
          ? Response.json({ access_token: 'at', expires_in: 3600 })
          : new Response(null, { status: 200 }),
      captured,
    );
    await acknowledgePlaySubscription('solco_premium_monthly', 'tok', config, fetcher, now);
    const ack = captured.find((r) => r.url.includes(':acknowledge'));
    expect(ack?.url).toContain(
      'purchases/subscriptions/solco_premium_monthly/tokens/tok:acknowledge',
    );
    expect(ack?.method).toBe('POST');
  });

  it('non lancia se Google risponde 400 (già confermato)', async () => {
    const fetcher = fakeFetch((url) =>
      url === TOKEN_URL
        ? Response.json({ access_token: 'at', expires_in: 3600 })
        : Response.json({ error: 'already acknowledged' }, { status: 400 }),
    );
    await expect(
      acknowledgePlaySubscription('p', 'tok', config, fetcher, now),
    ).resolves.toBeUndefined();
  });
});
