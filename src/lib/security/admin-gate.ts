// @polsia:user-owned — regola ferrea dell'amministrazione, applicata nel proxy prima di qualsiasi
// pagina: /admin e ogni sua sottopagina esistono SOLO per un amministratore con email verificata
// (stessa regola di resolveAdminAccess, usata dall'AdminShell e da ogni API /api/admin). Per
// chiunque altro (visitatori, utenti normali, Googlebot e ogni crawler) la risposta è un 404
// essenziale, uguale per tutti: niente HTML né JavaScript dell'amministrazione, mai in cache, mai
// indicizzabile (X-Robots-Tag + meta robots), nessuno script. Senza cookie di sessione non si legge
// nemmeno il database. Restano anche le altre difese: robots.txt (Disallow /admin e /api/), la
// regola del firewall Vercel su /admin e /api/admin, il controllo nell'AdminShell e quello sul
// server di ogni API admin (provato per tutte in tests/unit/admin-api-iron-rule.test.ts).
import type { NextRequest } from 'next/server';
import { resolveAdminAccess } from '@/lib/business/admin-account-policy';

/** Mai nei risultati di ricerca, mai in copia, mai un'anteprima. */
export const ADMIN_ROBOTS = 'noindex, nofollow, noarchive, nosnippet';

/**
 * Cookie di sessione di better-auth (nomi di getSessionCookie in better-auth/cookies: prefisso
 * `__Secure-` in HTTPS, forma con punto o trattino). Solo la presenza: la firma e la validità le
 * controlla better-auth.
 */
const SESSION_COOKIE_NAMES = new Set([
  '__Secure-better-auth.session_token',
  'better-auth.session_token',
  '__Secure-better-auth-session_token',
  'better-auth-session_token',
]);

export function hasSessionCookie(headers: Headers): boolean {
  const raw = headers.get('cookie');
  if (!raw) return false;
  return raw.split(';').some((part) => {
    const index = part.indexOf('=');
    if (index < 0) return false;
    return (
      SESSION_COOKIE_NAMES.has(part.slice(0, index).trim()) && part.slice(index + 1).trim() !== ''
    );
  });
}

/**
 * true per /admin e ogni sottopagina, anche scritte in modi che il server potrebbe comunque
 * portare lì: maiuscole, %-codifiche (anche doppie), barre ripetute o rovesciate, varianti RSC
 * (/admin.rsc, /admin.segments/…) e /_next/data/<build>/admin.json.
 */
export function isAdminPath(pathname: string): boolean {
  let path = pathname;
  for (let round = 0; round < 3; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded;
  }
  path = path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase()
    .replace(/^\/_next\/data\/[^/]+(?=\/)/, '');
  return /^\/admin(?:$|[/.;])/.test(path);
}

export type AdminSessionUser = {
  role?: string | null;
  email?: string | null;
  emailVerified?: boolean;
} | null;
/** Legge l'utente della sessione dalla richiesta (lancia se non è leggibile). */
export type AdminSessionReader = (headers: Headers) => Promise<AdminSessionUser>;

/** better-auth, caricato solo per le richieste a /admin con un cookie di sessione. */
const readSessionUser: AdminSessionReader = async (headers) => {
  const { auth } = await import('@/lib/auth');
  const session = await auth.api.getSession({ headers });
  return session?.user ?? null;
};

const HIDDEN_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HIDDEN_PAGES = {
  404: { heading: '404', title: 'Pagina non trovata', text: 'La pagina che cerchi non esiste.' },
  503: {
    heading: '503',
    title: 'Servizio non disponibile',
    text: 'Il servizio non è disponibile in questo momento. Riprova tra poco.',
  },
} as const;

/** Pagina autonoma e senza script: nulla rivela che dietro c'è l'amministrazione. */
export function hiddenAdminResponse(status: 404 | 503): Response {
  const page = HIDDEN_PAGES[status];
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${page.title} · Solco</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#111}main{max-width:32rem;padding:2rem;text-align:center}a{color:inherit}@media (prefers-color-scheme:dark){body{background:#0b0b0c;color:#f2f2f2}}</style></head><body><main><h1>${page.heading}</h1><p>${page.text}</p><p><a href="/">Torna a Solco</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': ADMIN_ROBOTS,
      'Content-Security-Policy': HIDDEN_CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Cookie',
      ...(status === 503 ? { 'Retry-After': '30' } : {}),
    },
  });
}

/**
 * null = la richiesta prosegue (non è /admin, oppure è un amministratore verificato); altrimenti
 * la risposta da mandare: 404 per chiunque non sia amministratore, 503 se la sessione non si può
 * leggere (database irraggiungibile: nessuno passa, nemmeno per errore).
 */
export async function adminGate(
  request: NextRequest,
  readUser: AdminSessionReader = readSessionUser,
): Promise<Response | null> {
  if (!isAdminPath(request.nextUrl.pathname)) return null;
  // Senza cookie di sessione nessuno può essere amministratore: niente database.
  if (!hasSessionCookie(request.headers)) return hiddenAdminResponse(404);
  let user: AdminSessionUser;
  try {
    user = await readUser(request.headers);
  } catch {
    return hiddenAdminResponse(503);
  }
  return resolveAdminAccess(false, user) === 'authorized' ? null : hiddenAdminResponse(404);
}
