// @polsia:user-owned — «Skynet», la chat (parte server). A ogni domanda del proprietario:
//   1. se è uno dei due comandi fissi («pausa autodifesa …», «riprendi autodifesa») lo esegue il
//      codice, senza passare da nessuna AI;
//   2. altrimenti Skynet TROVA TUTTO: legge insieme stato e segnali, diario (con la ricerca guidata
//      dalla domanda), firewall di Vercel, blocchi delle ultime 24 ore, controlli interni, deploy,
//      iscritti e visite — ogni fonte col suo tempo massimo, e chi non risponde viene dichiarato;
//   3. risponde Claude sul fascicolo completo; se non è raggiungibile, la riserva AI gratuita su
//      un fascicolo ridotto (solo conteggi e stati); se nemmeno quella, i fatti con parole fisse.
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
  switchAutodefense: (
    command: OwnerCommand,
    source: OwnerSource,
  ) => Promise<{ pausedUntil: string | null }>;
};

export type ChatAnswer = {
  reply: string;
  /** Chi ha scritto la risposta: Claude, la riserva AI, il codice (fatti) o un comando eseguito. */
  engine: ChatEngine;
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
    switchAutodefense: (command, origin) => switchAutodefense(command, origin),
  };
}

// ------------------------------------------------------------------ una domanda

const EMPTY_QUESTION =
  'Mi scriva una domanda: per esempio «Cosa è successo oggi?» o «Chi sta attaccando il sito?».';

/**
 * Una domanda del proprietario. `messages` è la conversazione (l'ultimo è la domanda), `source` da
 * dove arriva. Lancia solo se un comando non si riesce a eseguire; a una domanda risponde sempre.
 */
export async function askSkynet(
  input: { messages: ChatTurn[]; source: OwnerSource },
  options: Partial<ChatDeps> = {},
): Promise<ChatAnswer> {
  const deps: ChatDeps = { ...defaultChatDeps(), ...options };
  const secrets = secretValues(deps.env);
  const last = input.messages.at(-1);
  const question = cleanQuestion(last?.role === 'user' ? last.content : '', secrets);
  if (!question) return { reply: EMPTY_QUESTION, engine: 'facts', sources: [], missing: [] };

  const command = parseOwnerCommand(question);
  if (command) {
    const outcome = await deps.switchAutodefense(command, input.source);
    return {
      reply: commandReply(command, outcome.pausedUntil),
      engine: 'command',
      sources: [],
      missing: [],
    };
  }

  const dossier = await gatherDossier(question, deps);
  const { sources, missing } = dossierSources(dossier);
  const history = chatHistory(input.messages, secrets);
  const answer = (reply: string, engine: ChatEngine): ChatAnswer => ({
    reply: cleanReply(reply, secrets),
    engine,
    sources,
    missing,
  });

  const claude = await deps
    .askClaude(history, chatPrompt(renderDossier(dossier, 'full', secrets), question))
    .catch(() => null);
  if (claude?.trim()) return answer(claude, 'claude');
  // Alla riserva gratuita va il fascicolo ridotto: conteggi e stati, niente reti, percorsi o commit.
  const reserve = await deps
    .askReserve(history, chatPrompt(renderDossier(dossier, 'lite', secrets), question))
    .catch(() => null);
  if (reserve?.trim()) return answer(reserve, 'reserve');
  return answer(factsAnswer(dossier), 'facts');
}
