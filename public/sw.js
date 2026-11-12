// @polsia:user-owned — Service Worker di Solco: il guscio dell'app che si apre anche senza rete.
//
// JavaScript semplice, nessun import e nessuna dipendenza: il browser lo scarica così com'è da
// /sw.js (vercel.json gli toglie la cache HTTP, così gli aggiornamenti arrivano subito).
// Cosa fa e cosa NON fa è spiegato in docs/offline.md. In breve:
//   - pagine (navigazioni): prima la rete. Senza rete la copia salvata della stessa pagina, poi la
//     Libreria, poi /offline. Rete lenta: dopo 4 s solo la copia della stessa pagina (o il ripiego
//     se il dispositivo è offline), altrimenti si aspetta fino a 10 s. Salva solo l'HTML di "/" e
//     "/library", insieme ai CSS/JS che cita (cache del guscio, mai sfoltita).
//   - file statici con hash (/_next/static), font, loghi e icone: prima la cache, max ~200 voci,
//     sfoltite togliendo quelle usate meno di recente.
//   - mai toccate: /api, /health, login e pagamenti, /sw.js, richieste con Range (audio),
//     altri domini, metodi diversi da GET. I file audio dell'utente non passano mai di qui.
//
// Aggiornare: cambiare VERSION (es. 'v2') ripulisce le cache vecchie all'attivazione.

const VERSION = 'v1';
const SHELL_CACHE = `solco-shell-${VERSION}`;
const STATIC_CACHE = `solco-static-${VERSION}`;
/** Solo le cache di questo file: le altre cache del sito (es. musica locale) non si toccano. */
const OWN_CACHE_PREFIXES = ['solco-shell-', 'solco-static-'];

/** Dopo questa attesa si usa la copia salvata della stessa pagina, o il ripiego se offline. */
const NAVIGATION_TIMEOUT_MS = 4000;
/** Rete presente ma lenta (avvio a freddo, 3G): oltre questo limite si usa comunque il ripiego. */
const NAVIGATION_SLOW_TIMEOUT_MS = 10000;
const STATIC_MAX_ENTRIES = 200;
/** Quanti file statici citati dall'HTML di una pagina guscio salvare insieme a lei. */
const SHELL_ASSET_LIMIT = 60;
const STATIC_ASSET_PREFIX = '/_next/static/';

const OFFLINE_PATH = '/offline';
const LIBRARY_PATH = '/library';
const MANIFEST_PATH = '/manifest.webmanifest';
/** Pagine il cui HTML si salva a ogni visita riuscita: sono gusci che mostrano dati lato client. */
const SHELL_PAGES = ['/', LIBRARY_PATH];
const ICON_PATHS = [
  '/icon.svg',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/solco-icon-512.png',
  '/solco-android-icon.svg',
];
/** All'installazione: /offline è obbligatoria (senza, l'installazione riprova più tardi). */
const PRECACHE_REQUIRED = [OFFLINE_PATH];
/**
 * Latin subsets of the self-hosted fonts the app shell uses (custom-style.css / brand-theme.css):
 * fetched before this worker controlled the first page, they would otherwise never reach the
 * cache, and the app would open offline with fallback fonts. About 25 KB each.
 */
const FONT_PATHS = [
  '/fonts/inter/inter-400-normal-latin.woff2',
  '/fonts/inter/inter-500-normal-latin.woff2',
  '/fonts/inter/inter-600-normal-latin.woff2',
  '/fonts/inter/inter-700-normal-latin.woff2',
  '/fonts/instrument-serif/instrument-serif-400-normal-latin.woff2',
  '/fonts/space-grotesk/space-grotesk-400-normal-latin.woff2',
  '/fonts/space-grotesk/space-grotesk-500-normal-latin.woff2',
  '/fonts/space-grotesk/space-grotesk-600-normal-latin.woff2',
  '/fonts/space-grotesk/space-grotesk-700-normal-latin.woff2',
];
const PRECACHE_OPTIONAL = [
  LIBRARY_PATH,
  MANIFEST_PATH,
  '/icon.svg',
  '/apple-touch-icon.png',
  '/solco-icon-512.png',
  ...FONT_PATHS,
];
/** File immutabili o quasi: si servono dalla cache se presenti. */
const STATIC_PREFIXES = [STATIC_ASSET_PREFIX, '/fonts/', '/brand/'];
/**
 * Percorsi che il Service Worker non intercetta mai (la richiesta va in rete come se lui non ci
 * fosse): dati, controlli di salute, accesso e account, pagamenti, inviti, area admin.
 */
