// @polsia:user-owned — Server MCP (Model Context Protocol) OSPITATO da Solco, servito da
// src/app/api/mcp/route.ts. Espone la riserva AI gratuita (il router multi-provider: Groq,
// OpenRouter/Nemotron, …) come strumenti MCP — `chat` e `list_models` — su HTTP Streamable con
// JSON-RPC 2.0. Qui c'è solo la logica pura e iniettabile (decidere la risposta a un messaggio); la
// route fa autenticazione + HTTP. Non registra mai la chiave, il prompt o la risposta.
import 'server-only';
import {
  forwardChat as defaultForwardChat,
  listModels as defaultListModels,
  type ReserveChatBody,
} from '@/lib/business/ai-reserve-connector.server';

/** Versione di protocollo MCP di default (si rimanda a quella chiesta dal client, se la manda). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SERVER_INFO = { name: 'solco-free-ai', version: '1.0.0' } as const;

type Env = Record<string, string | undefined>;

export const MCP_TOOLS = [
  {
    name: 'chat',
    description:
      'Chiedi al modello AI gratuito e ricevi la risposta (non-streaming). Passa dalla riserva di ' +
      'Solco: Groq / OpenRouter / Nemotron con failover automatico.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Il messaggio da inviare.' },
        system: { type: 'string', description: 'Istruzione di sistema opzionale.' },
        model: { type: 'string', description: 'Id del modello opzionale; default "auto".' },
        temperature: { type: 'number', description: 'Temperatura opzionale (0–2).' },
        max_tokens: { type: 'integer', description: 'Massimo di token nella risposta.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_models',
    description: 'Elenca i modelli serviti dalla riserva (usa la chiave per «trovarli»).',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

export interface McpToolDeps {
  forwardChat: typeof defaultForwardChat;
  listModels: typeof defaultListModels;
}

const defaultDeps: McpToolDeps = {
  forwardChat: defaultForwardChat,
  listModels: defaultListModels,
};

/** Esegue uno strumento e ritorna il testo. Lancia su errore (lo chiamante lo mappa su isError). */
export async function runReserveTool(
  name: string,
  args: Record<string, unknown>,
  env: Env = process.env,
  deps: McpToolDeps = defaultDeps,
): Promise<string> {
  if (name === 'chat') {
    const messages: ReserveChatBody['messages'] = [];
    if (typeof args.system === 'string' && args.system) {
      messages.push({ role: 'system', content: args.system });
    }
    messages.push({
      role: 'user',
      content: typeof args.prompt === 'string' ? args.prompt : String(args.prompt ?? ''),
    });
    const body: ReserveChatBody = {
      model: typeof args.model === 'string' && args.model ? args.model : 'auto',
      messages,
      ...(typeof args.temperature === 'number' ? { temperature: args.temperature } : {}),
      ...(typeof args.max_tokens === 'number' ? { max_tokens: args.max_tokens } : {}),
    };
    const res = await deps.forwardChat(body, env);
    const data = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    if (!res.ok) throw new Error(`la riserva ha risposto con un errore (HTTP ${res.status})`);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('risposta vuota dalla riserva');
    }
    return content;
  }
  if (name === 'list_models') {
    const res = await deps.listModels(env);
    const data = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    if (!res.ok) throw new Error(`la riserva ha risposto con un errore (HTTP ${res.status})`);
    const ids = Array.isArray(data?.data)
      ? data.data.map((m) => m.id).filter((id): id is string => Boolean(id))
      : [];
    return ids.length > 0 ? ids.join('\n') : 'nessun modello disponibile';
  }
  throw new Error(`strumento sconosciuto: ${name}`);
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Gestisce un messaggio JSON-RPC MCP e ritorna l'oggetto risposta, oppure null per una NOTIFICA
 * (nessun id): il chiamante risponde allora con 202 senza corpo. Non lancia mai.
 */
export async function handleMcpMessage(
  message: JsonRpcMessage,
  env: Env = process.env,
  deps: McpToolDeps = defaultDeps,
): Promise<object | null> {
  const id = message?.id ?? null;
  const isRequest = message?.id !== undefined && message?.id !== null;
  const method = message?.method;
  const ok = (result: object) => ({ jsonrpc: '2.0' as const, id, result });
  const fail = (code: number, msg: string) => ({
    jsonrpc: '2.0' as const,
    id,
    error: { code, message: msg },
  });

  try {
    switch (method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        return ok({
          protocolVersion: typeof requested === 'string' ? requested : MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
        });
      }
      case 'tools/list':
        return ok({ tools: MCP_TOOLS });
      case 'tools/call': {
        const params = message.params ?? {};
        const toolName = typeof params.name === 'string' ? params.name : '';
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
        const text = await runReserveTool(toolName, toolArgs, env, deps);
        return ok({ content: [{ type: 'text', text }] });
      }
      case 'ping':
        return ok({});
      default:
        if (!isRequest) return null; // notifica (es. notifications/initialized)
        return fail(-32601, `metodo non trovato: ${method ?? ''}`);
    }
  } catch (error) {
    if (!isRequest) return null;
    const msg = error instanceof Error ? error.message : 'errore';
    // Un errore DELLO STRUMENTO è un tool-error (isError), non un errore di protocollo.
    if (method === 'tools/call') {
      return ok({ content: [{ type: 'text', text: `Errore: ${msg}` }], isError: true });
    }
    return fail(-32603, msg);
  }
}
