// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  requireAuth: vi.fn(),
  enforceRateLimit: vi.fn(async () => null as Response | null),
  readJsonLimited: vi.fn(),
  configured: vi.fn(() => true),
  count: vi.fn(async () => 0),
  presign: vi.fn(
    async () => 'https://bucket.s3.eu-west-1.amazonaws.com/public-uploads/x.mp3?sig=1',
  ),
}));

vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/business/request-body.server', () => ({
  readJsonLimited: mocks.readJsonLimited,
  limitedJsonError: () => new Response('too large', { status: 413 }),
}));
vi.mock('@/lib/music/s3-storage.server', () => ({ presignUploadPut: mocks.presign }));
vi.mock('@/lib/music/public-uploads.server', () => ({
  isPublicUploadConfigured: mocks.configured,
  countUserPublicUploads: mocks.count,
  MAX_UPLOADS_PER_USER: 3,
  buildPublicUploadKey: () => 'public-uploads/brano-ab12cd34ef56.mp3',
}));

import { GET, POST } from '@/app/api/music/public-uploads/blob/route';

const body = { title: 'Brano', fileName: 'brano.mp3', contentType: 'audio/mpeg', byteLength: 1000 };

function req(value: unknown) {
  mocks.readJsonLimited.mockResolvedValue({ ok: true, value });
  return new Request('https://solco.test/api/music/public-uploads/blob', {
    method: 'POST',
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.configured.mockReturnValue(true);
  mocks.count.mockResolvedValue(0);
  mocks.presign.mockResolvedValue(
    'https://bucket.s3.eu-west-1.amazonaws.com/public-uploads/x.mp3?sig=1',
  );
});

describe('GET /api/music/public-uploads/blob', () => {
  it('riporta se lo storage è configurato', async () => {
    expect((await GET().json()).configured).toBe(true);
  });
});

describe('POST /api/music/public-uploads/blob (presign)', () => {
  it('503 quando S3 non è configurato', async () => {
    mocks.configured.mockReturnValue(false);
    expect((await POST(req(body))).status).toBe(503);
  });
  it('403 su origine diversa', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await POST(req(body))).status).toBe(403);
    expect(mocks.presign).not.toHaveBeenCalled();
  });
  it('409 al raggiungimento del tetto per utente', async () => {
    mocks.count.mockResolvedValue(3);
    expect((await POST(req(body))).status).toBe(409);
    expect(mocks.presign).not.toHaveBeenCalled();
  });
  it('400 su corpo non valido', async () => {
    expect((await POST(req({ title: '' }))).status).toBe(400);
    expect(mocks.presign).not.toHaveBeenCalled();
  });
  it('400 su tipo audio non supportato', async () => {
    expect((await POST(req({ ...body, contentType: 'audio/midi' }))).status).toBe(400);
    expect(mocks.presign).not.toHaveBeenCalled();
  });
  it('200 con uploadUrl, chiave e content-type', async () => {
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.uploadUrl).toContain('amazonaws.com');
    expect(json.key).toBe('public-uploads/brano-ab12cd34ef56.mp3');
    expect(json.contentType).toBe('audio/mpeg');
    expect(mocks.presign).toHaveBeenCalledWith(
      'public-uploads/brano-ab12cd34ef56.mp3',
      'audio/mpeg',
    );
  });
});