const BYPASS_PATHS = [
  '/api',
  '/health',
  '/sw.js',
  '/login',
  '/signup',
  '/profile',
  '/delete-account',
  '/checkout',
  '/piani/grazie',
  '/piani/paypal',
  '/apple-music',
  '/invito',
  '/admin',
  '/dashboard',
  '/.well-known',
  '/_vercel',
];
/** Risposta della pagina di verifica anti-bot (src/lib/security/uam-gate.ts): mai in cache. */
const GATE_HEADER = 'x-solco-gate';
/** I file salvati non cambiano in base alle intestazioni della richiesta (RSC, Accept…). */
const MATCH_OPTIONS = { ignoreVary: true };

const OFFLINE_HTML = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sei offline · Solco</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000;color:#fafafa;font-family:"Space Grotesk",Arial,sans-serif;text-align:center;padding:24px;box-sizing:border-box}
main{max-width:28rem}
h1{font-size:2rem;margin:0 0 .75rem}
p{color:#a3a3a3;line-height:1.5;margin:0 0 1.5rem}
a{display:inline-block;padding:.75rem 1.5rem;border-radius:.75rem;background:#fafafa;color:#000;font-weight:600;text-decoration:none}
</style>
</head>
<body>
<main>
<h1>Sei offline</h1>
<p>Non c'è connessione a Internet. Solco riprende appena torni online.</p>
<a href="">Riprova</a>
</main>
</body>
</html>`;

function absoluteUrl(path) {
  return new URL(path, self.location.origin).href;
}

function matchesPath(pathname, base) {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Navigazioni verso file (/solco.apk, /ios/solco.mobileconfig, /llms.txt…): solo rete. */
function looksLikeFile(pathname) {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /\.[a-z0-9]{1,12}$/i.test(last);
}

function shellKeyFor(pathname) {
  return SHELL_PAGES.includes(pathname) ? absoluteUrl(pathname) : null;
}

/** Solo risposte complete dello stesso sito: niente redirect, errori, risposte parziali o gate. */
function isCacheable(response) {
  return Boolean(
    response &&
      response.status === 200 &&
      !response.redirected &&
      (response.type === 'basic' || response.type === 'default') &&
      !response.headers.has(GATE_HEADER),
  );
}

function isHtml(response) {
  return (response.headers.get('content-type') || '').includes('text/html');
}

/**
 * Strategia per una richiesta: 'navigate' (prima la rete), 'static' (prima la cache),
 * 'manifest' (rete, poi cache) oppure 'bypass' (nessuna intercettazione).
 */
function routeRequest(request) {
  if (request.method !== 'GET') return 'bypass';
  if (request.headers.has('range')) return 'bypass';
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return 'bypass';
  }
  if (url.origin !== self.location.origin) return 'bypass';
  if (BYPASS_PATHS.some((base) => matchesPath(url.pathname, base))) return 'bypass';
  if (request.mode === 'navigate') return looksLikeFile(url.pathname) ? 'bypass' : 'navigate';
  if (STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return 'static';
  if (ICON_PATHS.includes(url.pathname)) return 'static';
  if (url.pathname === MANIFEST_PATH) return 'manifest';
  return 'bypass';
}

function extendLifetime(event, promise) {
  const settled = Promise.resolve(promise).catch(() => undefined);
  try {
    event.waitUntil(settled);
  } catch {
    // L'evento è già concluso: la scrittura prosegue comunque in background.
  }
}

async function putAndTrim(cacheName, request, response, maxEntries) {
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  if (!maxEntries) return;
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  // Cache.keys() rispetta l'ordine di inserimento: si tolgono le voci più vecchie.
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function matchOwn(request) {
  for (const name of [STATIC_CACHE, SHELL_CACHE]) {
    const cache = await caches.open(name);
    const hit = await cache.match(request, MATCH_OPTIONS);
    if (hit) return hit;
  }
  return undefined;
}

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

function isDeviceOffline() {
  try {
    return self.navigator?.onLine === false;
  } catch {
    return false;
  }
}

/** La copia salvata della stessa pagina ("/" o "/library"), se c'è. */
async function savedShellCopy(shellKey) {
  if (!shellKey) return undefined;
  try {
    const cache = await caches.open(SHELL_CACHE);
    return await cache.match(shellKey, MATCH_OPTIONS);
  } catch {
    return undefined;
  }
}

/** Senza rete: la stessa pagina salvata, poi la Libreria, poi /offline, poi l'HTML di riserva. */
async function navigationFallback(url) {
  try {
    const cache = await caches.open(SHELL_CACHE);
    const candidates = [
      absoluteUrl(url.pathname),
      absoluteUrl(LIBRARY_PATH),
      absoluteUrl(OFFLINE_PATH),
    ];
    for (const key of candidates) {
      const hit = await cache.match(key, MATCH_OPTIONS);
      if (hit) return hit;
    }
  } catch {
    // Cache non disponibile (spazio esaurito, modalità privata): resta l'HTML di riserva.
  }
  return offlineResponse();
}

function handleNavigation(event) {
  const request = event.request;
  const url = new URL(request.url);
  const shellKey = shellKeyFor(url.pathname);
  const network = fetch(request);

  // La copia per la cache si fa nella prima reazione, prima che la pagina legga il corpo.
  extendLifetime(
    event,
    network.then((response) => {
      if (shellKey && isCacheable(response) && isHtml(response)) {
        const copy = response.clone();
        return maintainShell(() => saveShellPage(shellKey, copy));
      }
      return undefined;
    }),
  );

  return new Promise((resolve) => {
    let settled = false;
    const timers = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(value);
    };
    const fallback = () => finish(navigationFallback(url));
    // Rete lenta ma presente: un'altra pagina (es. la Libreria al posto di /premi) sarebbe
    // sbagliata. Dopo 4 s solo la copia della stessa pagina, o il ripiego se il dispositivo è
    // offline; altrimenti si aspetta la rete fino a 10 s.
    timers.push(
      setTimeout(async () => {
        if (settled) return;
        if (isDeviceOffline()) {
          fallback();
          return;
        }
        const copy = await savedShellCopy(shellKey);
        if (copy) finish(copy);
      }, NAVIGATION_TIMEOUT_MS),
    );
    timers.push(setTimeout(fallback, NAVIGATION_SLOW_TIMEOUT_MS));
    network.then(finish, fallback);
  });
}

async function cacheFirst(event) {
  const request = event.request;
  const statics = await caches.open(STATIC_CACHE);
  const hit = await statics.match(request, MATCH_OPTIONS);
  if (hit) {
    // LRU: un file usato torna in fondo all'ordine di inserimento, così lo sfoltimento toglie
    // quelli non usati da più tempo e non quelli che servono a ogni pagina.
    extendLifetime(event, statics.put(request, hit.clone()));
    return hit;
  }
  const pinned = await (await caches.open(SHELL_CACHE)).match(request, MATCH_OPTIONS);
  if (pinned) return pinned;
  const response = await fetch(request);
  if (isCacheable(response)) {
    extendLifetime(event, putAndTrim(STATIC_CACHE, request, response.clone(), STATIC_MAX_ENTRIES));
  }
  return response;
}

async function networkThenCache(event) {
  const request = event.request;
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      extendLifetime(
        event,
        putAndTrim(SHELL_CACHE, absoluteUrl(MANIFEST_PATH), response.clone(), 0),
      );
    }
    return response;
  } catch (error) {
    const cached = await matchOwn(absoluteUrl(MANIFEST_PATH));
    if (cached) return cached;
    throw error;
  }
}

async function fetchForPrecache(path) {
  const response = await fetch(
    new Request(absoluteUrl(path), { cache: 'reload', credentials: 'same-origin' }),
  );
  return isCacheable(response) ? response : null;
}

/** File statici (/_next/static/...) citati da un HTML: CSS e JS che servono per mostrarlo offline. */
function staticAssetsIn(html) {
  const found = new Set();
  const pattern = /["'](?:\/_next\/)?(static\/(?:chunks|css|media)\/[^"'\\\s<>]+)/g;
  let match = pattern.exec(html);
  while (match !== null) {
    found.add(`/_next/${match[1]}`);
    match = pattern.exec(html);
  }
  return [...found];
}

/**
 * Nella cache del guscio (mai sfoltita), insieme all'HTML che li cita: le pagine salvate restano
 * copie coerenti, con il loro CSS e JS, anche dopo molti deploy e molte pagine visitate. Prima si
 * copiano dalla cache statica; si scaricano solo se mancano.
 */
async function pinAssets(paths) {
  const list = [...new Set(paths)].slice(0, SHELL_ASSET_LIMIT);
  const shell = await caches.open(SHELL_CACHE);
  const statics = await caches.open(STATIC_CACHE);
  await Promise.all(
    list.map(async (path) => {
      try {
        const key = absoluteUrl(path);
        if (await shell.match(key, MATCH_OPTIONS)) return;
        const stored = await statics.match(key, MATCH_OPTIONS);
        const response = stored || (await fetch(key, { credentials: 'same-origin' }));
        if (isCacheable(response)) await shell.put(key, response);
      } catch {
        // Facoltativo: il file si salverà alla prossima visita online che lo usa.
      }
    }),
  );
}

/** Toglie dalla cache del guscio i /_next/static che nessuna pagina salvata cita più. */
async function pruneShellAssets() {
  const cache = await caches.open(SHELL_CACHE);
  const keep = new Set();
  for (const path of [...SHELL_PAGES, OFFLINE_PATH]) {
    const page = await cache.match(absoluteUrl(path), MATCH_OPTIONS);
    if (!page) continue;
    for (const asset of staticAssetsIn(await page.text())) keep.add(absoluteUrl(asset));
  }
  for (const key of await cache.keys()) {
    const url = new URL(key.url);
    if (url.pathname.startsWith(STATIC_ASSET_PREFIX) && !keep.has(url.href)) {
      await cache.delete(key);
    }
  }
}

/** Le scritture sul guscio una alla volta: una pulizia non cancella i file appena fissati. */
let shellQueue = Promise.resolve();

function maintainShell(task) {
  const run = shellQueue.then(task);
  shellQueue = run.catch(() => undefined);
  return run;
}

/** Salva l'HTML di "/" o "/library" e fissa i CSS/JS che cita, così si riapre anche offline. */
async function saveShellPage(shellKey, response) {
  const html = await response.clone().text();
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(shellKey, response);
  await pinAssets(staticAssetsIn(html));
  await pruneShellAssets();
}

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  const pages = [];

  for (const path of PRECACHE_REQUIRED) {
    const response = await fetchForPrecache(path);
    if (!response) throw new Error(`Precache non riuscita: ${path}`);
    pages.push(await response.clone().text());
    await cache.put(absoluteUrl(path), response);
  }

  await Promise.all(
    PRECACHE_OPTIONAL.map(async (path) => {
      try {
        const response = await fetchForPrecache(path);
        if (!response) return;
        if (path === LIBRARY_PATH && isHtml(response)) pages.push(await response.clone().text());
        await cache.put(absoluteUrl(path), response);
      } catch {
        // Facoltativo: si riprova alla prossima visita online.
      }
    }),
  );

  try {
    await pinAssets(pages.flatMap(staticAssetsIn));
  } catch {
    // Facoltativo.
  }
}

async function deleteOldCaches() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter(
        (name) =>
          OWN_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
          name !== SHELL_CACHE &&
          name !== STATIC_CACHE,
      )
      .map((name) => caches.delete(name)),
  );
}

// Nessun skipWaiting all'installazione: la nuova versione aspetta finché la pagina non chiede
// SKIP_WAITING (service-worker-registration.tsx), così non si interrompe mai un ascolto.
self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        await deleteOldCaches();
      } finally {
        await self.clients.claim();
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  const type = typeof data === 'string' ? data : data?.type;
  if (type === 'SKIP_WAITING') extendLifetime(event, self.skipWaiting());
});

self.addEventListener('fetch', (event) => {
  const strategy = routeRequest(event.request);
  if (strategy === 'navigate') event.respondWith(handleNavigation(event));
  else if (strategy === 'static') event.respondWith(cacheFirst(event));
  else if (strategy === 'manifest') event.respondWith(networkThenCache(event));
  // 'bypass': nessun respondWith, il browser va in rete come se il Service Worker non ci fosse.
});
