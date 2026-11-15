// @polsia:user-owned — Premium illimitato per email, dalla «Gestione account» (/admin/account):
// - GET: tutte le concessioni con lo stato (attiva, in attesa del primo accesso, email non
//   verificata, revocata) e l'account collegato (UID);
// - POST { email, note? }: concede il Premium illimitato a un'email (o riattiva una revocata);
// - DELETE ?id=: revoca una concessione (resta salvata, revocata).
// Vale solo per un account con quell'email VERIFICATA (src/lib/business/premium-grants.server.ts).
// Solo amministratori con email verificata; le richieste che cambiano qualcosa partono dal sito
// stesso (sameOrigin) prima di ogni altro controllo; risposte mai in cache; nei log solo il nome
// dell'errore, mai l'email.
import 'server-only';
import {
  accountAdminError,
  accountAdminJson,
  accountAdminRateLimit,
  logAccountAdminError,
  requireAccountAdmin,
} from '@/lib/admin/account-admin-route.server';
import {
  grantPremiumToEmail,
  listPremiumGrants,
  revokePremiumGrant,
} from '@/lib/business/premium-grants.server';
import {
  PremiumGrantInputSchema,
  PremiumGrantResponseSchema,
  PremiumGrantsResponseSchema,
} from '@/lib/contracts/account-admin';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

function forbiddenOrigin() {
  return accountAdminError('forbidden_origin', 403, 'Richiesta non consentita.');
}

export async function GET(request: Request) {
  const access = await requireAccountAdmin(request);
  if (!access.allowed) return access.response;
  const limited = await accountAdminRateLimit(access.userId);
  if (limited) return limited;
  try {
    return accountAdminJson(
      PremiumGrantsResponseSchema.parse({ items: await listPremiumGrants() }),
    );
  } catch (error) {
    logAccountAdminError('elenco delle concessioni non riuscito', error);
    return accountAdminError(
      'grants_unavailable',
      500,
      'Le concessioni non sono disponibili in questo momento. Riprova tra poco.',
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const access = await requireAccountAdmin(request);
  if (!access.allowed) return access.response;
  const limited = await accountAdminRateLimit(access.userId);
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return accountAdminError('invalid_body', 400, 'Richiesta non valida.');
  }
  const input = PremiumGrantInputSchema.safeParse(raw);
  if (!input.success) {
    const errors: Record<string, string> = {};
    for (const issue of input.error.issues) {
      const field = String(issue.path[0] ?? 'email');
      if (!(field in errors)) errors[field] = issue.message;
    }
    return accountAdminJson({ errors }, 400);
  }

  try {
    const grant = await grantPremiumToEmail({
      email: input.data.email,
      note: input.data.note,
      adminId: access.userId,
    });
    return accountAdminJson(PremiumGrantResponseSchema.parse({ grant }), 201);
  } catch (error) {
    logAccountAdminError('concessione non riuscita', error);
    return accountAdminError(
      'grant_failed',
      500,
      'Non è stato possibile concedere il Premium illimitato. Riprova tra poco.',
    );
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const access = await requireAccountAdmin(request);
  if (!access.allowed) return access.response;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    return accountAdminError('invalid_id', 400, 'Concessione non valida.');
  }
  const limited = await accountAdminRateLimit(access.userId);
  if (limited) return limited;
  try {
    const grant = await revokePremiumGrant(id);
    if (!grant) return accountAdminError('not_found', 404, 'Concessione non trovata.');
    return accountAdminJson(PremiumGrantResponseSchema.parse({ grant }));
  } catch (error) {
    logAccountAdminError('revoca non riuscita', error);
    return accountAdminError(
      'revoke_failed',
      500,
      'Non è stato possibile revocare il Premium illimitato. Riprova tra poco.',
    );
  }
}
