// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getAppleSubscription: vi.fn(),
  getPlaySubscription: vi.fn(),
  acknowledgePlaySubscription: vi.fn(),
  appleIapConfig: vi.fn(),
  googlePlayConfig: vi.fn(),
  iapAllowSandbox: vi.fn(),
  iapRequireIntegrity: vi.fn(),
  verifyPlayIntegrityToken: vi.fn(),
  reportIapFraudSignal: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('@/lib/business/iap/apple-store.server', () => ({
  getAppleSubscription: mocks.getAppleSubscription,
}));
vi.mock('@/lib/business/iap/google-play.server', () => ({
  getPlaySubscription: mocks.getPlaySubscription,
  acknowledgePlaySubscription: mocks.acknowledgePlaySubscription,
}));
vi.mock('@/lib/business/iap/config.server', () => ({
  appleIapConfig: mocks.appleIapConfig,
  googlePlayConfig: mocks.googlePlayConfig,
  iapAllowSandbox: mocks.iapAllowSandbox,
  iapRequireIntegrity: mocks.iapRequireIntegrity,
}));
vi.mock('@/lib/business/iap/play-integrity.server', () => ({
  verifyPlayIntegrityToken: mocks.verifyPlayIntegrityToken,
}));
vi.mock('@/lib/business/iap/fraud-alert.server', () => ({
  reportIapFraudSignal: mocks.reportIapFraudSignal,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    solcoIapSubscription: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      upsert: mocks.upsert,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
  },
}));

import { iapAccountToken } from '@/lib/business/iap/account-token';
import {
  hasActiveIapSubscription,
  verifyAndPersistIapPurchase,
} from '@/lib/business/iap/entitlement.server';

const now = new Date('2026-06-01T00:00:00.000Z');
const future = new Date('2026-07-01T00:00:00.000Z');
const past = new Date('2026-05-01T00:00:00.000Z');

function appleSub(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'apple' as const,
    storeSubId: 'orig-1',
    latestOrderId: 'txn-1',
    productId: 'solco_premium_monthly',
    state: 'active',
    autoRenew: true,
    environment: 'Production',
    accountToken: iapAccountToken('user-1'),
    expiresAt: future,
    acknowledged: true,
    ...overrides,
  };
}

function googleSub(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'google' as const,
    storeSubId: 'ptoken',
    latestOrderId: 'GPA.1',
    productId: 'solco_premium_monthly',
    state: 'active',
    autoRenew: true,
    environment: 'production',
    accountToken: iapAccountToken('user-1'),
    expiresAt: future,
    acknowledged: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.appleIapConfig.mockReturnValue({ bundleId: 'com.solco.app', rootCas: 'x' });
  mocks.googlePlayConfig.mockReturnValue({ packageName: 'com.solco.app' });
  mocks.iapAllowSandbox.mockReturnValue(false);
  mocks.iapRequireIntegrity.mockReturnValue(false);
  mocks.verifyPlayIntegrityToken.mockResolvedValue({
    ok: true,
    verdict: {
      appRecognized: true,
      deviceIntegrity: true,
      licensed: true,
      packageName: 'com.solco.app',
    },
  });
  mocks.reportIapFraudSignal.mockResolvedValue(undefined);
  mocks.findUnique.mockResolvedValue(null);
  mocks.findFirst.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({});
});

