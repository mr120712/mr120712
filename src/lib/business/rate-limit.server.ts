// @polsia:user-owned
import 'server-only';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { prisma } from '@/lib/db';

type WindowLimit = { requests: number; windowMs: number };

export const ACTION_RATE_LIMITS = {
  // Ricerca musicale: di fatto illimitata per gli utenti veri. Resta solo un tetto molto alto
  // contro gli script (ogni ricerca interroga l'API Audius dal budget condiviso: senza alcun
  // limite un bot potrebbe esaurirlo e degradare la ricerca per tutti). La quota YouTube ha i
  // suoi limiti dedicati (youtube.search.global, music.search.youtube), qui non toccati.
  'music.search': [
    { requests: 60, windowMs: 10_000 },
    { requests: 5000, windowMs: 86_400_000 },
  ],
  // Anonymous catalogue proxies (Audius, podcasts, radio, Jamendo, YouTube video details).
  'music.catalog': [
    { requests: 60, windowMs: 60_000 },
    { requests: 1500, windowMs: 86_400_000 },
  ],
  // Social preview image of a shared playlist (DB read + Audius covers + PNG drawing), per IP.
  // Generous: link-preview crawlers fetch from few addresses; the CDN absorbs repeated hits.
  'share.og': [
    { requests: 120, windowMs: 60_000 },
    { requests: 3000, windowMs: 86_400_000 },
  ],
  // Verification emails: per recipient address, and app-wide.
  'auth.verification_email': [
    { requests: 3, windowMs: 3_600_000 },
    { requests: 5, windowMs: 86_400_000 },
  ],
  'auth.verification_email.global': [{ requests: 300, windowMs: 86_400_000 }],
  // Calls to Stripe/PayPal to confirm or open a subscription or the billing portal.
  'subscriptions.sync': [
    { requests: 10, windowMs: 60_000 },
    { requests: 100, windowMs: 86_400_000 },
  ],
  'product.check.global': [{ requests: 50, windowMs: 86_400_000 }],
  // YouTube search.list costs 100 of the 10,000 daily units. Counted only when a search really
  // reaches YouTube (cache misses): one pool for the whole app, plus a per-person share.
  'youtube.search.global': [{ requests: 90, windowMs: 86_400_000 }],
  'music.search.youtube': [{ requests: 20, windowMs: 86_400_000 }],
  // Anonymous YouTube video details (1 quota unit each, from a small app-wide share): per IP.
  'music.youtube.details': [{ requests: 20, windowMs: 86_400_000 }],
  // Spotify import: reading the person's playlists (each call reaches Spotify's API).
  'spotify.read': [
    { requests: 30, windowMs: 60_000 },
    { requests: 400, windowMs: 86_400_000 },
  ],
  // Background checks: runs started by the public status endpoint (whole app) and by admins.
  'monitor.run': [
    { requests: 4, windowMs: 3_600_000 },
    { requests: 60, windowMs: 86_400_000 },
  ],
  'monitor.run.admin': [
    { requests: 5, windowMs: 600_000 },
    { requests: 40, windowMs: 86_400_000 },
  ],
  // Pubblicazione manuale dell'annuncio build sul canale Telegram (azione admin): poche al giorno.
  'telegram.announce.admin': [
    { requests: 3, windowMs: 600_000 },
    { requests: 20, windowMs: 86_400_000 },
  ],
  'solco.pro.write': [
    { requests: 20, windowMs: 60_000 },
    { requests: 200, windowMs: 86_400_000 },
  ],
  'listening.write': [
    { requests: 30, windowMs: 60_000 },
    { requests: 500, windowMs: 86_400_000 },
  ],
  // Each AI search is a paid Claude request: a few per minute, 30 per day per account.
  'music.ai_search': [
    { requests: 3, windowMs: 60_000 },
    { requests: 30, windowMs: 86_400_000 },
  ],
  // App-wide ceiling on paid AI searches, whatever the number of accounts.
  'music.ai_search.global': [{ requests: 400, windowMs: 86_400_000 }],
  // "Organizza con l'AI": each call reads a long text with Opus 5.5's 1M context and can cost ~$4.
  // Tight by design — a short burst, a few per day per account, and an app-wide daily ceiling.
  'ai.organize': [
    { requests: 2, windowMs: 300_000 },
    { requests: 3, windowMs: 86_400_000 },
  ],
  'ai.organize.global': [{ requests: 30, windowMs: 86_400_000 }],
  // Generatore di annunci TikTok con Claude 5.5 (azione admin): ogni call è una richiesta a pagamento.
  // Qualche tentativo al minuto per admin, un tetto giornaliero, più un tetto app-wide.
  'tiktok.announce.admin': [
    { requests: 6, windowMs: 60_000 },
    { requests: 60, windowMs: 86_400_000 },
  ],
  'tiktok.announce.global': [{ requests: 200, windowMs: 86_400_000 }],
  // Pubblicazione di un video su TikTok (Content Posting, azione admin): poche al giorno.
  'tiktok.publish.admin': [
    { requests: 5, windowMs: 60_000 },
    { requests: 25, windowMs: 86_400_000 },
  ],
  'tiktok.publish.global': [{ requests: 100, windowMs: 86_400_000 }],
  // Imported songs found on YouTube (100 quota units each, only on a cache miss): per listener
  // and app-wide, leaving most of the daily 10,000 units to regular search.
  'music.resolve_song': [
    { requests: 8, windowMs: 10_000 },
    { requests: 60, windowMs: 86_400_000 },
  ],
  'music.resolve_song.global': [{ requests: 40, windowMs: 86_400_000 }],
  'ai.chat': [
    { requests: 12, windowMs: 60_000 },
    { requests: 60, windowMs: 3_600_000 },
  ],
  'solco.support': [{ requests: 5, windowMs: 600_000 }],
  // Tetto app-wide sulle risposte del supporto: ognuna è una richiesta a Claude a pagamento.
  'solco.support.global': [{ requests: 300, windowMs: 86_400_000 }],
  'admin.assistant': [
    { requests: 20, windowMs: 60_000 },
    { requests: 100, windowMs: 3_600_000 },
  ],
  'product.check.start': [
    { requests: 5, windowMs: 600_000 },
    { requests: 30, windowMs: 86_400_000 },
  ],
  'product.check.link': [
    { requests: 60, windowMs: 60_000 },
    { requests: 180, windowMs: 86_400_000 },
  ],
  'messages.send': [
    { requests: 10, windowMs: 60_000 },
    { requests: 120, windowMs: 3_600_000 },
  ],
  'community.follow': [
    { requests: 20, windowMs: 60_000 },
    { requests: 120, windowMs: 3_600_000 },
  ],
  'community.unfollow': [
    { requests: 30, windowMs: 60_000 },
    { requests: 180, windowMs: 3_600_000 },
  ],
  'community.profile.update': [
    { requests: 10, windowMs: 60_000 },
    { requests: 60, windowMs: 3_600_000 },
  ],
  'shops.create': [
    { requests: 3, windowMs: 600_000 },
    { requests: 10, windowMs: 86_400_000 },
  ],
  'shops.update': [
    { requests: 10, windowMs: 60_000 },
    { requests: 60, windowMs: 3_600_000 },
  ],
  'products.create': [
    { requests: 20, windowMs: 60_000 },
    { requests: 100, windowMs: 3_600_000 },
  ],
  'products.update': [
    { requests: 20, windowMs: 60_000 },
    { requests: 100, windowMs: 3_600_000 },
  ],
  'library.write': [
    { requests: 60, windowMs: 60_000 },
    { requests: 600, windowMs: 3_600_000 },
  ],
  'library.import': [
    { requests: 3, windowMs: 600_000 },
    { requests: 20, windowMs: 86_400_000 },
  ],
  // "Scarica il permesso": download offline di un brano consentito (Audius scaricabile, podcast).
  // Ogni download trasferisce il file intero dal proxy: pochi al minuto e 20 al giorno per account.
  'music.download': [
    { requests: 5, windowMs: 60_000 },
    { requests: 20, windowMs: 86_400_000 },
  ],
  // Tetto app-wide sui download offline di oggi, qualunque sia il numero di account.
  'music.download.global': [{ requests: 500, windowMs: 86_400_000 }],
  'subscriptions.checkout': [
    { requests: 5, windowMs: 600_000 },
    { requests: 30, windowMs: 86_400_000 },
  ],
  // Verifica di un acquisto in-app (Apple/Google): dopo l'acquisto e a ogni refresh dello stato.
  'iap.verify': [
    { requests: 15, windowMs: 60_000 },
    { requests: 150, windowMs: 86_400_000 },
  ],
  // Ricerca su Audius di una versione scaricabile dei brani importati (batch, ogni chiamata è un
  // lotto): poche al minuto per account, con un tetto giornaliero.
  'music.resolve_download': [
    { requests: 6, windowMs: 60_000 },
    { requests: 60, windowMs: 86_400_000 },
  ],
  // Registrazione di un brano caricato sul sito: ogni chiamata ispeziona un file privato.
  // Poche al minuto per account, con un tetto giornaliero contro il riempimento dell'archivio.
  'recordings.write': [
    { requests: 8, windowMs: 60_000 },
    { requests: 40, windowMs: 86_400_000 },
  ],
} as const satisfies Record<string, readonly WindowLimit[]>;

