// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// Helpers for src/app/opengraph-image.tsx. The optional background photo is
// `brandVisual.og.image` in src/lib/brand.ts.

// Satori (next/og) decodes PNG and JPEG only.
const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg']);
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch the OG background photo and inline it as a data URL. Returns null for
 * anything that should fall back to the plain-color card: no URL, a non-https
 * URL, a failed/slow fetch or an unsupported format. Never throws, so a broken
 * image can't fail the build.
 */
export async function loadOgBackground(
  src: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (typeof src !== 'string' || !src.startsWith('https://')) return null;
  try {
    const res = await fetchImpl(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (!type || !SUPPORTED_TYPES.has(type)) return null;
    const body = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${body.toString('base64')}`;
  } catch {
    return null;
  }
}

/** `#rgb` / `#rrggbb` → `rgba(r, g, b, alpha)`; anything else → black at `alpha`. */
export function hexToRgba(hex: string, alpha: number): string {
  const raw = hex.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(raw)
    ? raw
        .split('')
        .map((c) => c + c)
        .join('')
    : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) return `rgba(0, 0, 0, ${alpha})`;
  const n = Number.parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
