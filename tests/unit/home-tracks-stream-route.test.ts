// @polsia:user-owned — proxy di streaming dei brani in evidenza: percorsi ammessi, sessione
// obbligatoria (401), hotlinking e navigazione diretta rifiutati (403), limite per account solo
// sugli avvii (non sui blocchi di seek), limite Free dei brani in evidenza (30 avvii al mese, 402
// oltre, registrato solo con l'audio, conteggio separato dai 40 del catalogo), file privato letto
// con il token e file pubblico dal CDN, Range inoltrato, 404 se il blob manca.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type PlayRow = { userId: string; qualifiedId: string; month: string; createdAt: Date };

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  token: 'tok_test' as string | undefined,
  user: { id: 'u1' } as { id: string } | null,
  premium: false,
  enforceRateLimit: vi.fn(async () => null as Response | null),
  listing: { audio: [] as Array<{ pathname: string; url: string }> },
  // Registro degli ascolti in memoria (funzioni semplici: resetAllMocks non le tocca).
  plays: [] as Array<{ userId: string; qualifiedId: string; month: string; createdAt: Date }>,
  recordFails: false,
}));

// Il route importa `get`; home-tracks.server (per isHomeAudioBlob) importa `list` + env.
vi.mock('@vercel/blob', () => ({ get: mocks.get, list: mocks.list }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: async () => mocks.user }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
}));
vi.mock('@/lib/music/featured-catalog.server', () => ({
  loadFeaturedCatalogState: async () => ({ listing: mocks.listing }),
}));
vi.mock('@/lib/business/premium-access.server', () => ({
  hasPremiumAccess: async () => mocks.premium,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    musicPlay: {
      count: async ({
        where,
      }: {
        where: {
          userId: string;
          month: string;
          NOT?: Array<{ qualifiedId: { startsWith: string } }>;
          qualifiedId?: { startsWith: string };
        };
      }) =>
        mocks.plays.filter(
          (row) =>
            row.userId === where.userId &&
            row.month === where.month &&
            (!where.qualifiedId || row.qualifiedId.startsWith(where.qualifiedId.startsWith)) &&
            !(where.NOT ?? []).some((rule) =>
              row.qualifiedId.startsWith(rule.qualifiedId.startsWith),
            ),
        ).length,
      findFirst: async ({
        where,
      }: {
        where: { userId: string; qualifiedId: string; createdAt: { gt: Date } };
      }) =>
        mocks.plays.find(
          (row) =>
            row.userId === where.userId &&
            row.qualifiedId === where.qualifiedId &&
            row.createdAt > where.createdAt.gt,
        ) ?? null,
      create: async ({ data }: { data: PlayRow }) => {
        mocks.plays.push(data);
        return data;
      },
    },
    $transaction(run: (transaction: unknown) => Promise<unknown>) {
      if (mocks.recordFails) {
        throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), {
          code: 'P2034',
        });
      }
      return run(this);
    },
  },
}));

import { GET } from '@/app/api/music/home-tracks/stream/route';
import {
  FEATURED_FREE_MONTHLY_PLAYS,
  FREE_MONTHLY_PLAYS,
  REPLAY_WINDOW_MS,
  romeMonth,
} from '@/lib/business/play-quota';

const PLAYER = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-dest': 'audio',
  'sec-fetch-mode': 'no-cors',
};

function req(pathname: string | null, headers: Record<string, string> = PLAYER) {
  const url = pathname
    ? `https://solco.example/api/music/home-tracks/stream?p=${encodeURIComponent(pathname)}`
    : 'https://solco.example/api/music/home-tracks/stream';
  return new Request(url, { headers });
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
  mocks.user = { id: 'u1' };
  mocks.premium = false;
  mocks.listing = { audio: [] };
  mocks.plays.length = 0;
  mocks.recordFails = false;
  mocks.enforceRateLimit.mockResolvedValue(null);
});

/** Una riga del registro di u1, fuori dalla finestra di riascolto se non indicato altrimenti. */
function playRow(qualifiedId: string, ageMs = 2 * REPLAY_WINDOW_MS): PlayRow {
  return {
    userId: 'u1',
    qualifiedId,
    month: romeMonth(new Date()),
    createdAt: new Date(Date.now() - ageMs),
  };
}