export type RateLimitAction = keyof typeof ACTION_RATE_LIMITS;
export type RateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterSeconds: number;
      status: 429 | 503;
      error: string;
      message: string;
    };

const RATE_LIMIT_BACKEND_RETRY_SECONDS = 30;
const UNKNOWN_IDENTITY_RETRY_SECONDS = 60;

/**
 * Gli id autenticati hanno priorità; gli anonimi usano solo l'header impostato dall'ingress.
 * Su Vercel è x-real-ip (scritto da Vercel, non dal client). cf-connecting-ip vale solo se il
 * sito passa davvero da Cloudflare (TRUST_CLOUDFLARE_IP=1): altrimenti chiunque potrebbe
 * inventarlo a ogni richiesta e aggirare i limiti.
 */
export function getRateLimitIdentity(userId: string | null, headers: Headers): string | null {
  if (userId) return `user:${userId}`;

  const trusted =
    process.env.TRUST_CLOUDFLARE_IP === '1' ? ['cf-connecting-ip', 'x-real-ip'] : ['x-real-ip'];
  for (const header of trusted) {
    const candidate = headers.get(header)?.trim();
    if (candidate && !candidate.includes(',') && isIP(candidate)) {
      return `ip:${candidate.toLowerCase()}`;
    }
  }

  return null;
}

