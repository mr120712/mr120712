// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ask: vi.fn(), enforceRateLimit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/deepseek-chat.server', () => ({ askDeepseek: mocks.ask }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));

import { OPTIONS, POST } from '@/app/api/space-chat/v1/chat/completions/route';
import { GET } from '@/app/api/space-chat/v1/models/route';
import { spaceChatOrigins } from '@/lib/business/space-chat.server';

const KEY = 'k'.repeat(40);
const SPACE = 'https://solcomusic-deepseek-static-chat.static.hf.space';

function post(
  body: unknown,
  { origin = SPACE, key = KEY }: { origin?: string; key?: string } = {},
) {
  return new Request('https://solco.test/api/space-chat/v1/chat/completions', {
    method: 'POST',
    headers: { origin, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const chat = {
  model: 'x',
  stream: true,
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'ciao' },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('SPACE_CHAT_API_KEY', KEY);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.ask.mockResolvedValue({ status: 'ok', reply: 'Ciao!', model: 'claude-sonnet-5' });
});

describe('/api/space-chat', () => {
  it('preflight: CORS solo per lo Space', async () => {
    const ok = OPTIONS(
      new Request('https://solco.test/x', { method: 'OPTIONS', headers: { origin: SPACE } }),
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SPACE);
    const other = OPTIONS(
      new Request('https://solco.test/x', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('senza chiave configurata o con chiave sbagliata non chiama il modello', async () => {
    expect((await POST(post(chat, { key: 'wrong' }))).status).toBe(401);
    vi.stubEnv('SPACE_CHAT_API_KEY', '');
    expect((await POST(post(chat))).status).toBe(503);
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('stream: risponde in SSE con il sistema separato e CORS', async () => {
    const res = await POST(post(chat));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe(SPACE);
    const text = await res.text();
    expect(text).toContain('"content":"Ciao!"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    expect(mocks.ask).toHaveBeenCalledWith({
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'ciao' }],
    });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('space.chat', 'space:owner');
  });

  it('senza stream: JSON OpenAI; errori del modello con lo stato giusto', async () => {
    const res = await POST(post({ ...chat, stream: false }));
    expect((await res.json()).choices[0].message.content).toBe('Ciao!');
    mocks.ask.mockResolvedValue({ status: 'failed', error: 'timeout' });
    expect((await POST(post(chat))).status).toBe(504);
    mocks.ask.mockResolvedValue({ status: 'not_configured' });
    expect((await POST(post(chat))).status).toBe(503);
  });

  it('l’ultimo messaggio deve essere dell’utente', async () => {
    const res = await POST(post({ messages: [{ role: 'assistant', content: 'x' }] }));
    expect(res.status).toBe(400);
  });

  it('models: chiave e CORS', async () => {
    const res = GET(
      new Request('https://solco.test/api/space-chat/v1/models', {
        headers: { origin: SPACE, authorization: `Bearer ${KEY}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(SPACE);
  });

  it('origini: CSV validato, default lo Space', () => {
    expect(spaceChatOrigins({})).toEqual([SPACE]);
    expect(spaceChatOrigins({ SPACE_CHAT_ORIGINS: 'https://a.example/, javascript:x' })).toEqual([
      'https://a.example',
    ]);
  });
});
