// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  activeProviders,
  baseUrlFrom,
  forwardChat,
} from '@/lib/business/ai-reserve-connector.server';

const def = {
  baseUrl: 'https://openrouter.ai/api/v1',
  baseUrlVar: 'OPENROUTER_BASE_URL',
  baseUrlDomain: 'openrouter.ai',
};
const at = (value: string) => baseUrlFrom(def, { OPENROUTER_BASE_URL: value });

describe('OPENROUTER_BASE_URL', () => {
  it("accetta l'endpoint UE (e normalizza lo slash finale)", () => {
    expect(at('https://eu.openrouter.ai/api/v1')).toBe('https://eu.openrouter.ai/api/v1');
    expect(at('https://eu.openrouter.ai/api/v1/')).toBe('https://eu.openrouter.ai/api/v1');
  });

  it.each([
    'http://eu.openrouter.ai/api/v1',
    'https://evil.example/v1',
    'https://openrouter.ai.evil.example/v1',
    'https://evilopenrouter.ai/v1',
    'https://user:pass@eu.openrouter.ai/api/v1',
    'https://eu.openrouter.ai:8443/api/v1',
    'not a url',
  ])('rifiuta %s → endpoint globale', (value) => {
    expect(at(value)).toBe('https://openrouter.ai/api/v1');
  });

  it('assente → endpoint globale; gli altri provider non cambiano', () => {
    expect(baseUrlFrom(def, {})).toBe('https://openrouter.ai/api/v1');
    const env = {
      OPENROUTER_API_KEY: 'o',
      GROQ_API_KEY: 'g',
      OPENROUTER_BASE_URL: 'https://eu.openrouter.ai/api/v1',
    };
    const urls = Object.fromEntries(activeProviders(env).map((p) => [p.id, p.baseUrl]));
    expect(urls.openrouter).toBe('https://eu.openrouter.ai/api/v1');
    expect(urls.groq).toBe('https://api.groq.com/openai/v1');
  });

  it('il resto della Riserva resta sull’endpoint globale se OPENROUTER_BASE_URL non è impostato', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    );
    await forwardChat(
      { messages: [{ role: 'user', content: 'hi' }] },
      { OPENROUTER_API_KEY: 'o', AI_RESERVE_PROVIDERS: 'openrouter' },
      fetchImpl,
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });
});
