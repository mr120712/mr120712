// @polsia:user-owned — anteprima di 30 secondi applicata dal server per gli utenti free:
// inoltra solo l'inizio dello stream audio, così il limite non si aggira dal browser.
import 'server-only';
import { assertPublicHttpsUrl } from '@/lib/music/podcasts.server';

export const PREVIEW_SECONDS = 30;
/** 30 s a 320 kbps: copre qualsiasi bitrate comune (con bitrate più bassi l'anteprima dura di più,
 *  ma il player si ferma comunque a 30 s). */
export const PREVIEW_MAX_BYTES = Math.ceil((PREVIEW_SECONDS * 320_000) / 8);
const TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

/** Legge al massimo `maxBytes` dallo stream e poi chiude la connessione a monte. */
export function truncateStream(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= maxBytes) {
        controller.close();
        await reader.cancel().catch(() => undefined);
        return;
      }
      const { done, value } = await reader.read();
      if (done || !value) {
        controller.close();
        return;
      }
      const chunk = value.byteLength > maxBytes - sent ? value.slice(0, maxBytes - sent) : value;
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  });
}

/** Risposta audio limitata all'anteprima, seguendo i redirect solo verso host pubblici HTTPS. */
export async function previewResponse(sourceUrl: string, fetcher: FetchLike = fetch) {
  let current = sourceUrl;
  for (let hop = 0; hop < 4; hop += 1) {
    const url = await assertPublicHttpsUrl(current);
    const upstream = await fetcher(url, {
      headers: { 'Icy-MetaData': '0', 'User-Agent': 'Solco/1.0' },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location');
      await upstream.body?.cancel().catch(() => undefined);
      if (!location) break;
      current = new URL(location, url).toString();
      continue;
    }
    if (!upstream.ok || !upstream.body) break;
    const type = upstream.headers.get('content-type') ?? 'audio/mpeg';
    if (!/^(audio\/|application\/ogg|application\/octet-stream)/i.test(type)) break;
    return new Response(truncateStream(upstream.body, PREVIEW_MAX_BYTES), {
      status: 200,
      headers: {
        'Content-Type': type.split(';')[0] ?? 'audio/mpeg',
        'Cache-Control': 'private, no-store',
        'X-Solco-Preview': String(PREVIEW_SECONDS),
        Vary: 'Cookie',
      },
    });
  }
  return Response.json({ error: 'preview_unavailable' }, { status: 502 });
}
