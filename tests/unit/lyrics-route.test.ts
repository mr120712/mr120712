// @polsia:user-owned — GET /api/music/lyrics: serve una sessione, parametri validati (mai "..",
// public-uploads/ o file non audio), limite per utente, mai in cache, e la STESSA risposta per
// "testo mancante" e "testo non autorizzato" (nessun indizio su cosa esiste nello store).
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  consumeRateLimit: vi.fn(),
  readFeatured: vi.fn(),
  readUpload: vi.fn(),
}));

vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  rateLimitResponse: (_action: string, decision: { status: number; retryAfterSeconds: number }) =>
    Response.json(
      { error: 'rate_limited' },
      {
        status: decision.status,
        headers: {
          'Retry-After': String(decision.retryAfterSeconds),
          'Cache-Control': 'private, no-store',
        },
      },
    ),
}));
vi.mock('@/lib/music/featured-lyrics.server', () => ({ readFeaturedLyrics: mocks.readFeatured }));
vi.mock('@/lib/music/public-uploads.server', () => ({
  readPublishedUploadLyrics: mocks.readUpload,
}));
vi.mock('@/lib/env', () => ({ env: { BLOB_READ_WRITE_TOKEN: 'tok_test' } }));

import { GET } from '@/app/api/music/lyrics/route';

const UPLOAD_ID = 'c'.repeat(25);
const LYRICS = {
  kind: 'synced' as const,
  lines: [{ timeMs: 1000, text: 'Ciao' }],
  source: 'featured' as const,
  credit: 'Testo: Autrice',
};

function request(query: string) {
  return new Request(`https://solco.example/api/music/lyrics${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.readFeatured.mockResolvedValue(null);
  mocks.readUpload.mockResolvedValue(null);
});

describe('GET /api/music/lyrics', () => {
  it('senza sessione: 401, nessuna lettura', async () => {
    mocks.requireAuth.mockRejectedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const res = await GET(request(`?featured=${encodeURIComponent('A - B.mp3')}`));
    expect(res.status).toBe(401);
    expect(mocks.readFeatured).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('brano in evidenza autorizzato: testo, private no-store, limite per utente', async () => {
    mocks.readFeatured.mockResolvedValue(LYRICS);
    const res = await GET(request(`?featured=${encodeURIComponent('Pop/A - B.mp3')}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ lyrics: LYRICS });
    expect(mocks.readFeatured).toHaveBeenCalledWith('Pop/A - B.mp3');
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('music.lyrics', 'user:user-1');
  });

  it('upload pubblicato con testo confermato', async () => {
    const upload = { ...LYRICS, source: 'upload', credit: "Testo pubblicato dall'autore" };
    mocks.readUpload.mockResolvedValue(upload);
    const res = await GET(request(`?upload=${UPLOAD_ID}`));
    expect(await res.json()).toEqual({ lyrics: upload });
    expect(mocks.readUpload).toHaveBeenCalledWith(UPLOAD_ID);
  });

  it('mancante e non autorizzato: risposta identica (200, { lyrics: null }, stessi header)', async () => {
    // I lettori restituiscono null in entrambi i casi: la route non può distinguerli.
    const missing = await GET(request(`?featured=${encodeURIComponent('Non esiste.mp3')}`));
    const notCleared = await GET(request(`?featured=${encodeURIComponent('Senza testo.mp3')}`));
    expect(missing.status).toBe(200);
    expect(notCleared.status).toBe(200);
    expect(await missing.text()).toBe(await notCleared.text());
    expect([...missing.headers.entries()].sort()).toEqual([...notCleared.headers.entries()].sort());
    const upload = await GET(request(`?upload=${UPLOAD_ID}`));
    expect(await upload.json()).toEqual({ lyrics: null });
  });

  it.each([
    ['nessun parametro', ''],
    ['due parametri', `?featured=a.mp3&upload=${UPLOAD_ID}`],
    ['parametro ripetuto', '?featured=a.mp3&featured=b.mp3'],
    ['risalita', `?featured=${encodeURIComponent('x/../public-uploads/a.mp3')}`],
    ['upload degli utenti', `?featured=${encodeURIComponent('public-uploads/a.mp3')}`],
    ['non audio', `?featured=${encodeURIComponent('diritti.json')}`],
    ['file di testo', `?featured=${encodeURIComponent('A - B.lrc')}`],
    ['percorso assoluto', `?featured=${encodeURIComponent('/a.mp3')}`],
    ['barra rovesciata', `?featured=${encodeURIComponent('a\\b.mp3')}`],
    ['id upload non valido', '?upload=ABC'],
    ['id upload con risalita', `?upload=${encodeURIComponent('../x')}`],
  ])('%s: 400, nessuna lettura e nessun consumo del limite', async (_name, query) => {
    const res = await GET(request(query));
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.readFeatured).not.toHaveBeenCalled();
    expect(mocks.readUpload).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('oltre il limite: 429 con Retry-After, nessuna lettura', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 30,
      error: 'rate_limited',
      message: 'x',
    });
    const res = await GET(request(`?upload=${UPLOAD_ID}`));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(mocks.readUpload).not.toHaveBeenCalled();
  });

  it('database non disponibile: 503 senza dettagli', async () => {
    mocks.readUpload.mockRejectedValue(new Error('db giù'));
    const res = await GET(request(`?upload=${UPLOAD_ID}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'lyrics_unavailable' });
  });

  it('una forma inattesa dal lettore non arriva al client', async () => {
    mocks.readFeatured.mockResolvedValue({ ...LYRICS, lines: [] });
    const res = await GET(request(`?featured=${encodeURIComponent('A.mp3')}`));
    expect(await res.json()).toEqual({ lyrics: null });
  });
});
