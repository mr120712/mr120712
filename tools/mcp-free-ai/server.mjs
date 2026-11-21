#!/usr/bin/env node
// MCP connector for a free, OpenAI-compatible LLM endpoint.
//
// Zero dependencies. Speaks MCP over stdio (newline-delimited JSON-RPC 2.0), so
// any MCP client (Claude Code, Claude Desktop, …) can call it with `node server.mjs`.
//
// It talks ONLY to Solco's hosted reserve router (the FreeLLMAPI network runs on Solco alone):
//   LLM_BASE_URL = https://www.solcomusic.online/api/ai-reserve/v1   (default; optional)
//   LLM_API_KEY  = your FREELLMAPI_API_KEY (the reserve Bearer secret set on Vercel)
// LLM_BASE_URL may only point at a Solco host (solcomusic.online / www.solcomusic.online) over
// HTTPS; anything else is refused, so the key is never sent outside Solco.
//
// Tools exposed:
//   • chat         — send a prompt, get the model's reply (non-streaming)
//   • list_models  — list the models the endpoint serves (use the key to "find" them)
import process from 'node:process';

const SOLCO_RESERVE_URL = 'https://www.solcomusic.online/api/ai-reserve/v1';
const SOLCO_HOSTS = new Set(['solcomusic.online', 'www.solcomusic.online']);

/** The reserve URL, only on a Solco host over HTTPS; '' (refused) for anything else. */
function solcoBaseUrl(raw) {
  const value = (raw || SOLCO_RESERVE_URL).trim().replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !SOLCO_HOSTS.has(url.hostname.toLowerCase())) return '';
    if (url.username || url.password || url.search || url.hash) return '';
    return value;
  } catch {
    return '';
  }
}

const BASE_URL = solcoBaseUrl(process.env.LLM_BASE_URL);
const API_KEY = process.env.LLM_API_KEY || '';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'auto';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || '60000');
const SERVER = { name: 'free-ai-reserve', version: '1.0.0' };
const PROTOCOL = '2025-06-18';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function sendResult(id, payload) {
  send({ jsonrpc: '2.0', id, result: payload });
}
function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  {
    name: 'chat',
    description:
      'Ask the free AI model a question and get its reply (non-streaming). Routes through the ' +
      'configured OpenAI-compatible endpoint — Solco’s reserve (Groq / OpenRouter / Nemotron ' +
      'with automatic failover) or a local FreeLLMAPI.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user message to send.' },
        system: { type: 'string', description: 'Optional system instruction.' },
        model: { type: 'string', description: 'Optional model id; default "auto".' },
        temperature: { type: 'number', description: 'Optional sampling temperature (0–2).' },
        max_tokens: { type: 'integer', description: 'Optional max tokens in the reply.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_models',
    description:
      'List the models the configured endpoint serves (GET /models). Use this to discover which ' +
      'free models the key unlocks.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function httpJson(method, path, body) {
  if (!BASE_URL) {
    throw new Error(
      `LLM_BASE_URL must be Solco's reserve over HTTPS (default ${SOLCO_RESERVE_URL}); other hosts are refused.`,
    );
  }
  const headers = { accept: 'application/json' };
  if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callTool(name, args) {
  if (name === 'chat') {
    const messages = [];
    if (args.system) messages.push({ role: 'system', content: String(args.system) });
    messages.push({ role: 'user', content: String(args.prompt ?? '') });
    const payload = { model: args.model || DEFAULT_MODEL, messages, stream: false };
    if (typeof args.temperature === 'number') payload.temperature = args.temperature;
    if (typeof args.max_tokens === 'number') payload.max_tokens = args.max_tokens;
    const data = await httpJson('POST', '/chat/completions', payload);
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.length
      ? content
      : JSON.stringify(data).slice(0, 2000);
  }
  if (name === 'list_models') {
    const data = await httpJson('GET', '/models');
    const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
    return ids.length ? ids.join('\n') : JSON.stringify(data).slice(0, 2000);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        return sendResult(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER,
        });
      case 'tools/list':
        return sendResult(id, { tools: TOOLS });
      case 'tools/call': {
        const text = await callTool(params?.name, params?.arguments ?? {});
        return sendResult(id, { content: [{ type: 'text', text }] });
      }
      case 'ping':
        return sendResult(id, {});
      default:
        // Notifications (notifications/initialized, …) carry no id — ignore them.
        if (!isRequest) return;
        return sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!isRequest) return;
    // A failing tool call is a tool-level error (isError), not a protocol error.
    if (method === 'tools/call') {
      return sendResult(id, { content: [{ type: 'text', text: `Error: ${text}` }], isError: true });
    }
    return sendError(id, -32603, text);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // Ignore unparseable lines rather than crash the server.
      }
    }
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
