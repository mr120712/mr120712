// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { followAudiusStreamRedirects } from '@/lib/music/audius-api.server';

const headers = new Headers({ Accept: 'audio/*' });

function redirect(location: string | null): Response {
  const h = new Headers();
  if (location) h.set('location', location);
  return new Response(null, { status: 302, headers: h });
}

function audio(status = 200): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status,
    headers: { 'content-type': 'audio/mpeg' },
  });
}

describe('followAudiusStreamRedirects', () => {
  it('restituisce subito una risposta non-3xx', async () => {
    const fetcher = vi.fn();
    const out = await followAudiusStreamRedirects(
      audio(206),
      'https://dn.audius.co/stream',
      headers,
      fetcher as unknown as typeof fetch,
    );
    expect(out.status).toBe(206);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('segue un redirect verso un host pubblico (IP) e torna la risposta finale', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      audio(200),
    );
    const out = await followAudiusStreamRedirects(
      redirect('https://8.8.8.8/content/track.mp3'),
      'https://dn.audius.co/stream',
      headers,
      fetcher as unknown as typeof fetch,
    );
    expect(out.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const calledUrl = fetcher.mock.calls[0]?.[0];
    expect(calledUrl).toBe('https://8.8.8.8/content/track.mp3');
  });

  it('blocca un redirect verso un indirizzo privato (502, niente fetch)', async () => {
    const fetcher = vi.fn();
    const out = await followAudiusStreamRedirects(
      redirect('https://127.0.0.1/evil'),
      'https://dn.audius.co/stream',
      headers,
      fetcher as unknown as typeof fetch,
    );
    expect(out.status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocca un redirect verso localhost', async () => {
    const fetcher = vi.fn();
    const out = await followAudiusStreamRedirects(
      redirect('https://localhost/evil'),
      'https://dn.audius.co/stream',
      headers,
      fetcher as unknown as typeof fetch,
    );
    expect(out.status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('un 3xx senza Location torna così com’è (il chiamante lo tratta come non-ok)', async () => {
    const fetcher = vi.fn();
    const out = await followAudiusStreamRedirects(
      redirect(null),
      'https://dn.audius.co/stream',
      headers,
      fetcher as unknown as typeof fetch,
    );
    expect(out.status).toBe(302);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('un http redirect viene promosso a https prima del controllo', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      audio(200),
    );
    await followAudiusStreamRedirects(
      redirect('http://8.8.8.8/content/track.mp3'),
      'https://dn.audius.co/stream',
      headers,
      fetcher as unknown as typeof fetch,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://8.8.8.8/content/track.mp3');
  });
});
