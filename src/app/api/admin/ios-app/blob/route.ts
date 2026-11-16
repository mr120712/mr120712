// @polsia:user-owned — token per il caricamento diretto dell'IPA nello store Vercel Blob (client
// upload) dalla pagina admin /admin/app-ios. Solo dalla stessa origine e solo per amministratori
// verificati, con limite orario per admin. Il token vale solo per il prefisso `ios-app/`, per file
// .ipa fino a IOS_IPA_MAX_BYTES, con suffisso casuale e senza sovrascritture; il file diventa attivo
// solo dopo POST /api/admin/ios-app, che lo ispeziona (e lo cancella se non va bene).
import 'server-only';
import { type HandleUploadBody, handleUpload } from '@vercel/blob/client';
import { z } from 'zod';
import { iosAdminJson, requireIosAdmin } from '@/lib/admin/ios-app-access.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { IOS_INSTALL_MESSAGES } from '@/lib/contracts/ios-install';
import { env } from '@/lib/env';
import { IOS_IPA_MAX_BYTES, IOS_IPA_MIME_TYPES, isIosIpaPathname } from '@/lib/ios-app';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

/** Validità del token: il browser lo chiede subito prima di caricare. */
const TOKEN_VALIDITY_MS = 30 * 60_000;
const BODY_MAX_BYTES = 4_096;

/** L'unico evento ammesso: la richiesta del token (formato del client di @vercel/blob). */
const ClientTokenRequestSchema = z.object({
  type: z.literal('blob.generate-client-token'),
  payload: z.object({
    pathname: z.string().max(300),
    clientPayload: z.string().max(1_000).nullish(),
    multipart: z.boolean().optional(),
  }),
});

function logFailure(what: string, error: unknown) {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (mai token).
  console.error(
    `[admin/ios-app/blob] ${what}:`,
    error instanceof Error ? error.name : typeof error,
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return iosAdminJson({ error: 'forbidden_origin' }, 403);
  const access = await requireIosAdmin(request);
  if (!access.allowed) return access.response;

  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return iosAdminJson(
      { error: 'not_configured', message: IOS_INSTALL_MESSAGES.notConfigured },
      503,
    );
  }

  const payload = await readJsonLimited(request, BODY_MAX_BYTES);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = ClientTokenRequestSchema.safeParse(payload.value);
  if (!parsed.success) return iosAdminJson({ error: 'invalid_body' }, 400);
  if (!isIosIpaPathname(parsed.data.payload.pathname)) {
    return iosAdminJson(
      { error: 'invalid_pathname', message: 'Percorso del file non consentito.' },
      400,
    );
  }

  const limited = await enforceRateLimit('admin.ios.app', `user:${access.userId}`);
  if (limited) return limited;

  const body: HandleUploadBody = {
    type: 'blob.generate-client-token',
    payload: {
      pathname: parsed.data.payload.pathname,
      clientPayload: parsed.data.payload.clientPayload ?? null,
      multipart: parsed.data.payload.multipart === true,
    },
  };
  try {
    const result = await handleUpload({
      token,
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!isIosIpaPathname(pathname)) throw new Error('Percorso non consentito.');
        return {
          allowedContentTypes: [...IOS_IPA_MIME_TYPES],
          maximumSizeInBytes: IOS_IPA_MAX_BYTES,
          addRandomSuffix: true,
          allowOverwrite: false,
          validUntil: Date.now() + TOKEN_VALIDITY_MS,
        };
      },
    });
    return iosAdminJson(result);
  } catch (error) {
    logFailure('token non rilasciato', error);
    return iosAdminJson(
      { error: 'upload_rejected', message: 'Il caricamento del file non è stato autorizzato.' },
      400,
    );
  }
}
