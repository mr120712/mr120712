// @polsia:user-owned — cifratura dei token Spotify e del cookie OAuth (AES-256-GCM, Web Crypto).
// Chiave: SPOTIFY_TOKEN_KEY (base64, 32 byte) se presente, altrimenti HKDF-SHA256 da
// BETTER_AUTH_SECRET (info "solco-spotify-tokens-v1"). Formato: "v1.<iv b64url>.<ct b64url>".
// Ogni valore è legato al suo contesto (dati autenticati aggiuntivi): un token copiato nella riga
// di un altro utente, o un cookie usato come token, non si decifra.
import 'server-only';
import { base64UrlDecode, base64UrlEncode } from '@/lib/spotify/pkce';

const VERSION = 'v1';
const HKDF_INFO = 'solco-spotify-tokens-v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** Longest sealed value accepted (a Spotify token is a few hundred characters). */
const MAX_SEALED_LENGTH = 8_192;

type KeySource = { kind: 'raw'; key: Uint8Array } | { kind: 'hkdf'; secret: string };

let cached: { id: string; key: Promise<CryptoKey> } | null = null;

const encoder = new TextEncoder();

function decodeStandardBase64(value: string): Uint8Array | null {
  const normalized = value.trim().replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return base64UrlDecode(normalized);
}

function keySource(): KeySource | null {
  const raw = process.env.SPOTIFY_TOKEN_KEY?.trim();
  if (raw) {
    const key = decodeStandardBase64(raw);
    // A malformed explicit key disables the feature instead of silently using another key.
    return key && key.length === KEY_BYTES ? { kind: 'raw', key } : null;
  }
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret ? { kind: 'hkdf', secret } : null;
}

/** True when a usable encryption key is configured. */
export function hasTokenKey(): boolean {
  return keySource() !== null;
}

async function importKey(source: KeySource): Promise<CryptoKey> {
  if (source.kind === 'raw') {
    return crypto.subtle.importKey('raw', source.key, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  }
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(source.secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function currentKey(): Promise<CryptoKey> {
  const source = keySource();
  if (!source) throw new Error('Spotify token key is not configured');
  // The id only distinguishes configurations within this process (tests change the env).
  const id = source.kind === 'raw' ? `raw:${base64UrlEncode(source.key)}` : `hkdf:${source.secret}`;
  if (cached?.id !== id) {
    const key = importKey(source);
    cached = { id, key };
    // A failed import must not stay cached.
    key.catch(() => {
      if (cached?.key === key) cached = null;
    });
  }
  return cached.key;
}

/** Encrypts `plaintext`, bound to `context` (e.g. `token:<userId>`). */
export async function sealValue(plaintext: string, context: string): Promise<string> {
  const key = await currentKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(plaintext),
  );
  return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

/** Decrypts a value from sealValue; null when it is malformed, tampered with or for another context. */
export async function openValue(sealed: string, context: string): Promise<string | null> {
  if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_LENGTH) return null;
  const [version, ivText, ciphertextText, ...rest] = sealed.split('.');
  if (version !== VERSION || rest.length > 0 || !ivText || !ciphertextText) return null;
  const iv = base64UrlDecode(ivText);
  const ciphertext = base64UrlDecode(ciphertextText);
  // AES-GCM appends a 16-byte tag: anything shorter cannot be valid.
  if (!iv || iv.length !== IV_BYTES || !ciphertext || ciphertext.length < 16) return null;
  try {
    const key = await currentKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      key,
      ciphertext,
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    return null;
  }
}
