// @polsia:user-owned — funzionalità SPERIMENTALE del bot Telegram: /video <url|descrizione>.
// yt-dlp NON può girare nel runtime serverless di Solco (niente Python/binario/ffmpeg, limiti di
// tempo e dimensione): questa funzione è un SOTTILE connettore verso un worker yt-dlp ESTERNO (uno
// che ospiti tu, o un'API compatibile tipo Cobalt). Il comando è spento di default e triplo-gated:
//   1) BOT_VIDEO_EXPERIMENTAL=1  — accende la funzione;
//   2) la chat è fra gli admin (SKYNET_TELEGRAM_CHAT_IDS) e in privato — owner-only;
//   3) YTDLP_SERVICE_URL punta a un worker HTTPS pubblico — altrimenti risponde "non configurato".
// L'AI (la riserva interna) interpreta la richiesta in linguaggio naturale → URL o query + titolo;
// il worker fa il lavoro di yt-dlp e restituisce un URL diretto al media, che il bot rimanda come
// LINK (inviare il file intero sbatte contro i limiti Vercel+Telegram). Non logga né token né chiavi,
// e non elude mai DRM o paywall: si limita a inoltrare al worker ciò che l'utente chiede.
import 'server-only';
import { z } from 'zod';
import { freellmapiJson } from '@/lib/business/ai-freellmapi.server';

type Env = Record<string, string | undefined>;
const clean = (value: string | undefined): string | undefined =>
  value?.trim() ? value.trim() : undefined;

/** Deadline complessiva della risoluzione del worker (sotto il maxDuration=60 della route). */
export const BOT_VIDEO_WORKER_TIMEOUT_MS = 40_000;
/** Deadline del passo AI (riserva): breve, per non consumare il budget della route. */
export const BOT_VIDEO_AI_TIMEOUT_MS = 12_000;

/**
 * La funzione video è ACCESA di default: diventa usabile per gli owner (SKYNET_TELEGRAM_CHAT_IDS) in
 * chat privata quando il worker yt-dlp è configurato. Resta un interruttore di sicurezza: si spegne
 * solo con BOT_VIDEO_EXPERIMENTAL = 0 / false / off / no.
 */
export function botVideoExperimentalEnabled(env: Env = process.env): boolean {
  const raw = clean(env.BOT_VIDEO_EXPERIMENTAL)?.toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/**
 * Agent/modello FreeLLMAPI scelto per interpretare le richieste video in linguaggio naturale
 * (BOT_VIDEO_AI_MODEL). Vuoto = scelta automatica della riserva (FREELLMAPI_MODEL o 'auto', che gira
 * sul miglior provider disponibile). Imposta un id preciso (dal catalogo in Admin → Monitoraggio) per
 * forzare un agent specifico.
 */
export function botVideoAiModel(env: Env = process.env): string | undefined {
  return clean(env.BOT_VIDEO_AI_MODEL);
}

/**
 * L'URL del worker yt-dlp esterno, SOLO se è un HTTPS pubblico usabile dal server di Vercel: no http,
 * no localhost/loopback, no IP privati, no host "nudi" o suffissi interni (anti-SSRF: anche se è
 * configurato dall'owner, non deve poter puntare a un servizio interno). null se assente o non usabile.
 */
export function ytdlpServiceUrl(env: Env = process.env): string | null {
  const raw = clean(env.YTDLP_SERVICE_URL);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.')) return null;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return null;
  }
  if (host === '0.0.0.0' || host === '::1' || host.startsWith('127.')) return null;
  if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
    return null;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  return raw.replace(/\/+$/, '');
}

/** Chiave opzionale del worker (Bearer). Mai loggata. */
export function ytdlpServiceKey(env: Env = process.env): string | undefined {
  return clean(env.YTDLP_SERVICE_KEY);
}

