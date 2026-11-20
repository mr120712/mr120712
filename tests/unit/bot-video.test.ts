// @polsia:user-owned — unit della funzione sperimentale /video del bot: gating (flag, chat admin),
// anti-SSRF dell'URL del worker, interpretazione AI (riserva mockata) e risoluzione del download
// (worker finto, nessuna rete reale).
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ freellmapiJson: vi.fn() }));
vi.mock('@/lib/business/ai-freellmapi.server', () => ({
  freellmapiJson: mocks.freellmapiJson,
}));

import {
  botVideoAiModel,
  botVideoExperimentalEnabled,
  extractUrl,
  interpretVideoRequest,
  isAdminTelegramChat,
  resolveVideoDownload,
  type VideoIntent,
  ytdlpServiceUrl,
} from '@/lib/business/bot-video.server';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('botVideoExperimentalEnabled', () => {
  it('accesa di default; spenta solo con 0/false/off/no', () => {
    expect(botVideoExperimentalEnabled({})).toBe(true);
    expect(botVideoExperimentalEnabled({ BOT_VIDEO_EXPERIMENTAL: '1' })).toBe(true);
    expect(botVideoExperimentalEnabled({ BOT_VIDEO_EXPERIMENTAL: 'on' })).toBe(true);
    expect(botVideoExperimentalEnabled({ BOT_VIDEO_EXPERIMENTAL: '0' })).toBe(false);
    expect(botVideoExperimentalEnabled({ BOT_VIDEO_EXPERIMENTAL: 'false' })).toBe(false);
    expect(botVideoExperimentalEnabled({ BOT_VIDEO_EXPERIMENTAL: 'off' })).toBe(false);
    expect(botVideoExperimentalEnabled({ BOT_VIDEO_EXPERIMENTAL: 'no' })).toBe(false);
  });
});

describe('botVideoAiModel', () => {
  it('ritorna l’agent FreeLLMAPI scelto, o undefined (scelta automatica della riserva)', () => {
    expect(botVideoAiModel({})).toBeUndefined();
    expect(botVideoAiModel({ BOT_VIDEO_AI_MODEL: '   ' })).toBeUndefined();
    expect(botVideoAiModel({ BOT_VIDEO_AI_MODEL: 'llama-3.3-70b-versatile' })).toBe(
      'llama-3.3-70b-versatile',
    );
  });
});

describe('ytdlpServiceUrl', () => {
  it('accetta solo HTTPS pubblico; rifiuta http, localhost, IP privati, host nudi', () => {
    expect(ytdlpServiceUrl({})).toBeNull();
    expect(ytdlpServiceUrl({ YTDLP_SERVICE_URL: 'http://ytdlp.example.com' })).toBeNull();
    expect(ytdlpServiceUrl({ YTDLP_SERVICE_URL: 'https://localhost/x' })).toBeNull();
    expect(ytdlpServiceUrl({ YTDLP_SERVICE_URL: 'https://127.0.0.1/x' })).toBeNull();
    expect(ytdlpServiceUrl({ YTDLP_SERVICE_URL: 'https://10.0.0.5/x' })).toBeNull();
    expect(ytdlpServiceUrl({ YTDLP_SERVICE_URL: 'https://worker/x' })).toBeNull(); // host nudo
    expect(ytdlpServiceUrl({ YTDLP_SERVICE_URL: 'https://ytdlp.example.com/' })).toBe(
      'https://ytdlp.example.com',
    );
  });
});

describe('isAdminTelegramChat', () => {
  it('true solo per le chat in SKYNET_TELEGRAM_CHAT_IDS', () => {
    const env = { SKYNET_TELEGRAM_CHAT_IDS: '111, 222 ,333' };
    expect(isAdminTelegramChat('222', env)).toBe(true);
    expect(isAdminTelegramChat('999', env)).toBe(false);
    expect(isAdminTelegramChat('222', {})).toBe(false);
  });
});

describe('extractUrl', () => {
  it('estrae il primo http(s) o null', () => {
    expect(extractUrl('guarda https://youtu.be/abc che bello')).toBe('https://youtu.be/abc');
    expect(extractUrl('nessun link qui')).toBeNull();
  });
});

describe('interpretVideoRequest', () => {
  it('con un URL non chiama l’AI e lo usa direttamente', async () => {
    const intent = await interpretVideoRequest('scarica https://youtu.be/abc grazie', {});
    expect(intent.url).toBe('https://youtu.be/abc');
    expect(intent.query).toBeNull();
    expect(mocks.freellmapiJson).not.toHaveBeenCalled();
  });

  it('senza URL usa l’AI per query + titolo', async () => {
    mocks.freellmapiJson.mockResolvedValue({
      query: 'maneskin sanremo 2021',
      title: 'Måneskin — Sanremo 2021',
    });
    const intent = await interpretVideoRequest('quel video dei maneskin a sanremo', {});
    expect(intent.url).toBeNull();
    expect(intent.query).toBe('maneskin sanremo 2021');
    expect(intent.title).toBe('Måneskin — Sanremo 2021');
  });

  it('usa l’agent FreeLLMAPI scelto (BOT_VIDEO_AI_MODEL) nella chiamata AI', async () => {
    mocks.freellmapiJson.mockResolvedValue({ query: 'x', title: 'y' });
    await interpretVideoRequest('un video', { BOT_VIDEO_AI_MODEL: 'gpt-oss-120b' });
    expect(mocks.freellmapiJson).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-oss-120b' }),
    );
  });

  it('senza modello scelto, lascia decidere alla riserva (model undefined)', async () => {
    mocks.freellmapiJson.mockResolvedValue({ query: 'x', title: 'y' });
    await interpretVideoRequest('un video', {});
    expect(mocks.freellmapiJson).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined }),
    );
  });

  it('se l’AI fallisce, ricade sul testo grezzo', async () => {
    mocks.freellmapiJson.mockRejectedValue(new Error('reserve down'));
    const intent = await interpretVideoRequest('un video qualsiasi', {});
    expect(intent).toEqual({ url: null, query: 'un video qualsiasi', title: 'un video qualsiasi' });
  });
});

