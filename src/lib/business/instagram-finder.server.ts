// @polsia:user-owned — «Trova creator Instagram» (solo admin). Pipeline:
//  1. l'AI (Riserva AI di Solco, in-process) trasforma la descrizione in ≤5 hashtag e parole chiave;
//  2. Hashtag Search: post pubblici top e recenti di ogni hashtag; le @menzioni nelle didascalie
//     (crediti, collaborazioni) diventano candidati, insieme agli username indicati dall'admin;
//  3. Business Discovery: dati pubblici reali di ogni candidato (solo account Business/Creator);
//  4. punteggio (pertinenza, engagement, attività) e riordino dell'AI con un motivo per ciascuno.
// Nulla viene salvato: i risultati vivono solo nella risposta.
import 'server-only';
import { forwardChat } from '@/lib/business/ai-reserve-connector.server';
import {
  businessDiscovery,
  type GraphMedia,
  type GraphProfile,
  hashtagId,
  hashtagMedia,
  INSTAGRAM_USERNAME,
  type InstagramGraphConfig,
  InstagramGraphError,
} from '@/lib/business/instagram-graph.server';
import type {
  InstagramCreator,
  InstagramFinderRequest,
  InstagramFinderResponse,
  InstagramPost,
} from '@/lib/contracts/instagram-finder';

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export const MAX_HASHTAGS = 5;
export const MAX_CANDIDATES = 30;
const DISCOVERY_CONCURRENCY = 5;
const AI_TIMEOUT_MS = 25_000;
/** Tempo totale della ricerca (la route ha maxDuration 90; il bot Telegram ne passa uno più corto). */
const DEFAULT_BUDGET_MS = 80_000;

function envMs(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(max, Math.max(min, parsed)) : fallback;
}

// ---------------------------------------------------------------- AI (Riserva AI, JSON)

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

async function askJson(
  system: string,
  user: string,
  env: Env,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const aiTimeout = envMs(env.INSTAGRAM_FINDER_AI_TIMEOUT_MS, AI_TIMEOUT_MS, 8_000, 40_000);
  const providers =
    env.INSTAGRAM_FINDER_PROVIDERS?.trim() ||
    env.DEEPSEEK_SOLCO_PROVIDERS?.trim() ||
    'mwapi,mwapi-2';
  try {
    const res = await forwardChat(
      {
        model: 'auto',
        messages: [
          { role: 'system', content: `${system}\nRispondi SOLO con un oggetto JSON valido.` },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      },
      {
        ...env,
        AI_RESERVE_PROVIDERS: providers,
        AI_RESERVE_CHAIN_BUDGET_MS: String(aiTimeout),
        AI_RESERVE_ATTEMPT_TIMEOUT_MS: String(aiTimeout - 3_000),
      },
      fetchImpl,
    );
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null } }[];
    } | null;
    const content = body?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? extractJson(content) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- 1. piano

export function normalizeHashtag(value: string): string | null {
  const tag = value.trim().replace(/^#+/, '').toLowerCase();
  return /^[\p{L}\p{N}_]{2,50}$/u.test(tag) ? tag : null;
}

const STOPWORDS = new Set(
  'che con per una uno gli le dei delle del della di da in su tra fra and the for with from who are'.split(
    ' ',
  ),
);

/** Parole chiave della descrizione, senza AI: base del punteggio e piano di riserva. */
export function briefKeywords(brief: string): string[] {
  const words = brief
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word) && !/^\d+k?$/.test(word));
  return [...new Set(words)].slice(0, 10);
}

interface Plan {
  hashtags: string[];
  keywords: string[];
  summary: string;
}

async function makePlan(
  request: InstagramFinderRequest,
  env: Env,
  fetchImpl: FetchLike,
): Promise<{ plan: Plan; ai: boolean }> {
  const given = request.hashtags.map(normalizeHashtag).filter((tag): tag is string => !!tag);
  const fallbackKeywords = briefKeywords(request.brief);
  const raw = (await askJson(
    'Sei un esperto di influencer marketing musicale su Instagram. Dalla richiesta ricava: ' +
      '"hashtags" (al massimo 5, senza #, quelli che i creator giusti usano davvero, specifici e ' +
      'non generici come #music), "keywords" (al massimo 8 parole che compaiono nelle bio o nelle ' +
      'didascalie dei creator giusti, anche in inglese) e "summary" (una frase in italiano).',
    request.brief,
    env,
    fetchImpl,
  )) as { hashtags?: unknown; keywords?: unknown; summary?: unknown } | undefined;
  const aiTags = Array.isArray(raw?.hashtags)
    ? raw.hashtags.map((tag) => (typeof tag === 'string' ? normalizeHashtag(tag) : null))
    : [];
  const aiKeywords = Array.isArray(raw?.keywords)
    ? raw.keywords
        .filter((word): word is string => typeof word === 'string')
        .map((w) => w.toLowerCase().trim())
    : [];
  // Ogni hashtag nuovo consuma il budget di Meta (30 diversi ogni 7 giorni): le parole della
  // richiesta diventano hashtag solo se mancano sia quelli indicati sia quelli dell'AI.
  const chosen = [...given, ...aiTags.filter((tag): tag is string => !!tag)];
  const fallbackTags = fallbackKeywords
    .map(normalizeHashtag)
    .filter((tag): tag is string => !!tag)
    .slice(0, 3);
  const hashtags = [...new Set(chosen.length > 0 ? chosen : fallbackTags)].slice(0, MAX_HASHTAGS);
  const keywords = [...new Set([...aiKeywords.filter(Boolean), ...fallbackKeywords])].slice(0, 14);
  const summary =
    typeof raw?.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim().slice(0, 300)
      : `Creator per: ${request.brief.slice(0, 200)}`;
  return { plan: { hashtags, keywords, summary }, ai: raw !== undefined };
}

