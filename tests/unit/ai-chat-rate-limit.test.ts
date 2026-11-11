// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  enforceRateLimit: vi.fn(),
  getRateLimitIdentity: vi.fn(),
  streamChat: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.getRateLimitIdentity,
}));
vi.mock('@/lib/ai/client', () => ({
  AiConfigurationError: class AiConfigurationError extends Error {},
  streamChat: mocks.streamChat,
}));

import { POST } from '@/app/api/ai/chat/route';
import { authorizeAiChat } from '@/lib/ai/authorize';

function chatRequest(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request('https://solco.test/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.51', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue(null);
  mocks.getRateLimitIdentity.mockReturnValue('ip:192.0.2.51');
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.streamChat.mockResolvedValue(new ReadableStream());
});

describe('protezione del relay AI', () => {
  it('applica il limite all’identità autenticata o all’IP fidato prima del relay', async () => {
    const adminLimit = Response.json(
      { error: 'rate_limited', message: 'Riprova tra 10 secondi.', retryAfterSeconds: 10 },
      { status: 429, headers: { 'Retry-After': '10' } },
    );
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'utente-1' } });
    mocks.getRateLimitIdentity.mockReturnValueOnce('user:utente-1');
    mocks.enforceRateLimit.mockResolvedValueOnce(adminLimit);

    const denied = await authorizeAiChat(
      chatRequest({ messages: [{ role: 'user', content: 'Ciao' }] }),
    );
    expect(denied?.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('ai.chat', 'user:utente-1');

    mocks.getSession.mockResolvedValueOnce(null);
    mocks.getRateLimitIdentity.mockReturnValueOnce('ip:192.0.2.51');
    await authorizeAiChat(chatRequest({ messages: [{ role: 'user', content: 'Ciao' }] }));
    expect(mocks.enforceRateLimit).toHaveBeenLastCalledWith('ai.chat', 'ip:192.0.2.51');
  });

  it('rifiuta corpi troppo grandi prima di consumare il budget', async () => {
    const response = await authorizeAiChat(
      chatRequest(
        { messages: [{ role: 'user', content: 'x'.repeat(16_001) }] },
        { 'content-length': '200000' },
      ),
    );

    expect(response?.status).toBe(413);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('il relay restituisce 429 prima dello streaming e conserva il 400 per input non valido', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json(
        { error: 'rate_limited', message: 'Riprova tra 10 secondi.' },
        { status: 429, headers: { 'Retry-After': '10' } },
      ),
    );
    const blocked = await POST(chatRequest({ messages: [{ role: 'user', content: 'Ciao' }] }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('10');
    expect(mocks.streamChat).not.toHaveBeenCalled();

    const invalid = await POST(chatRequest({ messages: [] }));
    expect(invalid.status).toBe(400);
    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.streamChat).not.toHaveBeenCalled();
  });
});
