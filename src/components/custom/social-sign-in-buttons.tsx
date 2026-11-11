// @polsia:user-owned
'use client';

import { useEffect, useState } from 'react';
import { signIn } from '@/lib/auth-client';
import { safeAuthDestination } from '@/lib/business/auth-form';
import {
  mapSocialAuthFailure,
  SOCIAL_AUTH_ERROR_PARAM,
  SOCIAL_AUTH_PROVIDER_PARAM,
  type SocialProvider,
  socialAuthErrorCallbackURL,
} from '@/lib/business/social-auth';

const CALLBACK_ERROR_VALUE = 'error';

function returnedFailure() {
  const params = new URLSearchParams(window.location.search);
  const provider = params.get(SOCIAL_AUTH_PROVIDER_PARAM);
  if (
    params.get(SOCIAL_AUTH_ERROR_PARAM) !== CALLBACK_ERROR_VALUE ||
    (provider !== 'apple' && provider !== 'google')
  ) {
    return undefined;
  }

  return mapSocialAuthFailure(provider, params.get('error'));
}

function errorCode(error: unknown) {
  if (typeof error !== 'object' || error === null) return 'provider_error';
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('statusText' in error && typeof error.statusText === 'string') return error.statusText;
  return 'provider_error';
}

/** Google is the generic OAuth provider `google` registered by the framework (src/lib/auth.ts). */
function startProvider(provider: SocialProvider, callbackURL: string) {
  const options = {
    callbackURL: safeAuthDestination(callbackURL),
    errorCallbackURL: socialAuthErrorCallbackURL(provider, callbackURL),
  };
  return provider === 'google'
    ? signIn.oauth2({ providerId: 'google', ...options })
    : signIn.social({ provider: 'apple', ...options });
}

export function SocialSignInButtons({ callbackURL }: { callbackURL: string }) {
  const [pending, setPending] = useState<SocialProvider | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof mapSocialAuthFailure> | undefined>();

  useEffect(() => {
    setFailure(returnedFailure());
  }, []);

  async function start(provider: SocialProvider) {
    setPending(provider);
    setFailure(undefined);

    try {
      const result = await startProvider(provider, callbackURL);
      if (result.error) {
        setFailure(mapSocialAuthFailure(provider, errorCode(result.error)));
        setPending(null);
      }
    } catch {
      setFailure(mapSocialAuthFailure(provider, 'provider_error'));
      setPending(null);
    }
  }

  // Each provider shows only when the deploy configures it (read literally: Next inlines them).
  const GOOGLE_ENABLED = Boolean(process.env.NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID);
  const APPLE_ENABLED = process.env.NEXT_PUBLIC_APPLE_SIGNIN === '1';
  if (!GOOGLE_ENABLED && !APPLE_ENABLED) return null;

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        oppure
        <span className="h-px flex-1 bg-border" />
      </div>
      {GOOGLE_ENABLED ? (
        <button
          type="button"
          onClick={() => void start('google')}
          disabled={pending !== null}
          className="inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-lg border border-input bg-background px-4 text-sm font-semibold text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          <svg viewBox="0 0 48 48" className="size-5" aria-hidden="true">
            <path
              fill="#EA4335"
              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            />
            <path
              fill="#FBBC05"
              d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            />
          </svg>
          {pending === 'google' ? 'Apertura Google…' : 'Continua con Google'}
        </button>
      ) : null}
      {APPLE_ENABLED ? (
        <button
          type="button"
          onClick={() => void start('apple')}
          disabled={pending !== null}
          className="inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden="true">
            <path d="M16.37 12.19c.02 2.2 1.93 2.93 1.95 2.94-.02.05-.3 1.03-.99 2.04-.6.88-1.22 1.75-2.2 1.77-.96.02-1.27-.57-2.37-.57-1.1 0-1.45.55-2.35.59-.94.04-1.66-.95-2.27-1.83-1.24-1.8-2.19-5.1-.92-7.33a3.51 3.51 0 0 1 2.96-1.8c.92-.02 1.79.63 2.36.63.57 0 1.64-.78 2.76-.67.47.02 1.8.19 2.65 1.44-.07.04-1.58.92-1.57 2.79ZM14.56 5.93c.5-.61.83-1.46.74-2.3-.72.03-1.59.48-2.1 1.08-.46.54-.86 1.4-.75 2.22.8.07 1.61-.4 2.11-1Z" />
          </svg>
          {pending === 'apple' ? 'Apertura Apple…' : 'Continua con Apple'}
        </button>
      ) : null}
      {failure ? (
        <p className="text-sm leading-6 text-destructive" role="alert" aria-live="polite">
          {failure.message}
        </p>
      ) : null}
    </div>
  );
}
