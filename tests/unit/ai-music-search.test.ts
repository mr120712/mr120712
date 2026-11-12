// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  key: string;
  userId: string | null;
  payload: unknown;
  createdAt: Date;
  expiresAt: Date;
};

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  rows: new Map<string, Row>(),
  deleted: vi.fn(),
}));

vi.mock('server-only', () => ({}));
// Same hierarchy as the real SDK (a timeout is a connection error; 402 has no class of its own).
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status?: number) {
      super('api');
      this.status = status;
    }
  }
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class NotFoundError extends APIError {}
  class RateLimitError extends APIError {}
  class APIConnectionError extends APIError {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  class APIUserAbortError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static PermissionDeniedError = PermissionDeniedError;
    static NotFoundError = NotFoundError;
    static RateLimitError = RateLimitError;
    static APIConnectionError = APIConnectionError;
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIUserAbortError = APIUserAbortError;
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
    beta = { messages: { create: mocks.create } };
    models = { list: mocks.list };
  }
  return { default: Anthropic };
});
vi.mock('@anthropic-ai/sdk/helpers/beta/zod', () => ({
  betaZodOutputFormat: () => ({ type: 'json_schema', schema: {} }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    aiMusicSearchCache: {
      findUnique: vi.fn(
        async ({ where }: { where: { key: string } }) => mocks.rows.get(where.key) ?? null,
      ),
      upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: Row }) => {
        mocks.rows.set(where.key, create);
        return create;
      }),
      deleteMany: mocks.deleted,
    },
  },
}));

import Anthropic from '@anthropic-ai/sdk';
import {
  AI_SEARCH_MODEL,
  aiSearchEffort,
  normalizePrompt,
  sanitizePlan,
} from '@/lib/business/ai-music-search';
import {
  aiSearchAvailable,
  aiSearchCacheKey,
  aiSearchConfigured,
  anthropicApiKey,
  planMusicSearch,
} from '@/lib/business/ai-music-search.server';
import { AI_SEARCH_EXAMPLES } from '@/lib/contracts/ai-music-search';

const rawPlan = {
  intro: '  Ho cercato lo-fi giapponese   tranquillo. ',
  youtubeQueries: ['japanese lofi', 'Japanese Lofi', 'city pop night', 'third'],
  audioQueries: ['lofi', 'chillhop', 'ambient'],
  radioTags: ['Lofi', 'chillout', 'jazz', 'quarto'],
  podcastQuery: null,
  genres: ['lofi', 'inventato', 'jazz'],
};
const ok = (plan: unknown = rawPlan) => ({
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 10 },
  content: [{ type: 'text', text: JSON.stringify(plan) }],
});

type ErrorClass = new (status?: number) => Error;
const Errors = Anthropic as unknown as Record<
  | 'APIError'
  | 'AuthenticationError'
  | 'PermissionDeniedError'
  | 'NotFoundError'
  | 'RateLimitError'
  | 'APIConnectionError'
  | 'APIConnectionTimeoutError',
  ErrorClass
>;

// The key state is kept per key fingerprint: a fresh key per test keeps the tests independent.
const SECRET = 'SECRETVALUE';
let keyCount = 0;
let key = '';
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;
const logged = () => JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls]);

