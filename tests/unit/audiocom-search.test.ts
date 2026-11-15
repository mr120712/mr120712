// @polsia:user-owned — ricerca su audio.com (audiocom.server): parsing zod di ogni campo (campi
// sconosciuti ammessi, voce anomala scartata da sola), solo categorie musicali, indirizzi solo
// https su audio.com, stream solo per licenze riproducibili, cache per query normalizzata (10 min
// con risultati, 1 min senza), ricerche uguali condivise, quota PERSONALE di chi cerca (solo per le
// richieste che partono davvero, mai in cache) prima del limite GLOBALE (40/min, identità
// 'global'), 429/401/errori/non collegato → stato immediato senza bloccare; gli esiti dei limiti
// non spingono fuori dalla cache i risultati buoni; le cover non hanno mai lo stream. HTTP finto.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  getAccess: vi.fn(),
  markRejected: vi.fn(),
  recordError: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('@/lib/music/audiocom-connection.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/audiocom-connection.server')>()),
  getAudioComAccessToken: mocks.getAccess,
  markAudioComAccessRejected: mocks.markRejected,
  recordAudioComError: mocks.recordError,
}));

import {
  AUDIOCOM_CACHE_MAX,
  AUDIOCOM_SEARCH_URL,
  audioComCacheKey,
  clearAudioComSearchCache,
  parseAudioComSearch,
  searchAudioCom,
} from '@/lib/music/audiocom.server';

