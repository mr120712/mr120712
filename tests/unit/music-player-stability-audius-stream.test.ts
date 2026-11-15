// @polsia:user-owned
// @vitest-environment node
// Regressione: il proxy dello stream Audius limitava a 30 s l'INTERA richiesta (AbortSignal.timeout
// interrompe anche il corpo), quindi ogni brano veniva tagliato a metà 30 s dopo l'inizio della
// risposta. Il limite deve valere solo fino all'arrivo degli header.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  clearAudiusMetadataCacheForTests,
  createAudiusApiClient,
  followAudiusStreamRedirects,
} from '@/lib/music/audius-api.server';

const headers = new Headers({ Accept: 'audio/*' });

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function audio(status = 200): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status,
    headers: { 'content-type': 'audio/mpeg' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stream Audius: limite di tempo solo sugli header', () => {
  it('dopo un redirect, il corpo dello stream non viene interrotto dopo 30 s', async () => {
    // AbortSignal.timeout interrompe anche il corpo della risposta: non va usato per lo stream.
    const lifetimeTimeout = vi.spyOn(AbortSignal, 'timeout');
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return audio(206);
    });
    const response = await followAudiusStreamRedirects(
      redirect('https://8.8.8.8/content/track.mp3'),
      'https://dn.audius.co/stream',
      headers,
      fetcher as unknown as typeof fetch,
    );
    expect(response.status).toBe(206);
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(signal?.aborted).toBe(false);
    expect(lifetimeTimeout).not.toHaveBeenCalled();
  });

  it('se gli header non arrivano entro 30 s la richiesta si interrompe comunque', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const outcome = followAudiusStreamRedirects(
      redirect('https://8.8.8.8/content/track.mp3'),
      'https://dn.audius.co/stream',
      headers,
      fetcher as unknown as typeof fetch,
    ).then(
      () => 'risposta',
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(outcome).resolves.toBe('TimeoutError');
  });

  it('streamTrack: lo stream già risposto resta aperto oltre i 30 s', async () => {
    clearAudiusMetadataCacheForTests();
    const lifetimeTimeout = vi.spyOn(AbortSignal, 'timeout');
    vi.useFakeTimers();
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      signals.push(init?.signal);
      return audio(200);
    });
    const client = createAudiusApiClient({
      apiKey: 'stream-test-key',
      fetcher,
      reserve: async () => ({ allowed: true, notBefore: 0 }),
      wait: async () => undefined,
      hostResolver: async () => ['https://stream.audius.co'],
      now: () => 0,
    });
    const response = await client.streamTrack('track-71', 'bytes=393216-');
    expect(response.status).toBe(200);
    expect(signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(signals[0]?.aborted).toBe(false);
    expect(lifetimeTimeout).not.toHaveBeenCalled();
  });
});
