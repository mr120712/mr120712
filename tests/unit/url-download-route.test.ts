// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  requireAuth: vi.fn(async (_r?: Request) => ({ id: 'u1' })),
  readJson: vi.fn(),
  reserve: vi.fn(async (_u?: string) => null as Response | null),
  release: vi.fn(async (_u?: string) => undefined),
  download: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/business/request-body.server', () => ({
  readJsonLimited: mocks.readJson,
  limitedJsonError: () => Response.json({ error: 'too_large' }, { status: 413 }),
}));
vi.mock('@/lib/music/offline-download.server', () => ({
  reserveDownloadLimits: mocks.reserve,
  releaseDownloadLimits: mocks.release,
}));
vi.mock('@/lib/music/url-download.server', () => ({ downloadFromUrl: mocks.download }));

import { POST } from '@/app/api/music/download/by-url/route';

function req(url = 'https://audius.co/x/y') {
  mocks.readJson.mockResolvedValue({ ok: true, value: { url } });
  return new Request('https://solco.test/api/music/download/by-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue({ id: 'u1' });
  mocks.reserve.mockResolvedValue(null);
  mocks.release.mockResolvedValue(undefined);
  mocks.download.mockResolvedValue({
    ok: true,
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/mpeg',
    filename: 'Brano.mp3',
  });
});

describe('POST /api/music/download/by-url', () => {
  it('rifiuta se non same-origin (403), senza auth né prenotazione', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('richiede il login: propaga la risposta di requireAuth', async () => {
    mocks.requireAuth.mockRejectedValue(new Response(null, { status: 401 }));
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('corpo non valido: 400, nessuna prenotazione', async () => {
    const r = req();
    mocks.readJson.mockResolvedValue({ ok: false, status: 400 });
    const res = await POST(r);
    expect(res.status).toBe(400);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('oltre il limite di download: inoltra la risposta 429, non scarica', async () => {
    mocks.reserve.mockResolvedValue(Response.json({ error: 'rate_limited' }, { status: 429 }));
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('sorgente non consentita: rimborsa la prenotazione e risponde con l’errore', async () => {
    mocks.download.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'source_not_allowed',
      message: 'no',
    });
    const res = await POST(req('https://youtube.com/x'));
    expect(res.status).toBe(403);
    expect(mocks.release).toHaveBeenCalledWith('u1');
  });

  it('successo: 200 binario con Content-Disposition attachment, nessun rimborso', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''Brano.mp3");
    expect(mocks.release).not.toHaveBeenCalled();
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('eccezione durante il download: rimborsa e risponde 502', async () => {
    mocks.download.mockRejectedValue(new Error('boom'));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(mocks.release).toHaveBeenCalledWith('u1');
  });
});
