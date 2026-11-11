// @polsia:user-owned
//
// The UAM gate, meant to run from src/proxy.ts on every matched navigation. It
// returns `null` to let the request through, or the loading-screen interstitial
// that solves a proof-of-work challenge and comes back with a clearance cookie
// (POST /api/uam/verify).
//
// Not wired yet: src/proxy.ts lands together with the move of the framework CSP
// proxy (root proxy.ts) under src/. While a root proxy.ts exists, Turbopack runs
// the ROOT file's code for a src/proxy.ts matcher, so the gate would never run.
//
// Fails OPEN: the gate is off unless UAM_MODE and a strong UAM_SECRET are both
// set, it never challenges on a host whose pages verify would refuse, and any
// internal error lets the request through. A broken gate must never lock
// visitors out of Solco. No 'server-only' here: this module is bundled into the
// proxy.
//
// Cost: in attack mode every request the proxy matcher selects, refused ones
// included, still runs the proxy as a Vercel Function (an invocation, CPU time
// and a ~15 KB HTML answer each); on the Hobby plan a real flood can exhaust the
// plan limits and pause the site. Against a volumetric attack turn on Vercel
// Firewall "Attack Challenge Mode" (all plans), which challenges at the edge
// before any function runs. UAM attack mode complements it, it does not replace it.
import { type NextRequest, NextResponse } from 'next/server';
import {
  ipPrefix,
  isAllowlistedBot,
  isGateablePath,
  issueChallenge,
  readUamConfig,
  UAM_COOKIE,
  type UamContext,
  uaHash,
  uamChallengeHosts,
  verifyClearance,
} from './uam';
import { renderUamPage, uamPageCsp } from './uam-page';

let warnedWeakSecret = false;

/** Standard base64 of 16 random bytes, for the interstitial's script nonce. */
function createNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * `null` = let it through. Otherwise the interstitial response (200 in
 * first-visit mode, 503 + Retry-After in attack mode). RSC and prefetch
 * requests without clearance get the same HTML: the client router then falls
 * back to a full navigation, which shows the loading screen. Other methods
 * without clearance get a bodyless 405.
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
    if (!uamChallengeHosts(process.env).has(request.nextUrl.host)) return null;

    const userAgent = request.headers.get('user-agent');
    const ctx: UamContext = {
      secret: config.secret,
      // Vercel sets x-real-ip; x-forwarded-for / cf-connecting-ip are client-spoofable.
      ipPrefix: ipPrefix(request.headers.get('x-real-ip')),
      uaHash: await uaHash(userAgent),
    };

    const clearance = request.cookies.get(UAM_COOKIE)?.value;
    if (clearance && (await verifyClearance(clearance, ctx, config.mode))) return null;
    if (config.allowlistBots && isAllowlistedBot(userAgent)) return null;

    // Next renders dynamic pages for POST/PUT/PATCH/DELETE as well, so letting
    // them through would skip the challenge. Nothing legitimate is lost: Server
    // Actions are banned and every POST endpoint lives under /api (not gated).
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new NextResponse(null, {
        status: 405,
        headers: {
          Allow: 'GET, HEAD',
          'Cache-Control': 'no-store, private',
          'X-Solco-Gate': 'challenge',
        },
      });
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
