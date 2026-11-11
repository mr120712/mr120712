// @polsia:user-owned
'use client';

import { useEffect, useState } from 'react';
import { signIn } from '@/lib/auth-client';
import { safeAuthDestination } from '@/lib/business/auth-form';
import {
  mapSocialAuthFailure,
  SOCIAL_AUTH_ERROR_PARAM,
  SOCIAL_AUTH_PROVIDER_PARAM,
  socialAuthErrorCallbackURL,
} from '@/lib/business/social-auth';

const CALLBACK_ERROR_VALUE = 'error';

function returnedFailure() {
  const params = new URLSearchParams(window.location.search);
  if (
    params.get(SOCIAL_AUTH_ERROR_PARAM) !== CALLBACK_ERROR_VALUE ||
    params.get(SOCIAL_AUTH_PROVIDER_PARAM) !== 'apple'
  ) {
    return undefined;
  }

  return mapSocialAuthFailure('apple', params.get('error'));
}

function errorCode(error: unknown) {
  if (typeof error !== 'object' || error === null) return 'provider_error';
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('statusText' in error && typeof error.statusText === 'string') return error.statusText;
  return 'provider_error';
}

export function SocialSignInButtons({ callbackURL }: { callbackURL: string }) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof mapSocialAuthFailure> | undefined>();

  useEffect(() => {
    setFailure(returnedFailure());
  }, []);

  async function startAppleSignIn() {
    setPending(true);
    setFailure(undefined);

    try {
      const result = await signIn.social({
        provider: 'apple',
        callbackURL: safeAuthDestination(callbackURL),
        errorCallbackURL: socialAuthErrorCallbackURL('apple', callbackURL),
      });

      if (result.error) {
        setFailure(mapSocialAuthFailure('apple', errorCode(result.error)));
        setPending(false);
      }
    } catch {
      setFailure(mapSocialAuthFailure('apple', 'provider_error'));
      setPending(false);
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-center text-sm leading-6 text-muted-foreground">
        Oppure continua con il tuo account Apple.
      </p>
      <button
        type="button"
        onClick={() => void startAppleSignIn()}
        disabled={pending}
        className="inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-lg bg-foreground px-4 text-sm font-semibold text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
      >
        <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden="true">
          <path d="M16.37 12.19c.02 2.2 1.93 2.93 1.95 2.94-.02.05-.3 1.03-.99 2.04-.6.88-1.22 1.75-2.2 1.77-.96.02-1.27-.57-2.37-.57-1.1 0-1.45.55-2.35.59-.94.04-1.66-.95-2.27-1.83-1.24-1.8-2.19-5.1-.92-7.33a3.51 3.51 0 0 1 2.96-1.8c.92-.02 1.79.63 2.36.63.57 0 1.64-.78 2.76-.67.47.02 1.8.19 2.65 1.44-.07.04-1.58.92-1.57 2.79ZM14.56 5.93c.5-.61.83-1.46.74-2.3-.72.03-1.59.48-2.1 1.08-.46.54-.86 1.4-.75 2.22.8.07 1.61-.4 2.11-1Z" />
        </svg>
        {pending ? 'Apertura Apple…' : 'Continua con Apple'}
      </button>
      {failure ? (
        <p className="text-sm leading-6 text-destructive" role="alert" aria-live="polite">
          {failure.message}
        </p>
      ) : null}
    </div>
  );
}