/** Le chat Telegram degli amministratori (owner): SKYNET_TELEGRAM_CHAT_IDS (CSV di id). */
export function isAdminTelegramChat(chatId: string, env: Env = process.env): boolean {
  const ids = (clean(env.SKYNET_TELEGRAM_CHAT_IDS) ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 && ids.includes(chatId);
}

/**
 * Alias "oscuro" opzionale per il comando video (BOT_VIDEO_ALIAS): un trigger NON ovvio, come copertura.
 * Es. BOT_VIDEO_ALIAS="grab" → anche "/grab <url>" avvia il video. Deve essere un comando Telegram valido
 * (lettere/numeri/underscore, 1-32 char); vuoto o non valido = nessun alias.
 */
export function botVideoAlias(env: Env = process.env): string | undefined {
  const raw = clean(env.BOT_VIDEO_ALIAS)?.toLowerCase();
  return raw && /^[a-z0-9_]{1,32}$/.test(raw) ? raw : undefined;
}

/** Regex del comando video: /video, /yt e l'eventuale alias oscuro. Gruppo 1 = argomento (url o testo). */
export function videoCommandRegex(env: Env = process.env): RegExp {
  const alias = botVideoAlias(env);
  const names = alias ? `video|yt|${alias}` : 'video|yt';
  return new RegExp(`^/(?:${names})(?:@\\w+)?(?:\\s+([\\s\\S]+))?$`);
}

const URL_RE = /\bhttps?:\/\/[^\s<>()]+/i;

/** Estrae il primo URL http(s) dal testo (euristica, senza AI). null se non c'è. */
export function extractUrl(text: string): string | null {
  return URL_RE.exec(text)?.[0] ?? null;
}

/** Intento interpretato: un URL diretto OPPURE una query di ricerca, più un titolo leggibile. */
export interface VideoIntent {
  url: string | null;
  query: string | null;
  title: string;
}

function trim(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Interpreta la richiesta dell'utente. Se c'è un URL lo usa direttamente (nessuna spesa AI). Altrimenti
 * l'AI (la riserva interna) trasforma il linguaggio naturale in una query di ricerca pulita + un titolo
 * breve; se la riserva non è disponibile o fallisce, si usa il testo grezzo come query (degrada bene).
 */
export async function interpretVideoRequest(
  input: string,
  env: Env = process.env,
): Promise<VideoIntent> {
  const url = extractUrl(input);
  if (url) return { url, query: null, title: trim(input.replace(url, '').trim() || url, 200) };

  try {
    const parsed = await freellmapiJson<{ query?: unknown; title?: unknown }>({
      messages: [
        {
          role: 'system',
          content:
            'Un utente vuole scaricare un video. Rispondi SOLO con JSON ' +
            '{"query":"<parole chiave per trovare il video>","title":"<titolo breve e leggibile>"}. ' +
            'Nessun altro testo.',
        },
        { role: 'user', content: trim(input, 500) },
      ],
      model: botVideoAiModel(env),
      maxTokens: 200,
      signal: AbortSignal.timeout(BOT_VIDEO_AI_TIMEOUT_MS),
      env,
    });
    const query = clean(typeof parsed.query === 'string' ? parsed.query : undefined) ?? input;
    const title = clean(typeof parsed.title === 'string' ? parsed.title : undefined) ?? query;
    return { url: null, query: trim(query, 200), title: trim(title, 200) };
  } catch {
    return { url: null, query: trim(input, 200), title: trim(input, 200) };
  }
}

/** La risposta attesa dal worker yt-dlp esterno: un URL diretto al media, più metadati opzionali. */
export const BotVideoWorkerResponseSchema = z.object({
  url: z.string().url().max(4096),
  title: z.string().trim().min(1).max(300).nullish(),
  ext: z.string().trim().max(16).nullish(),
  durationSeconds: z.number().int().nonnegative().max(86_400).nullish(),
  // Solo in modalità "serve": la dimensione in byte del file scaricato (per decidere se Telegram può
  // prelevarlo dall'URL e inviarlo in chat). Assente in modalità "extract" (URL diretto).
  filesize: z.number().int().nonnegative().max(10_000_000_000).nullish(),
});
export type BotVideoWorkerResponse = z.infer<typeof BotVideoWorkerResponseSchema>;

export interface VideoResult {
  mediaUrl: string;
  title: string;
  ext: string | null;
  durationSeconds: number | null;
  /** Byte del file (solo modalità "serve"); null in "extract". Decide l'invio del file in Telegram. */
  filesize: number | null;
}

export type BotVideoOutcome =
  | { status: 'not_configured' }
  | { status: 'ok'; result: VideoResult }
  | { status: 'failed'; detail: string };

export type FetchLike = typeof fetch;

/**
 * Chiama il worker yt-dlp esterno (POST <base>/download con {url|query}) e normalizza la risposta in un
 * VideoResult. Mai throw: rete/timeout/HTTP non-2xx/corpo non valido → esito `failed` con un dettaglio
 * breve e senza segreti; worker non configurato → `not_configured`.
 */
export async function resolveVideoDownload(
  intent: VideoIntent,
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<BotVideoOutcome> {
  const base = ytdlpServiceUrl(env);
  if (!base) return { status: 'not_configured' };
  const key = ytdlpServiceKey(env);
  const payload = intent.url ? { url: intent.url } : { query: intent.query };

  let res: Response;
  try {
    res = await fetchImpl(`${base}/download`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ ...payload, format: 'best' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(BOT_VIDEO_WORKER_TIMEOUT_MS),
    });
  } catch {
    return { status: 'failed', detail: 'il servizio di download non ha risposto in tempo' };
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: 'failed', detail: `il servizio ha risposto HTTP ${res.status}` };
  }

  const data = (await res.json().catch(() => null)) as unknown;
  const parsed = BotVideoWorkerResponseSchema.safeParse(data);
  if (!parsed.success) return { status: 'failed', detail: 'risposta del servizio non valida' };

  return {
    status: 'ok',
    result: {
      mediaUrl: parsed.data.url,
      title: clean(parsed.data.title ?? undefined) ?? intent.title,
      ext: clean(parsed.data.ext ?? undefined) ?? null,
      durationSeconds: parsed.data.durationSeconds ?? null,
      filesize: parsed.data.filesize ?? null,
    },
  };
}

/** Interpreta la richiesta e risolve il download in un solo passo (AI + worker). Mai throw. */
export async function requestBotVideo(
  input: string,
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<BotVideoOutcome> {
  const intent = await interpretVideoRequest(input, env).catch(
    (): VideoIntent => ({ url: extractUrl(input), query: input, title: input }),
  );
  return resolveVideoDownload(intent, env, fetchImpl);
}
