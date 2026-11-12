// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { OFFLINE_DOWNLOAD_META_HEADER } from '@/lib/contracts/offline';
import { AudiusApiError } from '@/lib/music/audius-api.server';
import {
  downloadAudiusAudio,
  fetchBoundedAudio,
  offlineDownloadError,
  offlineDownloadResponse,
  readBoundedBody,
  resolveAudiusDownload,
  resolveDownloadMime,
} from '@/lib/music/offline-download.server';

function audioResponse(bytes: number[], contentType = 'audio/mpeg', status = 200) {
  return new Response(new Uint8Array(bytes), { status, headers: { 'content-type': contentType } });
}

// Un host che risolve a un indirizzo pubblico (nessun DNS reale nei test).
const publicResolve = async () => ['93.184.216.34'];

describe('readBoundedBody', () => {
  it('legge tutti i byte entro il tetto', async () => {
    const body = await readBoundedBody(audioResponse([1, 2, 3, 4]), 10);
    expect(body).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('interrompe e segnala too_large oltre il tetto', async () => {
    expect(await readBoundedBody(audioResponse([1, 2, 3]), 2)).toBe('too_large');
  });

  it('segnala error su corpo vuoto o assente', async () => {
    expect(await readBoundedBody(audioResponse([]), 10)).toBe('error');
    expect(await readBoundedBody(new Response(null, { status: 200 }), 10)).toBe('error');
  });
});

describe('fetchBoundedAudio (SSRF-safe, limitato)', () => {
  it('rifiuta un host che risolve a un indirizzo privato senza mai chiamare fetch', async () => {
    const fetcher = vi.fn();
    const result = await fetchBoundedAudio('https://cdn.example.com/ep.mp3', {
      fetcher: fetcher as unknown as typeof fetch,
      resolve: async () => ['10.0.0.5'],
    });
    expect(result).toEqual({ ok: false, reason: 'blocked_host' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rifiuta gli URL non HTTPS (protezione SSRF)', async () => {
    const result = await fetchBoundedAudio('http://cdn.example.com/ep.mp3', {
      resolve: publicResolve,
      fetcher: vi.fn() as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: 'blocked_host' });
  });

  it('scarica l’audio da un host pubblico entro il tetto', async () => {
    const fetcher = vi.fn(async () => audioResponse([1, 2, 3, 4, 5]));
    const result = await fetchBoundedAudio('https://cdn.example.com/ep.mp3', {
      fetcher: fetcher as unknown as typeof fetch,
      resolve: publicResolve,
    });
    expect(result).toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      contentType: 'audio/mpeg',
    });
  });

  it('rifiuta un file più grande del tetto', async () => {
    const fetcher = vi.fn(async () => audioResponse([1, 2, 3, 4]));
    const result = await fetchBoundedAudio('https://cdn.example.com/ep.mp3', {
      maxBytes: 2,
      fetcher: fetcher as unknown as typeof fetch,
      resolve: publicResolve,
    });
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rifiuta un contenuto che non è audio', async () => {
    const fetcher = vi.fn(async () => audioResponse([1], 'text/html'));
    const result = await fetchBoundedAudio('https://cdn.example.com/ep', {
      fetcher: fetcher as unknown as typeof fetch,
      resolve: publicResolve,
    });
    expect(result).toEqual({ ok: false, reason: 'not_audio' });
  });

  it('segue i reindirizzamenti (http→https) con la stessa protezione a ogni salto', async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: URL | string) => {
      const url = input.toString();
      seen.push(url);
      if (url === 'https://redir.example.com/ep.mp3') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://cdn.example.com/final.mp3' },
        });
      }
      return audioResponse([9, 9]);
    });
    const result = await fetchBoundedAudio('https://redir.example.com/ep.mp3', {
      fetcher: fetcher as unknown as typeof fetch,
      resolve: publicResolve,
    });
    expect(result).toEqual({ ok: true, bytes: new Uint8Array([9, 9]), contentType: 'audio/mpeg' });
    expect(seen).toEqual(['https://redir.example.com/ep.mp3', 'https://cdn.example.com/final.mp3']);
  });
});

describe('resolveDownloadMime', () => {
  it('usa il content-type audio concreto', () => {
    expect(resolveDownloadMime('audio/mp4; codecs=mp4a', 'https://x/y.m4a')).toBe('audio/mp4');
  });
  it('ricade sull’estensione dell’URL quando il tipo è generico', () => {
    expect(resolveDownloadMime('application/octet-stream', 'https://x/y.m4a')).toBe('audio/mp4');
    expect(resolveDownloadMime(null, 'https://x/y.flac')).toBe('audio/flac');
  });
  it('ripiega su audio/mpeg quando non sa decidere', () => {
    expect(resolveDownloadMime(null, 'https://x/senza-estensione')).toBe('audio/mpeg');
  });
});

