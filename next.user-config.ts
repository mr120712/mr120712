// @polsia:user-owned — your Next.js customizations, merged into next.config.ts by the
// framework. Edit freely (no slot markers). next.config.ts stays framework-owned: don't
// put security headers / CSP / a full `images` block here.
import type { NextConfig } from 'next';
import type { CspExtraSources } from './src/lib/csp';
import type { AppCapabilities } from './src/lib/permissions-policy';

type RemotePatterns = NonNullable<NonNullable<NextConfig['images']>['remotePatterns']>;

/** Remote hosts you load <Image> from. e.g. { protocol: 'https', hostname: 'images.unsplash.com' } */
export const userRemotePatterns: RemotePatterns = [];

/**
 * Browser capabilities this app needs (drives the Permissions-Policy header).
 * Default: everything OFF — the app cannot even PROMPT for these, so e.g. audio
 * recording never starts. Flip one to `true` to emit `<feature>=(self)`, which
 * lets THIS origin request it; the browser's own permission prompt is still the
 * gate (the user must click Allow). Leave features you don't use OFF — declaring
 * unused device permissions is flagged by security audits.
 *   microphone  → getUserMedia({ audio }), MediaRecorder (voice recording)
 *   camera      → getUserMedia({ video }) (video calls, QR scan, photo)
 *   geolocation → navigator.geolocation ("near me", maps)
 */
export const appCapabilities: AppCapabilities = {
  // Registrazione di un brano direttamente sul sito (MediaRecorder). Il browser chiede
  // comunque il permesso: questo abilita solo la possibilità di chiederlo.
  microphone: true,
  camera: false,
  geolocation: false,
};

/**
 * Extra Content-Security-Policy source allow-lists, appended to the locked base
 * policy (proxy.ts). Default: all EMPTY (same-origin only). List the EXACT
 * third-party origins a feature needs — never a bare `*` (wildcards and
 * script/style execution escapes are dropped). script-src and style-src are
 * intentionally NOT configurable here: the strict script-src is the XSS rampart,
 * locked by tests/unit/csp.test.ts.
 *   frameSrc   → third-party <iframe> (Stripe, YouTube, reCAPTCHA, Calendly, maps)
 *   connectSrc → fetch/XHR/WebSocket/SSE to other origins (Supabase, Sentry, APIs)
 *   mediaSrc   → <audio>/<video> beyond the base `https:` allowance (rare)
 *   fontSrc    → web fonts from other origins (next/font self-hosts, so rare)
 *   imgSrc     → images beyond the base `https:` allowance (rare)
 * e.g. { frameSrc: ['https://js.stripe.com'], connectSrc: ['https://*.supabase.co'] }
 */
export const cspExtraSources: CspExtraSources = {
  frameSrc: [
    'https://www.youtube.com',
    'https://authorize.music.apple.com',
    'https://www.tiktok.com',
  ],
  // Apple Music (MusicKit JS): catalogue API, playback licences and audio segments.
  // Vercel Blob: il client carica i byte DIRETTO dal browser. In @vercel/blob 2.x il PUT va al
  // gateway https://vercel.com/api/blob (verificato dal vivo: senza questo host il browser blocca
  // il PUT via CSP e il client ritenta all'infinito → "Caricamento…" bloccato). Gli host
  // blob.vercel-storage.com restano per le altre operazioni; la riproduzione usa media-src https.
  connectSrc: [
    'https://api.music.apple.com',
    'https://*.apple.com',
    'https://*.mzstatic.com',
    'https://vercel.com',
    'https://blob.vercel-storage.com',
    'https://*.blob.vercel-storage.com',
  ],
  mediaSrc: [],
  fontSrc: [],
  imgSrc: [],
};

/** Package-level Next options (transpilePackages, experimental.optimizePackageImports, …). */
export const userNextConfig: NextConfig = {
  // Sottodominio di stato: la radice di status.solcomusic.online porta alla pagina /stato.
  // Si usa un REDIRECT (non un rewrite): con un rewrite l'URL resta "/" e il router client di
  // Next re-renderizza la home dopo l'idratazione (si vedrebbe la landing, non lo stato). Il
  // redirect cambia l'URL in /stato, quindi il browser carica davvero la pagina di stato.
  // Match su host e x-forwarded-host per robustezza dietro il proxy. Gli altri domini non sono toccati.
  async redirects() {
    const statusHost = 'status.solcomusic.online';
    return [
      {
        source: '/',
        has: [{ type: 'host', value: statusHost }],
        destination: '/stato',
        permanent: false,
      },
      {
        source: '/',
        has: [{ type: 'header', key: 'x-forwarded-host', value: statusHost }],
        destination: '/stato',
        permanent: false,
      },
    ];
  },
};

export type ConfigPlugin = (config: NextConfig) => NextConfig;

/**
 * Next plugins that must WRAP the whole config (next-intl, Sentry, MDX,
 * bundle-analyzer). Each entry is a `(config) => config` wrapper — pre-bind
 * options. next.config.ts applies these and re-asserts the security headers
 * afterward, so a plugin can extend the build but never drop the day-1 posture.
 * For i18n, install the `i18n` module and add its plugin here per its AGENT.md.
 *
 *   export const userConfigPlugins: ConfigPlugin[] = [
 *     createNextIntlPlugin('./src/i18n/request.ts'),
 *     (config) => withSentryConfig(config, { silent: true }),
 *   ];
 */
export const userConfigPlugins: ConfigPlugin[] = [];
