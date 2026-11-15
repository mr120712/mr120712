// @polsia:user-owned — «Carica su audio.com» (POST, stessa origine, solo amministratori verificati):
// il file che il browser ha appena messo nello staging di Vercel Blob va sull'account audio.com
// collegato, con titolo, descrizione, licenza, categoria, visibilità, download ed eventuale
// collection. I passi e le difese stanno in audiocom-upload.server.ts; qui il controllo d'accesso,
// il limite orario per admin, il contratto del corpo (rightsConfirmed deve essere proprio true) e la
// risposta. La copia di staging si cancella SEMPRE alla fine, riuscito o no, appena l'URL risulta
// davvero un file di staging dello store di Solco.
//
// Risposte: 201 { audio, collectionAdded }; 400 { errors: { campo: messaggio } }; 401/403 come le
// altre route admin di audio.com; 409/422 rifiuti di audio.com; 429 limite; 502/503 audio.com o lo
// storage non disponibili (messaggio in italiano). Mai token né URL firmati nelle risposte o nei log.
import 'server-only';
import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  AudioComUploadInputSchema,
  AudioComUploadResponseSchema,
} from '@/lib/contracts/audiocom-upload';
import { audioComPrivateHeaders, requireAudioComAdmin } from '@/lib/music/audiocom-admin.server';
import {
  deleteAudioComStagingBlob,
  isAudioComUploadConfigured,
  stagedAudioComBlobUrl,
  uploadStagedAudioToAudioCom,
} from '@/lib/music/audiocom-upload.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
/** Lettura dallo storage + invio ad audio.com di un file fino a 100 MB. */
export const maxDuration = 120;

/** Solo metadati (il file non passa mai di qui). */
const BODY_MAX_BYTES = 8_192;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: audioComPrivateHeaders });
}

function logFailure(what: string, error: unknown) {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (mai token).
  console.error(
    `[admin/audiocom/uploads] ${what}:`,
    error instanceof Error ? error.name : typeof error,
  );
}

/** Il primo messaggio per ogni campo (forma { errors: { campo: messaggio } } di applyServerErrors). */
function fieldErrors(error: ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

function blobUrlOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? (value as { blobUrl?: unknown }).blobUrl
    : undefined;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'forbidden_origin' }, 403);
  const access = await requireAudioComAdmin(request);
  if (!access.allowed) return access.response;

  const payload = await readJsonLimited(request, BODY_MAX_BYTES);
  if (!payload.ok) return limitedJsonError(payload);

  // Un URL che è davvero un file di staging dello store di Solco si cancella comunque alla fine.
  const staged = stagedAudioComBlobUrl(blobUrlOf(payload.value));
  try {
    const limited = await enforceRateLimit('audiocom.upload.admin', `user:${access.userId}`);
    if (limited) return limited;

    if (!isAudioComUploadConfigured()) {
      return json(
        {
          error: 'not_configured',
          message: 'Il caricamento non è configurato sul server (Vercel Blob).',
        },
        503,
      );
    }

    const input = AudioComUploadInputSchema.safeParse(payload.value);
    if (!input.success) {
      const errors = fieldErrors(input.error);
      return Object.keys(errors).length > 0
        ? json({ errors }, 400)
        : json({ error: 'invalid_body', message: 'Richiesta non valida.' }, 400);
    }
    // Forma giusta ma host di un altro store (o di nessuno): mai letto, mai cancellato.
    if (!staged) {
      return json(
        { errors: { blobUrl: 'Il file caricato non è valido: sceglilo e caricalo di nuovo.' } },
        400,
      );
    }

    const outcome = await uploadStagedAudioToAudioCom(input.data, staged);
    if (outcome.kind === 'created') {
      return json(AudioComUploadResponseSchema.parse(outcome.body), 201);
    }
    if (outcome.kind === 'fields') return json({ errors: outcome.errors }, 400);
    return json({ error: outcome.error, message: outcome.message }, outcome.status);
  } catch (error) {
    logFailure('caricamento non riuscito', error);
    return json(
      {
        error: 'audiocom_upload_failed',
        message: 'Il caricamento su audio.com non è riuscito. Riprova tra poco.',
      },
      500,
    );
  } finally {
    if (staged) await deleteAudioComStagingBlob(staged);
  }
}