// --- Audius: risoluzione e byte -------------------------------------------------------------

const PLAYABLE_AUDIUS = {
  id: 'trk-1',
  title: 'Brano aperto',
  permalink: '/artista/brano-aperto',
  user: { id: 'usr-1', handle: 'artista', name: 'Artista' },
  artwork: { '480x480': 'https://audius.co/cover.jpg' },
  is_available: true,
  is_streamable: true,
  license: null,
  is_stream_gated: false,
  access: { stream: true },
  access_authorities: null,
  is_downloadable: true,
  duration: 200,
};

function fakeClient(overrides: Record<string, unknown> = {}, stream?: () => Promise<Response>) {
  return {
    getTrack: vi.fn(async () => ({ data: { ...PLAYABLE_AUDIUS, ...overrides } })),
    streamTrack: vi.fn(stream ?? (async () => audioResponse([1, 2, 3]))),
  };
}

describe('resolveAudiusDownload', () => {
  it('consente un brano riproducibile e scaricabile, con attribuzione completa', async () => {
    const resolution = await resolveAudiusDownload('trk-1', fakeClient());
    expect(resolution).toEqual({
      ok: true,
      title: 'Brano aperto',
      artist: 'Artista',
      sourceUrl: 'https://audius.co/artista/brano-aperto',
      durationSeconds: 200,
      attribution: {
        sourceName: 'Audius',
        sourceUrl: 'https://audius.co/artista/brano-aperto',
        licenseName: 'Audius Open Music License',
        licenseUrl: 'https://openaudiofoundation.org/open-music-license.pdf',
        creditLine: '© Artista',
      },
    });
  });

  it('nega un brano non reso scaricabile dall’artista', async () => {
    const resolution = await resolveAudiusDownload('trk-1', fakeClient({ is_downloadable: false }));
    expect(resolution).toEqual({ ok: false, reason: 'not_downloadable' });
  });

  it('nega un brano con licenza non aperta (prima del download)', async () => {
    const resolution = await resolveAudiusDownload(
      'trk-1',
      fakeClient({ license: 'All rights reserved' }),
    );
    expect(resolution).toEqual({ ok: false, reason: 'license_not_allowed' });
  });

  it('propaga il limite di richieste Audius', async () => {
    const client = {
      getTrack: vi.fn(async () => {
        throw new AudiusApiError('rate_limited', 'limite', 42);
      }),
      streamTrack: vi.fn(),
    };
    expect(await resolveAudiusDownload('trk-1', client)).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 42,
    });
  });
});

describe('downloadAudiusAudio', () => {
  it('restituisce i byte audio dal flusso ufficiale', async () => {
    const result = await downloadAudiusAudio('trk-1', fakeClient());
    expect(result).toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
  });

  it('rifiuta un brano più grande del tetto', async () => {
    const result = await downloadAudiusAudio('trk-1', fakeClient(), 1);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rifiuta una risposta che non è audio', async () => {
    const client = fakeClient({}, async () => audioResponse([1], 'text/html'));
    expect(await downloadAudiusAudio('trk-1', client)).toEqual({ ok: false, reason: 'not_audio' });
  });
});

describe('risposte HTTP del download', () => {
  it('restituisce i byte con i metadati validati nell’header', async () => {
    const response = offlineDownloadResponse(new Uint8Array([1, 2, 3]), 'audio/mpeg', {
      source: 'audius-download',
      downloadKey: 'audius:trk-1',
      title: 'Brano aperto',
      artist: 'Artista',
      album: null,
      durationSeconds: 200,
      mimeType: 'audio/mpeg',
      attribution: {
        sourceName: 'Audius',
        sourceUrl: 'https://audius.co/artista/brano-aperto',
        licenseName: 'Audius Open Music License',
        licenseUrl: 'https://openaudiofoundation.org/open-music-license.pdf',
        creditLine: '© Artista',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    const header = response.headers.get(OFFLINE_DOWNLOAD_META_HEADER);
    const meta = JSON.parse(Buffer.from(header ?? '', 'base64').toString('utf8'));
    expect(meta.source).toBe('audius-download');
    expect(meta.downloadKey).toBe('audius:trk-1');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('costruisce un errore JSON privato con Retry-After', async () => {
    const response = offlineDownloadError('rate_limited', 'Troppo veloce.', 429, 30);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      error: 'rate_limited',
      message: 'Troppo veloce.',
      retryAfterSeconds: 30,
    });
  });
});
