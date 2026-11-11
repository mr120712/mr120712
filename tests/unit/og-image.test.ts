// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { hexToRgba, loadOgBackground } from '@/lib/og-image';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const respond = (body: BodyInit | null, init: ResponseInit) =>
  vi.fn(async () => new Response(body, init)) as unknown as typeof fetch;

describe('loadOgBackground', () => {
  it('inlines a fetched PNG as a data URL', async () => {
    const fetchImpl = respond(PNG_BYTES, { headers: { 'content-type': 'image/png' } });
    const result = await loadOgBackground('https://cdn.example.com/og.png', fetchImpl);
    expect(result).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`);
  });

  it('normalizes a content-type with parameters', async () => {
    const fetchImpl = respond(PNG_BYTES, {
      headers: { 'content-type': 'Image/JPEG; charset=binary' },
    });
    const result = await loadOgBackground('https://cdn.example.com/og.jpg', fetchImpl);
    expect(result?.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it.each([undefined, '', 42, 'http://cdn.example.com/og.png', '/og.png'])(
    'skips the fetch for %j',
    async (src) => {
      const fetchImpl = respond(PNG_BYTES, { headers: { 'content-type': 'image/png' } });
      expect(await loadOgBackground(src, fetchImpl)).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('falls back on a non-2xx response', async () => {
    const fetchImpl = respond(null, { status: 404 });
    expect(await loadOgBackground('https://cdn.example.com/og.png', fetchImpl)).toBeNull();
  });

  it('falls back on a format Satori cannot decode', async () => {
    const fetchImpl = respond(PNG_BYTES, { headers: { 'content-type': 'image/webp' } });
    expect(await loadOgBackground('https://cdn.example.com/og.webp', fetchImpl)).toBeNull();
  });

  it('falls back when the fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await loadOgBackground('https://cdn.example.com/og.png', fetchImpl)).toBeNull();
  });
});

describe('hexToRgba', () => {
  it.each([
    ['#0a0a0a', 0.5, 'rgba(10, 10, 10, 0.5)'],
    ['#FFF', 1, 'rgba(255, 255, 255, 1)'],
    ['264d3b', 0, 'rgba(38, 77, 59, 0)'],
    ['oklch(0.5 0.1 150)', 0.9, 'rgba(0, 0, 0, 0.9)'],
  ])('%s @ %d → %s', (hex, alpha, expected) => {
    expect(hexToRgba(hex, alpha)).toBe(expected);
  });
});