describe('verifyAndPersistIapPurchase', () => {
  const input = {
    userId: 'user-1',
    platform: 'apple' as const,
    productId: 'solco_premium_monthly',
    token: 'txn-1',
    now,
  };

  it('rifiuta un prodotto sconosciuto', async () => {
    const r = await verifyAndPersistIapPurchase({ ...input, productId: 'ignoto' });
    expect(r).toEqual({ confirmed: false, reason: 'unknown_product' });
  });

  it('rifiuta se la piattaforma non è configurata', async () => {
    mocks.appleIapConfig.mockReturnValue(null);
    const r = await verifyAndPersistIapPurchase(input);
    expect(r).toEqual({ confirmed: false, reason: 'not_configured' });
  });

  it('restituisce not_found se lo store non ha l’abbonamento', async () => {
    mocks.getAppleSubscription.mockResolvedValue(null);
    const r = await verifyAndPersistIapPurchase(input);
    expect(r).toEqual({ confirmed: false, reason: 'not_found' });
  });

  it('rifiuta la sandbox in produzione', async () => {
    mocks.getAppleSubscription.mockResolvedValue(appleSub({ environment: 'Sandbox' }));
    const r = await verifyAndPersistIapPurchase(input);
    expect(r).toEqual({ confirmed: false, reason: 'sandbox_not_allowed' });
  });

  it('rifiuta una ricevuta legata a un altro account (anti-replay)', async () => {
    mocks.getAppleSubscription.mockResolvedValue(
      appleSub({ accountToken: iapAccountToken('victim') }),
    );
    const r = await verifyAndPersistIapPurchase(input);
    expect(r).toEqual({ confirmed: false, reason: 'account_mismatch' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rifiuta se l’abbonamento appartiene già a un altro utente Solco', async () => {
    mocks.getAppleSubscription.mockResolvedValue(appleSub());
    mocks.findUnique.mockResolvedValue({ userId: 'other-user', firstPaidAt: null });
    const r = await verifyAndPersistIapPurchase(input);
    expect(r).toEqual({ confirmed: false, reason: 'account_mismatch' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('conferma e salva un abbonamento valido (primo pagamento)', async () => {
    mocks.getAppleSubscription.mockResolvedValue(appleSub());
    const r = await verifyAndPersistIapPurchase(input);
    expect(r).toEqual({
      confirmed: true,
      active: true,
      validUntil: future,
      planId: 'premium',
      firstPaid: true,
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const arg = mocks.upsert.mock.calls[0]?.[0];
    expect(arg.create).toMatchObject({ userId: 'user-1', planId: 'premium', firstPaidAt: now });
  });

  it('NON riconta il primo pagamento se l’utente ha già pagato (anti-farming referral)', async () => {
    mocks.getAppleSubscription.mockResolvedValue(appleSub());
    mocks.findFirst.mockResolvedValue({ id: 'old-row' }); // pagamento precedente
    const r = await verifyAndPersistIapPurchase(input);
    expect(r).toMatchObject({ confirmed: true, active: true, firstPaid: false });
  });

  it('su Google conferma (acknowledge) un acquisto non ancora confermato', async () => {
    mocks.getPlaySubscription.mockResolvedValue({
      platform: 'google',
      storeSubId: 'ptoken',
      latestOrderId: 'GPA.1',
      productId: 'solco_premium_monthly',
      state: 'active',
      autoRenew: true,
      environment: 'production',
      accountToken: iapAccountToken('user-1'),
      expiresAt: future,
      acknowledged: false,
    });
    mocks.acknowledgePlaySubscription.mockResolvedValue(undefined);
    const r = await verifyAndPersistIapPurchase({
      ...input,
      platform: 'google',
      token: 'ptoken',
    });
    expect(r).toMatchObject({ confirmed: true, active: true });
    expect(mocks.acknowledgePlaySubscription).toHaveBeenCalledWith(
      'solco_premium_monthly',
      'ptoken',
      expect.anything(),
      expect.anything(),
      now,
    );
  });

  it('segnala la frode quando la ricevuta è di un altro account', async () => {
    mocks.getAppleSubscription.mockResolvedValue(
      appleSub({ accountToken: iapAccountToken('victim') }),
    );
    await verifyAndPersistIapPurchase(input);
    expect(mocks.reportIapFraudSignal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'account_mismatch', userId: 'user-1' }),
    );
  });

  it('Google: con enforcement acceso e verdetto Integrity negativo rifiuta', async () => {
    mocks.iapRequireIntegrity.mockReturnValue(true);
    mocks.verifyPlayIntegrityToken.mockResolvedValue({
      ok: false,
      hard: true,
      reason: 'device_untrusted',
    });
    mocks.getPlaySubscription.mockResolvedValue(googleSub());
    const r = await verifyAndPersistIapPurchase({
      ...input,
      platform: 'google',
      token: 'ptoken',
      integrityToken: 'itok',
    });
    expect(r).toEqual({ confirmed: false, reason: 'integrity_failed' });
    expect(mocks.reportIapFraudSignal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'integrity_failed', platform: 'google' }),
    );
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('Google: con enforcement acceso e token Integrity assente rifiuta', async () => {
    mocks.iapRequireIntegrity.mockReturnValue(true);
    mocks.verifyPlayIntegrityToken.mockResolvedValue({ ok: false, hard: false, reason: 'absent' });
    mocks.getPlaySubscription.mockResolvedValue(googleSub());
    const r = await verifyAndPersistIapPurchase({ ...input, platform: 'google', token: 'ptoken' });
    expect(r).toEqual({ confirmed: false, reason: 'integrity_failed' });
  });

  it('Google: enforcement SPENTO non blocca ma segnala un verdetto negativo', async () => {
    mocks.iapRequireIntegrity.mockReturnValue(false);
    mocks.verifyPlayIntegrityToken.mockResolvedValue({
      ok: false,
      hard: true,
      reason: 'app_unrecognized',
    });
    mocks.getPlaySubscription.mockResolvedValue(googleSub());
    const r = await verifyAndPersistIapPurchase({
      ...input,
      platform: 'google',
      token: 'ptoken',
      integrityToken: 'itok',
    });
    expect(r).toMatchObject({ confirmed: true, active: true });
    expect(mocks.reportIapFraudSignal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'integrity_failed' }),
    );
  });

  it('Google: verdetto Integrity valido conferma normalmente', async () => {
    mocks.getPlaySubscription.mockResolvedValue(googleSub());
    const r = await verifyAndPersistIapPurchase({
      ...input,
      platform: 'google',
      token: 'ptoken',
      integrityToken: 'itok',
    });
    expect(r).toMatchObject({ confirmed: true, active: true });
    expect(mocks.reportIapFraudSignal).not.toHaveBeenCalled();
  });
});

describe('hasActiveIapSubscription', () => {
  it('true per una riga attiva non scaduta senza interrogare lo store', async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: '1',
        userId: 'user-1',
        platform: 'apple',
        storeSubId: 'o',
        productId: 'solco_premium_monthly',
        state: 'active',
        validUntil: future,
        checkedAt: now,
      },
    ]);
    expect(await hasActiveIapSubscription('user-1', now)).toBe(true);
    expect(mocks.getAppleSubscription).not.toHaveBeenCalled();
  });

  it('false quando non ci sono righe', async () => {
    mocks.findMany.mockResolvedValue([]);
    expect(await hasActiveIapSubscription('user-1', now)).toBe(false);
  });

  it('ri-verifica una riga scaduta e resta false se lo store la dà scaduta', async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: '1',
        userId: 'user-1',
        platform: 'apple',
        storeSubId: 'o',
        productId: 'solco_premium_monthly',
        state: 'active',
        validUntil: past,
        checkedAt: past,
      },
    ]);
    mocks.getAppleSubscription.mockResolvedValue(appleSub({ state: 'expired', expiresAt: past }));
    mocks.update.mockResolvedValue({
      id: '1',
      userId: 'user-1',
      platform: 'apple',
      storeSubId: 'o',
      productId: 'solco_premium_monthly',
      state: 'expired',
      validUntil: past,
      checkedAt: now,
    });
    expect(await hasActiveIapSubscription('user-1', now)).toBe(false);
    expect(mocks.getAppleSubscription).toHaveBeenCalledTimes(1);
  });
});
