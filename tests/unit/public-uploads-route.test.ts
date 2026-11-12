// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getSessionUser: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  identity: vi.fn(),
  readJsonLimited: vi.fn(),
  list: vi.fn(),
  register: vi.fn(),
  del: vi.fn(),
  report: vi.fn(),
  play: vi.fn(),
}));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: mocks.requireAuth,
  getSessionUser: mocks.getSessionUser,
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.identity,
}));
vi.mock('@/lib/business/request-body.server', () => ({
  readJsonLimited: mocks.readJsonLimited,
  limitedJsonError: () => new Response('too large', { status: 413 }),
}));
vi.mock('@/lib/music/public-uploads.server', () => {
  class PublicUploadLimitReached extends Error {}
  class InvalidPublicUploadSource extends Error {}
  class BlobNotConfigured extends Error {}
  return {
    listPublicUploads: mocks.list,
    registerPublicUpload: mocks.register,
    deletePublicUpload: mocks.del,
    reportPublicUpload: mocks.report,
    recordPublicUploadPlay: mocks.play,
    PublicUploadLimitReached,
    InvalidPublicUploadSource,
    BlobNotConfigured,
  };
});

import { POST as PLAY } from '@/app/api/music/public-uploads/[uploadId]/play/route';
import { POST as REPORT } from '@/app/api/music/public-uploads/[uploadId]/report/route';
import { DELETE } from '@/app/api/music/public-uploads/[uploadId]/route';
import { GET, POST } from '@/app/api/music/public-uploads/route';
import {
  InvalidPublicUploadSource,
  PublicUploadLimitReached,
} from '@/lib/music/public-uploads.server';

const id = 'c'.repeat(25);
const item = {
  id,
  title: 'Brano',
  artist: null,
  streamUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/x.mp3',
  durationSeconds: 100,
  playCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  mine: false,
};
const validBody = {
  title: 'Brano',
  blobUrl: item.streamUrl,
  blobPathname: 'public-uploads/x.mp3',
  mimeType: 'audio/mpeg',
  byteLength: 1000,
  elapsedSeconds: 100,
};

function postReq(body: unknown) {
  return new Request('https://solco.example/api/music/public-uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.identity.mockReturnValue('ip');
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.getSessionUser.mockResolvedValue({ id: 'user-1' });
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.readJsonLimited.mockResolvedValue({ ok: true, value: validBody });
});

describe('GET /api/music/public-uploads', () => {
  it('elenca i brani pubblici (anche anonimo)', async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.list.mockResolvedValue([item]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [item] });
    expect(mocks.list).toHaveBeenCalledWith(null);
  });
});

describe('POST /api/music/public-uploads', () => {
  it('403 se origine diversa', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await POST(postReq(validBody))).status).toBe(403);
  });
  it('401 se non autenticato', async () => {
    mocks.requireAuth.mockRejectedValue(new Response('no', { status: 401 }));
    expect((await POST(postReq(validBody))).status).toBe(401);
  });
  it('400 con errori di campo su corpo non valido', async () => {
    mocks.readJsonLimited.mockResolvedValue({ ok: true, value: { blobUrl: 'x' } });
    const res = await POST(postReq({ blobUrl: 'x' }));
    expect(res.status).toBe(400);
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it('201 con il brano registrato', async () => {
    mocks.register.mockResolvedValue({ ...item, mine: true });
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);
    expect(mocks.register).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ title: 'Brano' }),
    );
  });
  it('409 al raggiungimento del tetto', async () => {
    mocks.register.mockRejectedValue(new PublicUploadLimitReached());
    expect((await POST(postReq(validBody))).status).toBe(409);
  });
  it('400 su sorgente non valida', async () => {
    mocks.register.mockRejectedValue(new InvalidPublicUploadSource());
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: Record<string, string> };
    expect(body.errors?.blobUrl).toBeTruthy();
  });
});

describe('DELETE /api/music/public-uploads/[id]', () => {
  const params = Promise.resolve({ uploadId: id });
  function req() {
    return new Request(`https://solco.example/api/music/public-uploads/${id}`, {
      method: 'DELETE',
    });
  }
  it('403 se origine diversa', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await DELETE(req(), { params })).status).toBe(403);
  });
  it('404 se niente eliminato', async () => {
    mocks.del.mockResolvedValue(false);
    expect((await DELETE(req(), { params })).status).toBe(404);
  });
  it('200 all’eliminazione', async () => {
    mocks.del.mockResolvedValue(true);
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(200);
    expect(mocks.del).toHaveBeenCalledWith('user-1', id);
  });
  it('404 su id malformato', async () => {
    const res = await DELETE(req(), { params: Promise.resolve({ uploadId: 'BAD!' }) });
    expect(res.status).toBe(404);
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

describe('POST /api/music/public-uploads/[id]/report', () => {
  const params = Promise.resolve({ uploadId: id });
  function req() {
    return new Request(`https://solco.example/api/music/public-uploads/${id}/report`, {
      method: 'POST',
    });
  }
  it('200 sulla segnalazione', async () => {
    mocks.readJsonLimited.mockResolvedValue({ ok: true, value: {} });
    mocks.report.mockResolvedValue(true);
    const res = await REPORT(req(), { params });
    expect(res.status).toBe(200);
    expect(mocks.report).toHaveBeenCalledWith(id, 'user-1');
  });
  it('404 se il brano pubblicato non esiste', async () => {
    mocks.readJsonLimited.mockResolvedValue({ ok: true, value: {} });
    mocks.report.mockResolvedValue(false);
    expect((await REPORT(req(), { params })).status).toBe(404);
  });
});

describe('POST /api/music/public-uploads/[id]/play', () => {
  const params = Promise.resolve({ uploadId: id });
  function req() {
    return new Request(`https://solco.example/api/music/public-uploads/${id}/play`, {
      method: 'POST',
    });
  }
  it('conta l’ascolto (200)', async () => {
    mocks.play.mockResolvedValue(undefined);
    const res = await PLAY(req(), { params });
    expect(res.status).toBe(200);
    expect(mocks.play).toHaveBeenCalledWith(id);
  });
  it('403 se origine diversa', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await PLAY(req(), { params })).status).toBe(403);
  });
});
