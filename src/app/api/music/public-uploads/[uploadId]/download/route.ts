// @polsia:user-owned — scarica un TUO brano caricato (SOLO il proprietario) come file con nome
// leggibile. Streamma l'oggetto da Vercel Blob e lo ri-serve come allegato. È contenuto dell'utente:
// qui si scarica solo ciò che hai caricato tu, nessuna estrazione da fonti di terzi (YouTube ecc.).
import 'server-only';
import { NextResponse } from 'next/server';
import { getOwnUploadForDownload } from '@/lib/music/public-uploads.server';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';
/** Un brano pubblico è al massimo 40 MB: lo streaming sta ben sotto il limite della funzione. */
export const maxDuration = 60;

const idPattern = /^[a-z0-9]{20,40}$/;

/** Nome file sicuro dal titolo: solo lettere/numeri/spazi e poca punteggiatura, lunghezza limitata. */
function safeBaseName(title: string): string {
  const cleaned = title
    .replace(/[^\p{L}\p{N} .,_()-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'brano';
}

/** Estensione dedotta dalla chiave dell'oggetto (costruita dal server con l'estensione giusta). */
function extensionFromPath(pathname: string): string {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'mp3';
}

export async function GET(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  let userId: string;
  try {
    const user = await requireAuth(request);
    userId = user.id;
  } catch (response) {
    return response as Response;
  }

  const { uploadId } = await params;
  if (!idPattern.test(uploadId)) return new NextResponse(null, { status: 404 });

  const upload = await getOwnUploadForDownload(userId, uploadId);
  if (!upload) return new NextResponse(null, { status: 404 });

  // L'URL è quello salvato dal server alla registrazione (host Blob affidabile): nessun input
  // dell'utente nell'URL → nessun rischio SSRF.
  let upstream: Response;
  try {
    upstream = await fetch(upload.blobUrl, {
      signal:
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(45_000)
          : undefined,
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) return new NextResponse(null, { status: 502 });

  const ext = extensionFromPath(upload.blobPathname);
  const base = safeBaseName(upload.title);
  // filename= (solo ASCII, fallback) + filename*= (UTF-8, nome reale) per i browser moderni.
  const asciiName = `${base.replace(/[^\x20-\x7e]/g, '_')}.${ext}`;
  const utf8Name = encodeURIComponent(`${base}.${ext}`);

  const headers = new Headers();
  headers.set(
    'content-type',
    upload.mimeType || upstream.headers.get('content-type') || 'application/octet-stream',
  );
  const length = upstream.headers.get('content-length');
  if (length) headers.set('content-length', length);
  headers.set(
    'content-disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
  );
  headers.set('cache-control', 'private, no-store');

  return new Response(upstream.body, { status: 200, headers });
}
