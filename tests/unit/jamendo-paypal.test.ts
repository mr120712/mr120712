// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const plans = new Map<string, { key: string; paypalPlanId: string }>();
  const stored: { row: Record<string, unknown> | null } = { row: null };
  return {
    plans,
    prisma: {
      payPalBillingPlan: {
        findUnique: vi.fn(
          async ({ where }: { where: { key: string } }) => plans.get(where.key) ?? null,
        ),
        upsert: vi.fn(async ({ create }: { create: { key: string; paypalPlanId: string } }) => {
          plans.set(create.key, create);
          return create;
        }),
      },
      payPalSubscription: {
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
          stored.row = { id: 'pp-row', firstPaidAt: null, ...create };
          return stored.row;
        }),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (stored.row) Object.assign(stored.row, data);
          return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn(async () => stored.row),
      },
      solcoSubscription: { findFirst: vi.fn(async () => null) },
    },
  };
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: db.prisma }));

import {
  confirmPayPalSubscription,
  createPayPalSubscription,
  paypalEnabled,
  paypalPaymentVerified,
  resetPayPalTokenCache,
} from '@/lib/business/paypal-subscriptions.server';
import {
  clearJamendoCache,
  listJamendoTracks,
  normalizeJamendoTrack,
} from '@/lib/music/jamendo.server';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id-example-123');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret-example-123');
  vi.stubEnv('PAYPAL_ENV', 'sandbox');
  vi.stubEnv('JAMENDO_CLIENT_ID', 'jamendo-id');
  db.plans.clear();
  resetPayPalTokenCache();
  clearJamendoCache();
});
afterEach(() => vi.unstubAllEnvs());

describe('Jamendo', () => {
  it('normalizza solo brani con audio HTTPS', () => {
    const raw = {
      id: '1532771',
      name: 'Brano',
      artist_name: 'Artista',
      album_name: 'Album',
      album_image: 'https://usercontent.jamendo.com/cover.jpg',
      audio: 'https://prod-1.storage.jamendo.com/?trackid=1532771',
      duration: 201,
      shareurl: 'https://www.jamendo.com/track/1532771',
      license_ccurl: 'https://creativecommons.org/licenses/by/3.0/',
    };
    expect(normalizeJamendoTrack(raw)).toMatchObject({ id: '1532771', durationSeconds: 201 });
    expect(normalizeJamendoTrack({ ...raw, audio: 'http://insecure' })).toBeNull();
    expect(normalizeJamendoTrack({ ...raw, id: 'abc' })).toBeNull();
  });

  it('non espone l’URL audio negli elenchi e segnala la configurazione mancante', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        headers: { status: 'success' },
        results: [
          {
            id: '1',
            name: 'A',
            artist_name: 'B',
            audio: 'https://prod-1.storage.jamendo.com/a.mp3',
          },
        ],
      }),
    );
    const result = await listJamendoTracks({ q: 'jazz' }, fetcher as unknown as typeof fetch);
    expect(result.outcome).toBe('results');
    expect(result.tracks[0]).not.toHaveProperty('audioUrl');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('search=jazz');
    vi.stubEnv('JAMENDO_CLIENT_ID', '');
    expect(await listJamendoTracks({}, fetcher as unknown as typeof fetch)).toEqual({
      outcome: 'not_configured',
      tracks: [],
    });
  });
});

describe('PayPal', () => {
  it('considera valido solo un pagamento attivo con importo incassato', () => {
    const paid = (value: string, status = 'ACTIVE') => ({
      status,
      billing_info: { last_payment: { amount: { value, currency_code: 'EUR' } } },
    });
    expect(paypalPaymentVerified(paid('4.99'))).toBe(true);
    expect(paypalPaymentVerified(paid('0.00'))).toBe(false);
    expect(paypalPaymentVerified(paid('4.99', 'APPROVED'))).toBe(false);
    expect(paypalPaymentVerified({ status: 'ACTIVE' })).toBe(false);
  });

  it('crea prodotto e piano una sola volta e restituisce il link di approvazione', async () => {
    expect(paypalEnabled()).toBe(true);
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 3600 });
      if (url.endsWith('/v1/catalogs/products')) return json({ id: 'PROD-1' });
      if (url.endsWith('/v1/billing/plans')) {
        const body = JSON.parse(String(init?.body));
        expect(body.billing_cycles[0].pricing_scheme.fixed_price).toEqual({
          value: '4.99',
          currency_code: 'EUR',
        });
        return json({ id: 'P-1' });
      }
      if (url.endsWith('/v1/billing/subscriptions')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ plan_id: 'P-1', custom_id: 'user-1|premium|month' });
        return json({
          id: 'I-ABC123',
          links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const input = {
      userId: 'user-1',
      planId: 'premium' as const,
      period: 'month' as const,
      appUrl: 'https://solco.test',
    };
    await expect(createPayPalSubscription(input, fetcher as unknown as typeof fetch)).resolves.toBe(
      'https://www.sandbox.paypal.com/approve',
    );
    await createPayPalSubscription(input, fetcher as unknown as typeof fetch);
    const created = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/v1/billing/plans'));
    expect(created).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('api-m.sandbox.paypal.com');
  });

  it('conferma solo abbonamenti dello stesso utente e approvati', async () => {
    const make = (custom: string, status: string) =>
      vi.fn(async (url: string) =>
        url.endsWith('/oauth2/token')
          ? json({ access_token: 'tok', expires_in: 3600 })
          : json({
              id: 'I-ABC123',
              custom_id: custom,
              status,
              billing_info: { next_billing_time: '2026-12-11T10:00:00Z' },
            }),
      );
    await expect(
      confirmPayPalSubscription(
        'user-1',
        'I-ABC123',
        make('user-2|premium|month', 'ACTIVE') as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'account_mismatch' });
    await expect(
      confirmPayPalSubscription(
        'user-1',
        'I-ABC123',
        make('user-1|premium|month', 'APPROVAL_PENDING') as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'incomplete' });
    const row = await confirmPayPalSubscription(
      'user-1',
      'I-ABC123',
      make('user-1|family|year', 'ACTIVE') as unknown as typeof fetch,
    );
    expect(row).toMatchObject({
      userId: 'user-1',
      planId: 'family',
      period: 'year',
      status: 'ACTIVE',
    });
  });
});
