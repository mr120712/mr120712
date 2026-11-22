// @polsia:user-owned — «Skynet», la chat (parte server). A ogni domanda del proprietario:
//   1. se è uno dei due comandi fissi («pausa autodifesa …», «riprendi autodifesa») lo esegue il
//      codice, senza passare da nessuna AI;
//   2. altrimenti Skynet TROVA TUTTO: legge insieme stato e segnali, diario (con la ricerca guidata
//      dalla domanda), firewall di Vercel, blocchi delle ultime 24 ore, controlli interni, deploy,
//      iscritti e visite — ogni fonte col suo tempo massimo, e chi non risponde viene dichiarato;
//   3. risponde GPT-6 (gpt-6.2-sol, poi gpt-6.1-sol, via MagnetAPI) sul fascicolo completo ma
//      ANONIMIZZATO (IP mascherati, email abbreviate: gpt6.server); poi Claude sul fascicolo completo;
//      poi la riserva AI gratuita su un fascicolo ridotto (solo conteggi e stati); se nessuno
//      risponde, i fatti con parole fisse. Tutti i motori stanno in un unico budget di tempo;
//   4. «genera regole scanner» (solo il proprietario): GPT-6 scrive regole anti-scanner, il codice le
//      verifica (scanner-rules.ts) e le propone. Skynet non le applica.
// Sola lettura: da qui non parte nessuna modifica, a parte la pausa dell'autodifesa chiesta dal
// proprietario. Niente segreti né indirizzi IP interi nel fascicolo e nella risposta (chat.ts); le
// domande non finiscono nei log.
import 'server-only';
import { getSignupStats } from '@/lib/admin/signups.server';
import { getVisitorStats } from '@/lib/admin/visitors.server';
import {
  anthropicApiKey,
  anthropicClient,
  classifyAnthropicError,
  keyUsable,
  logAiFailure,
  rememberKeyOk,
} from '@/lib/business/ai-anthropic.server';
import { freellmapiChat, freellmapiConfigured } from '@/lib/business/ai-freellmapi.server';
import type { AdminSignups } from '@/lib/contracts/admin-signups';
import type { AdminVisitors } from '@/lib/contracts/admin-visitors';
import type { MonitorHeartbeat, MonitorRun } from '@/lib/contracts/monitoring';
import { prisma } from '@/lib/db';
import { listHeartbeats, recentRuns } from '@/lib/monitoring/monitor.server';
import type { OwnerSource } from './autodefense';
import {
  CHAT_SYSTEM,
  CHAT_SYSTEM_GPT6,
  type ChatEngine,
  type ChatTurn,
  chatHistory,
  chatPrompt,
  checksBrief,
  cleanQuestion,
  cleanReply,
  commandReply,
  DIARY_PERIOD,
  DIARY_RECENT,
  DIARY_TOPIC,
  type DiaryBrief,
  type Dossier,
  diaryBrief,
  diarySearch,
  dossierSources,
  factsAnswer,
  type OwnerCommand,
  parseOwnerCommand,
  questionWindow,
  renderDossier,
  secretValues,
  signupsBrief,
  stateBrief,
  type TimeWindow,
  visitorsBrief,
} from './chat';
import {
  gpt6Chat,
  redactForThirdParty,
  SKYNET_GPT6_MODELS,
  type SkynetGpt6Model,
} from './gpt6.server';
import {
  checkRule,
  isScannerRulesCommand,
  parseProposedRules,
  SCANNER_RULES_SYSTEM,
  scannerRulesPrompt,
  scannerRulesReply,
} from './scanner-rules';
import {
  readVercelForChat,
  SKYNET_AI_MODEL,
  skynetOverview,
  switchAutodefense,
  type VercelForChat,
} from './sentinel.server';

/** Tempo massimo per fonte: una fonte lenta non blocca la risposta, viene dichiarata mancante. */
const SOURCE_TIMEOUT_MS = 6_000;
const VERCEL_TIMEOUT_MS = 10_000;
const CLAUDE_TIMEOUT_MS = 26_000;
const RESERVE_TIMEOUT_MS = 12_000;
/** Tempo massimo di ciascun GPT-6: il più potente ha più tempo, il secondo è la riserva rapida. */
const GPT6_TIMEOUT_MS: Record<SkynetGpt6Model, number> = {
  'gpt-6.2-sol': 20_000,
  'gpt-6.1-sol': 12_000,
};
/**
 * Budget di tempo per TUTTI i motori insieme, dopo la ricerca nelle fonti: le route (pannello e bot
 * Telegram) hanno 60 s in tutto. Un motore parte solo se restano almeno AI_MIN_MS.
 */
