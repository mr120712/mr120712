// @polsia:user-owned — «Skynet» e i due GPT-6 di MagnetAPI (gpt-6.2-sol, poi gpt-6.1-sol come
// riserva). Scelta del proprietario: GPT-6 è il primo motore della chat di Skynet e scrive le regole
// anti-scanner. MagnetAPI è un rivenditore TERZO: prima di partire, ogni testo passa da
// redactForThirdParty (segreti cancellati, IP mascherati come «203.0.x.x», email abbreviate come
// «u***@dominio»). La chiave va solo a https://api.magnetapi.org/v1 (nessun redirect seguito) e
// non compare mai in risposte o log.
import 'server-only';
import { MAGNETAPI_KEY_VARS, MAGNETAPI_URL } from '@/lib/business/magnetapi-status.server';
import { type ChatTurn, maskIpsInText, redactSecrets } from './chat';

type EnvLike = Record<string, string | undefined>;

/** I due GPT-6 di Skynet, in ordine: il più potente prima, l'altro se il primo non risponde. */
export const SKYNET_GPT6_MODELS = ['gpt-6.2-sol', 'gpt-6.1-sol'] as const;
export type SkynetGpt6Model = (typeof SKYNET_GPT6_MODELS)[number];

const EMAIL =
  /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;

/** Email abbreviate: «mario.rossi@gmail.com» → «m***@gmail.com». */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, '$1***@$2');
}

/** Tutto ciò che va a un servizio terzo: segreti cancellati, IP mascherati, email abbreviate. */
export function redactForThirdParty(text: string, secrets: readonly string[]): string {
  return maskEmails(maskIpsInText(redactSecrets(text, secrets)));
}

export function magnetapiKey(env: EnvLike = process.env): string | null {
  for (const name of MAGNETAPI_KEY_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export type Gpt6Request = {
  model: SkynetGpt6Model;
  system: string;
  messages: ChatTurn[];
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  /** I segreti da togliere (secretValues dell'ambiente): si applica a system e messaggi. */
  secrets: readonly string[];
  env?: EnvLike;
  fetchImpl?: typeof fetch;
};

/**
 * Una risposta di GPT-6, o null: senza chiave, su errore, timeout, risposta vuota o filtrata.
 * Non lancia mai.
 */
export async function gpt6Chat(request: Gpt6Request): Promise<string | null> {
  const key = magnetapiKey(request.env);
  if (!key) return null;
  const clean = (text: string) => redactForThirdParty(text, request.secrets);
  try {
    const res = await (request.fetchImpl ?? fetch)(`${MAGNETAPI_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(request.timeoutMs),
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.2,
        messages: [
          { role: 'system', content: clean(request.system) },
          ...request.messages.map((turn) => ({ role: turn.role, content: clean(turn.content) })),
        ],
      }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    } | null;
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') return null;
    const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
    return text || null;
  } catch {
    return null;
  }
}
