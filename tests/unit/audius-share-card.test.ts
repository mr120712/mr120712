// @polsia:user-owned — dati della scheda di un brano Audius condiviso: solo da Audius e solo per
// brani ascoltabili su Solco, testo senza indirizzi web, cache in memoria (1 ora / 5 minuti), un
// limite per IP e un tetto giornaliero dell'intera app consumati solo a cache vuota, e nessuna
// lettura (né ricordo del rifiuto) se uno dei due è pieno o il limitatore non risponde.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  getTrack: vi.fn(),
  createClient: vi.fn(),
  activation: { active: true, apiKey: 'chiave-di-prova', blockers: [] as string[] },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusActivation: () => mocks.activation,
}));
vi.mock('@/lib/music/audius-api.server', () => ({
  createAudiusApiClient: mocks.createClient,
  reserveAudiusRequestSlot: vi.fn(),
}));

import {
  clearAudiusShareCardCacheForTests,
  getAudiusShareCard,
} from '@/lib/music/audius-share-card.server';

const CID = 'baeaaaiqsec3v4qj7c6afbm4jcuij6qqq4ycn5plde7u6lhldnierwopply35m';
const NODE = 'https://audius-01.staked.cloud';

function audiusTrackPayload(
  id: string,
  title = 'Luci basse',
  artist = 'Artista Audius',
  extra: Record<string, unknown> = {},
) {
  return {
    data: {
      id,
      title,
      permalink: `/artista/${id}`,
      duration: 201,
      is_available: true,
      is_streamable: true,
      is_stream_gated: false,
      access: { stream: true, download: false },
      access_authorities: [],
      license: null,
      artwork: {
        '150x150': `${NODE}/content/${CID}/150x150.jpg`,
        '480x480': `${NODE}/content/${CID}/480x480.jpg`,
        '1000x1000': `${NODE}/content/${CID}/1000x1000.jpg`,
      },
      user: { id: 'u1', handle: 'artista', name: artist },
      ...extra,
    },
  };
}

beforeEach(() => {
  clearAudiusShareCardCacheForTests();
  mocks.activation = { active: true, apiKey: 'chiave-di-prova', blockers: [] };
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.getTrack.mockReset().mockImplementation(async (id: string) => audiusTrackPayload(id));
  mocks.createClient.mockReset().mockImplementation(() => ({ getTrack: mocks.getTrack }));
});

