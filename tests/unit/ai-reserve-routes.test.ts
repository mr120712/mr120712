// @polsia:user-owned — route del connettore "Riserva AI": il gate del Bearer e la validazione zod
// del corpo. La logica di inoltro (lib) è finta; qui si verificano solo auth, 400 e delega.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeReserve: vi.fn(),
  forwardChat: vi.fn(),
  listModels: vi.fn(),
  enforceRateLimit: vi.fn(),
  getRateLimitIdentity: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/ai-reserve-connector.server', () => ({
  authorizeReserve: mocks.authorizeReserve,
  forwardChat: mocks.forwardChat,
  listModels: mocks.listModels,
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.getRateLimitIdentity,
}));

import { POST } from '@/app/api/ai-reserve/v1/chat/completions/route';
import { GET } from '@/app/api/ai-reserve/v1/models/route';

function get(headers: Record<string, string> = {}): Request {
  return new Request('https://solco.test/api/ai-reserve/v1/models', { headers });
}
function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://solco.test/api/ai-reserve/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.authorizeReserve.mockReset();
  mocks.forwardChat.mockReset();
  mocks.listModels.mockReset();
  mocks.enforceRateLimit.mockReset();
  mocks.getRateLimitIdentity.mockReset();
  mocks.forwardChat.mockResolvedValue(new Response('{}', { status: 200 }));
  mocks.listModels.mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
  mocks.enforceRateLimit.mockResolvedValue(null); // consenti per default
  mocks.getRateLimitIdentity.mockReturnValue('ip:test');
});

describe('GET /models', () => {
  it('rifiuta con lo status dell’auth e non tocca l’upstream', async () => {
    mocks.authorizeReserve.mockReturnValue({ ok: false, status: 401, error: 'unauthorized' });
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(mocks.listModels).not.toHaveBeenCalled();
  });

  it('autorizzato → delega a listModels', async () => {
    mocks.authorizeReserve.mockReturnValue({ ok: true });
    const res = await GET(get({ authorization: 'Bearer x' }));
    expect(res.status).toBe(200);
    expect(mocks.listModels).toHaveBeenCalledTimes(1);
  });
});

describe('POST /chat/completions', () => {
  it('401 quando il Bearer non va: nessun inoltro', async () => {
    mocks.authorizeReserve.mockReturnValue({ ok: false, status: 401, error: 'unauthorized' });
    const res = await POST(post({ messages: [{ role: 'user', content: 'ciao' }] }));
    expect(res.status).toBe(401);
    expect(mocks.forwardChat).not.toHaveBeenCalled();
  });

  it('429 quando il rate limit è superato: nessun inoltro', async () => {
    mocks.authorizeReserve.mockReturnValue({ ok: true });
    mocks.enforceRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    );
    const res = await POST(
      post({ messages: [{ role: 'user', content: 'ciao' }] }, { authorization: 'Bearer x' }),
    );
    expect(res.status).toBe(429);
    expect(mocks.forwardChat).not.toHaveBeenCalled();
  });

  it('400 su corpo non valido (messages vuoto): nessun inoltro', async () => {
    mocks.authorizeReserve.mockReturnValue({ ok: true });
    const res = await POST(post({ messages: [] }, { authorization: 'Bearer x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(mocks.forwardChat).not.toHaveBeenCalled();
  });

  it('400 su ruolo non ammesso', async () => {
    mocks.authorizeReserve.mockReturnValue({ ok: true });
    const res = await POST(
      post({ messages: [{ role: 'bot', content: 'x' }] }, { authorization: 'Bearer x' }),
    );
    expect(res.status).toBe(400);
  });

  it('valido → inoltra il corpo SENZA il campo stream', async () => {
    mocks.authorizeReserve.mockReturnValue({ ok: true });
    const res = await POST(
      post(
        { model: 'auto', messages: [{ role: 'user', content: 'ciao' }], stream: true },
        { authorization: 'Bearer x' },
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.forwardChat).toHaveBeenCalledTimes(1);
    const forwarded = mocks.forwardChat.mock.calls[0]?.[0];
    expect(forwarded).toMatchObject({
      model: 'auto',
      messages: [{ role: 'user', content: 'ciao' }],
    });
    expect(forwarded).not.toHaveProperty('stream');
  });

  it("accetta messaggi tool-use (role 'tool', tool_calls, content null) e tools/tool_choice", async () => {
    mocks.authorizeReserve.mockReturnValue({ ok: true });
    const body = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'sei un agent' },
        { role: 'user', content: 'leggi dir' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'ls',
            description: 'List files in cwd',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      tool_choice: 'auto',
    };
    const res = await POST(post(body, { authorization: 'Bearer x' }));
    expect(res.status).toBe(200);
    expect(mocks.forwardChat).toHaveBeenCalledTimes(1);
    const forwarded = mocks.forwardChat.mock.calls[0]?.[0];
    expect(forwarded).toMatchObject({
      messages: [
        { role: 'system' },
        { role: 'user' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' },
      ],
      tools: [{ type: 'function', function: { name: 'ls' } }],
      tool_choice: 'auto',
    });
  });

  it('accetta content come array di parti (OpenAI multimodale/structured)', async () => {
    mocks.authorizeReserve.mockReturnValue({ ok: true });
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'descrivi' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR...' } },
          ],
        },
      ],
    };
    const res = await POST(post(body, { authorization: 'Bearer x' }));
    expect(res.status).toBe(200);
    const forwarded = mocks.forwardChat.mock.calls[0]?.[0];
    expect(forwarded.messages[0].content).toHaveLength(2);
  });
});
