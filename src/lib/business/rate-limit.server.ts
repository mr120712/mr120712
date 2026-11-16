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
  // Avvii dello stream dei brani in evidenza (route home-tracks/stream), per ACCOUNT: contano solo
  // le richieste che iniziano un ascolto (niente Range o Range dall'inizio), non i blocchi di seek
  // e riproduzione a blocchi. Ampio per chi ascolta, stretto per chi scarica l'intero store.
  'music.featured.stream': [
    { requests: 60, windowMs: 600_000 },
    { requests: 600, windowMs: 86_400_000 },
  ],
  // Copertine dei brani in evidenza (lettura dello store + riduzione a 512 px), per IP. Separato da
  // music.catalog: una Home piena di copertine non deve far rispondere 429 a radio e podcast. La
  // CDN tiene in cache le risposte, quindi qui arrivano solo le copertine non ancora viste.
  'music.cover': [
    { requests: 240, windowMs: 60_000 },
    { requests: 5000, windowMs: 86_400_000 },
  ],
  // Testi dei brani nel player (solo brani con i diritti sul testo), per utente: uno per brano
  // aperto, più i cambi di brano col pannello aperto. Basta per l'uso vero, ferma gli script.
  'music.lyrics': [
    { requests: 30, windowMs: 60_000 },
    { requests: 600, windowMs: 86_400_000 },
  ],
  // Social preview image of a shared playlist or song (DB/Audius read + covers + drawing), per IP.
  // Generous: link-preview crawlers fetch from few addresses; the CDN absorbs repeated hits.
  'share.og': [
    { requests: 120, windowMs: 60_000 },
    { requests: 3000, windowMs: 86_400_000 },
  ],
  // Anteprime dei brani condivisi: lettura del brano da Audius (solo se la cache in memoria non lo
  // conosce già; una sola richiesta ad Audius per lettura). Prima un limite per IP, così un solo
  // indirizzo non consuma il tetto di tutti; poi un tetto giornaliero per l'intera app, che protegge
  // il budget mensile Audius condiviso con ricerca e player. Oltre l'uno o l'altro la scheda resta
  // generica (nessuna lettura).
  'share.og.audius': [
    { requests: 20, windowMs: 60_000 },
    { requests: 300, windowMs: 86_400_000 },
  ],
  'share.og.audius.global': [{ requests: 1500, windowMs: 86_400_000 }],
  // Verification emails: per recipient address, and app-wide.
  'auth.verification_email': [
    { requests: 3, windowMs: 3_600_000 },
    { requests: 5, windowMs: 86_400_000 },
  ],
  'auth.verification_email.global': [{ requests: 300, windowMs: 86_400_000 }],
  // Recupero password: email per destinatario e per l'intera app, richieste per IP.
  'auth.reset_email': [
    { requests: 3, windowMs: 3_600_000 },
    { requests: 5, windowMs: 86_400_000 },
  ],
  'auth.reset_email.global': [{ requests: 300, windowMs: 86_400_000 }],
  'auth.reset_request.ip': [
    { requests: 10, windowMs: 3_600_000 },
    { requests: 30, windowMs: 86_400_000 },
  ],
  // Accesso col telefono: ogni SMS costa (e tutti i paesi sono ammessi): limiti per numero, per IP
  // e un tetto giornaliero per l'intera app contro l'"SMS pumping". Più i tentativi di verifica.
  'auth.phone_otp': [
    { requests: 3, windowMs: 600_000 },
    { requests: 10, windowMs: 86_400_000 },
  ],
  'auth.phone_otp.ip': [
    { requests: 5, windowMs: 3_600_000 },
    { requests: 20, windowMs: 86_400_000 },
  ],
  'auth.phone_otp.global': [{ requests: 300, windowMs: 86_400_000 }],
  'auth.phone_verify.ip': [
    { requests: 20, windowMs: 600_000 },
    { requests: 100, windowMs: 86_400_000 },
  ],
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
  // Comandi in arrivo al webhook del bot, PER CHAT: anti-spam. Oltre la soglia l'aggiornamento è
  // scartato (niente scritture DB né invii verso Telegram), così una chat non può martellare il bot.
  'telegram.webhook': [
    { requests: 20, windowMs: 60_000 },
    { requests: 300, windowMs: 86_400_000 },
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
  // «Crea playlist»: ogni proposta legge il catalogo Audius (una o due richieste, in cache per 10
  // minuti) e non tocca mai YouTube. Largo per l'uso vero (Sostituisci, Aggiungi altri), ferma gli
  // script che svuoterebbero il budget Audius condiviso.
  'playlist.engine.suggest': [
    { requests: 20, windowMs: 60_000 },
    { requests: 300, windowMs: 86_400_000 },
  ],
  // Le proposte con l'AI sono richieste a Claude a pagamento: poche al minuto e 30 al giorno per
  // account, più un tetto giornaliero per l'intera app.
  'playlist.engine.ai': [
    { requests: 4, windowMs: 60_000 },
    { requests: 30, windowMs: 86_400_000 },
  ],
  'playlist.engine.ai.global': [{ requests: 400, windowMs: 86_400_000 }],
  // Salvataggio di una bozza di «Crea playlist» come playlist della Libreria (una scrittura sola).
  'playlist.engine.save': [
    { requests: 10, windowMs: 600_000 },
    { requests: 60, windowMs: 86_400_000 },
  ],
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
  // «Potrebbe piacerti»: lettura dei consigli personali (Home e «Altri consigli»), per account.
  // I candidati si rifanno al massimo ogni 6 ore: qui si ferma solo chi ricarica a raffica.
  'music.recommendations': [
    { requests: 30, windowMs: 60_000 },
    { requests: 600, windowMs: 86_400_000 },
  ],
  // «Non mi interessa» / «Annulla» sui brani consigliati, per account.
  'music.recommendations.feedback': [
    { requests: 30, windowMs: 60_000 },
    { requests: 300, windowMs: 86_400_000 },
  ],
  // Suggerimenti AI dei consigli (solo Premium): UNA richiesta a Claude ogni 24 ore per account,
  // più un tetto giornaliero per l'intera app.
  'music.recommendations.ai': [{ requests: 1, windowMs: 86_400_000 }],
  'music.recommendations.ai.global': [{ requests: 300, windowMs: 86_400_000 }],
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
  // Trascrizione dei testi con Solco AI (Whisper su Groq, a consumo) dalla pagina admin «Diritti e
  // testi», solo brani dichiarati con "testo": true. Contata solo quando la chiamata al motore parte
  // davvero: per admin, più un tetto giornaliero per l'intera app.
  'lyrics.transcribe': [
    { requests: 10, windowMs: 3_600_000 },
    { requests: 30, windowMs: 86_400_000 },
  ],
  'lyrics.transcribe.global': [{ requests: 50, windowMs: 86_400_000 }],
  // «Verifica Solco AI» (un secondo di silenzio al motore: costo irrisorio ma reale), per admin.
  'lyrics.transcribe.check': [
    { requests: 6, windowMs: 3_600_000 },
    { requests: 20, windowMs: 86_400_000 },
  ],
  // Salvataggio del .lrc nello store (scrittura su Vercel Blob), per admin.
  'lyrics.transcribe.save': [
    { requests: 20, windowMs: 600_000 },
    { requests: 100, windowMs: 86_400_000 },
  ],
  // Ricerca su audio.com: l'API ammette 60 ricerche al minuto PER UTENTE audio.com e Solco usa UN
  // solo account (collegato dall'admin) per tutti gli ascoltatori. Tetto globale ben sotto (40 al
  // minuto, identità 'global'), contato solo quando una ricerca arriva davvero ad audio.com: la
  // cache in memoria di audiocom.server assorbe le ricerche ripetute. Oltre, la fonte è
  // "unavailable" e le altre fonti rispondono come sempre.
  'audiocom.search.global': [{ requests: 40, windowMs: 60_000 }],
  // Quota PERSONALE (utente o IP) delle ricerche che arrivano davvero ad audio.com, controllata
  // PRIMA del tetto globale e solo quando la ricerca non è già in cache: così una sola persona (o
  // uno script) non può consumare da sola i 40 al minuto condivisi da tutti. Le ricerche già in
  // cache non la consumano. Oltre, audio.com è "unavailable" solo per chi l'ha superata.
  'audiocom.search': [
    { requests: 6, windowMs: 60_000 },
    { requests: 300, windowMs: 86_400_000 },
  ],
  // «Collega audio.com» (registrazione del client e avvio dell'autorizzazione), per admin.
  'audiocom.connect.admin': [
    { requests: 10, windowMs: 600_000 },
    { requests: 40, windowMs: 86_400_000 },
  ],
  // «Carica su audio.com» (pagina admin), per admin: ogni invio legge dallo storage e manda ad
  // audio.com un file fino a 100 MB.
  'audiocom.upload.admin': [{ requests: 10, windowMs: 3_600_000 }],
  // Token per mettere quel file nello staging di Vercel Blob, per admin: un po' più largo
  // dell'invio, per i caricamenti interrotti e ripresi.
  'audiocom.upload.stage.admin': [{ requests: 20, windowMs: 3_600_000 }],
  // Segnali di visita (POST /api/visits) per IP: uno per pagina aperta, quindi largo per chi naviga
  // davvero e stretto per uno script che volesse gonfiare le statistiche dei visitatori.
  'site.visit': [
    { requests: 60, windowMs: 60_000 },
    { requests: 3000, windowMs: 86_400_000 },
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

/**
 * Tentativi della transazione quando richieste CONCORRENTI della stessa identità si scontrano sulla
 * stessa riga (P2034: conflitto di scrittura o deadlock; P2002: due prime righe insieme). Succede
 * davvero: una Home apre ~20 copertine nello stesso istante. Con 4 tentativi immediati alcune
 * richieste finivano in 503 (copertine sostituite dalla lettera); così si riprova con attese brevi,
 * crescenti e sparpagliate a caso, e il conteggio resta esatto (stessa transazione Serializable).
 */
export const RATE_LIMIT_TRANSACTION_ATTEMPTS = 8;

/**
 * Attesa prima del tentativo successivo al numero `attempt` (0 = dopo il primo fallimento): tetto
 * 20, 40, 80, 160, 320, 400… ms, poi un valore a caso tra metà tetto e il tetto, così le richieste
 * scontrate non riprovano tutte nello stesso istante. In tutto al più ~1,4 s, solo sotto conflitto.
 */
export function rateLimitRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(400, 20 * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function waitBeforeRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, rateLimitRetryDelayMs(attempt)));
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

  for (let attempt = 0; attempt < RATE_LIMIT_TRANSACTION_ATTEMPTS; attempt += 1) {
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
      // Solo un conflitto tra richieste concorrenti si riprova; ogni altro errore: 503 (mai via libera).
      if (attempt < RATE_LIMIT_TRANSACTION_ATTEMPTS - 1 && retryableTransactionError(error)) {
        await waitBeforeRetry(attempt);
        continue;
      }
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

  for (let attempt = 0; attempt < RATE_LIMIT_TRANSACTION_ATTEMPTS; attempt += 1) {
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
      if (attempt < RATE_LIMIT_TRANSACTION_ATTEMPTS - 1 && retryableTransactionError(error)) {
        await waitBeforeRetry(attempt);
        continue;
      }
      return;
    }
  }
}