const fetchMock = vi.fn<typeof fetch>();
/** Chi cerca (IP d'ingresso affidabile), per la quota personale. */
const WHO = { identity: 'ip:198.51.100.7' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type RawAudio = Record<string, unknown>;

function audio(id: string, overrides: RawAudio = {}): { type: string; model: RawAudio } {
  return {
    type: 'audio',
    model: {
      id,
      title: `Brano ${id}`,
      slug: `brano-${id}`,
      username: 'artista-uno',
      author_name: 'Artista Uno',
      category: 'music',
      license: 'cc-by',
      is_listed: true,
      is_downloadable: false,
      image: `https://s3.audio.com/images/${id}.jpg`,
      play: {
        url: `https://s3.audio.com/audio/${id}.mp3`,
        duration: 183_400,
        waveform: `https://s3.audio.com/audio/${id}.json`,
      },
      tags: ['rock'],
      // Campo che il nostro schema non conosce: ammesso e ignorato.
      future_field: { nested: true },
      ...overrides,
    },
  };
}

/** Chiamate al limite di un'azione ('audiocom.search' personale o 'audiocom.search.global'). */
function limiterCalls(action: string) {
  return mocks.consumeRateLimit.mock.calls.filter((call) => call[0] === action);
}

const DENIED = {
  allowed: false,
  retryAfterSeconds: 20,
  status: 429,
  error: 'rate_limited',
  message: 'limite',
} as const;

beforeEach(() => {
  clearAudioComSearchCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.getAccess.mockReset().mockResolvedValue({ ok: true, token: 'tok-1', version: 7 });
  mocks.markRejected.mockReset().mockResolvedValue(undefined);
  mocks.recordError.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('parsing della risposta', () => {
  it('tiene solo audio musicali validi; stream solo con licenza riproducibile e host audio.com', () => {
    const tracks = parseAudioComSearch([
      audio('1'),
      audio('2', { license: 'arr' }),
      audio('3', { category: 'podcast' }),
      { type: 'author', model: { id: '9', username: 'x' } },
      { type: 'collection', model: { id: '10' } },
      audio('4', { is_listed: false }),
      audio('5', { play: { url: 'http://s3.audio.com/audio/5.mp3', duration: 1000 } }),
      audio('6', { play: { url: 'https://audio.com.evil.example/6.mp3', duration: 1000 } }),
      audio('7', { image: 'https://tracker.example/pixel.gif', category: 'cover' }),
      audio('8', { username: '' }),
      audio('1'), // doppione
      audio('11', { license: 'cc-by-4.0', category: 'beats' }),
      audio('12', { license: 'cc-by-nc' }),
      { type: 'audio', model: { id: { bad: true } } },
      'spazzatura',
    ]);
    expect(tracks?.map((track) => track.id)).toEqual(['1', '2', '5', '6', '7', '11', '12']);
    const byId = Object.fromEntries((tracks ?? []).map((track) => [track.id, track]));
    expect(byId['1']).toEqual({
      id: '1',
      title: 'Brano 1',
      authorName: 'Artista Uno',
      pageUrl: 'https://audio.com/artista-uno/audio/brano-1',
      imageUrl: 'https://s3.audio.com/images/1.jpg',
      streamUrl: 'https://s3.audio.com/audio/1.mp3',
      durationSeconds: 183,
      category: 'music',
      license: 'cc-by',
    });
    // Tutti i diritti riservati: nessuno stream arriva al client.
    expect(byId['2']?.streamUrl).toBeNull();
    // http e host che non è audio.com: niente stream.
    expect(byId['5']?.streamUrl).toBeNull();
    expect(byId['6']?.streamUrl).toBeNull();
    // Copertina su un host estraneo: scartata.
    expect(byId['7']?.imageUrl).toBeNull();
    // Licenza mai vista: "unknown", mai riprodotta.
    expect(byId['11']).toMatchObject({ license: 'unknown', streamUrl: null, category: 'beats' });
    expect(byId['12']).toMatchObject({ license: 'cc-by-nc', streamUrl: null });
  });

  it('cover: mai lo stream (anche con CC BY), resta nella ricerca solo per il player di audio.com', () => {
    const tracks = parseAudioComSearch([
      audio('777', {
        category: 'cover',
        license: 'cc-by',
        title: 'Yesterday (Beatles cover)',
        play: { url: 'https://s3.audio.com/audio/777.mp3', duration: 125_000 },
      }),
      audio('778', { category: 'beats', license: 'cc-0' }),
    ]);
    expect(tracks?.map((track) => [track.id, track.category, track.streamUrl])).toEqual([
      ['777', 'cover', null],
      ['778', 'beats', 'https://s3.audio.com/audio/778.mp3'],
    ]);
  });

  it('un corpo che non è un elenco non è valido', () => {
    expect(parseAudioComSearch({ items: [] })).toBeNull();
    expect(parseAudioComSearch([])).toEqual([]);
  });

  it('la chiave di cache è la query normalizzata', () => {
    expect(audioComCacheKey('  Daft   PÙNK ')).toBe('daft punk');
  });
});

describe('searchAudioCom', () => {
  it('chiede types=audio, la prima pagina, con il Bearer dell’account collegato', async () => {
    fetchMock.mockImplementation(async () => json([audio('1'), audio('2', { license: 'arr' })]));
    const result = await searchAudioCom('Daft Punk', WHO);
    expect(result.status).toBe('results');
    expect(result.tracks).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const requested = new URL(String(url));
    expect(`${requested.origin}${requested.pathname}`).toBe(AUDIOCOM_SEARCH_URL);
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      query: 'Daft Punk',
      types: 'audio',
      page: '1',
    });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok-1');
    expect(init?.redirect).toBe('error');
    // Prima la quota personale di chi cerca, poi il limite globale.
    expect(mocks.consumeRateLimit.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['audiocom.search', 'ip:198.51.100.7'],
      ['audiocom.search.global', 'global'],
    ]);
  });

  it('cache: 10 minuti con risultati (anche per la stessa query scritta diversamente)', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-15T10:00:00Z'), toFake: ['Date'] });
    fetchMock.mockImplementation(async () => json([audio('1')]));
    expect((await searchAudioCom('Daft Punk', WHO)).status).toBe('results');
    expect((await searchAudioCom('  daft   púnk ', WHO)).status).toBe('results');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse('2026-11-15T10:09:00Z'));
    await searchAudioCom('Daft Punk', WHO);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse('2026-11-15T10:11:00Z'));
    expect((await searchAudioCom('Daft Punk', WHO)).status).toBe('results');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cache: 1 minuto senza risultati o con errore', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-15T10:00:00Z'), toFake: ['Date'] });
    fetchMock.mockImplementation(async () => json([audio('3', { category: 'podcast' })]));
    expect(await searchAudioCom('nulla', WHO)).toEqual({ status: 'empty', tracks: [] });
    await searchAudioCom('nulla', WHO);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse('2026-11-15T10:01:30Z'));
    expect(await searchAudioCom('nulla', WHO)).toEqual({ status: 'empty', tracks: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Anche un errore resta in cache un minuto.
    fetchMock.mockImplementation(async () => json({}, 500));
    expect((await searchAudioCom('errore', WHO)).status).toBe('unavailable');
    expect((await searchAudioCom('errore', WHO)).status).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ricerche uguali contemporanee: una sola richiesta', async () => {
    let release: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const first = searchAudioCom('caruso', WHO);
    const second = searchAudioCom('Caruso', WHO);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(json([audio('1')]));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(limiterCalls('audiocom.search.global')).toHaveLength(1);
  });

  it('cache limitata: oltre 500 query si toglie la meno usata', async () => {
    fetchMock.mockImplementation(async () => json([audio('1')]));
    for (let index = 0; index <= AUDIOCOM_CACHE_MAX; index += 1) {
      await searchAudioCom(`query numero ${index}`, WHO);
    }
    expect(fetchMock).toHaveBeenCalledTimes(AUDIOCOM_CACHE_MAX + 1);
    await searchAudioCom('query numero 0', WHO); // la più vecchia: uscita dalla cache
    expect(fetchMock).toHaveBeenCalledTimes(AUDIOCOM_CACHE_MAX + 2);
    await searchAudioCom(`query numero ${AUDIOCOM_CACHE_MAX}`, WHO); // recente: ancora in cache
    expect(fetchMock).toHaveBeenCalledTimes(AUDIOCOM_CACHE_MAX + 2);
  });

  it('limite globale superato → unavailable subito, nessuna richiesta, pausa per tutte le query', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-15T10:00:00Z'), toFake: ['Date'] });
    mocks.consumeRateLimit.mockImplementation(async (action: string) =>
      action === 'audiocom.search.global' ? DENIED : { allowed: true },
    );
    expect(await searchAudioCom('primo', WHO)).toEqual({ status: 'unavailable', tracks: [] });
    expect(await searchAudioCom('secondo', WHO)).toEqual({ status: 'unavailable', tracks: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiterCalls('audiocom.search.global')).toHaveLength(1);
    // Durante la pausa nemmeno la quota personale si consuma (nessuna richiesta partirebbe).
    expect(limiterCalls('audiocom.search')).toHaveLength(1);
    // L'esito del limite non resta in cache: finita la pausa, la stessa query va ad audio.com.
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
    fetchMock.mockImplementation(async () => json([audio('1')]));
    vi.setSystemTime(Date.parse('2026-11-15T10:00:21Z'));
    expect((await searchAudioCom('primo', WHO)).status).toBe('results');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 di audio.com → unavailable, pausa secondo Retry-After, ultimo problema registrato', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-15T10:00:00Z'), toFake: ['Date'] });
    fetchMock.mockResolvedValueOnce(json({}, 429, { 'retry-after': '30' }));
    expect(await searchAudioCom('uno', WHO)).toEqual({ status: 'unavailable', tracks: [] });
    expect(mocks.recordError).toHaveBeenCalledWith('rate_limited');
    await searchAudioCom('due', WHO);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse('2026-11-15T10:00:31Z'));
    fetchMock.mockResolvedValueOnce(json([audio('1')]));
    expect((await searchAudioCom('tre', WHO)).status).toBe('results');
  });

  it('401 → token segnato come rifiutato (per versione) e unavailable', async () => {
    fetchMock.mockImplementation(async () => json({ name: 'Unauthorized' }, 401));
    expect(await searchAudioCom('uno', WHO)).toEqual({ status: 'unavailable', tracks: [] });
    expect(mocks.markRejected).toHaveBeenCalledWith(7);
    expect(mocks.recordError).toHaveBeenCalledWith('search_unauthorized');
  });

  it('nessun account collegato → disconnected, senza limite né richieste', async () => {
    mocks.getAccess.mockResolvedValue({ ok: false, reason: 'disconnected' });
    expect(await searchAudioCom('uno', WHO)).toEqual({ status: 'disconnected', tracks: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('risposta non valida, errore 500 o rete giù → unavailable (mai un’eccezione)', async () => {
    fetchMock.mockResolvedValueOnce(json({ not: 'a list' }));
    expect((await searchAudioCom('uno', WHO)).status).toBe('unavailable');
    expect(mocks.recordError).toHaveBeenCalledWith('invalid_response');
    fetchMock.mockResolvedValueOnce(json({}, 500));
    expect((await searchAudioCom('due', WHO)).status).toBe('unavailable');
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await searchAudioCom('tre', WHO)).status).toBe('unavailable');
  });

  it('query troppo corta → skipped senza nessuna chiamata', async () => {
    expect(await searchAudioCom(' a ', WHO)).toEqual({ status: 'skipped', tracks: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getAccess).not.toHaveBeenCalled();
  });
});

describe('quota personale (una sola persona non esaurisce il budget di tutti)', () => {
  it('si consuma solo quando parte davvero una richiesta: la cache è gratis', async () => {
    fetchMock.mockImplementation(async () => json([audio('1')]));
    await searchAudioCom('chopin notturno', WHO);
    await searchAudioCom('Chopin  Notturno', { identity: 'ip:203.0.113.9' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(limiterCalls('audiocom.search')).toEqual([['audiocom.search', 'ip:198.51.100.7']]);
  });

  it('quota finita → unavailable solo per chi cerca (requesterLimited), niente richiesta né limite globale', async () => {
    mocks.consumeRateLimit.mockImplementation(async (action: string, identity: string | null) =>
      action === 'audiocom.search' && identity === 'ip:198.51.100.7' ? DENIED : { allowed: true },
    );
    fetchMock.mockImplementation(async () => json([audio('1')]));
    expect(await searchAudioCom('chopin notturno', WHO)).toEqual({
      status: 'unavailable',
      tracks: [],
      requesterLimited: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiterCalls('audiocom.search.global')).toHaveLength(0);
    // Il rifiuto non va in cache: un'altra persona con la stessa query ottiene i risultati.
    const other = await searchAudioCom('chopin notturno', { identity: 'ip:203.0.113.9' });
    expect(other.status).toBe('results');
    expect(other.requesterLimited).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('senza identità affidabile la decisione è chiesta con null e nessuna richiesta parte', async () => {
    mocks.consumeRateLimit.mockImplementation(async (_action: string, identity: string | null) =>
      identity ? { allowed: true } : DENIED,
    );
    const result = await searchAudioCom('chopin notturno', { identity: null });
    expect(result).toMatchObject({ status: 'unavailable', requesterLimited: true });
    expect(limiterCalls('audiocom.search')).toEqual([['audiocom.search', null]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con le regole vere dei limiti, 40 query diverse da un solo IP non lasciano audio.com agli altri senza risultati', async () => {
    const actual = await vi.importActual<typeof import('@/lib/business/rate-limit.server')>(
      '@/lib/business/rate-limit.server',
    );
    const buckets = new Map<string, number[]>();
    mocks.consumeRateLimit.mockImplementation(
      async (action: keyof typeof actual.ACTION_RATE_LIMITS, identity: string | null) => {
        if (!identity) return DENIED;
        const key = `${action}|${identity}`;
        const decision = actual.evaluateRateLimit(
          buckets.get(key) ?? [],
          actual.ACTION_RATE_LIMITS[action],
          Date.now(),
        );
        if (!decision.allowed) return { ...DENIED, retryAfterSeconds: decision.retryAfterSeconds };
        buckets.set(key, decision.timestamps);
        return { allowed: true };
      },
    );
    fetchMock.mockImplementation(async () => json([audio('1')]));
    for (let index = 0; index < 40; index += 1) {
      await searchAudioCom(`attacker query ${index}`, WHO);
    }
    // Solo la quota personale dell'IP è arrivata ad audio.com.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const victim = await searchAudioCom('chopin notturno', { identity: 'ip:203.0.113.9' });
    expect(victim.status).toBe('results');
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('una raffica di query diverse fermate dai limiti non spinge fuori dalla cache i risultati buoni', async () => {
    fetchMock.mockImplementation(async () => json([audio('1')]));
    expect((await searchAudioCom('chopin notturno', WHO)).status).toBe('results');
    mocks.consumeRateLimit.mockImplementation(async (action: string, identity: string | null) =>
      action === 'audiocom.search' && identity === 'ip:192.0.2.66' ? DENIED : { allowed: true },
    );
    for (let index = 0; index <= AUDIOCOM_CACHE_MAX; index += 1) {
      const flood = await searchAudioCom(`attacco ${index}`, { identity: 'ip:192.0.2.66' });
      expect(flood.requesterLimited).toBe(true);
    }
    expect((await searchAudioCom('chopin notturno', { identity: 'ip:203.0.113.9' })).status).toBe(
      'results',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('limiti configurati', () => {
  it('audiocom.search.global: 40 al minuto (sotto i 60 di audio.com)', async () => {
    const actual = await vi.importActual<typeof import('@/lib/business/rate-limit.server')>(
      '@/lib/business/rate-limit.server',
    );
    expect(actual.ACTION_RATE_LIMITS['audiocom.search.global']).toEqual([
      { requests: 40, windowMs: 60_000 },
    ]);
  });

  it('audiocom.search: quota personale ben sotto il limite globale', async () => {
    const actual = await vi.importActual<typeof import('@/lib/business/rate-limit.server')>(
      '@/lib/business/rate-limit.server',
    );
    expect(actual.ACTION_RATE_LIMITS['audiocom.search']).toEqual([
      { requests: 6, windowMs: 60_000 },
      { requests: 300, windowMs: 86_400_000 },
    ]);
  });
});
