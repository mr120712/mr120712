import { describe, expect, it } from 'vitest';
import {
  appleOAuthCredentials,
  mapSocialAuthFailure,
  socialAuthErrorCallbackURL,
} from '@/lib/business/social-auth';

describe('esiti dell’accesso social', () => {
  it.each(['apple', 'google'] as const)(
    'mappa l’annullamento di %s a un messaggio italiano e a sessione non autenticata',
    (provider) => {
      const result = mapSocialAuthFailure(provider, 'access_denied');

      expect(result).toMatchObject({
        provider,
        kind: 'cancelled',
        authenticated: false,
        retryable: true,
      });
      expect(result.message).toContain('annullato');
      expect(result.message).toContain('puoi riprovare');
    },
  );

  it.each(['apple', 'google'] as const)(
    'mappa un errore di %s a un messaggio italiano senza autenticare la sessione',
    (provider) => {
      const result = mapSocialAuthFailure(provider, 'temporarily_unavailable');

      expect(result).toMatchObject({
        provider,
        kind: 'error',
        authenticated: false,
        retryable: true,
      });
      expect(result.message).toContain(provider === 'apple' ? 'Apple' : 'Google');
      expect(result.message).toContain('Riprova');
    },
  );

  it('segnala le credenziali Apple mancanti senza costruire un provider parziale', () => {
    expect(appleOAuthCredentials(undefined, 'private-secret')).toBeUndefined();
    expect(appleOAuthCredentials('service-id', undefined)).toBeUndefined();
    expect(appleOAuthCredentials(' service-id ', ' private-secret ')).toEqual({
      clientId: 'service-id',
      clientSecret: 'private-secret',
    });
  });

  it('riporta gli errori OAuth alla schermata di accesso e conserva solo callback locali', () => {
    const callback = socialAuthErrorCallbackURL('apple', 'https://example.test/redirect');
    const url = new URL(callback, 'https://solco.test');

    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('solco_social_provider')).toBe('apple');
    expect(url.searchParams.get('callbackURL')).toBe('/dashboard');
  });
});