describe('resolveVideoDownload', () => {
  const env = { YTDLP_SERVICE_URL: 'https://ytdlp.example.com', YTDLP_SERVICE_KEY: 'k' };
  const intent: VideoIntent = { url: 'https://youtu.be/abc', query: null, title: 'Video' };

  it('senza worker configurato → not_configured', async () => {
    expect(await resolveVideoDownload(intent, {}, vi.fn())).toEqual({ status: 'not_configured' });
  });

  it('worker ok → ok con mediaUrl + titolo; chiama /download con url e Bearer', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            url: 'https://cdn.example.com/v.mp4',
            title: 'Bel video',
            ext: 'mp4',
            durationSeconds: 90,
            filesize: 1_048_576,
          }),
          { status: 200 },
        ),
    );
    const out = await resolveVideoDownload(intent, env, fetchMock as unknown as typeof fetch);
    expect(out).toEqual({
      status: 'ok',
      result: {
        mediaUrl: 'https://cdn.example.com/v.mp4',
        title: 'Bel video',
        ext: 'mp4',
        durationSeconds: 90,
        filesize: 1_048_576,
      },
    });
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://ytdlp.example.com/download');
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.headers).toMatchObject({ authorization: 'Bearer k' });
    expect(JSON.parse(String(init?.body))).toMatchObject({ url: 'https://youtu.be/abc' });
  });

  it('worker HTTP 500 → failed', async () => {
    const fetchMock = vi.fn(async () => new Response('x', { status: 500 }));
    expect(
      (await resolveVideoDownload(intent, env, fetchMock as unknown as typeof fetch)).status,
    ).toBe('failed');
  });

  it('codici d’errore del worker → il dettaglio dice il rimedio, non un generico HTTP 502', async () => {
    const failure = async (status: number, body: unknown) => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
      const out = await resolveVideoDownload(intent, env, fetchMock as unknown as typeof fetch);
      return out.status === 'failed' ? out.detail : `unexpected:${out.status}`;
    };

    const botCheck = await failure(502, { detail: 'youtube_bot_check' });
    expect(botCheck).toContain('controllo anti-bot');
    expect(botCheck).toContain('YTDLP_COOKIES');
    expect(await failure(502, { detail: 'rate_limited' })).toContain('troppe richieste');
    expect(await failure(502, { detail: 'login_required' })).toContain('YTDLP_COOKIES');
    expect(await failure(502, { detail: 'unavailable' })).toContain('non è disponibile');
    expect(await failure(413, { detail: 'file too large or not downloadable' })).toContain(
      'troppo grande',
    );
    // Chiave diversa fra i due lati (401) e worker senza chiave (503): errori di configurazione.
    expect(await failure(401, { detail: 'unauthorized' })).toContain('stesso valore');
    expect(await failure(503, { detail: 'worker not configured: set WORKER_API_KEY' })).toContain(
      'WORKER_API_KEY',
    );
    // Codice sconosciuto o corpo non JSON → resta lo stato HTTP, come prima.
    expect(await failure(502, { detail: 'download failed' })).toBe(
      'il servizio ha risposto HTTP 502',
    );
    expect(await failure(500, 'x')).toBe('il servizio ha risposto HTTP 500');
    // Un `detail` non stringa (es. errori di validazione FastAPI) non rompe nulla.
    expect(await failure(422, { detail: [{ msg: 'field required' }] })).toBe(
      'il servizio ha risposto HTTP 422',
    );
  });

  it('rete che cade → failed', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(
      (await resolveVideoDownload(intent, env, fetchMock as unknown as typeof fetch)).status,
    ).toBe('failed');
  });

  it('corpo non valido (url mancante) → failed', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ title: 'x' }), { status: 200 }),
    );
    expect(
      (await resolveVideoDownload(intent, env, fetchMock as unknown as typeof fetch)).status,
    ).toBe('failed');
  });

  it('risposta senza filesize (modalità extract) → filesize null', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ url: 'https://cdn.example.com/x.mp4', title: 'X' }), {
          status: 200,
        }),
    );
    const out = await resolveVideoDownload(intent, env, fetchMock as unknown as typeof fetch);
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect(out.result.filesize).toBeNull();
  });
});
