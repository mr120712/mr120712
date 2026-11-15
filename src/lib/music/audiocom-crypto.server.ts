// @polsia:user-owned — cifratura dei token di audio.com e del cookie OAuth del collegamento.
// Stesso schema della cache delle trascrizioni (transcription-cache.server.ts, di cui riusa
// sealTranscript/openTranscript): AES-256-GCM con IV casuale di 12 byte e tag di 16, chiave
// HKDF-SHA256 da BETTER_AUTH_SECRET con sale ed etichetta (info) PROPRI di audio.com, così la
// chiave è diversa da tutte le altre derivate dallo stesso segreto. Ogni valore è legato al suo
// contesto (dati autenticati: es. "audiocom-access:v1:<clientId>"): un token spostato in un'altra
// colonna, o il cookie usato come token, non si decifra. Formato: "v1.<iv>.<tag>.<ct>" in base64url.
// Senza segreto il collegamento è spento (audioComConfig → null): nessun token si salva in chiaro.
import 'server-only';
import { hkdfSync } from 'node:crypto';
import { openTranscript, sealTranscript } from '@/lib/music/transcription-cache.server';
import { base64UrlDecode, base64UrlEncode } from '@/lib/spotify/pkce';

const VERSION = 'v1';
const HKDF_SALT = 'solco-audiocom-connection';
const HKDF_INFO = 'audiocom-tokens:aes-256-gcm:v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Valore cifrato più lungo accettato (un token è lungo al più qualche KB). */
const MAX_SEALED_LENGTH = 16_384;

let derived: { secret: string; key: Buffer } | null = null;

/** Chiave AES del segreto attuale (ricalcolata se cambia), o null se il segreto manca. */
function currentKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') return null;
  if (derived?.secret !== secret) {
    derived = {
      secret,
      key: Buffer.from(
        hkdfSync('sha256', Buffer.from(secret, 'utf8'), HKDF_SALT, HKDF_INFO, KEY_BYTES),
      ),
    };
  }
  return derived.key;
}

/** True se c'è una chiave di cifratura (BETTER_AUTH_SECRET presente). */
export function hasAudioComKey(): boolean {
  return currentKey() !== null;
}

/** Cifra `plaintext` legandolo a `context`. Lancia se la chiave manca (mai un salvataggio in chiaro). */
export function sealAudioComValue(plaintext: string, context: string): string {
  const key = currentKey();
  if (!key) throw new Error('audio.com encryption key is not configured');
  const sealed = sealTranscript(plaintext, context, key);
  return [
    VERSION,
    base64UrlEncode(sealed.iv),
    base64UrlEncode(sealed.authTag),
    base64UrlEncode(sealed.ciphertext),
  ].join('.');
}

/** Decifra un valore di sealAudioComValue; null se malformato, manomesso, di altro contesto o chiave. */
export function openAudioComValue(sealed: unknown, context: string): string | null {
  if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_LENGTH) return null;
  const key = currentKey();
  if (!key) return null;
  const [version, ivText, tagText, ciphertextText, ...rest] = sealed.split('.');
  if (version !== VERSION || rest.length > 0 || !ivText || !tagText || !ciphertextText) return null;
  const iv = base64UrlDecode(ivText);
  const authTag = base64UrlDecode(tagText);
  const ciphertext = base64UrlDecode(ciphertextText);
  if (!iv || iv.length !== IV_BYTES || !authTag || authTag.length !== TAG_BYTES || !ciphertext) {
    return null;
  }
  const opened = openTranscript({ iv, authTag, ciphertext }, context, key);
  return opened.ok ? opened.plaintext : null;
}
