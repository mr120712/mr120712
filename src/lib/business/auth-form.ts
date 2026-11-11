// @polsia:user-owned

export type EmailAuthFlow = 'login' | 'signup';

export function isSafeAuthDestination(value: string | null | undefined): value is string {
  return Boolean(value?.startsWith('/') && !value.startsWith('//') && !value.includes('\\'));
}

export function safeAuthDestination(value: string | null | undefined): string {
  return isSafeAuthDestination(value) ? value : '/dashboard';
}

function errorDetails(error: unknown) {
  if (typeof error !== 'object' || error === null) return { code: '', status: 0 };

  const code = 'code' in error && typeof error.code === 'string' ? error.code.toUpperCase() : '';
  const status = 'status' in error && typeof error.status === 'number' ? error.status : 0;
  return { code, status };
}

export function emailAuthErrorMessage(error: unknown, flow: EmailAuthFlow): string {
  const { code, status } = errorDetails(error);

  if (status === 429 || code.includes('RATE_LIMIT')) {
    return 'Hai fatto troppi tentativi. Attendi qualche minuto e riprova.';
  }
  if (code === 'INVALID_EMAIL' || code === 'INVALID_EMAIL_ADDRESS') {
    return 'Inserisci un indirizzo email valido.';
  }
  if (code.includes('PASSWORD_TOO_SHORT')) {
    return 'La password deve contenere almeno 8 caratteri.';
  }
  if (
    flow === 'signup' &&
    (code.includes('USER_ALREADY_EXISTS') || code.includes('EMAIL_ALREADY_EXISTS'))
  ) {
    return 'Esiste già un account con questa email. Accedi oppure usa un altro indirizzo.';
  }
  if (status >= 500) {
    return 'Il servizio di accesso non è disponibile al momento. Riprova tra poco.';
  }
  if (flow === 'login') {
    return 'Email o password non corretti. Controlla i dati e riprova.';
  }
  return 'Non è stato possibile creare l’account. Controlla i dati e riprova.';
}

export function emailAuthNetworkErrorMessage(): string {
  return 'Connessione non riuscita. Controlla la rete e riprova.';
}