const actionLabels: Record<RateLimitAction, string> = {
  'music.search': 'le ricerche musicali',
  'music.catalog': 'le richieste al catalogo',
  'music.featured.stream': 'gli ascolti dei brani in evidenza',
  'music.cover': 'le copertine',
  'music.lyrics': 'i testi dei brani',
  'share.og': 'le anteprime dei link condivisi',
  'share.og.audius': 'le anteprime dei brani condivisi',
  'share.og.audius.global': 'le anteprime dei brani condivisi di oggi',
  'auth.verification_email': 'le email di verifica',
  'auth.verification_email.global': 'le email di verifica di oggi',
  'auth.reset_email': 'le email di recupero password',
  'auth.reset_email.global': 'le email di recupero password di oggi',
  'auth.reset_request.ip': 'le richieste di recupero password',
  'auth.phone_otp': 'i codici SMS a questo numero',
  'auth.phone_otp.ip': 'i codici SMS richiesti',
  'auth.phone_otp.global': 'i codici SMS di oggi',
  'auth.phone_verify.ip': 'i tentativi di verifica del codice',
  'subscriptions.sync': 'le verifiche dell’abbonamento',
  'product.check.global': 'i controlli prodotto di oggi',
  'youtube.search.global': 'le ricerche YouTube di oggi',
  'music.search.youtube': 'le tue ricerche YouTube di oggi',
  'music.youtube.details': 'le verifiche dei video YouTube di oggi',
  'spotify.read': 'le letture da Spotify',
  'monitor.run': 'i controlli automatici',
  'monitor.run.admin': 'i controlli manuali',
  'telegram.announce.admin': 'gli annunci su Telegram',
  'telegram.webhook': 'i comandi al bot Telegram',
  'solco.pro.write': 'le modifiche a Solco Pro',
  'listening.write': 'le modifiche agli ascolti',
  'music.ai_search': 'le ricerche con l’AI',
  'music.ai_search.global': 'le ricerche con l’AI di oggi',
  'ai.organize': 'l’organizzazione con l’AI',
  'ai.organize.global': 'le organizzazioni con l’AI di oggi',
  'playlist.engine.suggest': 'le proposte di «Crea playlist»',
  'playlist.engine.ai': 'le playlist proposte dall’AI',
  'playlist.engine.ai.global': 'le playlist proposte dall’AI di oggi',
  'playlist.engine.save': 'il salvataggio delle playlist create',
  'tiktok.announce.admin': 'gli annunci TikTok con l’AI',
  'tiktok.announce.global': 'gli annunci TikTok con l’AI di oggi',
  'tiktok.publish.admin': 'le pubblicazioni su TikTok',
  'tiktok.publish.global': 'le pubblicazioni su TikTok di oggi',
  'music.resolve_song': 'le ricerche dei brani importati',
  'music.resolve_song.global': 'le ricerche dei brani importati di oggi',
  'music.recommendations': 'i brani consigliati',
  'music.recommendations.feedback': 'i «Non mi interessa» sui consigli',
  'music.recommendations.ai': 'i consigli con l’AI di oggi',
  'music.recommendations.ai.global': 'i consigli con l’AI di oggi',
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
  'lyrics.transcribe': 'le trascrizioni dei testi con l’IA',
  'lyrics.transcribe.global': 'le trascrizioni dei testi con l’IA di oggi',
  'lyrics.transcribe.check': 'le verifiche di Solco AI',
  'lyrics.transcribe.save': 'i salvataggi dei testi',
  'audiocom.search.global': 'le ricerche su audio.com di questo minuto',
  'audiocom.search': 'le tue ricerche su audio.com',
  'audiocom.connect.admin': 'i collegamenti ad audio.com',
  'audiocom.upload.admin': 'i caricamenti su audio.com',
  'audiocom.upload.stage.admin': 'la preparazione dei caricamenti su audio.com',
  'site.visit': 'i segnali di visita',
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
