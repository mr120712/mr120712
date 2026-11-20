// @polsia:user-owned — unit dello stato dei provider della riserva: fonde il registro reale con la
// configurazione (activeProviders) e la sonda (probeProviders), queste ultime mockate (nessuna rete).
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  activeProviders: vi.fn(),
  probeProviders: vi.fn(),
}));

vi.mock('@/lib/business/ai-reserve-connector.server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/business/ai-reserve-connector.server')>();
  return {
    ...actual,
    activeProviders: mocks.activeProviders,
    probeProviders: mocks.probeProviders,
  };
});

import { reserveKnownProviders } from '@/lib/business/ai-reserve-connector.server';
import { reserveProvidersOverview } from '@/lib/business/ai-reserve-status.server';

const now = new Date('2026-11-20T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeProviders.mockReturnValue([]);
  mocks.probeProviders.mockResolvedValue([]);
});

describe('reserveKnownProviders', () => {
  it('elenca i 5 provider con variabile-chiave, URL di registrazione e modelli', () => {
    const known = reserveKnownProviders({});
    expect(known.map((p) => p.id)).toEqual(['groq', 'cerebras', 'gemini', 'mistral', 'openrouter']);
    for (const provider of known) {
      expect(provider.keyVar).toMatch(/_API_KEY$/);
      expect(provider.signupUrl).toMatch(/^https:\/\//);
      expect(provider.models.length).toBeGreaterThan(0);
    }
  });
});

describe('reserveProvidersOverview', () => {
  it('fonde registro, configurati e sonda in uno stato per provider', async () => {
    mocks.activeProviders.mockReturnValue([{ id: 'groq' }, { id: 'openrouter' }]);
    mocks.probeProviders.mockResolvedValue([
      { id: 'groq', label: 'Groq', status: 200, ok: true },
      { id: 'openrouter', label: 'OpenRouter', status: 429, ok: false },
    ]);
    const overview = await reserveProvidersOverview({}, now);
    const byId = Object.fromEntries(overview.providers.map((p) => [p.id, p]));

    expect(byId.groq?.status).toBe('live');
    expect(byId.groq?.httpStatus).toBe(200);
    expect(byId.openrouter?.status).toBe('failing');
    expect(byId.openrouter?.httpStatus).toBe(429);
    expect(byId.cerebras?.status).toBe('not_configured');
    expect(byId.gemini?.status).toBe('not_configured');
    expect(byId.mistral?.status).toBe('not_configured');

    expect(overview.liveCount).toBe(1);
    expect(overview.configuredCount).toBe(2);
    expect(overview.total).toBe(5);
    expect(overview.checkedAt).toBe(now.toISOString());
  });

  it('se la sonda fallisce del tutto, i provider con chiave risultano "failing"', async () => {
    mocks.activeProviders.mockReturnValue([{ id: 'groq' }]);
    mocks.probeProviders.mockRejectedValue(new Error('network'));
    const overview = await reserveProvidersOverview({}, now);
    const groq = overview.providers.find((p) => p.id === 'groq');
    expect(groq?.status).toBe('failing');
    expect(groq?.httpStatus).toBeNull();
    expect(overview.liveCount).toBe(0);
    expect(overview.configuredCount).toBe(1);
  });

  it('senza chiavi, tutti i provider sono "not_configured"', async () => {
    const overview = await reserveProvidersOverview({}, now);
    expect(overview.providers.every((p) => p.status === 'not_configured')).toBe(true);
    expect(overview.liveCount).toBe(0);
    expect(overview.configuredCount).toBe(0);
    expect(overview.total).toBe(5);
  });
});
