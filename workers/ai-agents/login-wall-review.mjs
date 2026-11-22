// @polsia:user-owned — 5 agenti specialisti + 1 capo squadra rivedono la SICUREZZA del muro di login
// di Solco (anti-aggiramento): come un visitatore non loggato, o un bot, potrebbe raggiungere
// contenuti o dati protetti. Leggono solo il codice del repo (nessun segreto), più una MAPPA generata
// qui che, per ogni route handler sotto src/app/api, elenca quali guardie usa (requireAuth,
// requireAdmin/isAuthorizedAdmin, sameOrigin, CRON_SECRET, checkTelegramOwner), così l'agente delle
// API vede subito quali rotte NON hanno un controllo di sessione.
import { readdir, readFile } from 'node:fs/promises';

export const LOGIN_WALL_SUBJECT =
  'Sei un ingegnere della sicurezza applicativa e rivedi il MURO DI LOGIN di Solco (app musicale ' +
  'Next.js 16 App Router su Vercel, autenticazione better-auth con cookie di sessione). Obiettivo: ' +
  'trovare come un visitatore NON loggato o un bot potrebbe aggirare il muro e leggere contenuti o ' +
  'dati riservati. Il muro vero è lato server, nelle route /api: il gating lato client ' +
  '(require-login.tsx) è solo esperienza d’uso. Per ogni problema indica il FILE e la funzione, lo ' +
  'scenario concreto di aggiramento (quale richiesta, da chi, cosa ottiene), la gravità e la ' +
  'correzione minima. Basati SOLO sul codice ricevuto: non inventare file, rotte o comportamenti. ' +
  'Non proporre di indebolire condivisioni volute (link pubblici di playlist, quiz, brani in ' +
  'evidenza), né la SEO (noindex), né l’accessibilità. Attento ai falsi positivi: una rotta può ' +
  'essere pubblica APPOSTA; dillo se non sei sicuro.';

/** File letti per intero, per nome di percorso del repo. */
const FILES = {
  wall: [
    'src/components/custom/require-login.tsx',
    'src/lib/signed-in-hint.ts',
    'src/lib/business/auth-form.ts',
    'src/lib/security/safe-auth-redirect.ts',
    'src/lib/business/social-share.ts',
  ],
  apiEnforcement: [
    'src/lib/require-auth.ts',
    'src/lib/same-origin.ts',
    'src/lib/business/admin-account-policy.ts',
    'src/lib/security/admin-gate.ts',
    'src/app/api/community/me/route.ts',
    'src/app/api/example/route.ts',
  ],
  publicContent: [
    'src/app/api/music/shared/[shareId]/route.ts',
    'src/app/(custom)/evidenza/[shareId]/page.tsx',
    'src/lib/music/featured-sections.ts',
    'src/lib/music/public-uploads.server.ts',
    'src/app/api/public/iscritti/route.ts',
  ],
  antibot: [
    'src/lib/security/uam-gate.ts',
    'src/lib/security/uam.ts',
    'src/lib/security/crawler-verify.ts',
    'src/lib/security/own-site-request.ts',
  ],
  proxySeo: [
    'src/proxy.ts',
    'src/lib/security/apex-redirect.ts',
    'src/lib/security/prototype-guard.ts',
    'src/app/robots.ts',
  ],
};

/** Le guardie che cerchiamo in ogni route handler (regex → etichetta per la mappa). Comprende i
 *  wrapper reali del progetto (requireAccountAdmin, requireSolcoPro, requireAudioComAdmin, …) e la
 *  verifica di firma dei webhook (pagamenti, Telegram), così una rotta davvero senza controllo si
 *  distingue da una protetta da un helper con un altro nome. */
const GUARDS = [
  [/require\w*Admin|isAuthorizedAdmin|adminGate|currentAdmin/, 'admin'],
  [/requireAuth|getSession|requireSolcoPro|verifyCheckoutSession|ensure\w*Session/, 'sessione'],
  [/CRON_SECRET|requireCron|checkCron/, 'cron'],
  [/checkTelegramOwner|webhookSecret|telegram.{0,20}secret/i, 'bot/webhook-token'],
  [/verify\w*Notification|verify\w*Webhook|constructEvent|verifySignature|svix|webhooks\.construct|appStoreServerApi|jws|x-goog/i, 'firma-webhook'],
  [/aiGate|reserveKey|FREELLMAPI_API_KEY/, 'chiave-riserva'],
  [/sameOrigin/, 'same-origin'],
];

/** Tutti i file route.ts sotto una cartella. */
async function routeFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await routeFiles(path, base)));
    else if (entry.name === 'route.ts') out.push(path);
  }
  return out;
}

/**
 * Una riga per ogni route handler: il percorso URL, i metodi esportati e le guardie trovate nel
 * sorgente. Una rotta che esporta POST/PUT/PATCH/DELETE senza «same-origin», o che non ha né
 * «sessione» né «admin» né «cron» né «bot-owner», è segnata con ⚠ perché va guardata a mano.
 */
