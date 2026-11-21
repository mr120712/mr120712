// @polsia:user-owned — controllo amministratore delle route di audio.com (/api/admin/audiocom/**):
// stesso criterio della scheda Iscritti (src/app/api/admin/signups/route.ts): sessione valida,
// ruolo "admin" ed email verificata. Il layout /admin protegge le pagine; ogni route ricontrolla.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';

export const audioComPrivateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
} as const;

export function audioComJsonError(error: string, status: number, message?: string): Response {
  return NextResponse.json(
    { error, ...(message ? { message } : {}) },
    { status, headers: audioComPrivateHeaders },
  );
}

export type AudioComAdminAccess =
  | { allowed: true; userId: string }
  | { allowed: false; response: Response };

/** Admin verificato, oppure la risposta d'errore pronta (401, 403 o 503). */
export async function requireAudioComAdmin(request: Request): Promise<AudioComAdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { allowed: false, response: audioComJsonError('unauthorized', 401) };
    if (!isAuthorizedAdmin(session.user)) {
      return { allowed: false, response: audioComJsonError('forbidden', 403) };
    }
    return { allowed: true, userId: session.user.id };
  } catch {
    return { allowed: false, response: audioComJsonError('session_unavailable', 503) };
  }
}

export type AudioComAdminSession =
  | { kind: 'admin'; userId: string }
  | { kind: 'signed_out' }
  | { kind: 'not_admin' };

/** Per i redirect del collegamento: admin verificato, nessuna sessione, o utente non admin. */
export async function audioComAdminSession(request: Request): Promise<AudioComAdminSession> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { kind: 'signed_out' };
    if (isAuthorizedAdmin(session.user)) {
      return { kind: 'admin', userId: session.user.id };
    }
    return { kind: 'not_admin' };
  } catch {
    return { kind: 'signed_out' };
  }
}