export function evaluateRateLimit(
  timestamps: readonly number[],
  limits: readonly WindowLimit[],
  now: number,
): { allowed: true; timestamps: number[] } | { allowed: false; retryAfterSeconds: number } {
  const longestWindow = Math.max(...limits.map((limit) => limit.windowMs));
  const active = timestamps
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now - longestWindow)
    .sort((left, right) => left - right);
  const blockedWindows = limits.flatMap((limit) => {
    const hits = active.filter((timestamp) => timestamp > now - limit.windowMs);
    if (hits.length < limit.requests) return [];

    const firstHitToExpire = hits[hits.length - limit.requests];
    if (firstHitToExpire === undefined) return [];
    return [firstHitToExpire + limit.windowMs - now];
  });

  if (blockedWindows.length > 0) {
    const waitMs = Math.max(...blockedWindows);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  return { allowed: true, timestamps: [...active, now] };
}

function storedTimestamps(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((timestamp): timestamp is number => typeof timestamp === 'number');
}

function retryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'P2034' || error.code === 'P2002';
}

function unavailableDecision(): RateLimitDecision {
  return {
    allowed: false,
    retryAfterSeconds: RATE_LIMIT_BACKEND_RETRY_SECONDS,
    status: 503,
    error: 'rate_limit_unavailable',
    message: `Il controllo temporaneo dei limiti non è disponibile; nessuna operazione è stata avviata. Riprova tra ${RATE_LIMIT_BACKEND_RETRY_SECONDS} secondi.`,
  };
}

function missingIdentityDecision(): RateLimitDecision {
  return {
    allowed: false,
    retryAfterSeconds: UNKNOWN_IDENTITY_RETRY_SECONDS,
    status: 503,
    error: 'rate_limit_identity_unavailable',
    message: `Non è possibile identificare in modo sicuro questa richiesta. Riprova tra ${UNKNOWN_IDENTITY_RETRY_SECONDS} secondi.`,
  };
}

