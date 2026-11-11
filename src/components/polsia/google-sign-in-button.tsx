// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/better-auth@0.11.0. Drift = commit rejected.
//
// "Continue with Google" through the Polsia Google sign-in broker or the owner's own Google
// client, with an "or" divider and the error that came back from Google (`?error=<code>` on
// this page). Renders nothing until Google sign-in is enabled. Style it through `className`.
'use client';

import { useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';

/**
 * Set by Polsia when it enables Google sign-in, or by the owner's own Google client id.
 * Read literally so Next inlines them in the bundle.
 */
const GOOGLE_SIGNIN_ENABLED = Boolean(
  process.env.NEXT_PUBLIC_POLSIA_GOOGLE_SIGNIN || process.env.NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID,
);

/** Provider id registered by `src/lib/auth.ts`. */
const GOOGLE_PROVIDER_ID = 'google';
const DEFAULT_CALLBACK_URL = '/';
const ERROR_PARAM = 'error';
/** Marks the error return of this button, so an `?error=` from another flow is ignored. */
const RETURN_PARAM = 'google_signin';
const RETURN_VALUE = 'error';
const ACCOUNT_NOT_LINKED = 'account_not_linked';
const ACCOUNT_NOT_LINKED_MESSAGE =
  'This email already has an account. Sign in with your password, then verify your email to use Google.';
const SIGN_IN_FAILED_MESSAGE = 'Google sign-in failed. Try again.';

export interface GoogleSignInButtonProps {
  /** Where the user lands once signed in. Default `/`. */
  callbackURL?: string;
  /** Where a failed sign-in returns (tagged, with `error=<code>`). Default: the current page. */
  errorCallbackURL?: string;
  className?: string;
}

/**
 * `base` (default: the current page) tagged with {@link RETURN_PARAM}; better-auth appends
 * `&error=<code>` to it. Example: `/login` → `/login?google_signin=error`.
 */
function errorReturnURL(base: string | undefined): string {
  const url = new URL(base ?? window.location.pathname, window.location.href);
  url.searchParams.set(RETURN_PARAM, RETURN_VALUE);
  return `${url.pathname}${url.search}`;
}

/** Message for the error Google sign-in sent back to this page, if any; other errors are ignored. */
function returnedError(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const code = params.get(ERROR_PARAM);
  if (params.get(RETURN_PARAM) !== RETURN_VALUE || !code) {
    return undefined;
  }

  return code === ACCOUNT_NOT_LINKED ? ACCOUNT_NOT_LINKED_MESSAGE : SIGN_IN_FAILED_MESSAGE;
}

/**
 * Signs in with Google through `authClient.signIn.oauth2` (never `signIn.social`: the provider
 * is the generic one registered by `src/lib/auth.ts`). Place it in sign-in and sign-up forms.
 *
 *   <GoogleSignInButton callbackURL="/dashboard" />
 */
export function GoogleSignInButton({
  callbackURL = DEFAULT_CALLBACK_URL,
  errorCallbackURL,
  className = 'flex flex-col gap-3',
}: GoogleSignInButtonProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!GOOGLE_SIGNIN_ENABLED) {
      return;
    }

    setError(returnedError());
  }, []);

  if (!GOOGLE_SIGNIN_ENABLED) {
    return null;
  }

  async function handleClick() {
    setPending(true);
    setError(undefined);
    const { error: signInError } = await authClient.signIn.oauth2({
      providerId: GOOGLE_PROVIDER_ID,
      callbackURL,
      errorCallbackURL: errorReturnURL(errorCallbackURL),
    });
    if (!signInError) {
      return;
    }

    setPending(false);
    setError(SIGN_IN_FAILED_MESSAGE);
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <svg viewBox="0 0 48 48" className="size-4" aria-hidden="true">
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
        {pending ? 'Redirecting…' : 'Continue with Google'}
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
