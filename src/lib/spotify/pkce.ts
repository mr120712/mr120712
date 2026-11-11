// @polsia:user-owned — PKCE (RFC 7636) e valori casuali per il flusso Authorization Code di Spotify.
// Solo Web Crypto (globalThis.crypto): nessun segreto, funzioni pure e testabili.

/** Caratteri ammessi in un code_verifier (RFC 7636 §4.1: ALPHA / DIGIT / "-" / "." / "_" / "~"). */
export const CODE_VERIFIER_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
export const CODE_VERIFIER_LENGTH = 64;
const STATE_BYTES = 32;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes unpadded base64url; null when the text is not base64url. */
export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Random code_verifier of `length` characters from the RFC 7636 alphabet. Rejection sampling
 * keeps every character equally likely (256 is not a multiple of 66).
 */
export function createCodeVerifier(length = CODE_VERIFIER_LENGTH): string {
  if (!Number.isInteger(length) || length < 43 || length > 128) {
    throw new RangeError('code_verifier length must be between 43 and 128');
  }
  const size = CODE_VERIFIER_ALPHABET.length;
  const limit = 256 - (256 % size);
  let verifier = '';
  while (verifier.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      verifier += CODE_VERIFIER_ALPHABET[byte % size];
      if (verifier.length === length) break;
    }
  }
  return verifier;
}

export function isCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

/** code_challenge for code_challenge_method=S256: BASE64URL(SHA256(ASCII(verifier))). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** OAuth `state`: 32 random bytes, base64url (43 characters). */
export function createOAuthState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(STATE_BYTES)));
}
