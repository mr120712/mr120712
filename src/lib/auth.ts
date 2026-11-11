// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/better-auth@0.12.0. Drift = commit rejected.
// Protected core (db/secret/base URL, admin plugin, multi-host trusted origins, Google sign-in
// through Polsia or the owner's client, with its multi-host base URL) + owner-admin grant, composed with the app's own databaseHooks. Configure auth
// in @/lib/auth-config (user-owned).

import 'server-only';
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createAuthMiddleware } from 'better-auth/api';
import { admin, type GenericOAuthConfig, genericOAuth } from 'better-auth/plugins';
import { authConfig } from '@/lib/auth-config';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/send';
import { env } from '@/lib/env';

// Compose the owner-admin grant with the app's hooks — don't overwrite them.
const appHooks = authConfig.databaseHooks;
const ownerEmail = env.POLSIA_OWNER_EMAIL?.trim().toLowerCase();

// Multi-host auth: ONE build is served on <slug>.polsia.app, the <slug>.polsia.io
// backup domain, and custom brand domains — each must pass better-auth's
// Origin/CSRF check on sign-in/sign-up. The wildcards cover the Polsia serving
// domains (incl. any post-rename slug); BETTER_AUTH_TRUSTED_ORIGINS is injected
// per-deploy by the Polsia backend with the company's active custom domains.
// baseURL's own origin is always trusted implicitly. Framework-owned so an
// app can't accidentally narrow it back to a single host.
const customOrigins =
  env.BETTER_AUTH_TRUSTED_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean) ?? [];
const trustedOrigins = ['https://*.polsia.app', 'https://*.polsia.io', ...customOrigins];

const WILDCARD = '*';
const HTTP_PROTOCOL = 'http:';

/** Provider id of Google sign-in (Polsia broker or the owner's client); the button signs in with it. */
const GOOGLE_PROVIDER_ID = 'google';
const GOOGLE_BROKER_PATH = '/api/v2/app-auth/google';
const GOOGLE_SCOPES = ['openid', 'email', 'profile'];
const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Parses an absolute URL; `undefined` when absent or invalid (env validation is skipped at build). */
function parseURL(value: string | undefined): URL | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Multi-host base URL, only while Google sign-in is on (otherwise BETTER_AUTH_URL as
 * before): OAuth redirect URIs and email links follow the request host when it is the app URL
 * or an exact custom domain (e.g. `brand.com`), so a Google sign-in started on a custom domain
 * returns there. Wildcards are never allowed (a forged `Host` would poison links); any other
 * host falls back to BETTER_AUTH_URL. `http` only when BETTER_AUTH_URL is (local dev).
 */
function resolveBaseURL(): BetterAuthOptions['baseURL'] {
  const appURL = parseURL(env.BETTER_AUTH_URL);
  if (!appURL || googlePlugins.length === 0) {
    return env.BETTER_AUTH_URL;
  }

  const customHosts = customOrigins
    .filter((origin) => !origin.includes(WILDCARD))
    .flatMap((origin) => parseURL(origin)?.host ?? []);

  return {
    allowedHosts: [...new Set([appURL.host, ...customHosts])],
    fallback: env.BETTER_AUTH_URL,
    protocol: appURL.protocol === HTTP_PROTOCOL ? 'http' : 'https',
  };
}

type GoogleEndpoints = Pick<GenericOAuthConfig, 'authorizationUrl' | 'tokenUrl' | 'userInfoUrl'>;

/** The generic provider `google` at the given endpoints: PKCE, client secret posted. */
function googleProvider(
  clientId: string,
  clientSecret: string,
  endpoints: GoogleEndpoints,
): GenericOAuthConfig {
  return {
    providerId: GOOGLE_PROVIDER_ID,
    clientId,
    clientSecret,
    ...endpoints,
    scopes: GOOGLE_SCOPES,
    pkce: true,
    authentication: 'post',
  };
}

/**
 * The owner's own Google OAuth client, set as app secrets (`NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID`,
 * `GOOGLE_SIGNIN_CLIENT_SECRET`): Google directly, identity from the `id_token` its token
 * endpoint returns. `undefined` unless both are set.
 */
function ownGoogle(): GenericOAuthConfig | undefined {
  const clientId = env.NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID;
  const clientSecret = env.GOOGLE_SIGNIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return undefined;
  }

  return googleProvider(clientId, clientSecret, {
    authorizationUrl: GOOGLE_AUTHORIZATION_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    userInfoUrl: GOOGLE_USERINFO_URL,
  });
}

/** The Polsia Google sign-in broker (a standard OAuth provider); `undefined` unless Polsia injects its env. */
function polsiaGoogle(): GenericOAuthConfig | undefined {
  const clientId = env.POLSIA_GOOGLE_SIGNIN_CLIENT_ID;
  const apiBaseURL = env.POLSIA_API_BASE_URL;
  const apiKey = env.POLSIA_API_KEY;
  if (!clientId || !apiBaseURL || !apiKey) {
    return undefined;
  }

  const brokerURL = (action: string) =>
    new URL(`${GOOGLE_BROKER_PATH}/${action}`, apiBaseURL).toString();

  return googleProvider(clientId, apiKey, {
    authorizationUrl: brokerURL('authorize'),
    tokenUrl: brokerURL('token'),
    userInfoUrl: brokerURL('userinfo'),
  });
}

