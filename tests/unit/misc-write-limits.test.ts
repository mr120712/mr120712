// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  requireSolcoPro: vi.fn(),
  persistPurchase: vi.fn(),
  getReadiness: vi.fn(),
  requireRightsAdmin: vi.fn(),
  deleteAccountData: vi.fn(),
  transaction: vi.fn(),
  listeningFindMany: vi.fn(),
  listeningUpdateMany: vi.fn(),
  listeningFindFirst: vi.fn(),
  preferenceFindUnique: vi.fn(),
  preferenceUpsert: vi.fn(),
  selectionFindUnique: vi.fn(),
  selectionUpsert: vi.fn(),
  sourceFindUnique: vi.fn(),
  sourceUpdate: vi.fn(),
}));

const { rightsHeaders } = vi.hoisted(() => ({
  rightsHeaders: {
    'Cache-Control': 'private, no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Vary: 'Cookie',
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : null),
}));
vi.mock('@/lib/business/solco-pro-entitlement', () => ({
  requireSolcoPro: mocks.requireSolcoPro,
  persistVerifiedSolcoProPurchase: mocks.persistPurchase,
  getSolcoProReadiness: mocks.getReadiness,
}));
vi.mock('@/lib/music/rights-admin.server', () => ({
  requireVerifiedMusicRightsAdmin: mocks.requireRightsAdmin,
  musicRightsPrivateHeaders: rightsHeaders,
}));
vi.mock('@/lib/music/audius-source.server', () => ({ getAudiusAlbumCatalogDetail: vi.fn() }));
vi.mock('@/lib/music/private-audio-source.server', () => ({
  InvalidPrivateAudioSource: class InvalidPrivateAudioSource extends Error {},
  InvalidPrivateEvidenceFile: class InvalidPrivateEvidenceFile extends Error {},
  PrivateAudioStorageUnavailable: class PrivateAudioStorageUnavailable extends Error {},
  inspectPrivateAudioSource: vi.fn(),
  inspectPrivateEvidenceFile: vi.fn(),
}));
vi.mock('@/lib/business/account-deletion', () => ({ deleteAccountData: mocks.deleteAccountData }));
vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: mocks.transaction,
    listeningEntry: {
      findMany: mocks.listeningFindMany,
      updateMany: mocks.listeningUpdateMany,
      findFirst: mocks.listeningFindFirst,
    },
    solcoProPreference: { findUnique: mocks.preferenceFindUnique, upsert: mocks.preferenceUpsert },
    solcoPlanSelection: { findUnique: mocks.selectionFindUnique, upsert: mocks.selectionUpsert },
    musicPlaybackSource: { findUnique: mocks.sourceFindUnique, update: mocks.sourceUpdate },
  },
}));

import { DELETE as deleteAccount } from '@/app/api/account/route';
import { PATCH as updateRights } from '@/app/api/admin/music-rights/[sourceId]/route';
import { POST as registerRights } from '@/app/api/admin/music-rights/route';
import { PATCH as updateListening } from '@/app/api/listening-entries/[entryId]/route';
import { POST as createListening, GET as getDiary } from '@/app/api/listening-entries/route';
import { GET as getOverview, PATCH as updateOverview } from '@/app/api/solco-pro/overview/route';
import { POST as selectPlan } from '@/app/api/solco-pro/plan-selection/route';
import { POST as verifyPurchase } from '@/app/api/solco-pro/purchase/verify/route';

const user = { id: 'user-1', email: 'listener@example.test', name: 'Ascoltatore' };

function jsonRequest(path: string, method: string, body: string, contentLength?: number) {
  return new Request(`https://solco.test${path}`, {
    method,
    headers: {
      origin: 'https://solco.test',
      'content-type': 'application/json',
      ...(contentLength === undefined ? {} : { 'content-length': String(contentLength) }),
    },
    body,
  });
}

function rateLimited() {
  return Response.json(
    { error: 'rate_limited', message: 'Riprova tra 60 secondi.', retryAfterSeconds: 60 },
    {
      status: 429,
      headers: { 'Retry-After': '60', 'Cache-Control': 'private, no-store' },
    },
  );
}

const listening = {
  albumId: '101',
  catalogProvider: 'legacy',
  albumName: 'Album A',
  artistName: 'Artista A',
  artworkUrl: null,
  releaseDate: '2007-10-10T07:00:00Z',
  genre: 'Alternative',
  trackCount: 10,
  rating: 4,
  note: 'Una nota',
  listenedOn: '2026-11-01',
};

const entryParams = { params: Promise.resolve({ entryId: 'entry-1' }) };
const sourceParams = { params: Promise.resolve({ sourceId: 'source-1' }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue(user);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.requireSolcoPro.mockResolvedValue({ allowed: true, user, entitlement: null });
  mocks.requireRightsAdmin.mockResolvedValue({ allowed: true, user: { id: 'admin-1' } });
  mocks.listeningFindMany.mockResolvedValue([]);
  mocks.preferenceFindUnique.mockResolvedValue(null);
});

