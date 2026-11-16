// @polsia:user-owned — dominio nudo → origine canonica (www), eseguito dal proxy (src/proxy.ts,
// slot middleware_chain) prima di qualunque altra cosa.
//
// Perché nel proxy: il reindirizzamento a livello di dominio di Vercel e i redirects() di Next
// rispondono 308 con un HSTS di solo max-age (o senza le intestazioni di next.config.ts), e
// hstspreload.org rifiuta il dominio finché la risposta di https://solcomusic.online non porta
// `includeSubDomains` e `preload`. Qui la risposta la costruiamo noi, con l'intestazione completa,
// identica a quella di next.config.ts. Percorso e query restano uguali; un percorso che tenti di
// cambiare origine (es. "//altro.host/x") resta un percorso dell'origine canonica.
//
// Nessun 'server-only': il modulo vive nel bundle del proxy. L'origine canonica è NEXT_PUBLIC_APP_URL
// (canonicalAppOrigin): se non inizia con "www." non c'è dominio nudo da reindirizzare (anteprime).
import { type NextRequest, NextResponse } from 'next/server';
import { canonicalAppOrigin } from '@/lib/security/uam';

/** Lo stesso valore di next.config.ts: 2 anni, sottodomini compresi, candidabile al preload. */
export const HSTS_PRELOAD_VALUE = 'max-age=63072000; includeSubDomains; preload';

type EnvLike = Record<string, string | undefined>;
type RequestLike = Pick<NextRequest, 'headers' | 'nextUrl'>;

/** L'host nudo di un'origine canonica che inizia con "www." (es. solcomusic.online); null altrimenti. */
export function apexHostOf(canonicalOrigin: string | null): string | null {
  if (!canonicalOrigin) return null;
  try {
    const host = new URL(canonicalOrigin).host.toLowerCase();
    return host.startsWith('www.') && host.length > 4 ? host.slice(4) : null;
  } catch {
    return null;
  }
}

/** L'host pubblico della richiesta: x-forwarded-host (prima voce) o l'host dell'URL. */
export function requestHost(request: RequestLike): string {
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase();
  return forwarded || request.nextUrl.host.toLowerCase();
}

/**
 * 308 verso l'origine canonica con HSTS completo se la richiesta è arrivata sul dominio nudo;
 * null in ogni altro caso (www, sottodomini, anteprime senza www, origine canonica assente).
 */
export function apexRedirect(
  request: RequestLike,
  env: EnvLike = process.env,
): NextResponse | null {
  const canonical = canonicalAppOrigin(env);
  const apex = apexHostOf(canonical);
  if (!canonical || !apex) return null;
  if (requestHost(request) !== apex) return null;
  // Concatenazione, non new URL(path, base): "//altro.host/x" resta un percorso dell'origine canonica.
  const target = new URL(`${canonical}${request.nextUrl.pathname}${request.nextUrl.search}`);
  if (target.origin !== canonical) return null;
  const response = NextResponse.redirect(target, 308);
  response.headers.set('Strict-Transport-Security', HSTS_PRELOAD_VALUE);
  response.headers.set('Cache-Control', 'public, max-age=3600');
  response.headers.set('X-Solco-Redirect', 'apex');
  return response;
}