beforeEach(() => {
  key = `sk-ant-api03-${SECRET}-${++keyCount}`;
  vi.stubEnv('ANTHROPIC_API_KEY', key);
  mocks.create.mockReset();
  mocks.list.mockReset().mockResolvedValue({ data: [] });
  mocks.deleted.mockReset().mockResolvedValue({ count: 0 });
  mocks.rows.clear();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe('ricerca con l’AI: regole', () => {
  it('limita le ricerche, toglie i doppioni e tiene solo generi esistenti', () => {
    const plan = sanitizePlan(rawPlan);
    expect(plan.intro).toBe('Ho cercato lo-fi giapponese tranquillo.');
    expect(plan.youtubeQueries).toEqual(['japanese lofi', 'city pop night']);
    expect(plan.audioQueries).toEqual(['lofi', 'chillhop']);
    expect(plan.radioTags).toEqual(['lofi', 'chillout', 'jazz']);
    expect(plan.genres.every((slug) => slug !== 'inventato')).toBe(true);
  });

  it('legge la chiave anche con il nome scritto male (ANTHROPHIC_API_KEY)', () => {
    expect(anthropicApiKey({ ANTHROPHIC_API_KEY: ' sk-x ' })).toBe('sk-x');
    expect(anthropicApiKey({ ANTHROPIC_API_KEY: 'sk-a', ANTHROPHIC_API_KEY: 'sk-b' })).toBe('sk-a');
    expect(anthropicApiKey({})).toBeUndefined();
  });

  it('usa Opus 5.5 con effort "medium" se non configurato diversamente', () => {
    expect(AI_SEARCH_MODEL).toBe('claude-opus-5-5');
    expect(aiSearchEffort(undefined)).toBe('medium');
    expect(aiSearchEffort('Low')).toBe('low');
    expect(aiSearchEffort(' HIGH ')).toBe('high');
    // xhigh/max would need streaming and a much larger budget: back to the default.
    expect(aiSearchEffort('MAX')).toBe('medium');
    expect(aiSearchEffort('xhigh')).toBe('medium');
    expect(aiSearchEffort('ultra')).toBe('medium');
    expect(normalizePrompt('  Lo-Fi   Notte ')).toBe('lo-fi notte');
  });

  it('i piani sono privati per utente, tranne quelli degli esempi pronti', () => {
    const mine = aiSearchCacheKey('jazz per cena', 'u1');
    const theirs = aiSearchCacheKey('jazz per cena', 'u2');
    expect(mine.key).not.toBe(theirs.key);
    expect(mine.owner).toBe('u1');
    const example = AI_SEARCH_EXAMPLES[0];
    expect(aiSearchCacheKey(example, 'u1')).toEqual(aiSearchCacheKey(` ${example} `, 'u2'));
    expect(aiSearchCacheKey(example, 'u1').owner).toBeNull();
  });
});

describe('ricerca con l’AI: chiamata a Claude', () => {
  it('chiede un piano strutturato con fallback, senza retry e con scadenza, e lo riusa', async () => {
    mocks.create.mockResolvedValue(ok());
    const first = await planMusicSearch('Lo-fi giapponese per studiare', 'u1');
    expect(first).toMatchObject({ ok: true, cached: false });
    const [request, options] = mocks.create.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium' },
    });
    expect(request.thinking).toBeUndefined();
    expect(request.temperature).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.deleted).toHaveBeenCalled();
    const again = await planMusicSearch('  lo-fi GIAPPONESE per studiare ', 'u1');
    expect(again).toMatchObject({ ok: true, cached: true });
    expect(mocks.create).toHaveBeenCalledOnce();
    // Another listener does not get (or learn about) u1's plan.
    await planMusicSearch('Lo-fi giapponese per studiare', 'u2');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('un rifiuto con testo parziale resta un rifiuto, un testo non valido è un errore (con log)', async () => {
    mocks.create.mockResolvedValueOnce({
      ...ok(),
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms', explanation: null },
      content: [{ type: 'text', text: '{"intro": "Mi disp' }],
    });
    expect(await planMusicSearch('qualcosa', 'u1')).toEqual({ ok: false, error: 'refused' });
    expect(consoleWarn).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'refusal', category: 'general_harms' }),
    );
    mocks.create.mockResolvedValueOnce({
      ...ok(),
      content: [{ type: 'text', text: 'non è JSON' }],
    });
    expect(await planMusicSearch('altro', 'u1')).toEqual({ ok: false, error: 'failed' });
    expect(consoleError).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'invalid_plan', blocks: ['text'] }),
    );
    mocks.create.mockResolvedValueOnce({ ...ok(), stop_reason: 'max_tokens', content: [] });
    expect(await planMusicSearch('altro ancora', 'u1')).toEqual({ ok: false, error: 'failed' });
    expect(consoleError).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({
        reason: 'stop_reason',
        stopReason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    );
    // Neither the listener's text nor the answer reaches the logs.
    expect(logged()).not.toContain('qualcosa');
    expect(logged()).not.toContain('non è JSON');
    expect(logged()).not.toContain('Mi disp');
  });

  it('sovraccarico e tempo scaduto diventano "busy", chiave mancante "not_configured"', async () => {
    mocks.create.mockRejectedValueOnce(new Errors.RateLimitError(429));
    expect(await planMusicSearch('a1', 'u1')).toEqual({ ok: false, error: 'busy' });
    mocks.create.mockRejectedValueOnce(new Errors.APIConnectionTimeoutError());
    expect(await planMusicSearch('a2', 'u1')).toEqual({ ok: false, error: 'busy' });
    mocks.create.mockRejectedValueOnce(new Errors.APIError(529));
    expect(await planMusicSearch('a3', 'u1')).toEqual({ ok: false, error: 'busy' });
    expect(consoleWarn).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'busy', status: 529, kind: 'api' }),
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'busy', kind: 'timeout' }),
    );
    // A busy API says nothing about the key: still offered.
    expect(aiSearchConfigured()).toBe(true);

    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(await planMusicSearch('a4', 'u1')).toEqual({ ok: false, error: 'not_configured' });
    expect(aiSearchConfigured()).toBe(false);
  });

  it('una rete assente/interrotta (APIConnectionError senza status) è "busy", non "failed"', async () => {
    // Un errore di connessione puro (DNS, reset, TLS, il "fetch failed" del SDK) non è un
    // APIConnectionTimeoutError e ha status undefined: è transitorio come un timeout.
    mocks.create.mockRejectedValueOnce(new Errors.APIConnectionError());
    expect(await planMusicSearch('conn1', 'u1')).toEqual({ ok: false, error: 'busy' });
    expect(consoleWarn).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'busy', kind: 'connection' }),
    );
    // Un blip di rete non è un verdetto sulla chiave: la ricerca resta accesa e si riprova.
    expect(aiSearchConfigured()).toBe(true);
    mocks.create.mockResolvedValueOnce(ok());
    expect(await planMusicSearch('conn2', 'u1')).toMatchObject({ ok: true });
  });
});