/**
 * Google sign-in as one generic provider `google`: the owner's own client when set, otherwise
 * the Polsia broker. None when the app configures `socialProviders.google`: the generic
 * provider would shadow it.
 */
function googleSignIn() {
  if (authConfig.socialProviders?.google) {
    return [];
  }

  const config = ownGoogle() ?? polsiaGoogle();
  if (!config) {
    return [];
  }

  return [genericOAuth({ config: [config] })];
}

// Set by api/auth/[...all]/route.ts beside the partitioned cookies of a session
// opened inside the Polsia dashboard preview. Direct visits never send it.
const PREVIEW_MARKER_COOKIE = '__Host-polsia-preview';

/**
 * A preview session cookie is SameSite=None, so any page loaded under the dashboard
 * could send it. Strip the cookies of cross-origin requests that carry an Origin
 * (every write and CORS call; never a navigation, so the preview's own page loads
 * keep their session) when that session is present.
 */
const previewSessionCsrf: BetterAuthPlugin = {
  id: 'polsia-preview-csrf',
  hooks: {
    before: [
      {
        matcher: (ctx) => isCrossOriginPreviewRequest(ctx.headers),
        handler: createAuthMiddleware(async (ctx) => {
          // The app's hooks run before this one and may have read the session; later
          // hooks and the endpoint read these same headers.
          ctx.context.session = null;
          ctx.headers?.delete('cookie');
        }),
      },
    ],
  },
};

function isCrossOriginPreviewRequest(headers: Headers | undefined): boolean {
  const site = headers?.get('sec-fetch-site');
  return (
    (site === 'cross-site' || site === 'same-site') &&
    Boolean(headers?.get('origin')) &&
    (headers?.get('cookie') ?? '')
      .split(';')
      .some((cookie) => cookie.trim().startsWith(`${PREVIEW_MARKER_COOKIE}=`))
  );
}

/** The Google provider, empty unless enabled; also gates the multi-host base URL. */
const googlePlugins = googleSignIn();

export const auth = betterAuth({
  ...authConfig,
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: resolveBaseURL(),
  trustedOrigins,
  // Signup must open a session: paywalls and protected pages right after signup
  // depend on it. Gate sensitive actions on user.emailVerified instead.
  emailAndPassword: {
    ...authConfig.emailAndPassword,
    enabled: authConfig.emailAndPassword?.enabled ?? false,
    requireEmailVerification: false,
    autoSignIn: true,
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: false,
    autoSignInAfterVerification: false,
    ...authConfig.emailVerification,
    sendVerificationEmail:
      authConfig.emailVerification?.sendVerificationEmail ??
      (async ({ user, url }) => {
        const href = url
          .replaceAll('&', '&amp;')
          .replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll("'", '&#39;');
        const result = await sendEmail({
          to: user.email,
          subject: 'Verify your email',
          html: `<p><a href="${href}">Verify your email</a></p>`,
          text: `Verify your email: ${url}`,
        });
        // The proxy can accept a suppressed recipient without sending mail.
        if (!result.id) throw new Error('Verification email could not be delivered');
      }),
  },
  // Better Auth's verification callback can write the pre-verification user to
  // its cookie cache. Always read authorization state from the session store.
  session: {
    ...authConfig.session,
    cookieCache: { ...authConfig.session?.cookieCache, enabled: false },
  },
  databaseHooks: {
    ...appHooks,
    user: {
      ...appHooks?.user,
      create: {
        ...appHooks?.user?.create,
        before: async (user, ctx) => {
          // Capture the SDK's identity before application hooks can mutate it.
          const originalEmail = user.email.toLowerCase();
          const originallyVerified = user.emailVerified === true;
          const r = await appHooks?.user?.create?.before?.(user, ctx);
          if (r === false) return false;
          const base = { ...user, ...(r && typeof r === 'object' && 'data' in r ? r.data : {}) };
          const emailVerified =
            originallyVerified &&
            base.emailVerified === true &&
            base.email.toLowerCase() === originalEmail;
          return {
            data: {
              ...base,
              emailVerified,
              // Unverified identities never receive an administrative role,
              // including a role supplied by an application create hook.
              ...(!emailVerified
                ? { role: 'user' }
                : ownerEmail === originalEmail
                  ? { role: 'admin' }
                  : {}),
            },
          };
        },
      },
      update: {
        ...appHooks?.user?.update,
        after: async (user, ctx) => {
          // Verification updates carry the full persisted user. Check the stored
          // identity again so a stale update cannot promote a changed address.
          if (ownerEmail && user.emailVerified && user.email.toLowerCase() === ownerEmail) {
            await prisma.user.updateMany({
              where: { id: user.id, email: user.email, emailVerified: true },
              data: { role: 'admin' },
            });
          }
          await appHooks?.user?.update?.after?.(user, ctx);
        },
      },
    },
  },
  plugins: [
    admin({
      defaultRole: 'user',
      adminRoles: ['admin'],
    }),
    previewSessionCsrf,
    ...googlePlugins,
    ...(authConfig.plugins ?? []),
  ],
});
