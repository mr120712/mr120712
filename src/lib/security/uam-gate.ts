// @polsia:user-owned
//
// The UAM gate, run by src/proxy.ts (middleware_chain slot) on every request the
// proxy matcher selects. It returns `null` to let the request through, or the
// loading-screen interstitial that solves a proof-of-work challenge and comes
// back with a clearance cookie (POST /api/uam/verify).
//
// Collegato: src/proxy.ts chiama uamGate() prima della CSP. Il matcher del proxy
// non esclude più le richieste di prefetch (header Purpose / Next-Router-Prefetch):
// erano un modo per saltare il gate (vedi il commento in src/proxy.ts).
//
// Fails OPEN: the gate is off unless UAM_MODE and a strong UAM_SECRET are both
// set, it never challenges on a host whose pages verify would refuse (in attack
// mode it redirects those hosts to the canonical origin instead, when there is
// one), and any internal error lets the request through. A broken gate must
// never lock visitors out of Solco. No 'server-only' here: this module is
// bundled into the proxy.
//
// Cost: in attack mode every request the proxy matcher selects, refused ones
// included, still runs the proxy as a Vercel Function (an invocation, CPU time
// and a ~15 KB HTML answer each); on the Hobby plan a real flood can exhaust the
// plan limits and pause the site. Against a volumetric attack turn on Vercel
// Firewall "Attack Challenge Mode" (all plans), which challenges at the edge
// before any function runs. UAM attack mode complements it, it does not replace it.
import { type NextRequest, NextResponse } from 'next/server';
import {
  canonicalAppOrigin,
  ipPrefix,
  isAllowlistedBot,
  isClientNavigationRequest,
  isGateablePath,
  isLinkPreviewBot,
  issueChallenge,
  readUamConfig,
  UAM_COOKIE,
  type UamContext,
  uaHash,
  uamChallengeHosts,
  verifyClearance,
} from './uam';
import { renderUamPage, uamPageCsp } from './uam-page';
import { LINK_PREVIEW_CSP, linkPreviewFor, renderLinkPreviewPage } from './uam-preview';

let warnedWeakSecret = false;

/** Standard base64 of 16 random bytes, for the interstitial's script nonce. */
function createNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/**
 * Next renders dynamic pages for POST/PUT/PATCH/DELETE as well, so letting
 * them through would skip the challenge. Nothing legitimate is lost: Server
 * Actions are banned and every POST endpoint lives under /api (not gated).
 */
function methodNotAllowed(): NextResponse {
  return new NextResponse(null, {
    status: 405,
    headers: {
      Allow: 'GET, HEAD',
      'Cache-Control': 'no-store, private',
      'X-Solco-Gate': 'challenge',
    },
  });
}

/**
 * Modalità attacco su un host dove la verifica non può riuscire (non è in uamChallengeHosts,
 * es. status.solcomusic.online, agganciato allo stesso progetto Vercel): invece di servire ogni
 * pagina senza controllo, 308 allo stesso percorso sull'origine canonica, dove il gate c'è.
 * Senza un'origine canonica https diversa da questo host si continua a lasciar passare (fail open).
 */
function redirectToCanonicalHost(request: NextRequest): NextResponse | null {
  const canonical = canonicalAppOrigin(process.env);
  if (!canonical || new URL(canonical).host === request.nextUrl.host) return null;
  if (!isReadMethod(request.method)) return methodNotAllowed();
  // Concatenazione, non new URL(path, base): un percorso "//altro.host/x" resta un percorso
  // dell'origine canonica e non diventa un redirect verso un altro sito.
  const target = new URL(`${canonical}${request.nextUrl.pathname}${request.nextUrl.search}`);
  if (target.origin !== canonical) return null;
  const response = NextResponse.redirect(target, 308);
  response.headers.set('Cache-Control', 'no-store, private');
  response.headers.set('X-Solco-Gate', 'redirect');
  return response;
}

/**
 * Modalità attacco, bot di anteprima dei link: 200 con una paginetta di soli meta tag (titolo,
 * descrizione, immagine assoluta), senza script e senza render dell'app. Gli URL usano l'origine
 * canonica (NEXT_PUBLIC_APP_URL se è https), altrimenti quella della richiesta.
 */
