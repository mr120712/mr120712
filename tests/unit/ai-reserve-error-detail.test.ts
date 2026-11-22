// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { forwardChat, providerErrorDetail } from '@/lib/business/ai-reserve-connector.server';

const body = { model: 'x/y', messages: [{ role: 'user' as const, content: 'hi' }] };
const refusal = () =>
  new Response(JSON.stringify({ error: { message: 'No endpoints found' } }), { status: 404 });

describe('providerErrorDetail', () => {
  it('estrae il messaggio, una riga, al più 200 caratteri, chiavi mascherate', () => {
    expect(
      providerErrorDetail(
        'OpenRouter',
        404,
        JSON.stringify({ error: { message: 'No\n endpoints' } }),
      ),
    ).toBe('OpenRouter 404: No endpoints');
    expect(
      providerErrorDetail('X', 401, JSON.stringify({ error: 'bad key sk-or-v1-abcdef1234567890' })),
    ).toBe('X 401: bad key [chiave]');
    expect(providerErrorDetail('X', 500, 'z'.repeat(500)).length).toBeLessThanOrEqual(210);
    expect(providerErrorDetail('X', 502, '')).toBe('X 502');
  });
});

describe('forwardChat AI_RESERVE_ERROR_DETAIL', () => {
  it('di default la risposta resta identica (nessun detail)', async () => {
    const res = await forwardChat(
      body,
      { OPENROUTER_API_KEY: 'k', AI_RESERVE_PROVIDERS: 'openrouter' },
      vi.fn().mockResolvedValue(refusal()),
    );
    expect(await res.json()).toEqual({ error: 'upstream_error', status: 404 });
  });

  it('con AI_RESERVE_ERROR_DETAIL=1 aggiunge il motivo del provider', async () => {
    const res = await forwardChat(
      body,
      { OPENROUTER_API_KEY: 'k', AI_RESERVE_PROVIDERS: 'openrouter', AI_RESERVE_ERROR_DETAIL: '1' },
      vi.fn().mockResolvedValue(refusal()),
    );
    expect(await res.json()).toEqual({
      error: 'upstream_error',
      status: 404,
      detail: 'OpenRouter 404: No endpoints found',
    });
  });
});