/** Username di account pubblici (creator, artisti, etichette, brand) proposti dall'AI. */
async function suggestUsernames(brief: string, env: Env, fetchImpl: FetchLike): Promise<string[]> {
  const raw = (await askJson(
    'Proponi fino a 20 username Instagram di account PUBBLICI professionali (creator, artisti, ' +
      'producer, etichette, media, brand) adatti alla richiesta. Solo account che sei sicuro ' +
      'esistano e siano pubblici e professionali: mai persone private. Formato: ' +
      '{"usernames":["…"]}, senza @.',
    brief,
    env,
    fetchImpl,
  )) as { usernames?: unknown } | undefined;
  if (!Array.isArray(raw?.usernames)) return [];
  return [
    ...new Set(
      raw.usernames
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.trim().replace(/^@/, '').toLowerCase())
        .filter((name) => INSTAGRAM_USERNAME.test(name)),
    ),
  ].slice(0, 20);
}

// ---------------------------------------------------------------- 2. post e menzioni

const MENTION = /(?:^|[^\w.@])@([A-Za-z0-9._]{1,30})/g;

export function captionMentions(caption: string): string[] {
  const found: string[] = [];
  for (const match of caption.matchAll(MENTION)) {
    const name = match[1]?.replace(/\.+$/, '').toLowerCase();
    if (name && INSTAGRAM_USERNAME.test(name)) found.push(name);
  }
  return found;
}

// ---------------------------------------------------------------- 3. metriche

export function profileMetrics(profile: GraphProfile, keywords: string[]) {
  const media = (profile.media?.data ?? []).slice(0, 12);
  const followers = Math.max(0, profile.followers_count ?? 0);
  const likes = media.map((item) => item.like_count ?? 0);
  const comments = media.map((item) => item.comments_count ?? 0);
  const avg = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const avgLikes = avg(likes);
  const avgComments = avg(comments);
  const engagementRate = followers > 0 ? Math.min(1, (avgLikes + avgComments) / followers) : 0;
  const lastPostAt =
    media
      .map((item) => item.timestamp)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;
  const text = [profile.biography ?? '', profile.name ?? '', ...media.map((m) => m.caption ?? '')]
    .join(' ')
    .toLowerCase();
  const hits = keywords.filter((word) => word && text.includes(word)).length;
  return { followers, avgLikes, avgComments, engagementRate, lastPostAt, keywordHits: hits };
}

/** Punteggio 0–100 senza AI: pertinenza 50, engagement 30 (5% = pieno), attività 20. */
export function heuristicScore(
  metrics: ReturnType<typeof profileMetrics>,
  keywordCount: number,
  now: Date,
): number {
  const relevance =
    keywordCount > 0 ? Math.min(1, metrics.keywordHits / Math.min(4, keywordCount)) : 0;
  const engagement = Math.min(1, metrics.engagementRate / 0.05);
  const days = metrics.lastPostAt
    ? (now.getTime() - new Date(metrics.lastPostAt).getTime()) / 86_400_000
    : Number.POSITIVE_INFINITY;
  const activity = days <= 14 ? 1 : days <= 60 ? 0.6 : days <= 180 ? 0.25 : 0;
  return Math.round(relevance * 50 + engagement * 30 + activity * 20);
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index] as T);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------- pipeline

export type InstagramFinderOutcome =
  | { ok: true; result: InstagramFinderResponse }
  | { ok: false; error: InstagramGraphError['failure']; detail?: string };