describe('account e diritti musicali: corpo limitato', () => {
  it('rifiuta un corpo troppo grande prima di cancellare l’account', async () => {
    const response = await deleteAccount(
      jsonRequest('/api/account', 'DELETE', JSON.stringify({ confirmation: 'x' }), 64 * 1024),
    );

    expect(response.status).toBe(413);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.deleteAccountData).not.toHaveBeenCalled();
  });

  it('mantiene confirmation_required per JSON non valido', async () => {
    const response = await deleteAccount(jsonRequest('/api/account', 'DELETE', '{'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'confirmation_required' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rifiuta registrazioni e azioni sui diritti troppo grandi, con intestazioni private', async () => {
    const registration = await registerRights(
      jsonRequest('/api/admin/music-rights', 'POST', '{}', 64 * 1024),
    );
    expect(registration.status).toBe(413);
    expect(await registration.json()).toEqual({ error: 'payload_too_large' });
    expect(registration.headers.get('cache-control')).toBe(rightsHeaders['Cache-Control']);

    const action = await updateRights(
      jsonRequest('/api/admin/music-rights/source-1', 'PATCH', '{}', 8 * 1024),
      sourceParams,
    );
    expect(action.status).toBe(413);
    expect(action.headers.get('vary')).toBe('Cookie');
    expect(mocks.sourceFindUnique).not.toHaveBeenCalled();

    const malformed = await updateRights(
      jsonRequest('/api/admin/music-rights/source-1', 'PATCH', '{'),
      sourceParams,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_json' });
  });
});

describe('diario degli ascolti: corpo, lunghezze e limiti di scrittura', () => {
  it('rifiuta un corpo troppo grande prima del limite e del database', async () => {
    const response = await createListening(
      jsonRequest('/api/listening-entries', 'POST', JSON.stringify(listening), 64 * 1024),
    );

    expect(response.status).toBe(413);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['genre', 'g'.repeat(101)],
    ['releaseDate', '2'.repeat(65)],
  ])('rifiuta %s troppo lungo invece di salvarlo', async (field, value) => {
    const response = await createListening(
      jsonRequest(
        '/api/listening-entries',
        'POST',
        JSON.stringify({ ...listening, [field]: value }),
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('applica listening.write per account prima di creare o modificare un ascolto', async () => {
    mocks.enforceRateLimit.mockResolvedValue(rateLimited());

    const created = await createListening(
      jsonRequest('/api/listening-entries', 'POST', JSON.stringify(listening)),
    );
    expect(created.status).toBe(429);
    expect(mocks.transaction).not.toHaveBeenCalled();

    const updated = await updateListening(
      jsonRequest('/api/listening-entries/entry-1', 'PATCH', JSON.stringify({ rating: 3 })),
      entryParams,
    );
    expect(updated.status).toBe(429);
    expect(mocks.listeningUpdateMany).not.toHaveBeenCalled();

    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.enforceRateLimit).toHaveBeenNthCalledWith(1, 'listening.write', 'user:user-1');
    expect(mocks.enforceRateLimit).toHaveBeenNthCalledWith(2, 'listening.write', 'user:user-1');
  });

  it('invia il diario senza cache condivisa', async () => {
    const response = await getDiary(new Request('https://solco.test/api/listening-entries'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
  });
});

describe('Solco Pro: corpo limitato e solco.pro.write', () => {
  it('limita il tema Pro e non salva quando il limite è raggiunto', async () => {
    const oversized = await updateOverview(
      jsonRequest('/api/solco-pro/overview', 'PATCH', '{}', 8 * 1024),
    );
    expect(oversized.status).toBe(413);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();

    mocks.enforceRateLimit.mockResolvedValueOnce(rateLimited());
    const limited = await updateOverview(
      jsonRequest('/api/solco-pro/overview', 'PATCH', JSON.stringify({ theme: 'amber' })),
    );
    expect(limited.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('solco.pro.write', 'user:user-1');
    expect(mocks.preferenceUpsert).not.toHaveBeenCalled();
  });

  it('invia la panoramica Pro senza cache condivisa', async () => {
    const response = await getOverview(new Request('https://solco.test/api/solco-pro/overview'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
  });

  it('limita la scelta del piano e la verifica dell’acquisto prima del database e di Stripe', async () => {
    const oversizedPlan = await selectPlan(
      jsonRequest('/api/solco-pro/plan-selection', 'POST', '{}', 8 * 1024),
    );
    expect(oversizedPlan.status).toBe(413);
    expect(oversizedPlan.headers.get('vary')).toContain('Cookie');

    const malformedPlan = await selectPlan(
      jsonRequest('/api/solco-pro/plan-selection', 'POST', '{'),
    );
    expect(malformedPlan.status).toBe(400);
    expect(await malformedPlan.json()).toEqual({ error: 'invalid_request' });

    mocks.enforceRateLimit.mockResolvedValue(rateLimited());
    const limitedPlan = await selectPlan(
      jsonRequest(
        '/api/solco-pro/plan-selection',
        'POST',
        JSON.stringify({ planId: 'free', billingPeriod: 'month' }),
      ),
    );
    expect(limitedPlan.status).toBe(429);
    expect(limitedPlan.headers.get('vary')).toContain('Cookie');
    expect(mocks.selectionFindUnique).not.toHaveBeenCalled();
    expect(mocks.selectionUpsert).not.toHaveBeenCalled();

    const oversizedVerify = await verifyPurchase(
      jsonRequest('/api/solco-pro/purchase/verify', 'POST', '{}', 8 * 1024),
    );
    expect(oversizedVerify.status).toBe(413);

    const limitedVerify = await verifyPurchase(
      jsonRequest(
        '/api/solco-pro/purchase/verify',
        'POST',
        JSON.stringify({ sessionId: 'cs_test_123' }),
      ),
    );
    expect(limitedVerify.status).toBe(429);
    expect(mocks.persistPurchase).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('solco.pro.write', 'user:user-1');
  });
});
