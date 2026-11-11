// @polsia:user-owned — verifica dell'audio ufficiale prima di contare un ascolto reindirizzato.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { mayBeAudioContentType, probeAudioUrl } from '@/lib/music/audio-probe.server';

const publicDns = async () => ['93.184.216.34'];

function answer(status: number, headers: Record<string, string> = {}, body = true) {
  const cancel = vi.fn();
  const stream = body
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([0xff, 0xfb]));
        },
        cancel,
      })
    : null;
  return { response: new Response(stream, { status, headers }), cancel };
}

describe('verifica dell’audio prima del redirect', () => {
  it('accetta 200/206 con un corpo audio e chiude subito la connessione', async () => {
    const partial = answer(206, { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-1/99' });
    const fetcher = vi.fn<typeof fetch>(async () => partial.response);

    expect(
      await probeAudioUrl('https://cdn.example.com/episode.mp3', { fetcher, resolve: publicDns }),
    ).toBe(true);
    const init = fetcher.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('range')).toBe('bytes=0-1');
    expect(init?.redirect).toBe('manual');
    expect(partial.cancel).toHaveBeenCalled();
  });

  it('apre uno stream dal vivo senza Range', async () => {
    const live = answer(200, { 'content-type': 'audio/aacp' });
    const fetcher = vi.fn<typeof fetch>(async () => live.response);

    expect(
      await probeAudioUrl('https://radio.example.com/live', {
        live: true,
        fetcher,
        resolve: publicDns,
      }),
    ).toBe(true);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('range')).toBeNull();
    expect(live.cancel).toHaveBeenCalled();
  });

  it('accetta i file serviti come octet-stream (default S3 dei podcast self-hosted)', async () => {
    for (const type of ['application/octet-stream', 'binary/octet-stream', 'video/mp4']) {
      const file = answer(206, { 'content-type': type });
      const fetcher = vi.fn<typeof fetch>(async () => file.response);
      expect(
        await probeAudioUrl('https://bucket.s3.amazonaws.com/ep.mp3', {
          fetcher,
          resolve: publicDns,
        }),
      ).toBe(true);
      expect(file.cancel).toHaveBeenCalled();
    }
  });

  it('rifiuta errori, risposte non audio, playlist e corpi vuoti', async () => {
    for (const response of [
      answer(404, { 'content-type': 'audio/mpeg' }).response,
      answer(503, { 'content-type': 'audio/mpeg' }).response,
      answer(200, { 'content-type': 'text/html' }).response,
      answer(200, { 'content-type': 'application/json' }).response,
      answer(200, { 'content-type': 'application/rss+xml' }).response,
      answer(200, { 'content-type': 'image/jpeg' }).response,
      answer(200, { 'content-type': 'audio/x-mpegurl' }).response,
      answer(200, { 'content-type': 'application/vnd.apple.mpegurl' }).response,
      answer(204, { 'content-type': 'audio/mpeg' }, false).response,
      answer(200, { 'content-type': 'audio/mpeg' }, false).response,
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => response);
      expect(
        await probeAudioUrl('https://cdn.example.com/a.mp3', { fetcher, resolve: publicDns }),
      ).toBe(false);
    }
    const failing = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    expect(
      await probeAudioUrl('https://cdn.example.com/a.mp3', {
        fetcher: failing,
        resolve: publicDns,
      }),
    ).toBe(false);
  });

  it('segue i redirect solo verso host HTTPS pubblici', async () => {
    const hop = (location: string) => new Response(null, { status: 302, headers: { location } });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(hop('https://dts.podtrac.com/redirect.mp3/cdn.example.com/a.mp3'))
      .mockResolvedValueOnce(hop('/a.mp3'))
      .mockResolvedValueOnce(answer(206, { 'content-type': 'audio/mpeg' }).response);
    expect(
      await probeAudioUrl('https://feeds.example.com/a.mp3', { fetcher, resolve: publicDns }),
    ).toBe(true);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://feeds.example.com/a.mp3',
      'https://dts.podtrac.com/redirect.mp3/cdn.example.com/a.mp3',
      'https://dts.podtrac.com/a.mp3',
    ]);

    // A plain-HTTP hop is upgraded to HTTPS, as browsers do for media.
    const upgraded = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(hop('http://cdn.example.com/a.mp3'))
      .mockResolvedValueOnce(answer(206, { 'content-type': 'audio/mpeg' }).response);
    expect(
      await probeAudioUrl('https://feeds.example.com/a.mp3', {
        fetcher: upgraded,
        resolve: publicDns,
      }),
    ).toBe(true);
    expect(String(upgraded.mock.calls[1]?.[0])).toBe('https://cdn.example.com/a.mp3');

    // Redirect to a private address (upgraded or not): refused before the request.
    for (const location of ['http://internal.example.com/a', 'https://internal.example.com/a']) {
      const guarded = vi.fn<typeof fetch>().mockResolvedValueOnce(hop(location));
      const resolve = async (host: string) =>
        host === 'internal.example.com' ? ['10.0.0.7'] : ['93.184.216.34'];
      expect(
        await probeAudioUrl('https://feeds.example.com/a.mp3', { fetcher: guarded, resolve }),
      ).toBe(false);
      expect(guarded).toHaveBeenCalledTimes(1);
    }

    // Endless redirects: gives up.
    const loop = vi.fn<typeof fetch>(async () => hop('https://feeds.example.com/again.mp3'));
    expect(
      await probeAudioUrl('https://feeds.example.com/a.mp3', { fetcher: loop, resolve: publicDns }),
    ).toBe(false);
    expect(loop.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('segue una catena di 6 redirect di analytics podcast fino al file', async () => {
    const chain = [
      'https://op3.dev/e/a.mp3',
      'https://dts.podtrac.com/redirect.mp3/a.mp3',
      'https://chrt.fm/track/a.mp3',
      'https://pdst.fm/e/a.mp3',
      'https://traffic.megaphone.fm/a.mp3',
      'https://dcs.megaphone.fm/a.mp3',
    ];
    const fetcher = vi.fn<typeof fetch>();
    for (const location of chain) {
      fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
    }
    fetcher.mockResolvedValueOnce(answer(206, { 'content-type': 'audio/mpeg' }).response);

    expect(
      await probeAudioUrl('https://feeds.example.com/a.mp3', { fetcher, resolve: publicDns }),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(String(fetcher.mock.calls[6]?.[0])).toBe('https://dcs.megaphone.fm/a.mp3');
  });

  it('non contatta indirizzi privati', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await probeAudioUrl('https://127.0.0.1/a.mp3', { fetcher })).toBe(false);
    expect(await probeAudioUrl('https://localhost/a.mp3', { fetcher })).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('scarta solo i tipi chiaramente non audio', () => {
    expect(mayBeAudioContentType('audio/mpeg; charset=binary')).toBe(true);
    expect(mayBeAudioContentType('application/ogg')).toBe(true);
    expect(mayBeAudioContentType('application/octet-stream')).toBe(true);
    expect(mayBeAudioContentType('binary/octet-stream')).toBe(true);
    expect(mayBeAudioContentType(null)).toBe(true);
    expect(mayBeAudioContentType('audio/x-scpls')).toBe(false);
    expect(mayBeAudioContentType('text/plain')).toBe(false);
    expect(mayBeAudioContentType('text/html; charset=utf-8')).toBe(false);
    expect(mayBeAudioContentType('application/xhtml+xml')).toBe(false);
    expect(mayBeAudioContentType('application/problem+json')).toBe(false);
  });
});
