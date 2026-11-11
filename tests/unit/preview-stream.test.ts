// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  premium: vi.fn(async () => false),
  resolve: vi.fn(async () => 'https://93.184.216.34/live.mp3' as string | null),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/premium-access.server', () => ({ currentUserHasPremium: mocks.premium }));
vi.mock('@/lib/music/jamendo.server', () => ({ resolveJamendoAudio: mocks.resolve }));
vi.mock('@/lib/business/play-quota.server', () => ({
  consumePlayForCurrentUser: vi.fn(async () => ({
    allowed: true,
    counted: true,
    used: 1,
    limit: 40,
  })),
  playDeniedResponse: vi.fn(),
}));

import { GET } from '@/app/api/music/jamendo/[trackId]/stream/route';
import {
  PREVIEW_MAX_BYTES,
  previewResponse,
  truncateStream,
} from '@/lib/music/preview-stream.server';

function bytes(total: number, chunk = 64 * 1024) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const size = Math.min(chunk, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

async function length(stream: ReadableStream<Uint8Array>) {
  let total = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    total += chunk.byteLength;
  return total;
}

beforeEach(() => {
  mocks.premium.mockReset().mockResolvedValue(false);
  mocks.resolve.mockReset().mockResolvedValue('https://93.184.216.34/live.mp3');
});

describe('anteprima di 30 secondi', () => {
  it('tronca uno stream infinito al limite di byte', async () => {
    expect(await length(truncateStream(bytes(10 * PREVIEW_MAX_BYTES), PREVIEW_MAX_BYTES))).toBe(
      PREVIEW_MAX_BYTES,
    );
    expect(await length(truncateStream(bytes(1000), PREVIEW_MAX_BYTES))).toBe(1000);
  });

  it('inoltra solo audio da host pubblici HTTPS', async () => {
    const audio = vi
      .fn()
      .mockResolvedValue(
        new Response(bytes(5 * PREVIEW_MAX_BYTES), { headers: { 'content-type': 'audio/mpeg' } }),
      );
    const ok = await previewResponse(
      'https://93.184.216.34/a.mp3',
      audio as unknown as typeof fetch,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-solco-preview')).toBe('30');
    expect(await length(ok.body as ReadableStream<Uint8Array>)).toBe(PREVIEW_MAX_BYTES);

    const html = vi
      .fn()
      .mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    expect(
      (await previewResponse('https://93.184.216.34/a', html as unknown as typeof fetch)).status,
    ).toBe(502);
    await expect(
      previewResponse('https://127.0.0.1/a.mp3', audio as unknown as typeof fetch),
    ).rejects.toThrow();
  });

  it('free e Premium ricevono lo stream completo: ogni ascolto Free conta sui 40 del mese', async () => {
    for (const premium of [false, true]) {
      mocks.premium.mockResolvedValueOnce(premium);
      const response = await GET(
        new Request('https://solco.test/api/music/jamendo/1532771/stream'),
        {
          params: Promise.resolve({ trackId: '1532771' }),
        },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://93.184.216.34/live.mp3');
      expect(response.headers.get('cache-control')).toContain('private');
    }
  });
});