export function gateMap(routes) {
  return routes
    .map(({ path, source }) => {
      const url = path
        .replace(/^src\/app/, '')
        .replace(/\/route\.ts$/, '')
        .replace(/\/\([^)]+\)/g, '');
      const methods = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE|HEAD)/g)].map(
        (m) => m[1],
      );
      const found = new Set();
      for (const [re, label] of GUARDS) if (re.test(source)) found.add(label);
      const mutating = methods.some((m) => m !== 'GET' && m !== 'HEAD');
      const unguarded = !['sessione', 'admin', 'cron', 'bot/webhook-token', 'firma-webhook', 'chiave-riserva'].some((g) => found.has(g));
      const noCsrf = mutating && !found.has('same-origin');
      const flags = `${unguarded ? ' ⚠senza-sessione' : ''}${noCsrf ? ' ⚠senza-same-origin' : ''}`;
      return `${url || '/'} [${methods.join(',') || '—'}] guardie: ${[...found].join(', ') || 'nessuna'}${flags}`;
    })
    .sort();
}

/** Legge i file a disposizione e costruisce la mappa delle guardie delle route. */
export async function collectLoginWall({ root } = {}) {
  const read = (path) => readFile(new URL(path, root), 'utf8').catch(() => null);
  const paths = [...new Set(Object.values(FILES).flat())];
  const contents = await Promise.all(paths.map(read));
  const files = Object.fromEntries(paths.map((p, i) => [p, contents[i]]).filter(([, t]) => t !== null));

  const apiDir = new URL('src/app/api', root);
  const routePaths = await routeFiles(apiDir.pathname);
  const routes = [];
  for (const abs of routePaths) {
    const rel = abs.slice(abs.indexOf('src/app/api'));
    const source = await readFile(abs, 'utf8').catch(() => '');
    if (source) routes.push({ path: rel, source });
  }
  const map = gateMap(routes);
  return {
    measuredAt: new Date().toISOString(),
    files,
    missing: paths.filter((p) => !(p in files)),
    map,
    routeCount: routes.length,
  };
}

const show = (m, paths) =>
  paths.map((p) => `===== ${p} =====\n${m.files[p] ?? '(file non trovato)'}`).join('\n\n');

export const LOGIN_WALL_SPECIALISTS = [
  {
    id: 'wall',
    title: 'Il muro lato client: rotte pubbliche, redirect, indizio di sessione',
    facts: (m) =>
      `${show(m, FILES.wall)}\n\nDomande: l'elenco delle rotte pubbliche (isPublicRoute) lascia passare ` +
      `più del voluto? loginDestination/callbackURL può diventare un open-redirect (//host, /\\host, ` +
      `URL assoluto)? l'indizio «già loggato» (localStorage/attributo) può far saltare la verifica?`,
  },
  {
    id: 'api-enforcement',
    title: 'Enforcement lato API: quali rotte non controllano la sessione',
    facts: (m) =>
      `${show(m, FILES.apiEnforcement)}\n\nMappa delle guardie di tutte le ${m.routeCount} route ` +
      `(⚠ = da guardare a mano):\n${m.map.join('\n')}\n\nDomande: quali rotte segnate ⚠senza-sessione ` +
      `servono dati di un utente o azioni riservate senza controllo? ⚠senza-same-origin su una rotta ` +
      `che modifica è un rischio CSRF? requireAuth/requireAdmin sono applicati davvero prima di leggere i dati?`,
  },
  {
    id: 'public-content',
    title: 'Contenuti serviti ai non loggati: espongono solo il voluto?',
    facts: (m) =>
      `${show(m, FILES.publicContent)}\n\nDomande: i link condivisi (brani in evidenza, playlist) e la ` +
      `Home pubblica espongono solo ciò che è inteso (metadati, streamUrl dichiarati) o anche dati privati, ` +
      `email, id interni, brani non condivisi? un id si può indovinare o enumerare?`,
  },
  {
    id: 'antibot',
    title: 'Cancello anti-bot (UAM): proof-of-work, cookie, uscita',
    facts: (m) =>
      `${show(m, FILES.antibot)}\n\nDomande: il proof-of-work e il cookie di clearance si possono forgiare, ` +
      `riusare da un'altra rete o da un altro user agent, o aggirare? la verifica dei crawler (Googlebot) ` +
      `si può fingere? una richiesta può dichiararsi «dal sito stesso» per saltare il cancello?`,
  },
  {
    id: 'proxy-seo',
    title: 'Proxy, redirect apice e noindex (bordo e motori di ricerca)',
    facts: (m) =>
      `${show(m, FILES.proxySeo)}\n\nNota: proxy.ts è framework-owned (sola lettura). Domande: il matcher ` +
      `del proxy lascia scoperto qualche percorso? le pagine protette dichiarano noindex (niente indicizzazione ` +
      `di contenuti riservati)? il redirect dell'apice o il prototype-guard aprono un buco?`,
  },
];

export const LOGIN_WALL_LEAD_PROMPT =
  'Sei il capo squadra della sicurezza. Unisci i rapporti in UN piano per potenziare il muro di login ' +
  'contro l’aggiramento: le 10 correzioni più utili in ordine di rischio (alto/medio/basso), ognuna con ' +
  'file e funzione, lo scenario di aggiramento che chiude, lo sforzo e la correzione concreta. Separa ' +
  'bene i VERI buchi (un non loggato ottiene dati riservati) dai miglioramenti di robustezza. Scarta i ' +
  'doppioni e ciò che le condivisioni volute spiegano. Chiudi dicendo cosa NON va toccato per non ' +
  'rompere i link pubblici, la SEO o l’accesso legittimo.';
