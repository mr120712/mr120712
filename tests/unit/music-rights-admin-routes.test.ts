// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  sameOrigin: vi.fn(),
  catalog: vi.fn(),
  inspectAudio: vi.fn(),
  inspectEvidence: vi.fn(),
  sourceFindMany: vi.fn(),
  sourceFindUnique: vi.fn(),
  sourceCreate: vi.fn(),
  sourceUpdate: vi.fn(),
  evidenceCreate: vi.fn(),
  evidenceUpdate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/music/rights-admin.server', () => ({
  musicRightsPrivateHeaders: { 'Cache-Control': 'private, no-store' },
  requireVerifiedMusicRightsAdmin: mocks.requireAdmin,
}));
vi.mock('@/lib/music/audius-source.server', () => ({ getAudiusAlbumCatalogDetail: mocks.catalog }));
vi.mock('@/lib/music/private-audio-source.server', () => ({
  InvalidPrivateAudioSource: class InvalidPrivateAudioSource extends Error {},
  InvalidPrivateEvidenceFile: class InvalidPrivateEvidenceFile extends Error {},
  PrivateAudioStorageUnavailable: class PrivateAudioStorageUnavailable extends Error {},
  inspectPrivateAudioSource: mocks.inspectAudio,
  inspectPrivateEvidenceFile: mocks.inspectEvidence,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    musicPlaybackSource: {
      findMany: mocks.sourceFindMany,
      findUnique: mocks.sourceFindUnique,
      create: mocks.sourceCreate,
      update: mocks.sourceUpdate,
    },
    musicRightsEvidence: {
      create: mocks.evidenceCreate,
      update: mocks.evidenceUpdate,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from '@/app/api/admin/music-rights/route';
import { PATCH } from '@/app/api/admin/music-rights/[sourceId]/route';
import { InvalidPrivateAudioSource, PrivateAudioStorageUnavailable } from '@/lib/music/private-audio-source.server';

const admin = { allowed: true, user: { id: 'verified-admin-3' } };
const catalogDetail = {
  state: 'available',
  album: { id: 'album-71' },
  tracks: [{ id: 'track-71' }],
};
const registration = {
  albumId: 'album-71',
  trackId: 'track-71',
  audio: { key: 'company/private/track-71.m4a', mimeType: 'audio/mp4', byteLength: 4000 },
  evidence: { key: 'company/private/rights-71.pdf', mimeType: 'application/pdf', byteLength: 900 },
  validFrom: '2026-11-01T00:00:00.000Z',
  validUntil: '2027-11-01T00:00:00.000Z',
  confirmFullTrackAndSolcoRights: true,
};

function post(body: unknown, method = 'POST') {
  return new Request('https://solco.test/api/admin/music-rights', {
    method,
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAdmin.mockResolvedValue(admin);
  mocks.catalog.mockResolvedValue(catalogDetail);
  mocks.inspectAudio.mockResolvedValue({ mimeType: 'audio/mp4', byteLength: 4000, durationSeconds: 183.25 });
  mocks.inspectEvidence.mockResolvedValue({ mimeType: 'application/pdf', byteLength: 900 });
  mocks.sourceFindMany.mockResolvedValue([]);
  mocks.sourceCreate.mockResolvedValue({ id: 'source-registered-1' });
  mocks.evidenceCreate.mockResolvedValue({ id: 'evidence-registered-1' });
  mocks.transaction.mockImplementation(async (callback) => callback({
    musicPlaybackSource: { create: mocks.sourceCreate },
    musicRightsEvidence: { create: mocks.evidenceCreate },
  }));
});

describe('gestione amministrativa delle fonti e dei diritti', () => {
  it('rende lo stato solo agli amministratori verificati e senza esporre chiavi private', async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      allowed: false,
      response: Response.json({ error: 'admin_required' }, { status: 403 }),
    });
    const denied = await GET(new Request('https://solco.test/api/admin/music-rights'));
    expect(denied.status).toBe(403);
    expect(mocks.sourceFindMany).not.toHaveBeenCalled();

    mocks.sourceFindMany.mockResolvedValueOnce([{
      id: 'source-registered-1', albumId: 'album-71', trackId: 'track-71',
      completeness: 'full_track', durationSeconds: 183.25, active: true,
      fileKey: 'private/audio-secret.m4a', evidenceFileKey: 'private/rights-secret.pdf',
      rightsEvidence: {
        validFrom: new Date('2026-11-01T00:00:00.000Z'),
        validUntil: new Date('2027-11-01T00:00:00.000Z'),
        verifiedAt: new Date('2026-11-01T00:00:00.000Z'),
        verifiedByUserId: 'verified-admin-3', revokedAt: null,
      },
    }]);
    const response = await GET(new Request('https://solco.test/api/admin/music-rights'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.records[0]).toMatchObject({
      albumId: 'album-71', trackId: 'track-71', active: true,
      rightsState: 'current', verifiedByUserId: 'verified-admin-3',
    });
    expect(JSON.stringify(body)).not.toMatch(/private\/audio|private\/rights|fileKey|evidenceFileKey/);
  });

  it('nega chiamate dirette e non-admin prima di leggere o modificare fonti', async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      allowed: false,
      response: Response.json({ error: 'admin_required' }, { status: 403 }),
    });
    const denied = await POST(post(registration));
    expect(denied.status).toBe(403);
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.sameOrigin.mockReturnValueOnce(false);
    const crossOrigin = await POST(post(registration));
    expect(crossOrigin.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);

    mocks.requireAdmin.mockResolvedValueOnce({
      allowed: false,
      response: Response.json({ error: 'admin_required' }, { status: 403 }),
    });
    const patch = await PATCH(post({ action: 'deactivate_source' }, 'PATCH'), {
      params: Promise.resolve({ sourceId: 'source-registered-1' }),
    });
    expect(patch.status).toBe(403);
    expect(mocks.sourceFindUnique).not.toHaveBeenCalled();
  });

  it('registra fonte e prova verificata in una transazione e non restituisce chiavi private', async () => {
    const response = await POST(post(registration));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ sourceId: 'source-registered-1', state: 'recorded' });
    expect(mocks.catalog).toHaveBeenCalledWith('album-71');
    expect(mocks.inspectAudio).toHaveBeenCalledWith(
      'company/private/track-71.m4a',
      'audio/mp4',
      4000,
    );
    expect(mocks.inspectEvidence).toHaveBeenCalledWith(
      'company/private/rights-71.pdf',
      'application/pdf',
      900,
    );
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.sourceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        albumId: 'album-71',
        trackId: 'track-71',
        completeness: 'full_track',
        durationSeconds: 183.25,
        active: true,
        createdByUserId: 'verified-admin-3',
      }),
      select: { id: true },
    }));
    expect(mocks.evidenceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        albumId: 'album-71',
        trackId: 'track-71',
        grant: 'solco_streaming',
        durationSeconds: 183.25,
        verifiedByUserId: 'verified-admin-3',
      }),
    }));
    expect(JSON.stringify(body)).not.toMatch(/company\/private|\.pdf|\.m4a/);
  });

  it('non registra dati se il file privato non è verificabile o lo storage non risponde', async () => {
    mocks.inspectAudio.mockRejectedValueOnce(new InvalidPrivateAudioSource());
    const invalid = await POST(post(registration));
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: 'private_file_invalid' });
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.inspectEvidence.mockRejectedValueOnce(new PrivateAudioStorageUnavailable());
    const unavailable = await POST(post(registration));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'private_storage_unavailable' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('registra disattivazione e revoca come modifiche persistenti distinte', async () => {
    mocks.sourceFindUnique.mockResolvedValue({
      id: 'source-registered-1',
      rightsEvidence: { id: 'evidence-registered-1', revokedAt: null },
    });
    const deactivated = await PATCH(post({ action: 'deactivate_source' }, 'PATCH'), {
      params: Promise.resolve({ sourceId: 'source-registered-1' }),
    });
    expect(deactivated.status).toBe(200);
    expect(await deactivated.json()).toEqual({ sourceId: 'source-registered-1', state: 'deactivated' });
    expect(mocks.sourceUpdate).toHaveBeenCalledWith({
      where: { id: 'source-registered-1' }, data: { active: false },
    });

    const revoked = await PATCH(post({ action: 'revoke_evidence' }, 'PATCH'), {
      params: Promise.resolve({ sourceId: 'source-registered-1' }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ sourceId: 'source-registered-1', state: 'revoked' });
    expect(mocks.evidenceUpdate).toHaveBeenCalledWith({
      where: { id: 'evidence-registered-1' }, data: { revokedAt: expect.any(Date) },
    });
  });
});
