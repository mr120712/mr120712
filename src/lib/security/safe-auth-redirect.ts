// @polsia:user-owned — dove better-auth può rimandare l'utente dopo accesso, registrazione o
// verifica email. Il framework accetta qualsiasi sito *.polsia.app / *.polsia.io (domini
// condivisi con altre app): qui si accettano solo percorsi interni o l'origine esatta di Solco,
// così un link di verifica non può portare chi lo apre su un sito di qualcun altro.

/** Request fields better-auth reads as "where to go next". */
export const AUTH_REDIRECT_FIELDS = [
  'callbackURL',
  'newUserCallbackURL',
  'errorCallbackURL',
  'redirectTo',
] as const;

function originOf(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Exact origins Solco itself is served from (no wildcards). */
export function allowedRedirectOrigins(env: Record<string, string | undefined> = process.env) {
  const origins = new Set<string>();
  for (const value of [env.BETTER_AUTH_URL, env.NEXT_PUBLIC_APP_URL]) {
    const origin = originOf(value);
    if (origin) origins.add(origin);
  }
  for (const entry of (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(',')) {
    const value = entry.trim();
    if (!value || value.includes('*')) continue;
    const origin = originOf(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

/** A path inside the app ("/dashboard?x=1"), never "//host" or "/\host" (browsers treat both as a host). */
function isInternalPath(value: string) {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !hasControlCharacters(value)
  );
}

/** Tabs, newlines and other control characters are dropped by browsers and can hide a "//". */
function hasControlCharacters(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isSafeAuthRedirect(value: unknown, origins: Set<string>): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  if (isInternalPath(value)) return true;
  const origin = originOf(value);
  return origin !== null && origins.has(origin);
}

/** The first unsafe redirect field in a request body or query, or null when all are safe. */
export function unsafeAuthRedirectField(
  sources: Array<Record<string, unknown> | undefined | null>,
  origins: Set<string> = allowedRedirectOrigins(),
): string | null {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of AUTH_REDIRECT_FIELDS) {
      if (field in source && !isSafeAuthRedirect(source[field], origins)) return field;
    }
  }
  return null;
}
