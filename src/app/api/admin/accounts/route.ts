// @polsia:user-owned — GET /api/admin/accounts?q=&page=: l'elenco della «Gestione account»
// (/admin/account) con UID, accesso, email verificata, ruolo, blocco e fonti del Premium di ogni
// account (25 per pagina, i più recenti prima; ricerca per nome, email o UID). Solo amministratori
// con email verificata; risposta mai in cache; nei log solo il nome dell'errore.
import 'server-only';
import { listAdminAccounts } from '@/lib/admin/account-admin.server';
import {
  accountAdminError,
  accountAdminJson,
  accountAdminRateLimit,
  logAccountAdminError,
  requireAccountAdmin,
} from '@/lib/admin/account-admin-route.server';
import {
  AdminAccountsQuerySchema,
  AdminAccountsResponseSchema,
} from '@/lib/contracts/account-admin';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const access = await requireAccountAdmin(request);
  if (!access.allowed) return access.response;

  const url = new URL(request.url);
  const query = AdminAccountsQuerySchema.safeParse({
    q: url.searchParams.get('q') ?? undefined,
    page: url.searchParams.get('page') ?? undefined,
  });
  if (!query.success) {
    return accountAdminError('invalid_query', 400, 'Ricerca non valida: al massimo 120 caratteri.');
  }

  const limited = await accountAdminRateLimit(access.userId);
  if (limited) return limited;

  try {
    // Il parse `strict` del contratto blocca qualunque campo non previsto prima della risposta.
    const body = AdminAccountsResponseSchema.parse(await listAdminAccounts(query.data));
    return accountAdminJson(body);
  } catch (error) {
    logAccountAdminError('elenco non riuscito', error);
    return accountAdminError(
      'accounts_unavailable',
      500,
      'Gli account non sono disponibili in questo momento. Riprova tra poco.',
    );
  }
}
