// @solco/sdk — errori

/**
 * Errore sollevato quando l'API di Solco risponde con uno stato non 2xx.
 *
 * Le rotte di Solco restituiscono, in caso di errore, un corpo JSON della forma
 * `{ error, message }` (e, dove previsto, `retryAfterSeconds`). I campi vengono
 * estratti qui così chi usa l'SDK può ramificare su `status` / `code` senza
 * ri-parsare il corpo.
 */
export class SolcoApiError extends Error {
  /** Stato HTTP della risposta (es. 401, 403, 429). */
  readonly status: number;
  /** Codice macchina dal campo `error` del corpo, se presente (es. "forbidden_origin"). */
  readonly code: string | null;
  /** Corpo grezzo della risposta (JSON già parsato, oppure testo). */
  readonly body: unknown;
  /** Secondi suggeriti prima di riprovare, dall'header `Retry-After` o dal corpo. */
  readonly retryAfterSeconds: number | null;
  /** Percorso richiesto, per diagnostica. */
  readonly path: string;

  constructor(init: {
    status: number;
    code?: string | null;
    message: string;
    body?: unknown;
    retryAfterSeconds?: number | null;
    path: string;
  }) {
    super(init.message);
    this.name = 'SolcoApiError';
    this.status = init.status;
    this.code = init.code ?? null;
    this.body = init.body ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.path = init.path;
    // Mantiene `instanceof SolcoApiError` quando il target di compilazione è < ES2015.
    Object.setPrototypeOf(this, SolcoApiError.prototype);
  }

  /** `true` se l'errore è un limite di frequenza (429). */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** `true` se manca l'autenticazione (401). */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** `true` se l'origine è stata rifiutata dal controllo CSRF same-origin (403). */
  get isForbiddenOrigin(): boolean {
    return this.status === 403 && this.code === 'forbidden_origin';
  }
}

/** Costruisce un {@link SolcoApiError} da una Response e dal corpo già letto. */
export function solcoApiErrorFromResponse(
  path: string,
  status: number,
  body: unknown,
  headerRetryAfter: string | null,
): SolcoApiError {
  let code: string | null = null;
  let message: string | null = null;
  let bodyRetryAfter: number | null = null;

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    // Le rotte di Solco usano `error`; better-auth (/api/auth/*) usa `code`.
    if (typeof record.error === 'string') code = record.error;
    else if (typeof record.code === 'string') code = record.code;
    if (typeof record.message === 'string') message = record.message;
    if (typeof record.retryAfterSeconds === 'number') bodyRetryAfter = record.retryAfterSeconds;
  }

  const retryAfterSeconds =
    bodyRetryAfter ??
    (headerRetryAfter && /^\d+$/.test(headerRetryAfter) ? Number(headerRetryAfter) : null);

  return new SolcoApiError({
    status,
    code,
    message: message ?? code ?? `La richiesta a ${path} è fallita (HTTP ${status}).`,
    body,
    retryAfterSeconds,
    path,
  });
}
