// @polsia:user-owned — Skynet tiene aperto /api/space-chat/ allo Space statico su Hugging Face.
//
// Perché: lo Space chiama Solco dal browser di un altro sito. Se l'IP del browser è sotto verifica
// (Skynet mette in «verifica» anche IP condivisi, come quelli di iCloud Private Relay o WARP), Vercel
// risponde con la pagina di verifica, che una chiamata cross-site non può superare: lo Space vede un
// errore CORS. Una regola personalizzata «bypass» non basta, perché il firewall valuta le regole IP
// PRIMA delle regole personalizzate. Il bypass condizionale invece viene valutato per primo.
//
// L'endpoint ha comunque le sue difese: chiave dedicata (SPACE_CHAT_API_KEY), CORS solo per lo
// Space e il limite 'space.chat' (10 al minuto, 300 al giorno). Mai una regola altrui sovrascritta:
// se il dominio ha già un bypass condizionale diverso, Skynet lo lascia stare e lo segnala.
import 'server-only';

export const SPACE_CHAT_BYPASS_DOMAIN = 'solcomusic.online';
export const SPACE_CHAT_BYPASS_PATH = '/api/space-chat/';
const NOTE = 'Skynet · Space chat su Hugging Face (chiave, CORS e limite propri)';
const VERCEL_API = 'https://api.vercel.com';
const TIMEOUT_MS = 8_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type BypassAccess = { token: string; projectId: string; teamId: string | null };
export type BypassOutcome = 'present' | 'created' | 'conflict' | 'failed';

function query(access: BypassAccess, domain?: string) {
  const params = new URLSearchParams({ projectId: access.projectId });
  if (access.teamId) params.set('teamId', access.teamId);
  if (domain) params.set('domain', domain);
  return params.toString();
}

/** Cerca, nella risposta di Vercel (forma non documentata nei dettagli), le regole del dominio. */
export function bypassState(body: unknown, domain: string): 'ours' | 'other' | 'none' {
  const rules: unknown[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if ('conditionGroup' in record || 'conditions' in record) rules.push(record);
      else for (const inner of Object.values(record)) collect(inner);
    }
  };
  collect(body);
  const forDomain = rules.filter((rule) => {
    const ruleDomain = (rule as Record<string, unknown>).domain;
    return typeof ruleDomain !== 'string' || ruleDomain === domain;
  });
  if (forDomain.length === 0) return 'none';
  return forDomain.some((rule) => JSON.stringify(rule).includes(SPACE_CHAT_BYPASS_PATH))
    ? 'ours'
    : 'other';
}

export async function ensureSpaceChatBypass(
  access: BypassAccess,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  domain: string = SPACE_CHAT_BYPASS_DOMAIN,
): Promise<BypassOutcome> {
  const headers = {
    Authorization: `Bearer ${access.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  try {
    const current = await fetchImpl(
      `${VERCEL_API}/v1/security/firewall/bypass/rules?${query(access, domain)}`,
      { headers, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (current.ok) {
      const state = bypassState(await current.json().catch(() => null), domain);
      if (state === 'ours') return 'present';
      if (state === 'other') return 'conflict';
    } else if (current.status !== 404) {
      await current.body?.cancel().catch(() => {});
      return 'failed';
    } else {
      await current.body?.cancel().catch(() => {});
    }
    const created = await fetchImpl(
      `${VERCEL_API}/v1/security/firewall/bypass/rules?${query(access)}`,
      {
        method: 'POST',
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          domain,
          conditionGroup: [
            { conditions: [{ type: 'path', op: 'pre', value: SPACE_CHAT_BYPASS_PATH }] },
          ],
          note: NOTE,
        }),
      },
    );
    await created.body?.cancel().catch(() => {});
    return created.ok ? 'created' : 'failed';
  } catch {
    return 'failed';
  }
}
