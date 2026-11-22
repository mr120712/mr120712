// @polsia:user-owned — MagnetAPI nel pannello admin («solo agenti»): sonda /models con la chiave,
// catena dei modelli degli agenti tra quelli elencati, nessun segreto nella vista. Rete finta.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { activeProviders } from '@/lib/business/ai-reserve-connector.server';
import {
  MAGNETAPI_AGENT_CHAIN,
  MAGNETAPI_URL,
  magnetapiAgentsView,
} from '@/lib/business/magnetapi-status.server';

const KEY = 'mk-test-secret-123';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('magnetapiAgentsView', () => {
  it('senza chiave: non configurato, nessuna richiesta, la catena attesa', async () => {
    const fetchImpl = fakeFetch(200, {});
    const view = await magnetapiAgentsView({}, fetchImpl);
    expect(view.status).toBe('not_configured');
    expect(view.configured).toBe(false);
    expect(view.keyVar).toBe('MAGNETAPI_API_KEY');
    expect(view.models).toEqual([...MAGNETAPI_AGENT_CHAIN]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('con chiave: interroga solo api.magnetapi.org/v1/models, catena = modelli elencati in ordine', async () => {
    const fetchImpl = fakeFetch(200, {
      data: [
        { id: 'gemini-4-carbon' },
        { id: 'gpt-6.1-sol' },
        { id: 'claude-opus-5-5' },
        { id: 'gpt-6.2-sol' },
      ],
    });
    const view = await magnetapiAgentsView({ MAGNETAPI_API_KEY: KEY }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MAGNETAPI_URL}/models`);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(init.redirect).toBe('error');
    expect(view.status).toBe('live');
    expect(view.httpStatus).toBe(200);
    // claude-fable-5-2 non è elencato: esce dalla catena; l'ordine resta quello degli agenti.
    expect(view.models).toEqual(['gpt-6.2-sol', 'claude-opus-5-5', 'gpt-6.1-sol']);
    expect(view.discoveredCount).toBe(4);
    expect(view.discoveredModels[0]).toBe('gpt-6.2-sol');
    expect(view.discoveredModels.at(-1)).toBe('gemini-4-carbon');
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it('chiave rifiutata (401): failing con lo status, nessun modello', async () => {
    const view = await magnetapiAgentsView(
      { MAGNET_API_KEY: KEY },
      fakeFetch(401, { error: 'invalid key' }),
    );
    expect(view.status).toBe('failing');
    expect(view.httpStatus).toBe(401);
    expect(view.discoveredCount).toBe(0);
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it('rete giù: failing senza status', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const view = await magnetapiAgentsView({ MAGNETAPI_API_KEY: KEY }, fetchImpl);
    expect(view.status).toBe('failing');
    expect(view.httpStatus).toBeNull();
  });

  it('MagnetAPI non entra mai nella riserva del sito (chat degli utenti)', () => {
    const ids = activeProviders({ MAGNETAPI_API_KEY: KEY, MAGNET_API_KEY: KEY }).map((p) => p.id);
    expect(ids).not.toContain('magnetapi');
  });
});

describe('reserveProvidersOverview · agenti', () => {
  it('MagnetAPI compare tra gli agenti, non tra i provider della riserva né nei loro conteggi', async () => {
    const { reserveProvidersOverview } = await import('@/lib/business/ai-reserve-status.server');
    const overview = await reserveProvidersOverview({}, new Date('2026-11-22T00:00:00Z'));
    expect(overview.agents.map((a) => a.id)).toEqual(['magnetapi']);
    expect(overview.agents[0]?.status).toBe('not_configured');
    expect(overview.providers.map((p) => p.id)).not.toContain('magnetapi');
    expect(overview.total).toBe(overview.providers.length);
  });
});