const featuredRows = () => mocks.plays.filter((row) => row.qualifiedId.startsWith('upload:'));

describe('GET /api/music/home-tracks/stream: percorsi', () => {
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
    expect((await GET(req('a.mp3'))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('GET /api/music/home-tracks/stream: accesso', () => {
  it('401 senza sessione, niente lettura dallo store', async () => {
    mocks.user = null;
    const response = await GET(req('a.mp3'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('403 per hotlinking da un altro sito e per l’URL aperto in una scheda', async () => {
    const crossSite = await GET(
      req('a.mp3', { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'audio' }),
    );
    expect(crossSite.status).toBe(403);
    const navigation = await GET(
      req('a.mp3', {
        'sec-fetch-site': 'none',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
      }),
    );
    expect(navigation.status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('un browser senza intestazioni Sec-Fetch passa (resta la sessione a decidere)', async () => {
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    expect((await GET(req('a.mp3', {}))).status).toBe(200);
  });

  it('il limite per account conta gli avvii, non i blocchi del Range', async () => {
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    await GET(req('a.mp3'));
    await GET(req('a.mp3', { ...PLAYER, range: 'bytes=0-1' }));
    await GET(req('a.mp3', { ...PLAYER, range: 'bytes=1000-' }));
    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.featured.stream', 'user:u1');
  });

  it('oltre il limite: la risposta 429 del limite, mai in cache', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      new Response('{"error":"rate_limited"}', { status: 429, headers: { 'Retry-After': '30' } }),
    );
    const response = await GET(req('a.mp3'));
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('GET /api/music/home-tracks/stream: lettura', () => {
  it('file privato: 200 e trasmette lo stream con content-type e accept-ranges', async () => {
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    const response = await GET(req('Rock/mia canzone.m4a'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mp4');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('3');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(mocks.get).toHaveBeenCalledWith(
      'Rock/mia%20canzone.m4a',
      expect.objectContaining({ access: 'private', token: 'tok_test' }),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('file privato: 206 e inoltra il Range (seek)', async () => {
    mocks.get.mockResolvedValue(
      okStream({ 'content-length': '2', 'content-range': 'bytes 1-2/3' }),
    );
    const response = await GET(req('a.mp3', { ...PLAYER, range: 'bytes=1-2' }));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-2/3');
    expect(mocks.get).toHaveBeenCalledWith(
      'a.mp3',
      expect.objectContaining({ headers: { range: 'bytes=1-2' } }),
    );
  });

  it('file PUBBLICO (secondo l’elenco condiviso): dal CDN, con lo stesso Range, senza token', async () => {
    mocks.listing = {
      audio: [{ pathname: 'a.mp3', url: 'https://store.public.blob.vercel-storage.com/a.mp3' }],
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([9, 9]), {
          status: 206,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': '2',
            'content-range': 'bytes 0-1/3',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await GET(req('a.mp3', { ...PLAYER, range: 'bytes=0-1' }));
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-1/3');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://store.public.blob.vercel-storage.com/a.mp3',
        expect.objectContaining({ headers: { range: 'bytes=0-1' }, redirect: 'error' }),
      );
      expect(mocks.get).not.toHaveBeenCalled();
      // L'avvio (Range dal primo byte) si registra dopo la risposta del CDN, con l'id del player.
      expect(mocks.plays.map((row) => row.qualifiedId)).toEqual(['upload:a.mp3']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('404 se get() non trova il blob o va in errore, e nessun ascolto registrato', async () => {
    mocks.get.mockResolvedValue(null);
    expect((await GET(req('a.mp3'))).status).toBe(404);
    mocks.get.mockRejectedValue(new Error('rete'));
    expect((await GET(req('a.mp3'))).status).toBe(404);
    expect(mocks.plays).toHaveLength(0);
  });
});

describe('GET /api/music/home-tracks/stream: limite Free dei brani in evidenza (30 avvii al mese)', () => {
  it('l’audio parte: un ascolto registrato con l’id del player; seek e ripresa entro 30 minuti non contano', async () => {
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    expect((await GET(req('Rock/mia canzone.m4a'))).status).toBe(200);
    expect(mocks.plays).toEqual([
      expect.objectContaining({
        userId: 'u1',
        qualifiedId: 'upload:Rock/mia canzone.m4a',
        month: romeMonth(new Date()),
      }),
    ]);
    // Seek (Range da metà), nuovo avvio di Safari (bytes=0-1) e ripresa: sempre un solo ascolto.
    mocks.get.mockResolvedValue(
      okStream({ 'content-length': '2', 'content-range': 'bytes 1-2/3' }),
    );
    expect((await GET(req('Rock/mia canzone.m4a', { ...PLAYER, range: 'bytes=1-2' }))).status).toBe(
      206,
    );
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    expect((await GET(req('Rock/mia canzone.m4a', { ...PLAYER, range: 'bytes=0-1' }))).status).toBe(
      200,
    );
    expect((await GET(req('Rock/mia canzone.m4a'))).status).toBe(200);
    expect(mocks.plays).toHaveLength(1);
    // Un altro brano in evidenza è un nuovo ascolto.
    expect((await GET(req('a.mp3'))).status).toBe(200);
    expect(featuredRows().map((row) => row.qualifiedId)).toEqual([
      'upload:Rock/mia canzone.m4a',
      'upload:a.mp3',
    ]);
  });

  it('31° brano in evidenza del mese: 402 monthly_limit con il tetto di 30, nessuna lettura dallo store', async () => {
    for (let i = 0; i < FEATURED_FREE_MONTHLY_PLAYS; i += 1) {
      mocks.plays.push(playRow(`upload:Pop/brano-${i}.mp3`));
    }
    const blocked = await GET(req('a.mp3'));
    expect(blocked.status).toBe(402);
    expect(blocked.headers.get('cache-control')).toBe('private, no-store');
    expect(await blocked.json()).toEqual({
      allowed: false,
      reason: 'monthly_limit',
      used: FEATURED_FREE_MONTHLY_PLAYS,
      limit: FEATURED_FREE_MONTHLY_PLAYS,
    });
    expect(mocks.get).not.toHaveBeenCalled();
    // Anche saltando il primo byte (nessun avvio per il limite di richieste) il tetto resta.
    expect((await GET(req('a.mp3', { ...PLAYER, range: 'bytes=1-' }))).status).toBe(402);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(FEATURED_FREE_MONTHLY_PLAYS);

    // Riprendere uno dei 30 partito pochi minuti fa: ammesso e non contato.
    mocks.plays.push(playRow('upload:Pop/brano-0.mp3', 5 * 60_000));
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    expect((await GET(req('Pop/brano-0.mp3'))).status).toBe(200);
    expect(mocks.plays).toHaveLength(FEATURED_FREE_MONTHLY_PLAYS + 1);
  });

  it('i 40 ascolti del catalogo non fermano i brani in evidenza (conteggi separati)', async () => {
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) mocks.plays.push(playRow(`audius:t${i}`));
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    expect((await GET(req('a.mp3'))).status).toBe(200);
    expect(featuredRows().map((row) => row.qualifiedId)).toEqual(['upload:a.mp3']);
  });

  it('Premium: nessun limite e nessuna riga registrata', async () => {
    mocks.premium = true;
    for (let i = 0; i < FEATURED_FREE_MONTHLY_PLAYS; i += 1) {
      mocks.plays.push(playRow(`upload:Pop/brano-${i}.mp3`));
    }
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    expect((await GET(req('a.mp3'))).status).toBe(200);
    expect(mocks.plays).toHaveLength(FEATURED_FREE_MONTHLY_PLAYS);
  });

  it('registro degli ascolti non disponibile: 503 senza audio, stream dello store chiuso, nessuna riga', async () => {
    mocks.recordFails = true;
    const cancel = vi.fn(async () => undefined);
    mocks.get.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream({ cancel }),
      headers: new Headers({ 'content-length': '3' }),
      blob: { contentType: 'audio/mp4', size: 3 },
    });
    const response = await GET(req('a.mp3'));
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).not.toMatch(/^audio\//);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: 'stream_unavailable' });
    expect(cancel).toHaveBeenCalled();
    expect(mocks.plays).toHaveLength(0);
  });
});