function linkPreviewResponse(request: NextRequest): NextResponse {
  const base = canonicalAppOrigin(process.env) ?? request.nextUrl.origin;
  const html = renderLinkPreviewPage(linkPreviewFor(request.nextUrl, base));
  return new NextResponse(request.method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'Content-Security-Policy': LINK_PREVIEW_CSP,
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Solco-Gate': 'preview',
    },
  });
}

/**
 * `null` = let it through. Otherwise the interstitial response (200 in
 * first-visit mode, 503 + Retry-After in attack mode). RSC and prefetch
 * requests without clearance get the same HTML: the client router then falls
 * back to a full navigation, which shows the loading screen. Other methods
 * without clearance get a bodyless 405.
 *
 * Modalità attacco, in più: gli host non protetti rimandano all'origine canonica (308), i bot
 * delle anteprime dei link ricevono la paginetta di meta tag, e le navigazioni client di Next
 * (`RSC: 1`) accettano una clearance emessa in modalità attacco fino a 24 ore (non solo un'ora),
 * così la navigazione client non si interrompe (e il player non si ferma) ogni ora. Le
 * navigazioni di documento, qualunque `Sec-Fetch-Dest` dichiarino, restano alla regola dell'ora.
 */
export async function uamGate(request: NextRequest): Promise<NextResponse | null> {
  try {
    const config = readUamConfig(process.env);
    if (!config.enabled) {
      if (config.reason === 'weak_secret' && !warnedWeakSecret) {
        warnedWeakSecret = true;
        // biome-ignore lint/suspicious/noConsole: one-time misconfiguration notice (no secret, no client data).
        console.warn(
          '[uam] UAM_MODE is set but UAM_SECRET is shorter than 32 chars: gate disabled',
        );
      }
      return null;
    }

    if (!isGateablePath(request.nextUrl.pathname)) return null;
    // Only where the loading screen can pass verify's origin check (no lockout).
    if (!uamChallengeHosts(process.env).has(request.nextUrl.host)) {
      return config.mode === 'attack' ? redirectToCanonicalHost(request) : null;
    }

    const userAgent = request.headers.get('user-agent');
    const ctx: UamContext = {
      secret: config.secret,
      // Vercel sets x-real-ip; x-forwarded-for / cf-connecting-ip are client-spoofable.
      ipPrefix: ipPrefix(request.headers.get('x-real-ip')),
      uaHash: await uaHash(userAgent),
    };

    const clearance = request.cookies.get(UAM_COOKIE)?.value;
    if (
      clearance &&
      (await verifyClearance(clearance, ctx, config.mode, {
        // Navigazione client (RSC): in modalità attacco basta una clearance di attacco fino a 24 h.
        clientNavigation: isClientNavigationRequest(request.headers),
      }))
    ) {
      return null;
    }
    if (config.allowlistBots && isAllowlistedBot(userAgent)) return null;

    if (!isReadMethod(request.method)) return methodNotAllowed();

    // La modalità attacco ignora la lista dei bot (lo UA lo dichiara il client), ma un bot di
    // anteprima non sa risolvere la verifica: riceve la paginetta di meta tag, mai l'app. I
    // crawler dei motori di ricerca no: per loro resta il 503 + Retry-After qui sotto.
    if (config.mode === 'attack' && isLinkPreviewBot(userAgent)) {
      return linkPreviewResponse(request);
    }

    const challenge = await issueChallenge(ctx, config.difficulty);
    const nonce = createNonce();
    const html = renderUamPage({
      nonce,
      challenge,
      difficulty: config.difficulty,
      mode: config.mode,
    });

    const headers = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': uamPageCsp(nonce),
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Solco-Gate': 'challenge',
    });
    if (config.interstitialStatus === 503) headers.set('Retry-After', '5');

    return new NextResponse(request.method === 'HEAD' ? null : html, {
      status: config.interstitialStatus,
      headers,
    });
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: fail-open trace; never the IP, the UA or the URL, only the error name.
    console.error(
      `[uam] gate failed open: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
    return null;
  }
}
