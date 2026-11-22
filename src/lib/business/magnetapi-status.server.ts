// @polsia:user-owned — MagnetAPI nel pannello admin, come provider «SOLO AGENTI». MagnetAPI è un
// rivenditore terzo di accesso ai modelli (GPT, Claude, …) che usano gli agenti di revisione
// (workers/ai-agents, workflow GitHub «AI agents»). NON fa parte della riserva AI del sito: non è in
// activeProviders/forwardChat, quindi i messaggi degli utenti non gli arrivano mai. Qui lo si
// interroga solo su /models (nessun token speso) per mostrare se la chiave funziona e quali modelli
// sblocca. Mai la chiave nella risposta: solo presente/assente e l'HTTP della sonda.
import 'server-only';
import {
  DISCOVER_MODELS_SAMPLE,
  type FetchLike,
  parseModelIds,
} from '@/lib/business/ai-reserve-connector.server';
import type { ReserveProviderView } from '@/lib/contracts/ai-reserve-providers';

type Env = Record<string, string | undefined>;

/** L'unico host a cui va la chiave (come nella policy degli agenti, workers/ai-agents/lib.mjs). */
export const MAGNETAPI_URL = 'https://api.magnetapi.org/v1';

/** Variabile della chiave su Vercel (la stessa del Secret GitHub degli agenti), poi un alias. */
export const MAGNETAPI_KEY_VARS = ['MAGNETAPI_API_KEY', 'MAGNET_API_KEY'] as const;

/** La catena di modelli degli agenti, in ordine (MAGNETAPI_CHAIN in workers/ai-agents/lib.mjs). */
export const MAGNETAPI_AGENT_CHAIN = [
  'gpt-6.2-sol',
  'claude-opus-5-5',
  'claude-fable-5-2',
  'gpt-6.1-sol',
] as const;

function magnetapiKey(env: Env): string | null {
  for (const name of MAGNETAPI_KEY_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** Stato di MagnetAPI per gli agenti: chiave presente? /models risponde? quali modelli sblocca? */
export async function magnetapiAgentsView(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<ReserveProviderView> {
  const base = {
    id: 'magnetapi',
    label: 'MagnetAPI',
    keyVar: MAGNETAPI_KEY_VARS[0],
    signupUrl: 'https://magnetapi.org',
  };
  const key = magnetapiKey(env);
  if (!key) {
    return {
      ...base,
      models: [...MAGNETAPI_AGENT_CHAIN],
      configured: false,
      status: 'not_configured',
      httpStatus: null,
      discoveredModels: [],
      discoveredCount: 0,
    };
  }
  let httpStatus: number | null = null;
  let all: string[] = [];
  try {
    const res = await fetchImpl(`${MAGNETAPI_URL}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error', // la chiave non deve seguire un redirect verso un altro host
      signal: AbortSignal.timeout(20_000),
    });
    httpStatus = res.status;
    if (res.ok) all = parseModelIds(await res.json().catch(() => null));
    else await res.body?.cancel().catch(() => undefined);
  } catch {
    httpStatus = null;
  }
  const ok = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
  // La catena REALE: i modelli della catena che la chiave elenca davvero (tutta la catena se la
  // sonda non ha risposto). I modelli scoperti mettono prima quelli della catena.
  const listed = new Set(all);
  const chain = ok
    ? MAGNETAPI_AGENT_CHAIN.filter((model) => listed.has(model))
    : [...MAGNETAPI_AGENT_CHAIN];
  const rank = (model: string) => {
    const at = (MAGNETAPI_AGENT_CHAIN as readonly string[]).indexOf(model);
    return at < 0 ? MAGNETAPI_AGENT_CHAIN.length : at;
  };
  const sorted = [...all].sort((a, b) => rank(a) - rank(b));
  return {
    ...base,
    models: chain,
    configured: true,
    status: ok ? 'live' : 'failing',
    httpStatus,
    discoveredModels: sorted.slice(0, DISCOVER_MODELS_SAMPLE),
    discoveredCount: all.length,
  };
}
