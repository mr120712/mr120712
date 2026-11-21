// @polsia:user-owned — parti comuni delle route /api/admin/legacy-users: controllo admin (stesso
// della scheda Iscritti: ruolo 'admin' + email verificata, 401/403/503), intestazioni private non
// memorizzabili, limite di frequenza su un bucket admin esistente e messaggi d'errore in italiano.
// Nessuna risposta contiene URL, host, email, hash o il testo di un errore del driver.
import 'server-only';
import { NextResponse } from 'next/server';
import type { LegacyFailure } from '@/lib/admin/legacy-users.server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { consumeRateLimit, type RateLimitAction } from '@/lib/business/rate-limit.server';
import type { LegacyErrorKindValue } from '@/lib/contracts/legacy-users';

export const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export function failure(
  error: string,
  status: number,
  message: string,
  extra: { kind?: LegacyErrorKindValue; retryAfterSeconds?: number } = {},
) {
  return NextResponse.json({ error, message, ...extra }, { status, headers: privateHeaders });
}

type AdminAccess = { allowed: true; userId: string } | { allowed: false; response: Response };

export async function requireLegacyAdmin(request: Request): Promise<AdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return {
        allowed: false,
        response: failure('unauthorized', 401, 'La sessione è scaduta: accedi di nuovo.'),
      };
    }
    if (!isAuthorizedAdmin(session.user)) {
      return {
        allowed: false,
        response: failure(
          'forbidden',
          403,
          'Serve un account amministratore con email verificata.',
        ),
      };
    }
    return { allowed: true, userId: session.user.id };
  } catch {
    return {
      allowed: false,
      response: failure(
        'session_unavailable',
        503,
        'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
      ),
    };
  }
}

/**
 * Limite di frequenza su un bucket admin già esistente, con un'identità propria (i conteggi non si
 * sommano a quelli dell'altra funzione). Null se si può procedere.
 */
export async function legacyRateLimit(
  action: RateLimitAction,
  identity: string,
): Promise<Response | null> {
  const decision = await consumeRateLimit(action, identity);
  if (decision.allowed) return null;
  if (decision.status === 429) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: `Troppe richieste ravvicinate. Riprova tra ${decision.retryAfterSeconds} secondi.`,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { ...privateHeaders, 'Retry-After': String(decision.retryAfterSeconds) },
      },
    );
  }
  return failure(
    'rate_limit_unavailable',
    503,
    'Non riesco a verificare il limite di richieste in questo momento. Riprova tra poco.',
    { retryAfterSeconds: decision.retryAfterSeconds },
  );
}

const KIND_TEXT: Record<LegacyErrorKindValue, string> = {
  timeout: 'il database non ha risposto in tempo',
  auth: 'utente o password non accettati',
  ssl: 'la connessione cifrata non è riuscita',
  not_found: 'il database indicato non esiste',
  unreachable: 'il server del database non è raggiungibile',
  too_large: 'ci sono troppi utenti da leggere in una volta',
  unknown: 'errore imprevisto',
};

/** Risposta HTTP di un esito negativo del modulo server. */
export function legacyFailureResponse(result: LegacyFailure): Response {
  switch (result.code) {
    case 'secret_missing':
      return failure(
        'secret_missing',
        503,
        'Manca BETTER_AUTH_SECRET sul server: senza non posso firmare l’anteprima.',
      );
    case 'unknown_source':
      return failure(
        'unknown_source',
        400,
        'Questo database non è più tra le variabili d’ambiente. Premi «Controlla i database».',
      );
    case 'source_in_use':
      return failure(
        'source_in_use',
        400,
        'È il database che il sito usa adesso: da qui non si trasferisce nulla.',
      );
    case 'source_incomplete':
      return failure(
        'source_incomplete',
        400,
        'Mancano i dati di accesso completi (password) per questo database.',
      );
    case 'source_incompatible':
      return failure(
        'source_incompatible',
        400,
        'Questo database non ha le tabelle utenti di Solco: non posso trasferire gli account.',
      );
    case 'source_unavailable':
      return failure(
        'source_unavailable',
        503,
        `Non riesco a leggere il vecchio database: ${KIND_TEXT[result.kind]}. Riprova tra poco.`,
        { kind: result.kind },
      );
    case 'preview_expired':
      return failure(
        'preview_expired',
        409,
        'L’anteprima è scaduta (vale 15 minuti). Rifai l’anteprima e conferma di nuovo.',
      );
    case 'preview_mismatch':
      return failure(
        'preview_mismatch',
        409,
        'Nel vecchio database ci sono account nuovi rispetto all’anteprima. Rifai l’anteprima.',
      );
    case 'preview_invalid':
      return failure(
        'preview_invalid',
        409,
        'L’anteprima non è valida per questo database. Rifai l’anteprima.',
      );
  }
}
