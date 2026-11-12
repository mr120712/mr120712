// @solco/sdk — autenticazione (better-auth, sotto /api/auth/*).
//
// La sessione è a cookie. Lato server il {@link HttpClient} tiene il cookie di
// sessione nel barattolo dopo il sign-in e lo rimanda sulle chiamate successive;
// nel browser ci pensa il browser. Il sign-in/up è una mutazione, quindi lato
// server parte con `Origin` = baseUrl (origine di better-auth, fidata di default).

import type { HttpClient } from '../http.js';
import type { SignInEmailInput, SignUpEmailInput, SolcoSession, SolcoUser } from '../types.js';

export interface AuthEmailResult {
  token?: string | null;
  user?: SolcoUser;
  redirect?: boolean;
  url?: string | null;
  [key: string]: unknown;
}

export class AuthResource {
  constructor(private readonly http: HttpClient) {}

  /** Accesso con email e password. In Node salva il cookie di sessione per le chiamate seguenti. */
  async signInEmail(input: SignInEmailInput): Promise<AuthEmailResult> {
    return this.http.requestJson<AuthEmailResult>('/api/auth/sign-in/email', {
      method: 'POST',
      body: input,
    });
  }

  /** Registrazione con email e password. */
  async signUpEmail(input: SignUpEmailInput): Promise<AuthEmailResult> {
    return this.http.requestJson<AuthEmailResult>('/api/auth/sign-up/email', {
      method: 'POST',
      body: input,
    });
  }

  /** Sessione corrente, o `null` se non autenticato. */
  async getSession(): Promise<SolcoSession | null> {
    return this.http.requestJson<SolcoSession | null>('/api/auth/get-session');
  }

  /** Logout. Lato server svuota il cookie di sessione dal barattolo. */
  async signOut(): Promise<{ success?: boolean } & Record<string, unknown>> {
    return this.http.requestJson('/api/auth/sign-out', { method: 'POST', body: {} });
  }
}