export async function consumeRateLimit(
  action: RateLimitAction,
  identity: string | null,
  now = Date.now(),
): Promise<RateLimitDecision> {
  if (!identity) return missingIdentityDecision();

  const identityHash = createHash('sha256').update(identity).digest('hex');
  const limits = ACTION_RATE_LIMITS[action];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          const where = { action_identityHash: { action, identityHash } };
          const current = await transaction.actionRateLimit.findUnique({ where });
          const decision = evaluateRateLimit(storedTimestamps(current?.timestamps), limits, now);
          if (!decision.allowed) {
            return {
              allowed: false,
              retryAfterSeconds: decision.retryAfterSeconds,
              status: 429,
              error: 'rate_limited',
              message: `Hai raggiunto il limite per questa azione. Riprova tra ${decision.retryAfterSeconds} secondi.`,
            } satisfies RateLimitDecision;
          }

          await transaction.actionRateLimit.upsert({
            where,
            create: { action, identityHash, timestamps: decision.timestamps },
            update: { timestamps: decision.timestamps },
          });
          return { allowed: true } satisfies RateLimitDecision;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (attempt < 3 && retryableTransactionError(error)) continue;
      return unavailableDecision();
    }
  }

  return unavailableDecision();
}

/**
 * Restituisce (rimborsa) UNA prenotazione fatta con consumeRateLimit, togliendo il timestamp più
 * recente per questa azione/identità. Serve al pattern "prenota prima, rimborsa se fallisce": così
 * si prenota lo slot in anticipo (niente burst oltre il limite) ma un'operazione fallita non pesa.
 * I timestamp della stessa finestra sono intercambiabili per il conteggio, quindi toglierne uno
 * qualsiasi è corretto anche con richieste concorrenti. Un rimborso fallito non è fatale (al
 * massimo l'operazione fallita resta contata): non lancia mai.
 */
export async function releaseRateLimit(
  action: RateLimitAction,
  identity: string | null,
): Promise<void> {
  if (!identity) return;
  const identityHash = createHash('sha256').update(identity).digest('hex');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await prisma.$transaction(
        async (transaction) => {
          const where = { action_identityHash: { action, identityHash } };
          const current = await transaction.actionRateLimit.findUnique({ where });
          const timestamps = storedTimestamps(current?.timestamps);
          if (timestamps.length === 0) return;
          // Toglie un'occorrenza del timestamp più recente (<= now, se presente).
          let index = 0;
          for (let i = 1; i < timestamps.length; i += 1) {
            const candidate = timestamps[i];
            const best = timestamps[index];
            if (candidate !== undefined && best !== undefined && candidate > best) index = i;
          }
          timestamps.splice(index, 1);
          await transaction.actionRateLimit.update({ where, data: { timestamps } });
        },
        { isolationLevel: 'Serializable' },
      );
      return;
    } catch (error) {
      if (attempt < 3 && retryableTransactionError(error)) continue;
      return;
    }
  }
}

