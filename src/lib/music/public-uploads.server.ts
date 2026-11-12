// @polsia:user-owned — logica server della libreria PUBBLICA di brani caricati (Vercel Blob).
// Il file audio è un oggetto PUBBLICO su Blob (URL CDN): qui si registrano i metadati, si elenca
// la classifica pubblica, si moderano le segnalazioni e si rimuovono (anche l'oggetto su Blob).
import 'server-only';
import { del, head } from '@vercel/blob';
import type { PublicUpload, PublicUploadCreateInput } from '@/lib/contracts/public-uploads';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/** Oltre questo numero di segnalatori DISTINTI il brano si auto-ritira dalla libreria pubblica. */
export const AUTO_UNPUBLISH_REPORTS = 5;
/** Tetto di brani pubblici per utente (anti-abuso). */
export const MAX_UPLOADS_PER_USER = 30;
/** Prefisso obbligatorio del percorso su Blob (lo impone anche il token di caricamento). */
export const PUBLIC_UPLOAD_PREFIX = 'public-uploads/';

export class PublicUploadLimitReached extends Error {}
export class InvalidPublicUploadSource extends Error {}
export class BlobNotConfigured extends Error {}

/** La libreria pubblica è attiva solo se Vercel Blob è configurato (token presente). */
export function isPublicUploadConfigured(): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN);
}

const selectUpload = {
  id: true,
  uploaderUserId: true,
  title: true,
  artist: true,
  blobUrl: true,
  durationSeconds: true,
  playCount: true,
  createdAt: true,
} as const;

type UploadRow = {
  id: string;
  uploaderUserId: string;
  title: string;
  artist: string | null;
  blobUrl: string;
  durationSeconds: number;
  playCount: number;
  createdAt: Date;
};

function toPublicUpload(row: UploadRow, viewerUserId: string | null): PublicUpload {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    streamUrl: row.blobUrl,
    durationSeconds: row.durationSeconds,
    playCount: row.playCount,
    createdAt: row.createdAt.toISOString(),
    mine: viewerUserId !== null && row.uploaderUserId === viewerUserId,
  };
}

/**
 * Registra un brano già caricato su Blob come oggetto pubblico. Verifica con head() che l'oggetto
 * esista davvero, sia audio, abbia la dimensione dichiarata e un percorso nel prefisso consentito;
 * così il client non può registrare un URL arbitrario o un file non audio.
 */
export async function registerPublicUpload(
  userId: string,
  input: PublicUploadCreateInput,
): Promise<PublicUpload> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new BlobNotConfigured();

  if (!input.blobPathname.startsWith(PUBLIC_UPLOAD_PREFIX)) {
    throw new InvalidPublicUploadSource();
  }

  const existing = await prisma.publicUpload.count({ where: { uploaderUserId: userId } });
  if (existing >= MAX_UPLOADS_PER_USER) throw new PublicUploadLimitReached();

  let meta: Awaited<ReturnType<typeof head>>;
  try {
    meta = await head(input.blobUrl, { token });
  } catch {
    throw new InvalidPublicUploadSource();
  }
  const contentType = (meta.contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (
    !contentType.startsWith('audio/') ||
    meta.size !== input.byteLength ||
    meta.pathname !== input.blobPathname
  ) {
    throw new InvalidPublicUploadSource();
  }

  const durationSeconds = Math.max(1, Math.min(86_400, Math.ceil(input.elapsedSeconds)));

  try {
    const row = await prisma.publicUpload.create({
      data: {
        uploaderUserId: userId,
        title: input.title,
        artist: input.artist && input.artist.length > 0 ? input.artist : null,
        blobUrl: input.blobUrl,
        blobPathname: input.blobPathname,
        mimeType: input.mimeType,
        byteLength: input.byteLength,
        durationSeconds,
      },
      select: selectUpload,
    });
    return toPublicUpload(row, userId);
  } catch (error) {
    // Stesso oggetto già registrato (blobUrl/blobPathname unici): sorgente non valida.
    if (isUniqueViolation(error)) throw new InvalidPublicUploadSource();
    throw error;
  }
}

/** Classifica pubblica: brani pubblicati, i più ascoltati prima, poi i più recenti. */
export async function listPublicUploads(viewerUserId: string | null): Promise<PublicUpload[]> {
  const rows = await prisma.publicUpload.findMany({
    where: { published: true },
    orderBy: [{ playCount: 'desc' }, { createdAt: 'desc' }],
    take: 100,
    select: selectUpload,
  });
  return rows.map((row) => toPublicUpload(row, viewerUserId));
}

/** I brani caricati dall'utente (anche ritirati dalla moderazione), per gestirli. */
export async function listMyPublicUploads(userId: string): Promise<PublicUpload[]> {
  const rows = await prisma.publicUpload.findMany({
    where: { uploaderUserId: userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: selectUpload,
  });
  return rows.map((row) => toPublicUpload(row, userId));
}

/** Registra un ascolto (playCount) per la classifica. Non fa mai throw bloccante per il player. */
export async function recordPublicUploadPlay(uploadId: string): Promise<void> {
  try {
    await prisma.publicUpload.update({
      where: { id: uploadId },
      data: { playCount: { increment: 1 } },
    });
  } catch {
    // Brano rimosso o non trovato: ignora.
  }
}

/**
 * Segnala un brano pubblicato. Una segnalazione per segnalatore (unique): oltre la soglia di
 * segnalatori distinti il brano si auto-ritira. Ritorna false se il brano pubblicato non esiste.
 */
export async function reportPublicUpload(
  uploadId: string,
  reporterUserId: string,
): Promise<boolean> {
  const upload = await prisma.publicUpload.findFirst({
    where: { id: uploadId, published: true },
    select: { id: true },
  });
  if (!upload) return false;

  try {
    await prisma.publicUploadReport.create({ data: { uploadId, reporterUserId } });
  } catch (error) {
    // Già segnalato da questo utente: non conta due volte, ma non è un errore.
    if (!isUniqueViolation(error)) throw error;
  }

  const reporters = await prisma.publicUploadReport.count({ where: { uploadId } });
  if (reporters >= AUTO_UNPUBLISH_REPORTS) {
    await prisma.publicUpload.update({ where: { id: uploadId }, data: { published: false } });
  }
  return true;
}

/** Rimuove un brano dell'utente: cancella l'oggetto su Blob e la riga. Ritorna false se non suo. */
export async function deletePublicUpload(userId: string, uploadId: string): Promise<boolean> {
  const row = await prisma.publicUpload.findFirst({
    where: { id: uploadId, uploaderUserId: userId },
    select: { id: true, blobUrl: true },
  });
  if (!row) return false;

  const token = env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    try {
      await del(row.blobUrl, { token });
    } catch {
      // L'oggetto potrebbe essere già sparito: procedi comunque a togliere la riga.
    }
  }
  await prisma.publicUpload.delete({ where: { id: row.id } });
  return true;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
