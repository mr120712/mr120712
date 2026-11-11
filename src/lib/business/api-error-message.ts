// @polsia:user-owned — messaggio da mostrare per un errore di apiFetch. I limiti raggiunti
// (troppe richieste, tetto di playlist o elementi) arrivano dal server già scritti in italiano,
// con i secondi o il numero giusto: meglio mostrarli così che un messaggio generico.

const SERVER_WORDED_ERRORS = new Set(['rate_limited', 'limit_reached']);

export function serverLimitMessage(error: unknown): string | null {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; message?: unknown })
      : null;
  if (typeof cause?.error !== 'string' || !SERVER_WORDED_ERRORS.has(cause.error)) return null;
  return typeof cause.message === 'string' && cause.message.trim()
    ? cause.message.trim().slice(0, 300)
    : null;
}

/** The server's own wording for a reached limit, otherwise the caller's fallback. */
export function apiErrorMessage(error: unknown, fallback: string) {
  return serverLimitMessage(error) ?? fallback;
}