const AI_BUDGET_MS = 40_000;
const AI_MIN_MS = 4_000;
/** Le regole anti-scanner sono un JSON più lungo: più spazio e un po' più di tempo. */
const SCANNER_RULES_TIMEOUT_MS = 30_000;
/** Giri dei controlli interni letti per la chat (circa due giorni). */
const CHECK_RUNS = 48;

type EnvLike = Record<string, string | undefined>;

export type ChatDeps = {
  db: Pick<typeof prisma, 'skynetEvent'>;
  env: EnvLike;
  now: () => Date;
  overview: () => Promise<Parameters<typeof stateBrief>[0]>;
  vercel: () => Promise<VercelForChat | null>;
  runs: () => Promise<MonitorRun[]>;
  heartbeats: () => Promise<MonitorHeartbeat[]>;
  signups: (now: Date) => Promise<AdminSignups>;
  visitors: (now: Date) => Promise<AdminVisitors>;
  /** Il modello: la conversazione fin qui e l'ultimo messaggio (fascicolo + domanda). */
  askClaude: (history: ChatTurn[], prompt: string) => Promise<string | null>;
  askReserve: (history: ChatTurn[], prompt: string) => Promise<string | null>;
  /** GPT-6 via MagnetAPI: i testi vengono anonimizzati dentro (gpt6.server). */
  askGpt6: (
    model: SkynetGpt6Model,
    history: ChatTurn[],
    prompt: string,
    timeoutMs: number,
  ) => Promise<string | null>;
  /** GPT-6 per le regole anti-scanner (system e prompt di scanner-rules.ts). */
  askGpt6Rules: (
    model: SkynetGpt6Model,
    prompt: string,
    timeoutMs: number,
  ) => Promise<string | null>;
  switchAutodefense: (
    command: OwnerCommand,
    source: OwnerSource,
  ) => Promise<{ pausedUntil: string | null }>;
};

export type ChatAnswer = {
  reply: string;
  /** Chi ha scritto la risposta: Claude, la riserva AI, il codice (fatti) o un comando eseguito. */
  engine: ChatEngine;
  /** Il modello preciso, quando lo si sa (es. «gpt-6.2-sol»). */
  model?: string;
  /** Le fonti lette per rispondere, e quelle che non hanno risposto. */
  sources: string[];
  missing: string[];
};

