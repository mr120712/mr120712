// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockAiConfigurationError extends Error {}
  return {
    stream: vi.fn(),
    keyUsable: vi.fn(),
    classifyAnthropicError: vi.fn(),
    chat: vi.fn(),
    premiumAccessSource: vi.fn(),
    monthlyPlays: vi.fn(),
    monthlyFeaturedPlays: vi.fn(),
    listeningCount: vi.fn(),
    MockAiConfigurationError,
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/ai-anthropic.server', () => ({
  AI_CLIENT_TIMEOUT_MS: 100_000,
  anthropicApiKey: () => 'sk-ant-api-test',
  anthropicClient: () => ({ beta: { messages: { stream: mocks.stream } } }),
  classifyAnthropicError: mocks.classifyAnthropicError,
  keyUsable: mocks.keyUsable,
  logAiFailure: vi.fn(),
  rememberKeyOk: vi.fn(),
}));
vi.mock('@/lib/ai/client', () => ({
  chat: mocks.chat,
  AiConfigurationError: mocks.MockAiConfigurationError,
}));
vi.mock('@/lib/business/premium-access.server', () => ({
  premiumAccessSource: mocks.premiumAccessSource,
}));
vi.mock('@/lib/business/play-quota.server', () => ({
  monthlyPlays: mocks.monthlyPlays,
  monthlyFeaturedPlays: mocks.monthlyFeaturedPlays,
}));
vi.mock('@/lib/db', () => ({ prisma: { listeningEntry: { count: mocks.listeningCount } } }));

import {
  readAccountStatus,
  runSupportAgent,
  SUPPORT_AGENT_SYSTEM_PROMPT,
  toClaudeMessages,
} from '@/lib/business/solco-support-agent.server';
import {
  SUPPORT_NOT_CONFIGURED,
  SUPPORT_OUT_OF_SCOPE,
  SUPPORT_TEMPORARY_ERROR,
} from '@/lib/business/solco-support-policy';

type FakeTurn = { deltas: string[]; message: Record<string, unknown> } | { error: Error };

/** Uno stream finto dell'SDK: emette i testi su `text`, poi `finalMessage()` risolve il messaggio. */
function fakeStreams(turns: FakeTurn[]) {
  const queue = [...turns];
  mocks.stream.mockImplementation(() => {
    const turn = queue.shift();
    if (!turn) throw new Error('Nessun turno finto rimasto.');
    let onText: (delta: string) => void = () => {};
    return {
      request_id: 'req_test',
      on(event: string, callback: (delta: string) => void) {
        if (event === 'text') onText = callback;
        return this;
      },
      async finalMessage() {
        if ('error' in turn) throw turn.error;
        for (const delta of turn.deltas) onText(delta);
        return turn.message;
      },
    };
  });
}

async function answer(input: Partial<Parameters<typeof runSupportAgent>[0]> = {}) {
  let text = '';
  await runSupportAgent({
    turns: [{ role: 'user', content: 'Quanti ascolti mi restano?' }],
    user: { id: 'user-1', emailVerified: true },
    emit: (chunk) => {
      text += chunk;
    },
    ...input,
  });
  return text;
}

const toolUse = {
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'tool_use', id: 'toolu_1', name: 'stato_account', input: {} },
  ],
};