const actionLabels: Record<RateLimitAction, string> = {
  'music.search': 'le ricerche musicali',
  'music.catalog': 'le richieste al catalogo',
  'share.og': 'le anteprime delle playlist condivise',
  'auth.verification_email': 'le email di verifica',
  'auth.verification_email.global': 'le email di verifica di oggi',
  'subscriptions.sync': 'le verifiche dell’abbonamento',
  'product.check.global': 'i controlli prodotto di oggi',
  'youtube.search.global': 'le ricerche YouTube di oggi',
  'music.search.youtube': 'le tue ricerche YouTube di oggi',
  'music.youtube.details': 'le verifiche dei video YouTube di oggi',
  'spotify.read': 'le letture da Spotify',
  'monitor.run': 'i controlli automatici',
  'monitor.run.admin': 'i controlli manuali',
  'telegram.announce.admin': 'gli annunci su Telegram',
  'solco.pro.write': 'le modifiche a Solco Pro',
  'listening.write': 'le modifiche agli ascolti',
  'music.ai_search': 'le ricerche con l’AI',
  'music.ai_search.global': 'le ricerche con l’AI di oggi',
  'ai.organize': 'l’organizzazione con l’AI',
  'ai.organize.global': 'le organizzazioni con l’AI di oggi',
  'tiktok.announce.admin': 'gli annunci TikTok con l’AI',
  'tiktok.announce.global': 'gli annunci TikTok con l’AI di oggi',
  'tiktok.publish.admin': 'le pubblicazioni su TikTok',
  'tiktok.publish.global': 'le pubblicazioni su TikTok di oggi',
  'music.resolve_song': 'le ricerche dei brani importati',
  'music.resolve_song.global': 'le ricerche dei brani importati di oggi',
  'ai.chat': 'le richieste all’assistente',
  'solco.support': 'le richieste al supporto',
  'solco.support.global': 'le richieste al supporto di oggi',
  'admin.assistant': 'le richieste all’assistente amministrativo',
  'product.check.start': 'i controlli prodotto',
  'product.check.link': 'le letture dei link',
  'messages.send': 'l’invio dei messaggi',
  'community.follow': 'le azioni di community',
  'community.unfollow': 'le azioni di community',
  'community.profile.update': 'le modifiche al profilo community',
  'shops.create': 'la creazione di negozi',
  'shops.update': 'le modifiche ai negozi',
  'products.create': 'la creazione di prodotti',
  'products.update': 'le modifiche ai prodotti',
  'library.write': 'le modifiche alla Libreria',
  'library.import': 'l’importazione di playlist',
  'music.download': 'i download offline',
  'music.download.global': 'i download offline di oggi',
  'subscriptions.checkout': 'l’avvio dei pagamenti',
  'iap.verify': 'le verifiche degli acquisti in-app',
  'music.resolve_download': 'le ricerche di versioni scaricabili',
  'recordings.write': 'le registrazioni dei brani',
};

type DeniedRateLimit = Exclude<RateLimitDecision, { allowed: true }>;

/** Risposta HTTP standard di un limite superato (429/503), con Retry-After e messaggio in italiano. */
export function rateLimitResponse(action: RateLimitAction, decision: DeniedRateLimit): Response {
  const message =
    decision.status === 429
      ? `Hai raggiunto il limite per ${actionLabels[action]}. Riprova tra ${decision.retryAfterSeconds} secondi.`
      : decision.message;
  return Response.json(
    { error: decision.error, message, retryAfterSeconds: decision.retryAfterSeconds },
    {
      status: decision.status,
      headers: {
        'Retry-After': String(decision.retryAfterSeconds),
        'Cache-Control': 'private, no-store',
      },
    },
  );
}

/**
 * Valuta i limiti SENZA registrare nulla. Serve quando l'azione va contata solo a buon fine (es.
 * un download: si verifica il limite all'inizio, ma lo si consuma — consumeRateLimit — solo dopo
 * che i byte sono confermati). Due richieste ravvicinate possono entrambe superare il peek, come
 * avviene per checkStreamPlay/recordStreamPlay: accettabile per un limite giornaliero prudenziale.
 */
export async function peekRateLimit(
  action: RateLimitAction,
  identity: string | null,
  now = Date.now(),
): Promise<RateLimitDecision> {
  if (!identity) return missingIdentityDecision();

  const identityHash = createHash('sha256').update(identity).digest('hex');
  const limits = ACTION_RATE_LIMITS[action];
  try {
    const current = await prisma.actionRateLimit.findUnique({
      where: { action_identityHash: { action, identityHash } },
    });
    const decision = evaluateRateLimit(storedTimestamps(current?.timestamps), limits, now);
    if (decision.allowed) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: decision.retryAfterSeconds,
      status: 429,
      error: 'rate_limited',
      message: `Hai raggiunto il limite per questa azione. Riprova tra ${decision.retryAfterSeconds} secondi.`,
    };
  } catch {
    return unavailableDecision();
  }
}

export async function enforceRateLimit(
  action: RateLimitAction,
  identity: string | null,
): Promise<Response | null> {
  const decision = await consumeRateLimit(action, identity);
  if (decision.allowed) return null;
  return rateLimitResponse(action, decision);
}
