// @polsia:user-owned — parti comuni delle rotte della «Gestione account» (/api/admin/accounts e
// /api/admin/premium-grants): solo un amministratore con email verificata (come le altre rotte
// admin), risposte mai in cache, limite per amministratore con il bucket admin esistente (identità
// propria per non sommarsi alle altre funzioni) e messaggi d'errore in italiano senza dettagli.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';

export const ACCOUNT_ADMIN_HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export function accountAdminJson(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: ACCOUNT_ADMIN_HEADERS });
}

export function accountAdminError(
  error: string,
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return accountAdminJson({ error, message, ...extra }, status);
}

export type AccountAdminAccess =
  | { allowed: true; userId: string }
  | { allowed: false; response: Response };

/** La sessione deve essere di un amministratore con email verificata. */
export async function requireAccountAdmin(request: Request): Promise<AccountAdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return {
        allowed: false,
        response: accountAdminError('unauthorized', 401, 'La sessione è scaduta: accedi di nuovo.'),
      };
    }
    if (!isAuthorizedAdmin(session.user)) {
      return {
        allowed: false,
        response: accountAdminError(
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
      response: accountAdminError(
        'session_unavailable',
        503,
        'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
      ),
    };
  }
}

/** Limite per amministratore (bucket admin esistente, identità «account»). */
export async function accountAdminRateLimit(userId: string): Promise<Response | null> {
  const limited = await enforceRateLimit('admin.assistant', `account-admin:user:${userId}`);
  if (limited) limited.headers.set('Cache-Control', 'private, no-store');
  return limited;
}

/** Nei log solo il nome dell'errore: mai email, query o righe. */
export function logAccountAdminError(where: string, error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
  console.error(`[admin/account] ${where}:`, error instanceof Error ? error.name : typeof error);
}
