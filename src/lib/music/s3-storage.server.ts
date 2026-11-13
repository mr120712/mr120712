// @polsia:user-owned — storage AWS S3 per i brani caricati dagli utenti (libreria pubblica).
// Il browser carica DIRETTO su S3 con un URL PUT firmato qui (presigned); il server deriva l'URL
// pubblico dalla chiave (mai si fida di un URL mandato dal client). Lettura pubblica via policy del
// bucket o CloudFront; nessun ACL impostato sull'oggetto (compatibile con "Bucket owner enforced").
import 'server-only';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/lib/env';

/** S3 è utilizzabile solo con regione, bucket e credenziali presenti. */
export function isS3Configured(): boolean {
  return Boolean(
    env.AWS_REGION && env.AWS_S3_BUCKET && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY,
  );
}

let cached: { id: string; client: S3Client } | null = null;
function s3(): S3Client {
  const region = env.AWS_REGION ?? '';
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? '';
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? '';
  const id = `${region}:${accessKeyId}`;
  if (!cached || cached.id !== id) {
    cached = {
      id,
      client: new S3Client({ region, credentials: { accessKeyId, secretAccessKey } }),
    };
  }
  return cached.client;
}

/** Base pubblica per il GET degli oggetti (CloudFront o endpoint S3), senza slash finale. */
export function s3PublicBaseUrl(): string {
  const explicit = env.AWS_S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  return `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com`;
}

/** URL pubblico (GET) dell'oggetto a partire dalla sua chiave. Ogni segmento è url-encoded. */
export function s3ObjectUrl(key: string): string {
  const path = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${s3PublicBaseUrl()}/${path}`;
}

/** URL PUT firmato per caricare un oggetto audio (scade in 10 minuti). */
export function presignUploadPut(key: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3(), command, { expiresIn: 600 });
}

/**
 * URL GET firmato (presigned) per ASCOLTARE un oggetto, anche se il bucket non è pubblico. Il
 * browser scarica direttamente da S3 (seek/Range nativi) senza passare dal server. Scade in 6 ore:
 * abbastanza per la riproduzione, la lista si rigenera ben prima. È firma locale: nessuna rete.
 */
export function presignGetUrl(key: string, expiresIn = 21_600): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }), {
    expiresIn,
  });
}

export type S3Object = { key: string; size: number; lastModified: Date | null };

/**
 * Una pagina di oggetti del bucket (max 1000, ordinati per chiave). `nextToken` presente finché ci
 * sono altre pagine. Non lancia su timeout? Sì, può lanciare: il chiamante decide la degradazione
 * (es. i brani in evidenza mostrano quanto già raccolto). Fail-open su timeout tramite deadlineMs.
 */
export async function listObjectsPage(
  continuationToken?: string,
  deadlineMs = 8000,
): Promise<{ objects: S3Object[]; nextToken?: string }> {
  const abortSignal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(deadlineMs)
      : undefined;
  const out = await s3().send(
    new ListObjectsV2Command({
      Bucket: env.AWS_S3_BUCKET,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }),
    { abortSignal },
  );
  const objects: S3Object[] = (out.Contents ?? []).flatMap((o) =>
    o.Key ? [{ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? null }] : [],
  );
  return { objects, nextToken: out.IsTruncated ? out.NextContinuationToken : undefined };
}

export type S3Head = { contentType: string | null; contentLength: number | null };

/** HEAD dell'oggetto (tipo e dimensione). Non lancia: null su timeout/errore (fail-open). */
export async function headObject(key: string, deadlineMs = 8000): Promise<S3Head | null> {
  const abortSignal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(deadlineMs)
      : undefined;
  try {
    const out = await s3().send(new HeadObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }), {
      abortSignal,
    });
    return {
      contentType: typeof out.ContentType === 'string' ? out.ContentType : null,
      contentLength: typeof out.ContentLength === 'number' ? out.ContentLength : null,
    };
  } catch {
    return null;
  }
}

/** Elimina l'oggetto (takedown / rimozione). Best-effort: non lancia mai. */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }));
  } catch {
    // Già rimosso o non raggiungibile: la riga viene comunque tolta dal DB dal chiamante.
  }
}
