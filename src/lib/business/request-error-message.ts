// @polsia:user-owned
/** Restituisce i messaggi di limite e dimensione senza esporre codici sconosciuti. */
export function requestErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || typeof error.cause !== 'object' || error.cause === null) {
    return fallback;
  }

  const body = error.cause as { error?: unknown; message?: unknown; retryAfterSeconds?: unknown };
  if (
    body.error === 'rate_limited' ||
    body.error === 'rate_limit_unavailable' ||
    body.error === 'rate_limit_identity_unavailable' ||
    body.error === 'payload_too_large'
  ) {
    if (typeof body.message === 'string') return body.message;
    if (typeof body.retryAfterSeconds === 'number' && Number.isFinite(body.retryAfterSeconds)) {
      return `Hai raggiunto un limite temporaneo. Riprova tra ${Math.max(1, Math.ceil(body.retryAfterSeconds))} secondi.`;
    }
  }

  return fallback;
}
