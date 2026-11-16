// @polsia:user-owned — «La richiesta nasce dentro Solco?» per le route che accettano solo richieste
// del sito stesso: lo stream dei brani in evidenza (anti-hotlink, featured-stream-access.ts) e gli
// avvii OAuth (Spotify, audio.com, TikTok).
//
// Regola: decide `Sec-Fetch-Site` quando dice same-origin, same-site o none. Quando dice cross-site
// (o same-site dove non basta) la richiesta passa SOLO se `Origin` o `Referer` portano un'origine di
// Solco. Perché: la web app di iOS aggiunta alla schermata Home (il profilo iOS, Web Clip a schermo
// intero) conta per WebKit come un'app diversa da Safari, e le richieste che passano da un contesto
// all'altro arrivano marcate `cross-site` anche se partono da una pagina di Solco: prima ricevevano
// 403 «in certi casi». `Origin` e `Referer` però li scrive il browser e un altro sito non può
// metterci la nostra origine: al più li toglie (referrerpolicy=no-referrer), e allora la richiesta
// resta rifiutata. Senza intestazioni Fetch Metadata (browser vecchi, app native) passa: decide la
// sessione. Puro, senza 'server-only': usato da route handler e test.

/** Valori di Sec-Fetch-Site che bastano da soli: il sito stesso o una navigazione dell'utente. */
export const DEFAULT_OWN_SITES: readonly string[] = ['same-origin', 'same-site', 'none'];
/** Avvii OAuth: un sottodominio (same-site) non basta, serve l'origine esatta o una navigazione. */
export const NAVIGATION_OWN_SITES: readonly string[] = ['same-origin', 'none'];

export type OwnSiteEnv = {
  NEXT_PUBLIC_APP_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
};

type RequestLike = Pick<Request, 'url' | 'headers'>;

/**
 * L'origine http(s) esatta di `value` (URL o origine), oppure null per wildcard, credenziali,
 * schemi diversi, "null" e valori non validi. Stesse regole di src/lib/same-origin.ts.
 */
export function exactOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048 || trimmed.includes('*')) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Host (con porta facoltativa) come lo manda il browser o lo riscrive l'hosting. */
const HOST_PATTERN = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/i;

/** Le origini su cui QUESTA richiesta è arrivata: host pubblico dell'hosting, header Host, URL. */
function requestOrigins(request: RequestLike): string[] {
  const origins: string[] = [];
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const scheme = proto === 'http' ? 'http' : 'https';
  for (const name of ['x-forwarded-host', 'host']) {
    const host = request.headers.get(name)?.split(',')[0]?.trim().toLowerCase();
    if (!host || !HOST_PATTERN.test(host)) continue;
    const origin = exactOrigin(`${scheme}://${host}`);
    if (origin) origins.push(origin);
  }
  const own = exactOrigin(request.url);
  if (own) origins.push(own);
  return origins;
}

/**
 * Le origini di Solco: NEXT_PUBLIC_APP_URL, le origini esatte di BETTER_AUTH_TRUSTED_ORIGINS (come
 * same-origin.ts) e, se c'è la richiesta, l'host su cui è arrivata (anche su anteprime e domini
 * secondari). Mai wildcard.
 */
export function ownSiteOrigins(env: OwnSiteEnv, request?: RequestLike): Set<string> {
  const origins = new Set<string>();
  const add = (value: string | undefined) => {
    const origin = exactOrigin(value);
    if (origin) origins.add(origin);
  };
  add(env.NEXT_PUBLIC_APP_URL);
  for (const entry of (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(',')) add(entry);
  if (request) for (const origin of requestOrigins(request)) origins.add(origin);
  return origins;
}

/**
 * Perché la richiesta passa: Fetch Metadata del sito stesso, nessuna Fetch Metadata (browser
 * vecchio o client nativo), oppure un `Origin`/`Referer` di Solco nonostante un Sec-Fetch-Site
 * cross-site (web app iOS). null = non passa.
 */
export type OwnSiteEvidence = 'fetch-metadata' | 'no-metadata' | 'origin' | 'referer';

export function ownSiteEvidence(
  headers: Headers,
  ownOrigins: ReadonlySet<string>,
  sites: readonly string[] = DEFAULT_OWN_SITES,
): OwnSiteEvidence | null {
  const site = headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (!site) return 'no-metadata';
  if (sites.includes(site)) return 'fetch-metadata';
  const origin = exactOrigin(headers.get('origin'));
  if (origin && ownOrigins.has(origin)) return 'origin';
  const referer = exactOrigin(headers.get('referer'));
  if (referer && ownOrigins.has(referer)) return 'referer';
  return null;
}

/** True se la richiesta può venire da Solco stesso (vedi ownSiteEvidence). */
export function isFromOwnSite(
  headers: Headers,
  ownOrigins: ReadonlySet<string>,
  sites: readonly string[] = DEFAULT_OWN_SITES,
): boolean {
  return ownSiteEvidence(headers, ownOrigins, sites) !== null;
}

/** Solo parole brevi e note nei log: un valore inatteso diventa "altro" (niente testo del client). */
function token(value: string | null | undefined): string {
  const lower = value?.trim().toLowerCase() ?? '';
  if (lower.length === 0) return 'assente';
  return /^[a-z-]{1,24}$/.test(lower) ? lower : 'altro';
}

/**
 * Riassunto di una richiesta rifiutata per il log del server, SENZA dati personali: solo le
 * categorie delle intestazioni (mai IP, User-Agent, URL, cookie né gli host di Origin/Referer).
 */
export function describeSiteHeaders(headers: Headers, ownOrigins: ReadonlySet<string>): string {
  const classify = (value: string | null): string => {
    if (!value) return 'assente';
    const origin = exactOrigin(value);
    if (!origin) return 'non-valido';
    return ownOrigins.has(origin) ? 'proprio' : 'altro';
  };
  return [
    `site=${token(headers.get('sec-fetch-site'))}`,
    `dest=${token(headers.get('sec-fetch-dest'))}`,
    `origin=${classify(headers.get('origin'))}`,
    `referer=${classify(headers.get('referer'))}`,
  ].join(' ');
}
