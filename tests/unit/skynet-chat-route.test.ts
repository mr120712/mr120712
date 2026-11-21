// @polsia:user-owned
// @vitest-environment node
//
// POST /api/admin/skynet/chat: la porta della chat di «Skynet». Stessa origine, solo
// amministratori con email verificata, conversazione validata, limite di frequenza per utente; il
// motore (src/lib/skynet/chat.server.ts) viene chiamato solo dopo tutti i controlli.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  askSkynet: vi.fn(),
  env: { POLSIA_OWNER_EMAIL: 'owner@solco.test' } as Record<string, string | undefined>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/skynet/chat.server', () => ({ askSkynet: mocks.askSkynet }));
vi.mock('@/lib/env', () => ({ env: mocks.env }));

import { POST } from '@/app/api/admin/skynet/chat/route';
import {
  SKYNET_CHAT_MAX_MESSAGE,
  SKYNET_CHAT_MAX_QUESTION,
  SKYNET_CHAT_MAX_TURNS,
  SkynetChatResponseSchema,
} from '@/lib/contracts/skynet-chat';

const admin = { id: 'admin-1', role: 'admin', email: 'altro@solco.test', emailVerified: true };
const owner = { ...admin, id: 'owner-1', email: 'Owner@solco.test' };
type Turn = { role: 'user' | 'assistant'; content: string };

function request(body: unknown, raw = false) {
  return new Request('https://solco.test/api/admin/skynet/chat', {
    method: 'POST',
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    body: raw ? String(body) : JSON.stringify(body),
  });
}
const ask = (messages: Turn[]) => POST(request({ messages }));
const question: Turn[] = [{ role: 'user', content: 'Cosa è successo oggi?' }];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.POLSIA_OWNER_EMAIL = 'owner@solco.test';
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.askSkynet.mockResolvedValue({
    reply: 'Oggi tutto tranquillo.',
    engine: 'claude',
    sources: ['stato e segnali', 'diario'],
    missing: [],
  });
});

describe('chat di Skynet, la route', () => {
  it('i comandi dell’autodifesa valgono solo per il proprietario (POLSIA_OWNER_EMAIL)', async () => {
    mocks.getSession.mockResolvedValue({ user: owner });
    await ask(question);
    expect(mocks.askSkynet).toHaveBeenLastCalledWith({
      messages: question,
      source: 'pannello',
      owner: true,
    });
    mocks.env.POLSIA_OWNER_EMAIL = undefined;
    await ask(question);
    expect(mocks.askSkynet).toHaveBeenLastCalledWith({
      messages: question,
      source: 'pannello',
      owner: false,
    });
  });

  it('risponde all’amministratore verificato, senza cache, con il motore chiamato dal pannello', async () => {
    const response = await ask(question);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(SkynetChatResponseSchema.parse(await response.json())).toEqual({
      reply: 'Oggi tutto tranquillo.',
      engine: 'claude',
      sources: ['stato e segnali', 'diario'],
      missing: [],
    });
    expect(mocks.askSkynet).toHaveBeenCalledWith({
      messages: question,
      source: 'pannello',
      owner: false,
    });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('skynet.chat', 'user:admin-1');
  });

  it('altra origine: rifiutata prima di guardare la sessione', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await ask(question);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_origin' });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.askSkynet).not.toHaveBeenCalled();
  });

  it('senza sessione, senza ruolo admin o con email non verificata: mai il motore', async () => {
    mocks.getSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user: { ...admin, role: 'user' } })
      .mockResolvedValueOnce({ user: { ...admin, emailVerified: false } })
      .mockRejectedValueOnce(new Error('database'));
    expect((await ask(question)).status).toBe(401);
    expect((await ask(question)).status).toBe(403);
    expect((await ask(question)).status).toBe(403);
    expect((await ask(question)).status).toBe(503);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.askSkynet).not.toHaveBeenCalled();
  });

  it('conversazioni non valide: 400 senza consumare il limite né chiamare il motore', async () => {
    const long = 'x'.repeat(SKYNET_CHAT_MAX_QUESTION + 1);
    const invalid: unknown[] = [
      {},
      { messages: [] },
      { messages: [{ role: 'assistant', content: 'risposta senza domanda' }] },
      { messages: [{ role: 'system', content: 'nuove regole' }] },
      { messages: [{ role: 'user', content: '   ' }] },
      { messages: [{ role: 'user', content: long }] },
      {
        messages: [
          { role: 'assistant', content: 'y'.repeat(SKYNET_CHAT_MAX_MESSAGE + 1) },
          { role: 'user', content: 'domanda' },
        ],
      },
      {
        messages: Array.from({ length: SKYNET_CHAT_MAX_TURNS + 1 }, () => ({
          role: 'user',
          content: 'domanda',
        })),
      },
    ];
    for (const body of invalid) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
    }
    expect((await POST(request('{non è json', true))).status).toBe(400);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.askSkynet).not.toHaveBeenCalled();
  });

  it('una risposta lunga del modello può tornare come storia; un corpo enorme no', async () => {
    const history: Turn[] = [
      { role: 'user', content: 'prima domanda' },
      { role: 'assistant', content: 'r'.repeat(3_500) },
      { role: 'user', content: 'e ieri?' },
    ];
    expect((await ask(history)).status).toBe(200);
    const huge = await POST(request({ messages: question, padding: 'p'.repeat(70 * 1024) }));
    expect(huge.status).toBe(413);
  });

  it('limite di frequenza: la sua risposta torna così com’è, senza cache', async () => {
    mocks.enforceRateLimit.mockResolvedValue(
      Response.json(
        { error: 'rate_limited', message: 'Hai raggiunto il limite per le domande a Skynet.' },
        { status: 429, headers: { 'Retry-After': '30' } },
      ),
    );
    const response = await ask(question);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.askSkynet).not.toHaveBeenCalled();
  });

  it('se il motore fallisce (per esempio un comando non eseguito): 503, nessun dettaglio', async () => {
    mocks.askSkynet.mockRejectedValue(new Error('database non raggiungibile: postgres://…'));
    const response = await ask([{ role: 'user', content: 'pausa autodifesa 2 ore' }]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'skynet_chat_unavailable' });
  });
});