describe('ricerca con l’AI: chiave e account Anthropic', () => {
  const notConfigured = { ok: false, error: 'not_configured' };

  it('una chiave rifiutata (401) spegne la ricerca senza altre chiamate, finché non cambia', async () => {
    const now = new Date('2026-11-12T08:00:00Z');
    mocks.create.mockRejectedValueOnce(new Errors.AuthenticationError(401));
    expect(await planMusicSearch('b1', 'u1', now)).toEqual(notConfigured);
    expect(consoleError).toHaveBeenCalledWith(
      '[solco] Anthropic key rejected',
      expect.objectContaining({ status: 401, standardKey: true, hasSpaces: false }),
    );
    expect(logged()).not.toContain(SECRET);

    // GET now says the search is off, and POST no longer calls (or pays) Anthropic.
    expect(aiSearchConfigured(now)).toBe(false);
    expect(await aiSearchAvailable(now)).toBe(false);
    expect(await planMusicSearch('b2', 'u1', now)).toEqual(notConfigured);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.list).not.toHaveBeenCalled();

    // Checked again after 10 minutes, and a new key starts clean straight away.
    expect(aiSearchConfigured(new Date(now.getTime() + 10 * 60 * 1000 + 1))).toBe(true);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-a-new-key');
    expect(aiSearchConfigured(now)).toBe(true);
    mocks.create.mockResolvedValueOnce(ok());
    expect(await planMusicSearch('b3', 'u1', now)).toMatchObject({ ok: true });
  });

  it.each([
    ['402 (credito finito)', () => new Errors.APIError(402), 402],
    ['403 (permesso negato)', () => new Errors.PermissionDeniedError(403), 403],
    ['404 (modello non disponibile)', () => new Errors.NotFoundError(404), 404],
  ])(
    '%s non dice "Riprova": la ricerca si spegne e il motivo va nei log',
    async (_label, make, status) => {
      mocks.create.mockRejectedValueOnce(make());
      expect(await planMusicSearch('c1', 'u1')).toEqual(notConfigured);
      expect(consoleError).toHaveBeenCalledWith(
        '[solco] AI search failed',
        expect.objectContaining({ reason: 'account', status }),
      );
      expect(logged()).not.toContain(SECRET);
      expect(aiSearchConfigured()).toBe(false);
      expect(await planMusicSearch('c2', 'u1')).toEqual(notConfigured);
      expect(mocks.create).toHaveBeenCalledOnce();
    },
  );

  it('il tetto di spesa mensile (429 enforced_spend_limit_reached) spegne la ricerca, non è "busy"', async () => {
    const spend = new Errors.RateLimitError(429);
    // SDK 1.8.0: error.errorCode is read from error.details.error_code.
    (spend as unknown as { errorCode: string }).errorCode = 'enforced_spend_limit_reached';
    mocks.create.mockRejectedValueOnce(spend);
    expect(await planMusicSearch('sp1', 'u1')).toEqual(notConfigured);
    expect(consoleError).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'account', spendLimit: true }),
    );
    // Remembered like an account problem: the next listener is not charged for a call that fails.
    expect(aiSearchConfigured()).toBe(false);
    expect(await planMusicSearch('sp2', 'u1')).toEqual(notConfigured);
    expect(mocks.create).toHaveBeenCalledOnce();
    // A plain 429 (no spend code) stays "busy" and leaves the search on.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-another-key');
    mocks.create.mockRejectedValueOnce(new Errors.RateLimitError(429));
    expect(await planMusicSearch('sp3', 'u1')).toEqual({ ok: false, error: 'busy' });
    expect(aiSearchConfigured()).toBe(true);
  });

  it('un 400 di configurazione (beta non abilitato) spegne la ricerca; un 400 qualunque resta "failed"', async () => {
    const beta = new Errors.APIError(400);
    (beta as unknown as { apiMessage: string }).apiMessage =
      'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.';
    mocks.create.mockRejectedValueOnce(beta);
    expect(await planMusicSearch('cfg1', 'u1')).toEqual(notConfigured);
    expect(consoleError).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'account', badRequest: true }),
    );
    expect(aiSearchConfigured()).toBe(false);
    expect(await planMusicSearch('cfg2', 'u1')).toEqual(notConfigured);
    expect(mocks.create).toHaveBeenCalledOnce();

    // A generic 400 (a bug in the request) is not an account verdict: it stays "failed".
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-yet-another-key');
    mocks.create.mockRejectedValueOnce(new Errors.APIError(400));
    expect(await planMusicSearch('cfg3', 'u1')).toEqual({ ok: false, error: 'failed' });
    expect(aiSearchConfigured()).toBe(true);
  });

  it('un errore di configurazione resta spento più a lungo di una chiave 401', async () => {
    const now = new Date('2026-11-12T08:00:00Z');
    mocks.create.mockRejectedValueOnce(new Errors.APIError(402));
    expect(await planMusicSearch('win1', 'u1', now)).toEqual(notConfigured);
    // Still off 11 minutes later — a 401 key would already be retried — because billing needs a fix.
    expect(aiSearchConfigured(new Date(now.getTime() + 11 * 60 * 1000))).toBe(false);
    // Rechecked only after the longer config window (30 min).
    expect(aiSearchConfigured(new Date(now.getTime() + 30 * 60 * 1000 + 1))).toBe(true);
  });

  it('la memoria segue l’ultima osservazione: un POST lento non riaccende una chiave già rifiutata', async () => {
    const t0 = new Date('2026-11-12T08:00:00Z');
    const tLater = new Date(t0.getTime() + 30 * 1000);
    // A POST starts first, while the key still looks usable, but its API call is slow: hold it open.
    let resolveSlow: (value: unknown) => void = () => undefined;
    mocks.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    );
    const slow = planMusicSearch('descrizione lenta', 'u1', t0);
    // Let the slow POST reach (and park on) its API call before the newer one runs.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Meanwhile a newer POST observes a rejected key (401) and records it.
    mocks.create.mockRejectedValueOnce(new Errors.AuthenticationError(401));
    expect(await planMusicSearch('descrizione recente', 'u1', tLater)).toEqual(notConfigured);
    expect(aiSearchConfigured(tLater)).toBe(false);

    // Now the slow (older) POST finally succeeds. It returns its own plan to its own caller…
    resolveSlow(ok());
    expect(await slow).toMatchObject({ ok: true });
    // …but it must NOT revive the key: the newer "rejected" verdict stands.
    expect(aiSearchConfigured(tLater)).toBe(false);
  });

  it('un 400 o un errore senza risposta resta "failed", ma lascia una traccia senza la chiave', async () => {
    mocks.create.mockRejectedValueOnce(new Errors.APIError(400));
    expect(await planMusicSearch('d1', 'u1')).toEqual({ ok: false, error: 'failed' });
    expect(consoleError).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'failed', status: 400 }),
    );
    // fetch's header error repeats the header value: only the error name is logged.
    mocks.create.mockRejectedValueOnce(
      new TypeError(`Headers.append: "Bearer ${key}" is an invalid header value`),
    );
    expect(await planMusicSearch('d2', 'u1')).toEqual({ ok: false, error: 'failed' });
    expect(consoleError).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'failed', errorName: 'TypeError' }),
    );
    expect(logged()).not.toContain(SECRET);
    // Not a verdict on the key: the search stays on.
    expect(aiSearchConfigured()).toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['senza il prefisso sk-ant-', 'sk-test'],
    ['incollata con il nome', 'ANTHROPIC_API_KEY=sk-ant-x'],
    ['con un a capo dentro', 'sk-ant-api03-a\nb'],
    ['con uno spazio dentro', 'sk-ant-api03-ab cd'],
    ['tra virgolette tipografiche', '\u201csk-ant-api03-abc\u201d'],
    ['con una virgoletta tipografica in fondo', 'sk-ant-api03-abc\u201d'],
    ['una chiave Admin', 'sk-ant-admin01-abc'],
  ])('una chiave %s non viene offerta né provata', async (_label, value) => {
    vi.stubEnv('ANTHROPIC_API_KEY', value);
    expect(aiSearchConfigured()).toBe(false);
    expect(await aiSearchAvailable()).toBe(false);
    expect(await planMusicSearch('e1', 'u1')).toEqual(notConfigured);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    // One diagnostic line per key, not one per page view.
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      '[solco] Anthropic key has the wrong shape; AI search stays off',
      expect.objectContaining({ length: value.length }),
    );
  });
});

