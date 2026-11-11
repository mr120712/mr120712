// @polsia:user-owned
import 'server-only';
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

const FORMAT = 'solco-aes-256-gcm-rsa-oaep-sha256-v1' as const;
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_CONTEXT_LENGTH = 512;

type RsaKey = string | Buffer | KeyObject;

export type EncryptedAudioSegment = {
  format: typeof FORMAT;
  context: string;
  iv: string;
  authTag: string;
  wrappedKey: string;
  ciphertext: string;
};

function assertContext(context: string) {
  if (!context.trim() || context.length > MAX_CONTEXT_LENGTH) {
    throw new Error('Invalid encrypted audio context');
  }
}

function decodeBase64(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid encrypted audio segment');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('Invalid encrypted audio segment');
  return decoded;
}

/**
 * Encrypts one stored segment with AES-256-GCM and wraps its random data key
 * with RSA-OAEP-SHA-256. Callers keep the RSA private key in a real secret
 * manager and pass only server-side key material; no key is returned or stored
 * in this record. `context` should bind the persisted track and segment IDs.
 */
export function encryptStoredAudioSegment(
  plaintext: Uint8Array,
  rsaPublicKey: RsaKey,
  context: string,
): EncryptedAudioSegment {
  assertContext(context);
  if (plaintext.byteLength === 0) throw new Error('Audio segment must not be empty');

  const dataKey = randomBytes(AES_KEY_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  try {
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrappedKey = publicEncrypt(
      {
        key: createPublicKey(rsaPublicKey),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      dataKey,
    );

    return {
      format: FORMAT,
      context,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      wrappedKey: wrappedKey.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    dataKey.fill(0);
  }
}

/** Decrypts a stored segment on the server after access and rights checks. */
export function decryptStoredAudioSegment(
  segment: EncryptedAudioSegment,
  rsaPrivateKey: RsaKey,
  expectedContext: string,
): Buffer {
  assertContext(expectedContext);
  if (
    segment.format !== FORMAT ||
    segment.context !== expectedContext ||
    !segment.ciphertext ||
    !segment.wrappedKey
  ) {
    throw new Error('Invalid encrypted audio segment');
  }

  const iv = decodeBase64(segment.iv);
  const authTag = decodeBase64(segment.authTag);
  const ciphertext = decodeBase64(segment.ciphertext);
  const wrappedKey = decodeBase64(segment.wrappedKey);
  if (
    iv.byteLength !== GCM_IV_BYTES ||
    authTag.byteLength !== GCM_TAG_BYTES ||
    ciphertext.byteLength === 0
  ) {
    throw new Error('Invalid encrypted audio segment');
  }

  const dataKey = privateDecrypt(
    {
      key: rsaPrivateKey instanceof KeyObject ? rsaPrivateKey : createPrivateKey(rsaPrivateKey),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    wrappedKey,
  );
  try {
    if (dataKey.byteLength !== AES_KEY_BYTES) throw new Error('Invalid wrapped audio key');
    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
    decipher.setAAD(Buffer.from(expectedContext, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    dataKey.fill(0);
  }
}
