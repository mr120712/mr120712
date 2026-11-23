// @polsia:user-owned — endpoint chat per lo Space statico privato su Hugging Face
// (Solcomusic/deepseek-static-chat). La pagina gira nel browser e chiama Solco direttamente:
//  • autenticazione: Bearer SPACE_CHAT_API_KEY (chiave dedicata, revocabile da sola);
//  • CORS: solo le origini in SPACE_CHAT_ORIGINS (CSV), default l'origine dello Space;
//  • modello: la stessa catena di /ds e /admin/deepseek (askDeepseek → MWAPI chiave 1, poi 2).
// Nessun cookie, nessuna sessione: la chiave È l'autorizzazione.
import 'server-only';
import { bearerMatches } from '@/lib/business/ai-reserve-connector.server';

type Env = Record<string, string | undefined>;

export const SPACE_CHAT_DEFAULT_ORIGINS = [
  'https://solcomusic-deepseek-static-chat.static.hf.space',
];

export function spaceChatOrigins(env: Env = process.env): string[] {
  const listed = (env.SPACE_CHAT_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin));
  return listed.length > 0 ? listed : SPACE_CHAT_DEFAULT_ORIGINS;
}

/** Header CORS per l'origine della richiesta, solo se è fra quelle ammesse. */
export function spaceChatCors(request: Request, env: Env = process.env): Record<string, string> {
  const origin = request.headers.get('origin');
  const base = { Vary: 'Origin' };
  if (!origin || !spaceChatOrigins(env).includes(origin)) return base;
  return {
    ...base,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '600',
  };
}

export type SpaceChatAuth = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function authorizeSpaceChat(request: Request, env: Env = process.env): SpaceChatAuth {
  const secret = env.SPACE_CHAT_API_KEY?.trim();
  if (!secret || secret.length < 24) return { ok: false, status: 503, error: 'not_configured' };
  const token = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') ?? '').trim())?.[1];
  if (!token || !bearerMatches(token.trim(), secret)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

/** Risposta in formato SSE di OpenAI (un solo pezzo): la pagina dello Space legge lo stream. */
export function sseReply(reply: string, model: string): string {
  const chunk = {
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}