export async function findInstagramCreators(
  request: InstagramFinderRequest,
  config: InstagramGraphConfig,
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<InstagramFinderOutcome> {
  const warnings: string[] = [];
  // Ogni fase parte solo se resta tempo: meglio un risultato parziale che una risposta persa.
  const startedAt = Date.now();
  const budget = envMs(env.INSTAGRAM_FINDER_BUDGET_MS, DEFAULT_BUDGET_MS, 20_000, 85_000);
  const timeLeft = (share: number) => Date.now() - startedAt < budget * share;
  const { plan, ai: aiPlanned } = await makePlan(request, env, fetchImpl);
  if (!aiPlanned)
    warnings.push('AI non disponibile: hashtag ricavati dalle parole della richiesta.');

  // 2. Post per hashtag (top + recenti), con le menzioni come candidati.
  const posts: InstagramPost[] = [];
  const mentionCount = new Map<string, { count: number; via: Set<string> }>();
  let fatal: InstagramGraphError | null = null;
  // INSTAGRAM_HASHTAG_SEARCH=off: niente Hashtag Search (serve la funzione «Instagram Public
  // Content Access», approvata da Meta). I candidati arrivano allora dall'AI e dagli username
  // indicati, e Business Discovery (senza quella revisione) li verifica.
  const hashtagSearchOff = /^(off|0|false|no)$/i.test(env.INSTAGRAM_HASHTAG_SEARCH?.trim() ?? '');
  for (const tag of hashtagSearchOff ? [] : plan.hashtags) {
    if (!timeLeft(0.45)) {
      warnings.push(`Tempo esaurito: hashtag non cercati da #${tag} in poi.`);
      break;
    }
    try {
      const id = await hashtagId(config, tag, fetchImpl);
      if (!id) {
        warnings.push(`#${tag}: hashtag non trovato.`);
        continue;
      }
      const [top, recent] = await Promise.all([
        hashtagMedia(config, id, 'top_media', fetchImpl),
        hashtagMedia(config, id, 'recent_media', fetchImpl).catch(() => [] as GraphMedia[]),
      ]);
      const seen = new Set<string>();
      for (const item of [...top, ...recent]) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const caption = item.caption ?? '';
        if (item.permalink?.startsWith('https://www.instagram.com/')) {
          posts.push({
            permalink: item.permalink,
            caption: caption.slice(0, 280),
            likes: item.like_count ?? 0,
            comments: item.comments_count ?? 0,
            hashtag: tag,
            timestamp: item.timestamp ?? null,
          });
        }
        for (const name of new Set(captionMentions(caption))) {
          const entry = mentionCount.get(name) ?? { count: 0, via: new Set<string>() };
          entry.count += 1;
          entry.via.add(`#${tag}`);
          mentionCount.set(name, entry);
        }
      }
    } catch (error) {
      if (!(error instanceof InstagramGraphError)) throw error;
      if (error.failure === 'auth' || error.failure === 'permission') {
        fatal = error;
        break;
      }
      warnings.push(`#${tag}: ${error.message}`);
      if (error.failure === 'rate_limited' || error.failure === 'hashtag_limit') break;
    }
  }
  // Token rifiutato: nessun'altra chiamata può riuscire.
  if (fatal?.failure === 'auth') return { ok: false, error: 'auth', detail: fatal.message };
  if (fatal) {
    warnings.push(
      `Ricerca per hashtag non disponibile (${fatal.message}): uso i creator suggeriti dall'AI, verificati su Instagram.`,
    );
  }
  if (hashtagSearchOff) {
    warnings.push(
      "Ricerca per hashtag disattivata: creator suggeriti dall'AI, verificati su Instagram.",
    );
  }

  // 3. Candidati: prima gli username indicati, poi le menzioni più frequenti.
  const via = new Map<string, Set<string>>();
  for (const name of request.usernames) via.set(name.toLowerCase(), new Set(['manuale']));
  const ranked = [...mentionCount.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [name, entry] of ranked) {
    if (via.size >= MAX_CANDIDATES) break;
    if (!via.has(name)) via.set(name, entry.via);
  }
  // Pochi candidati dagli hashtag (o hashtag non disponibili): l'AI propone account pubblici;
  // Business Discovery scarta quelli inventati o personali, quindi restano solo profili reali.
  if (via.size < 10 && timeLeft(0.6)) {
    for (const name of await suggestUsernames(request.brief, env, fetchImpl)) {
      if (via.size >= MAX_CANDIDATES) break;
      if (!via.has(name)) via.set(name, new Set(['suggerito AI']));
    }
  }
  const candidates = [...via.keys()].slice(0, MAX_CANDIDATES);

  let discoveryError: InstagramGraphError | null = null;
  let outOfTime = false;
  const profiles = await mapLimited(candidates, DISCOVERY_CONCURRENCY, async (name) => {
    if (discoveryError) return null;
    if (!timeLeft(0.85)) {
      outOfTime = true;
      return null;
    }
    try {
      return await businessDiscovery(config, name, fetchImpl);
    } catch (error) {
      if (error instanceof InstagramGraphError) {
        discoveryError ??= error;
        return null;
      }
      throw error;
    }
  });
  if (discoveryError) {
    const failure = (discoveryError as InstagramGraphError).failure;
    const message = (discoveryError as InstagramGraphError).message;
    if (
      profiles.every((profile) => profile === null) &&
      (failure === 'auth' || failure === 'permission')
    ) {
      return { ok: false, error: failure, detail: message };
    }
    warnings.push(`Business Discovery interrotta: ${message}`);
  }

  if (outOfTime) warnings.push('Tempo esaurito: alcuni profili non sono stati controllati.');
  const keywordCount = plan.keywords.length;
  let creators: InstagramCreator[] = profiles.flatMap((profile, index) => {
    if (!profile) return [];
    const metrics = profileMetrics(profile, plan.keywords);
    if (request.minFollowers !== undefined && metrics.followers < request.minFollowers) return [];
    if (request.maxFollowers !== undefined && metrics.followers > request.maxFollowers) return [];
    const name = candidates[index] as string;
    const website = profile.website?.startsWith('http') ? profile.website : null;
    const picture = profile.profile_picture_url?.startsWith('https://')
      ? profile.profile_picture_url
      : null;
    return [
      {
        username: profile.username,
        name: profile.name ?? null,
        biography: profile.biography?.slice(0, 400) ?? null,
        website,
        profilePictureUrl: picture,
        followers: metrics.followers,
        mediaCount: profile.media_count ?? 0,
        avgLikes: Math.round(metrics.avgLikes),
        avgComments: Math.round(metrics.avgComments),
        engagementRate: metrics.engagementRate,
        lastPostAt: metrics.lastPostAt,
        foundVia: [...(via.get(name) ?? [])],
        score: heuristicScore(metrics, keywordCount, now),
        reason: `${metrics.keywordHits} parole chiave in bio/post · engagement ${(metrics.engagementRate * 100).toFixed(1)}%`,
      },
    ];
  });
  const skipped = candidates.length - profiles.filter(Boolean).length;

  // 4. Riordino dell'AI (con motivo); se non risponde resta il punteggio calcolato.
  let aiRanked = false;
  if (creators.length > 0 && !timeLeft(0.75)) {
    warnings.push("Tempo esaurito: ordine calcolato senza il riordino dell'AI.");
  } else if (creators.length > 0) {
    const compact = creators.map((creator) => ({
      username: creator.username,
      bio: creator.biography?.slice(0, 200) ?? '',
      followers: creator.followers,
      engagement: Number((creator.engagementRate * 100).toFixed(2)),
      lastPostAt: creator.lastPostAt,
      score: creator.score,
    }));
    const raw = (await askJson(
      'Valuti creator Instagram per una collaborazione musicale. Per ogni profilo dai "score" ' +
        '(0–100: quanto è adatto alla richiesta, considerando pertinenza della bio, engagement e ' +
        'attività) e "reason" (una frase in italiano, concreta). Formato: ' +
        '{"ranking":[{"username":"…","score":0,"reason":"…"}]}. Usa solo i dati forniti.',
      JSON.stringify({ richiesta: request.brief, profili: compact }),
      env,
      fetchImpl,
    )) as { ranking?: unknown } | undefined;
    if (Array.isArray(raw?.ranking)) {
      const byName = new Map(
        raw.ranking.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const { username, score, reason } = entry as Record<string, unknown>;
          if (typeof username !== 'string' || typeof score !== 'number') return [];
          return [[username.toLowerCase(), { score, reason }] as const];
        }),
      );
      if (byName.size > 0) {
        aiRanked = true;
        creators = creators.map((creator) => {
          const verdict = byName.get(creator.username.toLowerCase());
          if (!verdict) return creator;
          return {
            ...creator,
            score: Math.round(
              Math.max(0, Math.min(100, verdict.score)) * 0.7 + creator.score * 0.3,
            ),
            reason:
              typeof verdict.reason === 'string' && verdict.reason.trim()
                ? verdict.reason.trim().slice(0, 300)
                : creator.reason,
          };
        });
      }
    }
  }
  creators.sort((a, b) => b.score - a.score || b.engagementRate - a.engagementRate);
  posts.sort((a, b) => b.likes + b.comments - (a.likes + a.comments));

  if (candidates.length === 0) {
    warnings.push(
      'Nessun creator menzionato nei post trovati: aggiungi username da verificare o hashtag più specifici.',
    );
  }
  return {
    ok: true,
    result: {
      summary: plan.summary,
      hashtags: plan.hashtags,
      creators,
      posts: posts.slice(0, 12),
      checked: candidates.length,
      skipped,
      aiRanked,
      warnings,
    },
  };
}