describe('scheda di un brano Audius condiviso', () => {
  it('titolo, artista e copertina arrivano da Audius', async () => {
    expect(await getAudiusShareCard('J7Xb000')).toEqual({
      title: 'Luci basse',
      artist: 'Artista Audius',
      coverUrl: `${NODE}/content/${CID}/480x480.jpg`,
    });
    expect(mocks.getTrack).toHaveBeenCalledWith('J7Xb000');
    expect(mocks.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'chiave-di-prova', fetcher: expect.any(Function) }),
    );
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og.audius.global', 'global');
  });

  it('prima il limite per IP, poi il tetto dell’intera app', async () => {
    await getAudiusShareCard('J7Xb000', { identity: 'ip:203.0.113.7' });
    expect(mocks.consumeRateLimit.mock.calls).toEqual([
      ['share.og.audius', 'ip:203.0.113.7'],
      ['share.og.audius.global', 'global'],
    ]);
    // Senza un IP affidabile: un solo limite condiviso per tutte queste richieste.
    await getAudiusShareCard('Altro1');
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('share.og.audius', 'ip:sconosciuto');
  });

  it('IP oltre il suo limite: nessuna lettura, tetto globale intatto, rifiuto non ricordato', async () => {
    mocks.consumeRateLimit.mockImplementation(async (action: string, identity: string) =>
      action === 'share.og.audius' && identity === 'ip:198.51.100.9'
        ? { allowed: false, status: 429, retryAfterSeconds: 60, error: 'rate_limited', message: '' }
        : { allowed: true },
    );
    expect(await getAudiusShareCard('J7Xb000', { identity: 'ip:198.51.100.9' })).toBeNull();
    expect(mocks.getTrack).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalledWith('share.og.audius.global', 'global');
    // Un altro indirizzo ottiene subito la scheda: il rifiuto del primo non è in cache.
    expect(await getAudiusShareCard('J7Xb000', { identity: 'ip:203.0.113.7' })).not.toBeNull();
    expect(mocks.getTrack).toHaveBeenCalledTimes(1);
  });

  it('brani che Solco non può far ascoltare: nessuna scheda', async () => {
    const blocked: Array<[string, Record<string, unknown>]> = [
      ['Riservato', { license: 'All rights reserved' }],
      ['NonDisp', { is_available: false }],
      ['Gated', { is_stream_gated: true, access: { stream: false, download: false } }],
      ['NoStream', { is_streamable: false }],
    ];
    for (const [id, extra] of blocked) {
      mocks.getTrack.mockResolvedValueOnce(audiusTrackPayload(id, 'Brano', 'Artista', extra));
      expect(await getAudiusShareCard(id), id).toBeNull();
    }
    expect(mocks.getTrack).toHaveBeenCalledTimes(blocked.length);
  });

  it('indirizzi web nel titolo o nell’artista Audius spariscono dalla scheda', async () => {
    mocks.getTrack.mockResolvedValueOnce(
      audiusTrackPayload(
        'Spam1',
        'Solco chiude: vai su https://evil.example/login',
        'Artista evil.com',
      ),
    );
    expect(await getAudiusShareCard('Spam1')).toMatchObject({
      title: 'Solco chiude: vai su',
      artist: 'Artista',
    });
    // Solo un indirizzo come titolo o come artista: nessuna scheda.
    mocks.getTrack.mockResolvedValueOnce(audiusTrackPayload('Spam2', 'www.evil.example'));
    expect(await getAudiusShareCard('Spam2')).toBeNull();
    mocks.getTrack.mockResolvedValueOnce(
      audiusTrackPayload('Spam3', 'Brano', 'https://evil.example/x'),
    );
    expect(await getAudiusShareCard('Spam3')).toBeNull();
  });

  it('in cache per un’ora: nessuna nuova lettura né consumo dei limiti', async () => {
    const now = Date.now();
    await getAudiusShareCard('J7Xb000', { now });
    await getAudiusShareCard('J7Xb000', { now: now + 59 * 60_000 });
    expect(mocks.getTrack).toHaveBeenCalledTimes(1);
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(2);
    await getAudiusShareCard('J7Xb000', { now: Date.now() + 61 * 60_000 });
    expect(mocks.getTrack).toHaveBeenCalledTimes(2);
  });

  it('richieste contemporanee per lo stesso brano: una sola lettura', async () => {
    const results = await Promise.all([
      getAudiusShareCard('J7Xb000'),
      getAudiusShareCard('J7Xb000'),
      getAudiusShareCard('J7Xb000'),
    ]);
    expect(results.every((card) => card?.title === 'Luci basse')).toBe(true);
    expect(mocks.getTrack).toHaveBeenCalledTimes(1);
  });

  it('errore o brano non trovato: null, ricordato per 5 minuti', async () => {
    mocks.getTrack.mockRejectedValue(new Error('Audius down'));
    const now = Date.now();
    expect(await getAudiusShareCard('Err0r1', { now })).toBeNull();
    expect(await getAudiusShareCard('Err0r1', { now: now + 4 * 60_000 })).toBeNull();
    expect(mocks.getTrack).toHaveBeenCalledTimes(1);
    expect(await getAudiusShareCard('Err0r1', { now: Date.now() + 6 * 60_000 })).toBeNull();
    expect(mocks.getTrack).toHaveBeenCalledTimes(2);

    mocks.getTrack.mockResolvedValue({ data: [] });
    expect(await getAudiusShareCard('Sparito')).toBeNull();
  });

  it('tetto giornaliero pieno o limitatore che non risponde: nessuna lettura Audius', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 3600,
      error: 'rate_limited',
      message: 'troppe',
    });
    expect(await getAudiusShareCard('Pieno1')).toBeNull();
    mocks.consumeRateLimit.mockRejectedValue(new Error('database down'));
    expect(await getAudiusShareCard('Rotto1')).toBeNull();
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 503,
      retryAfterSeconds: 30,
      error: 'rate_limit_unavailable',
      message: 'non disponibile',
    });
    expect(await getAudiusShareCard('Rotto2')).toBeNull();
    expect(mocks.getTrack).not.toHaveBeenCalled();
  });

  it('id non validi o Audius non configurato: nessuna lettura, nessun consumo', async () => {
    for (const id of ['', 'playlist:abc', 'a b', '../x', 'x'.repeat(129)]) {
      expect(await getAudiusShareCard(id)).toBeNull();
    }
    mocks.activation = { active: false, apiKey: '', blockers: ['credential_missing'] };
    expect(await getAudiusShareCard('J7Xb000')).toBeNull();
    expect(mocks.getTrack).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('tiene al massimo ~500 brani in memoria (i più vecchi escono)', async () => {
    for (let index = 0; index < 501; index += 1) await getAudiusShareCard(`id${index}`);
    expect(mocks.getTrack).toHaveBeenCalledTimes(501);
    await getAudiusShareCard('id500');
    expect(mocks.getTrack).toHaveBeenCalledTimes(501);
    await getAudiusShareCard('id0');
    expect(mocks.getTrack).toHaveBeenCalledTimes(502);
  });
});
