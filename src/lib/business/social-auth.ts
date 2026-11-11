// @polsia:user-owned

export type SocialProvider = 'apple' | 'google';

export const SOCIAL_AUTH_ERROR_PARAM = 'solco_social_signin';
export const SOCIAL_AUTH_PROVIDER_PARAM = 'solco_social_provider';

export type SocialAuthFailure = {
  provider: SocialProvider;
  kind: 'cancelled' | 'unavailable' | 'error';
  authenticated: false;
  retryable: true;
  message: string;
};

const CANCELLED_CODES = new Set([
  'access_denied',
  'cancelled',
  'canceled',
  'user_cancelled',
  'user_canceled',
  'user_cancelled_authorize',
]);

const UNAVAILABLE_CODES = new Set([
  'provider_not_found',
  'provider_not_configured',
  'social_provider_not_found',
  'oauth_provider_not_found',
  'unsupported_provider',
]);

const PROVIDER_NAMES: Record<SocialProvider, string> = {
  apple: 'Apple',
  google: 'Google',
};

export function mapSocialAuthFailure(
  provider: SocialProvider,
  rawCode: string | null | undefined,
): SocialAuthFailure {
  const code = rawCode?.trim().toLowerCase() ?? '';
  const providerName = PROVIDER_NAMES[provider];

  if (CANCELLED_CODES.has(code)) {
    return {
      provider,
      kind: 'cancelled',
      authenticated: false,
      retryable: true,
      message: `Accesso con ${providerName} annullato. Non hai effettuato l’accesso; puoi riprovare.`,
    };
  }

  if (UNAVAILABLE_CODES.has(code)) {
    return {
      provider,
      kind: 'unavailable',
      authenticated: false,
      retryable: true,
      message: `L’accesso con ${providerName} non è ancora configurato. Riprova più tardi.`,
    };
  }

  if (code === 'account_not_linked') {
    return {
      provider,
      kind: 'error',
      authenticated: false,
      retryable: true,
      message: `Questo account Solco non è collegato a ${providerName}. Riprova con il provider usato in precedenza.`,
    };
  }

  return {
    provider,
    kind: 'error',
    authenticated: false,
    retryable: true,
    message: `Non è stato possibile accedere con ${providerName}. Riprova.`,
  };
}

export function appleOAuthCredentials(clientId?: string, clientSecret?: string) {
  const normalizedClientId = clientId?.trim();
  const normalizedClientSecret = clientSecret?.trim();

  if (!normalizedClientId || !normalizedClientSecret) return undefined;

  return {
    clientId: normalizedClientId,
    clientSecret: normalizedClientSecret,
  };
}

export function socialAuthErrorCallbackURL(provider: SocialProvider, callbackURL: string) {
  const safeCallbackURL =
    callbackURL.startsWith('/') && !callbackURL.startsWith('//') && !callbackURL.includes('\\')
      ? callbackURL
      : '/dashboard';
  const params = new URLSearchParams({
    [SOCIAL_AUTH_ERROR_PARAM]: 'error',
    [SOCIAL_AUTH_PROVIDER_PARAM]: provider,
    callbackURL: safeCallbackURL,
  });

  return `/login?${params.toString()}`;
}