describe('ricerca con l’AI: verifica della chiave per GET', () => {
  it('chiede una volta GET /v1/models (anche con richieste in parallelo) e ricorda la risposta', async () => {
    const now = new Date('2026-11-12T08:00:00Z');
    const [first, second] = await Promise.all([aiSearchAvailable(now), aiSearchAvailable(now)]);
    expect([first, second]).toEqual([true, true]);
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.list).toHaveBeenCalledWith({ limit: 1 }, { timeout: 4_000, maxRetries: 0 });
    expect(await aiSearchAvailable(new Date(now.getTime() + 29 * 60 * 1000))).toBe(true);
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(await aiSearchAvailable(new Date(now.getTime() + 31 * 60 * 1000))).toBe(true);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, () => new Errors.AuthenticationError(401)],
    [403, () => new Errors.PermissionDeniedError(403)],
  ])(
    'una chiave che riceve %s spegne la ricerca senza bruciare un ascoltatore',
    async (status, make) => {
      mocks.list.mockRejectedValueOnce(make());
      expect(await aiSearchAvailable()).toBe(false);
      expect(consoleError).toHaveBeenCalledWith(
        '[solco] Anthropic key rejected',
        expect.objectContaining({ status }),
      );
      expect(logged()).not.toContain(SECRET);
      expect(aiSearchConfigured()).toBe(false);
      expect(await planMusicSearch('f1', 'u1')).toEqual({ ok: false, error: 'not_configured' });
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it('rete assente, tempo scaduto o errore 5xx non spengono la ricerca e si riprova dopo un minuto', async () => {
    const now = new Date('2026-11-12T08:00:00Z');
    mocks.list.mockRejectedValueOnce(new Errors.APIConnectionError());
    expect(await aiSearchAvailable(now)).toBe(true);
    expect(consoleWarn).toHaveBeenCalledWith(
      '[solco] AI search failed',
      expect.objectContaining({ reason: 'key_check', kind: 'connection' }),
    );
    expect(await aiSearchAvailable(new Date(now.getTime() + 30 * 1000))).toBe(true);
    expect(mocks.list).toHaveBeenCalledOnce();

    mocks.list.mockRejectedValueOnce(new Errors.APIError(500));
    expect(await aiSearchAvailable(new Date(now.getTime() + 61 * 1000))).toBe(true);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    mocks.list.mockRejectedValueOnce(new Errors.APIConnectionTimeoutError());
    expect(await aiSearchAvailable(new Date(now.getTime() + 122 * 1000))).toBe(true);
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });
});
