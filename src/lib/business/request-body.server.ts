// @polsia:user-owned
import { safeJsonParse } from '@/lib/security/prototype-guard';

export type LimitedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: 'invalid_json' | 'payload_too_large' };

export async function readJsonLimited(
  request: Request,
  maxBytes: number,
): Promise<LimitedJsonResult> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }

  if (!request.body) return { ok: true, value: null };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let totalBytes = 0;

  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      totalBytes += part.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'payload_too_large' };
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    // safeJsonParse scarta le chiavi pericolose (__proto__/constructor/prototype): nessun handler a
    // valle può ricevere dati capaci di inquinare Object.prototype. I payload legittimi non usano
    // quelle chiavi, quindi non c'è alcun impatto funzionale.
    return { ok: true, value: safeJsonParse(text) };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

export function limitedJsonError(result: Extract<LimitedJsonResult, { ok: false }>): Response {
  return Response.json(
    {
      error: result.error,
      message:
        result.status === 413
          ? 'La richiesta è troppo grande. Riduci il contenuto e riprova.'
          : 'Il corpo della richiesta non contiene JSON valido.',
    },
    { status: result.status },
  );
}
