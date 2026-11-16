// @polsia:user-owned — API admin dell'app iOS (/admin/app-ios): GET lo stato (store configurato, IPA
// attivo, identificativo e versione attesi), POST attiva l'IPA appena caricato nello store privato
// (lo ispeziona: identificativo, versione, firma) e cancella quello precedente, DELETE rimuove tutto.
// Solo stessa origine e amministratori verificati, con limite orario per admin.
import 'server-only';
import { iosAdminJson, requireIosAdmin } from '@/lib/admin/ios-app-access.server';
import { activateIosIpa, adminIosStatus, removeIosIpa } from '@/lib/business/ios-install.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { IOS_INSTALL_MESSAGES, IosIpaActivateRequestSchema } from '@/lib/contracts/ios-install';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
/** L'attivazione scarica e ispeziona l'IPA (decine di MB): tempo come le altre route lunghe. */
export const maxDuration = 120;

const BODY_MAX_BYTES = 4_096;

export async function GET(request: Request): Promise<Response> {
  const access = await requireIosAdmin(request);
  if (!access.allowed) return access.response;
  return iosAdminJson(await adminIosStatus());
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return iosAdminJson({ error: 'forbidden_origin' }, 403);
  const access = await requireIosAdmin(request);
  if (!access.allowed) return access.response;
  const limited = await enforceRateLimit('admin.ios.app', `user:${access.userId}`);
  if (limited) return limited;

  const payload = await readJsonLimited(request, BODY_MAX_BYTES);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = IosIpaActivateRequestSchema.safeParse(payload.value);
  if (!parsed.success) {
    return iosAdminJson({ error: 'invalid_body', message: 'Richiesta non valida.' }, 400);
  }
  const result = await activateIosIpa(parsed.data);
  if (!result.ok) {
    return iosAdminJson({ error: result.error, message: result.message }, result.status);
  }
  return iosAdminJson({ current: result.record });
}

export async function DELETE(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return iosAdminJson({ error: 'forbidden_origin' }, 403);
  const access = await requireIosAdmin(request);
  if (!access.allowed) return access.response;
  const limited = await enforceRateLimit('admin.ios.app', `user:${access.userId}`);
  if (limited) return limited;
  const removed = await removeIosIpa();
  if (!removed) {
    return iosAdminJson(
      { error: 'not_configured', message: IOS_INSTALL_MESSAGES.notConfigured },
      503,
    );
  }
  return iosAdminJson({ removed: removed.removed });
}
