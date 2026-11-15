// @polsia:user-owned — token per il caricamento diretto su Vercel Blob (client upload) del file da
// mandare ad audio.com dalla pagina admin /admin/audiocom («Carica su audio.com»).
//
// Solo dalla stessa origine e solo per amministratori verificati (requireAudioComAdmin, come le
// altre route /api/admin/audiocom/**), con un limite orario per admin. Il token vale solo per i
// formati accettati da audio.com, al massimo 100 MB, nel prefisso `audiocom-staging/` con un
// suffisso casuale, senza sovrascritture e con scadenza automatica dopo un giorno (rete di
// sicurezza: la route di invio cancella comunque il file appena finito, riuscito o no).
// Nessuna callback di completamento: il file si usa subito con POST /api/admin/audiocom/uploads,
// quindi ogni richiesta qui viene dal browser dell'amministratore. NON vale qui il cancello della
// libreria pubblica (publicUploadsDisabledResponse): è un'altra funzione.
import 'server-only';
import { type HandleUploadBody, handleUpload } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  AUDIOCOM_UPLOAD_MAX_BYTES,
  AUDIOCOM_UPLOAD_MIME_TYPES,
  isAudioComStagingPathname,
} from '@/lib/contracts/audiocom-upload';
import { env } from '@/lib/env';
import { audioComPrivateHeaders, requireAudioComAdmin } from '@/lib/music/audiocom-admin.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

/** Validità del token: il browser lo chiede subito prima di caricare. */
const TOKEN_VALIDITY_MS = 30 * 60_000;
/** Se la route di invio non arriva mai, Vercel Blob cancella da solo il file dopo un giorno. */
const STAGING_TTL_DAYS = 1;
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

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: audioComPrivateHeaders });
}

function logFailure(what: string, error: unknown) {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (mai token).
  console.error(
    `[admin/audiocom/uploads/blob] ${what}:`,
    error instanceof Error ? error.name : typeof error,
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'forbidden_origin' }, 403);
  const access = await requireAudioComAdmin(request);
  if (!access.allowed) return access.response;

  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return json(
      {
        error: 'not_configured',
        message: 'Il caricamento non è configurato sul server (Vercel Blob).',
      },
      503,
    );
  }

  const payload = await readJsonLimited(request, BODY_MAX_BYTES);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = ClientTokenRequestSchema.safeParse(payload.value);
  if (!parsed.success) return json({ error: 'invalid_body' }, 400);
  if (!isAudioComStagingPathname(parsed.data.payload.pathname)) {
    return json({ error: 'invalid_pathname', message: 'Percorso del file non consentito.' }, 400);
  }

  const limited = await enforceRateLimit('audiocom.upload.stage.admin', `user:${access.userId}`);
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
        if (!isAudioComStagingPathname(pathname)) throw new Error('Percorso non consentito.');
        return {
          allowedContentTypes: [...AUDIOCOM_UPLOAD_MIME_TYPES],
          maximumSizeInBytes: AUDIOCOM_UPLOAD_MAX_BYTES,
          addRandomSuffix: true,
          allowOverwrite: false,
          validUntil: Date.now() + TOKEN_VALIDITY_MS,
          ttlDays: STAGING_TTL_DAYS,
        };
      },
    });
    return json(result);
  } catch (error) {
    logFailure('token non rilasciato', error);
    return json(
      { error: 'upload_rejected', message: 'Il caricamento del file non è stato autorizzato.' },
      400,
    );
  }
}