describe('agente di assistenza Solco', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.keyUsable.mockReturnValue(true);
    mocks.premiumAccessSource.mockResolvedValue(null);
    mocks.monthlyPlays.mockResolvedValue(12);
    mocks.monthlyFeaturedPlays.mockResolvedValue(3);
    mocks.listeningCount.mockResolvedValue(5);
  });

  it('chiama stato_account per l’utente della sessione e risponde in streaming', async () => {
    fakeStreams([
      { deltas: ['Controllo il tuo account.'], message: toolUse },
      {
        deltas: ['Ti restano ', '28 ascolti.'],
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '…' }] },
      },
    ]);

    expect(await answer()).toBe('Controllo il tuo account.\n\nTi restano 28 ascolti.');
    expect(mocks.premiumAccessSource).toHaveBeenCalledWith('user-1');

    const second = mocks.stream.mock.calls[1]?.[0];
    // Il turno dell'assistente torna invariato (ragionamento compreso), poi il risultato.
    expect(second.messages.at(-2)).toEqual({ role: 'assistant', content: toolUse.content });
    const result = second.messages.at(-1).content[0];
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(JSON.parse(result.content)).toMatchObject({
      connesso: true,
      piano: 'Free',
      ascolti_brani_e_podcast: { usati: 12, limite: 40, rimasti: 28 },
      ascolti_brani_in_evidenza: { usati: 3, limite: 30, rimasti: 27 },
      registrazioni_diario: { usate: 5, limite: 40, rimaste: 35 },
    });
  });

  it('invia a Claude il prompt fisso in cache, effort basso e il fallback lato server', async () => {
    fakeStreams([{ deltas: ['Ok.'], message: { stop_reason: 'end_turn', content: [] } }]);
    await answer();
    const params = mocks.stream.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      output_config: { effort: 'low' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      system: [{ text: SUPPORT_AGENT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    });
    expect(params.tools.map((tool: { name: string }) => tool.name)).toEqual(['stato_account']);
    // Nessun dato dell'utente nel prompt di sistema (resta identico, quindi in cache).
    expect(SUPPORT_AGENT_SYSTEM_PROMPT).not.toContain('user-1');
    expect(SUPPORT_AGENT_SYSTEM_PROMPT).toContain('<guida>');
    expect(SUPPORT_AGENT_SYSTEM_PROMPT).toContain('link="/guida#problemi"');
  });

  it('per un ospite lo strumento non legge nessun account', async () => {
    expect(await readAccountStatus(null)).toMatchObject({ connesso: false });
    expect(mocks.premiumAccessSource).not.toHaveBeenCalled();
    mocks.premiumAccessSource.mockResolvedValue('subscription');
    expect(await readAccountStatus({ id: 'user-2', emailVerified: false })).toMatchObject({
      piano: 'Premium (Abbonamento)',
      email_confermata: false,
      ascolti_brani_e_podcast: { limite: 'illimitati con Premium' },
    });
  });

  it('un rifiuto di sicurezza diventa la risposta fuori perimetro', async () => {
    fakeStreams([
      { deltas: [], message: { stop_reason: 'refusal', stop_details: null, content: [] } },
    ]);
    expect(await answer()).toBe(SUPPORT_OUT_OF_SCOPE);
  });

  it('senza chiave Claude usabile risponde la riserva (proxy) alla sola ultima domanda', async () => {
    mocks.keyUsable.mockReturnValue(false);
    mocks.chat.mockResolvedValue('Risposta dal proxy.');
    expect(await answer()).toBe('Risposta dal proxy.');
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.chat.mock.calls[0]?.[0].messages.at(-1)).toEqual({
      role: 'user',
      content: 'Quanti ascolti mi restano?',
    });

    mocks.chat.mockRejectedValueOnce(new mocks.MockAiConfigurationError());
    expect(await answer()).toBe(SUPPORT_NOT_CONFIGURED);
  });

  it('se Claude fallisce prima di scrivere prova la riserva; dopo, aggiunge l’errore', async () => {
    fakeStreams([{ error: new Error('connessione persa') }]);
    mocks.chat.mockResolvedValue('Risposta dal proxy.');
    expect(await answer()).toBe('Risposta dal proxy.');

    fakeStreams([
      { deltas: ['Controllo.'], message: toolUse },
      { error: new Error('connessione persa') },
    ]);
    expect(await answer()).toBe(`Controllo.\n\n${SUPPORT_TEMPORARY_ERROR}`);
  });

  it('la conversazione per Claude inizia da un messaggio dell’utente', () => {
    expect(
      toClaudeMessages([
        { role: 'assistant', content: 'Ciao!' },
        { role: 'user', content: 'Come cerco?' },
      ]),
    ).toEqual([{ role: 'user', content: 'Come cerco?' }]);
  });
});