/** Limita una promessa a `ms`; oltre, fallisce (la chiamata sotto si esaurisce da sola). */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Una fonte: il suo risultato, o null se sbaglia o non risponde in tempo. */
async function source<T>(work: () => Promise<T>, ms = SOURCE_TIMEOUT_MS): Promise<T | null> {
  try {
    return await withDeadline(Promise.resolve().then(work), ms);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ il diario

const DIARY_SELECT = {
  id: true,
  at: true,
  kind: true,
  severity: true,
  title: true,
  report: true,
  notified: true,
} as const;

/**
 * Il diario per questa domanda: quanti eventi nel periodo e di che tipo, gli eventi del periodo,
 * quelli che parlano dell'argomento (cercati in TUTTO il diario, se il proprietario non ha chiesto
 * un periodo preciso) e gli ultimi in assoluto.
 */
export async function readDiary(
  deps: Pick<ChatDeps, 'db'>,
  question: string,
  window: TimeWindow,
): Promise<DiaryBrief> {
  const search = diarySearch(question);
  const range = { gte: window.from, lte: window.to };
  const topic = [
    ...(search.kinds.length > 0 ? [{ kind: { in: search.kinds } }] : []),
    ...(search.keys.length > 0 ? [{ keys: { hasSome: search.keys } }] : []),
    ...search.terms.flatMap((term) => [
      { title: { contains: term, mode: 'insensitive' as const } },
      { report: { contains: term, mode: 'insensitive' as const } },
    ]),
  ];
  const events = deps.db.skynetEvent;
  const [total, oldest, byKind, topical, period, recent] = await Promise.all([
    events.count(),
    events.findFirst({ orderBy: { at: 'asc' }, select: { at: true } }),
    events.groupBy({ by: ['kind'], where: { at: range }, _count: { _all: true } }),
    topic.length > 0
      ? events.findMany({
          where: window.explicit ? { at: range, OR: topic } : { OR: topic },
          orderBy: { at: 'desc' },
          take: DIARY_TOPIC + 1,
          select: DIARY_SELECT,
        })
      : Promise.resolve(null),
    events.findMany({
      where: { at: range },
      orderBy: { at: 'desc' },
      take: DIARY_PERIOD + DIARY_TOPIC,
      select: DIARY_SELECT,
    }),
    events.findMany({
      orderBy: { at: 'desc' },
      take: DIARY_RECENT + DIARY_PERIOD + DIARY_TOPIC,
      select: DIARY_SELECT,
    }),
  ]);
  return diaryBrief({
    total,
    oldest: oldest?.at ?? null,
    byKind: byKind.map((group) => ({ kind: group.kind, count: group._count._all })),
    topical,
    topicalScope: window.explicit ? 'window' : 'all',
    period,
    recent,
  });
}

// ------------------------------------------------------------------ trovare tutto

/** Tutte le fonti insieme, ognuna col suo tempo massimo: chi non risponde resta null. */
export async function gatherDossier(question: string, deps: ChatDeps): Promise<Dossier> {
  const now = deps.now();
  const window = questionWindow(question, now);
  const [overview, diary, vercel, runs, heartbeats, signups, visitors] = await Promise.all([
    source(() => deps.overview()),
    source(() => readDiary(deps, question, window)),
    source(() => deps.vercel(), VERCEL_TIMEOUT_MS),
    source(() => deps.runs()),
    source(() => deps.heartbeats()),
    source(() => deps.signups(now)),
    source(() => deps.visitors(now)),
  ]);
  return {
    adesso: now.toISOString(),
    periodoDellaDomanda: {
      dal: window.from.toISOString(),
      al: window.to.toISOString(),
      descrizione: window.label,
      chiestoDalProprietario: window.explicit,
    },
    stato: overview ? stateBrief(overview) : null,
    diario: diary,
    firewall: vercel?.firewall ?? null,
    blocchi24ore: vercel?.blocks ?? null,
    controlliInterni: runs ? checksBrief(runs, heartbeats ?? []) : null,
    deploy: vercel?.deployments ?? null,
    iscritti: signups ? signupsBrief(signups) : null,
    visite: visitors ? visitorsBrief(visitors) : null,
  };
}

// ------------------------------------------------------------------ i modelli

/** Claude risponde sul fascicolo; null se la chiave manca, la chiamata fallisce o non conclude. */
export async function askClaudeChat(history: ChatTurn[], prompt: string): Promise<string | null> {
  const apiKey = anthropicApiKey();
  const now = Date.now();
  if (!keyUsable(apiKey, now)) return null;
  try {
    const response = await anthropicClient().beta.messages.create(
      {
        model: SKYNET_AI_MODEL,
        max_tokens: 3000,
        // Un rifiuto su Opus 5.5 viene ritentato dal server su un modello di riserva.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: CHAT_SYSTEM,
        // I dati sono già stati trovati e ordinati: al modello resta da leggerli e rispondere.
        output_config: { effort: 'low' },
        messages: [...history, { role: 'user', content: prompt }],
      },
      { signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS) },
    );
    rememberKeyOk(apiKey, now);
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();
    // Una risposta tagliata dal limite di lunghezza resta utile; un rifiuto o altro no.
    const usable =
      response.stop_reason === 'end_turn' || (response.stop_reason === 'max_tokens' && text);
    if (!usable) {
      logAiFailure('skynet_chat_stop', undefined, {
        stopReason: response.stop_reason,
        model: response.model,
        requestId: response._request_id ?? null,
      });
      return null;
    }
    return text || null;
  } catch (error) {
    classifyAnthropicError(error, apiKey, now);
    return null;
  }
}

/** La riserva AI gratuita (il router multi-provider di Solco) quando Claude non è disponibile. */
export async function askReserveChat(history: ChatTurn[], prompt: string): Promise<string | null> {
  if (!freellmapiConfigured()) return null;
  try {
    const text = await withDeadline(
      freellmapiChat({
        messages: [
          { role: 'system', content: CHAT_SYSTEM },
          ...history,
          { role: 'user', content: prompt },
        ],
        maxTokens: 1200,
        temperature: 0.2,
        signal: AbortSignal.timeout(RESERVE_TIMEOUT_MS),
      }),
      RESERVE_TIMEOUT_MS,
    );
    return text.trim() || null;
  } catch {
    return null;
  }
}

/** GPT-6 risponde sul fascicolo (già anonimizzato da gpt6Chat), con il system prompt da analista. */
export function askGpt6Chat(
  model: SkynetGpt6Model,
  history: ChatTurn[],
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  return gpt6Chat({
    model,
    system: CHAT_SYSTEM_GPT6,
    messages: [...history, { role: 'user', content: prompt }],
    maxTokens: 1500,
    temperature: 0.2,
    timeoutMs,
    secrets: secretValues(process.env),
  });
}

/** GPT-6 scrive le regole anti-scanner (risposta JSON, verificata poi da scanner-rules.ts). */
export function askGpt6RulesChat(
  model: SkynetGpt6Model,
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  return gpt6Chat({
    model,
    system: SCANNER_RULES_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 2500,
    temperature: 0.1,
    timeoutMs,
    secrets: secretValues(process.env),
  });
}

export function defaultChatDeps(): ChatDeps {
  return {
    db: prisma,
    env: process.env,
    now: () => new Date(),
    overview: () => skynetOverview(),
    vercel: () => readVercelForChat(),
    runs: () => recentRuns(CHECK_RUNS),
    heartbeats: () => listHeartbeats(),
    signups: (now) => getSignupStats(now),
    visitors: (now) => getVisitorStats(now),
    askClaude: askClaudeChat,
    askReserve: askReserveChat,
    askGpt6: askGpt6Chat,
    askGpt6Rules: askGpt6RulesChat,
    switchAutodefense: (command, origin) => switchAutodefense(command, origin),
  };
}

// ------------------------------------------------------------------ una domanda

/** Un comando dell'autodifesa scritto da chi non è il proprietario: non si esegue nulla. */
export const OWNER_ONLY_COMMAND =
  'Solo il proprietario può mettere in pausa o riprendere l’autodifesa. Non è stato cambiato nulla.';

/** Il comando delle regole anti-scanner scritto da chi non è il proprietario. */
export const OWNER_ONLY_SCANNER_RULES =
  'Solo il proprietario può chiedere a Skynet nuove regole anti-scanner. Non è stato cambiato nulla.';

export const SCANNER_RULES_UNAVAILABLE =
  'GPT-6 non è raggiungibile in questo momento (chiave MagnetAPI assente, rifiutata o servizio lento): nessuna regola anti-scanner generata. Riprovi fra poco.';

const EMPTY_QUESTION =
  'Mi scriva una domanda: per esempio «Cosa è successo oggi?» o «Chi sta attaccando il sito?».';

/**
 * Una domanda a Skynet. `messages` è la conversazione (l'ultimo è la domanda), `source` da dove
 * arriva, `owner` se chi scrive è il proprietario: solo allora i due comandi dell'autodifesa si
 * eseguono (per gli altri amministratori la risposta lo dice e non cambia nulla). Lancia solo se
 * un comando non si riesce a eseguire; a una domanda risponde sempre.
 */
export async function askSkynet(
  input: { messages: ChatTurn[]; source: OwnerSource; owner: boolean },
  options: Partial<ChatDeps> = {},
): Promise<ChatAnswer> {
  const deps: ChatDeps = { ...defaultChatDeps(), ...options };
  const secrets = secretValues(deps.env);
  const last = input.messages.at(-1);
  const question = cleanQuestion(last?.role === 'user' ? last.content : '', secrets);
  if (!question) return { reply: EMPTY_QUESTION, engine: 'facts', sources: [], missing: [] };

  const command = parseOwnerCommand(question);
  if (command) {
    if (input.owner !== true) {
      return { reply: OWNER_ONLY_COMMAND, engine: 'command', sources: [], missing: [] };
    }
    const outcome = await deps.switchAutodefense(command, input.source);
    return {
      reply: commandReply(command, outcome.pausedUntil),
      engine: 'command',
      sources: [],
      missing: [],
    };
  }

  if (isScannerRulesCommand(question)) {
    if (input.owner !== true) {
      return { reply: OWNER_ONLY_SCANNER_RULES, engine: 'command', sources: [], missing: [] };
    }
    return scannerRules(deps, secrets);
  }

  const dossier = await gatherDossier(question, deps);
  const { sources, missing } = dossierSources(dossier);
  const history = chatHistory(input.messages, secrets);
  const answer = (reply: string, engine: ChatEngine, model?: string): ChatAnswer => ({
    reply: cleanReply(reply, secrets),
    engine,
    ...(model ? { model } : {}),
    sources,
    missing,
  });

  // Un solo budget di tempo per tutti i motori: ognuno ha il suo massimo, mai oltre ciò che resta.
  const deadline = Date.now() + AI_BUDGET_MS;
  const within = async (ms: number, work: (timeoutMs: number) => Promise<string | null>) => {
    const left = deadline - Date.now();
    if (left < AI_MIN_MS) return null;
    const timeoutMs = Math.min(ms, left);
    return withDeadline(work(timeoutMs), timeoutMs).catch(() => null);
  };

  // GPT-6 sul fascicolo completo: lo anonimizza gpt6Chat (IP mascherati, email abbreviate).
  const fullPrompt = chatPrompt(renderDossier(dossier, 'full', secrets), question);
  for (const model of SKYNET_GPT6_MODELS) {
    const reply = await within(GPT6_TIMEOUT_MS[model], (ms) =>
      deps.askGpt6(model, history, fullPrompt, ms),
    );
    if (reply?.trim()) return answer(reply, 'gpt6', model);
  }
  const claude = await within(CLAUDE_TIMEOUT_MS, () => deps.askClaude(history, fullPrompt));
  if (claude?.trim()) return answer(claude, 'claude');
  // Alla riserva gratuita va il fascicolo ridotto: conteggi e stati, niente reti, percorsi o commit.
  const reserve = await within(RESERVE_TIMEOUT_MS, () =>
    deps.askReserve(history, chatPrompt(renderDossier(dossier, 'lite', secrets), question)),
  );
  if (reserve?.trim()) return answer(reserve, 'reserve');
  return answer(factsAnswer(dossier), 'facts');
}

/**
 * «genera regole scanner»: GPT-6 scrive le regole guardando i blocchi delle ultime 24 ore
 * (anonimizzati); il codice le verifica una per una (scanner-rules.ts) e la risposta propone solo
 * quelle valide. Nessuna modifica al firewall.
 */
async function scannerRules(deps: ChatDeps, secrets: readonly string[]): Promise<ChatAnswer> {
  const vercel = await source(() => deps.vercel(), VERCEL_TIMEOUT_MS);
  const blocks = vercel?.blocks ?? null;
  const brief = blocks
    ? redactForThirdParty(
        JSON.stringify({ blocchi24ore: blocks, firewall: vercel?.firewall ?? null }),
        secrets,
      )
    : null;
  const sources = blocks ? ['blocchi delle ultime 24 ore'] : [];
  const missing = blocks ? [] : ['blocchi delle ultime 24 ore'];
  const prompt = scannerRulesPrompt(brief);
  const deadline = Date.now() + AI_BUDGET_MS;
  for (const model of SKYNET_GPT6_MODELS) {
    const left = deadline - Date.now();
    if (left < AI_MIN_MS) break;
    const timeoutMs = Math.min(SCANNER_RULES_TIMEOUT_MS, left);
    const text = await withDeadline(deps.askGpt6Rules(model, prompt, timeoutMs), timeoutMs).catch(
      () => null,
    );
    const proposed = text ? parseProposedRules(text) : [];
    if (proposed.length === 0) continue; // risposta vuota o non JSON: prova il secondo GPT-6
    const checked = proposed.map(checkRule);
    return {
      reply: cleanReply(scannerRulesReply(checked, model), secrets),
      engine: 'gpt6',
      model,
      sources,
      missing,
    };
  }
  return { reply: SCANNER_RULES_UNAVAILABLE, engine: 'facts', sources, missing };
}
