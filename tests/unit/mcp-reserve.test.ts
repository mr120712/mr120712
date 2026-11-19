// @polsia:user-owned — unit del server MCP ospitato: handshake, elenco strumenti, chiamata agli
// strumenti (riserva finta, nessuna rete), notifiche e errori.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  handleMcpMessage,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  type McpToolDeps,
  runReserveTool,
} from '@/lib/business/mcp-reserve.server';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deps(over: Partial<McpToolDeps> = {}): McpToolDeps {
  return {
    forwardChat: vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ciao dalla riserva' } }] }),
    ),
    listModels: vi.fn(async () =>
      jsonResponse({ data: [{ id: 'llama-3.3-70b' }, { id: 'nemotron' }] }),
    ),
    ...over,
  };
}

describe('handleMcpMessage: handshake', () => {
  it('initialize rimanda la versione del client e annuncia gli strumenti', async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      {},
      deps(),
    )) as { result: { protocolVersion: string; capabilities: unknown; serverInfo: unknown } };
    expect(res.result.protocolVersion).toBe('2025-03-26');
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.serverInfo).toEqual(MCP_SERVER_INFO);
  });

  it('initialize senza versione usa quella di default', async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      {},
      deps(),
    )) as { result: { protocolVersion: string } };
    expect(res.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('tools/list elenca chat e list_models', async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {},
      deps(),
    )) as {
      result: { tools: { name: string }[] };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual(['chat', 'list_models']);
  });

  it('ping risponde con un risultato vuoto', async () => {
    const res = (await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, {}, deps())) as {
      result: object;
    };
    expect(res.result).toEqual({});
  });
});

describe('handleMcpMessage: notifiche e metodi sconosciuti', () => {
  it('una notifica (senza id) non riceve risposta', async () => {
    expect(
      await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}, deps()),
    ).toBeNull();
  });

  it('un metodo sconosciuto con id → errore -32601', async () => {
    const res = (await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'boh' }, {}, deps())) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32601);
  });
});

describe('handleMcpMessage: tools/call', () => {
  it('chat passa prompt/system/model alla riserva e ritorna il testo', async () => {
    const d = deps();
    const res = (await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'chat',
          arguments: { prompt: 'ciao', system: 'sii breve', model: 'auto', temperature: 0.5 },
        },
      },
      {},
      d,
    )) as { result: { content: { type: string; text: string }[] } };
    expect(res.result.content[0]).toEqual({ type: 'text', text: 'ciao dalla riserva' });
    const body = (d.forwardChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(body).toMatchObject({
      model: 'auto',
      temperature: 0.5,
      messages: [
        { role: 'system', content: 'sii breve' },
        { role: 'user', content: 'ciao' },
      ],
    });
  });

  it('list_models ritorna gli id uno per riga', async () => {
    const res = (await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_models', arguments: {} },
      },
      {},
      deps(),
    )) as { result: { content: { text: string }[] } };
    expect(res.result.content[0]?.text).toBe('llama-3.3-70b\nnemotron');
  });

  it('errore della riserva → tool-error (isError), non errore di protocollo', async () => {
    const res = (await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'chat', arguments: { prompt: 'x' } },
      },
      {},
      deps({ forwardChat: vi.fn(async () => jsonResponse({ error: 'boom' }, 502)) }),
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]?.text).toContain('HTTP 502');
  });

  it('strumento sconosciuto → isError', async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      {},
      deps(),
    )) as { result: { isError: boolean } };
    expect(res.result.isError).toBe(true);
  });
});

describe('runReserveTool', () => {
  it('chat con risposta vuota lancia', async () => {
    await expect(
      runReserveTool(
        'chat',
        { prompt: 'x' },
        {},
        deps({
          forwardChat: vi.fn(async () => jsonResponse({ choices: [{ message: {} }] })),
        }),
      ),
    ).rejects.toThrow(/vuota/);
  });
});
