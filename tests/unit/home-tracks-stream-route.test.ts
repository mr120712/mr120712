// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  token: 'tok_test' as string | undefined,
}));

// Il route importa `get`; home-tracks.server (per isHomeAudioBlob) importa `list` + env.
vi.mock('@vercel/blob', () => ({ get: mocks.get, list: mocks.list }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));

import { GET } from '@/app/api/music/home-tracks/stream/route';

function req(pathname: string | null, range?: string) {
  const url = pathname
    ? `https://solco.example/api/music/home-tracks/stream?p=${encodeURIComponent(pathname)}`
    : 'https://solco.example/api/music/home-tracks/stream';
  return new Request(url, { headers: range ? { range } : {} });
}

function okStream(headers: Record<string, string>, contentType = 'audio/mp4') {
  return {
    statusCode: 200,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
    headers: new Headers(headers),
    blob: { contentType, size: 3 },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.token = 'tok_test';
});

describe('GET /api/music/home-tracks/stream', () => {
  it('404 se manca il parametro p', async () => {
    expect((await GET(req(null))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('404 per un percorso non audio', async () => {
    expect((await GET(req('copertina.png'))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('404 per un upload utente (prefisso riservato)', async () => {
    expect((await GET(req('public-uploads/x.mp3'))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('404 senza token', async () => {
    mocks.token = undefined;
    expect((await GET(req('mia.m4a'))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('200 e trasmette lo stream con content-type e accept-ranges', async () => {
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    const res = await GET(req('mia.m4a'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('3');
    // Legge come privato, con il percorso richiesto.
    expect(mocks.get).toHaveBeenCalledWith(
      'mia.m4a',
      expect.objectContaining({ access: 'private' }),
    );
  });

  it('206 e inoltra il Range (seek)', async () => {
    mocks.get.mockResolvedValue(
      okStream({ 'content-range': 'bytes 0-1/3', 'content-length': '2' }),
    );
    const res = await GET(req('mia.m4a', 'bytes=0-1'));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-1/3');
    expect(mocks.get).toHaveBeenCalledWith(
      'mia.m4a',
      expect.objectContaining({ headers: { range: 'bytes=0-1' } }),
    );
  });

  it('404 se get() non trova il blob', async () => {
    mocks.get.mockResolvedValue(null);
    expect((await GET(req('mia.m4a'))).status).toBe(404);
  });
});
