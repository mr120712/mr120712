// @polsia:user-owned — verifica dei payload firmati da Apple (JWS con catena x5c).
//
// StoreKit / App Store Server API restituiscono transazioni e notifiche come JWS ES256: l'header
// porta la catena di certificati `x5c` [foglia, intermedio, radice]. Fidarsi del payload richiede:
//   1. ogni certificato è firmato dal successivo (foglia←intermedio←radice);
//   2. ogni certificato è dentro il suo periodo di validità;
//   3. la radice della catena è ESATTAMENTE una delle Apple Root CA fornite dall'operatore
//      (ancora di fiducia: nessuna radice "inventata" dall'aggressore è accettata);
//   4. la firma del JWS è valida con la chiave pubblica della foglia.
// Solo allora si decodifica il payload. Qualsiasi scostamento lancia IapVerificationError.
import 'server-only';
import { verify as cryptoVerify, X509Certificate } from 'node:crypto';

export class IapVerificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IapVerificationError';
  }
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
}

/** Spezza una catena PEM (una o più radici concatenate) in certificati X.509. */
function parsePemCertificates(pem: string): X509Certificate[] {
  const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!matches) return [];
  const certs: X509Certificate[] = [];
  for (const block of matches) {
    try {
      certs.push(new X509Certificate(block));
    } catch {
      // Blocco non valido: ignorato (le radici valide bastano).
    }
  }
  return certs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Verifica un JWS firmato da Apple e restituisce il payload decodificato. `rootCasPem` sono le
 * Apple Root CA accettate (PEM concatenati). `now` serve ai controlli di validità dei certificati.
 */
export function verifyAppleSignedPayload(
  jws: string,
  rootCasPem: string,
  now: Date = new Date(),
): Record<string, unknown> {
  const parts = jws.split('.');
  if (parts.length !== 3) {
    throw new IapVerificationError('malformed_jws', 'JWS non valido.');
  }
  const headerSegment = parts[0];
  const payloadSegment = parts[1];
  const signatureSegment = parts[2];
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    throw new IapVerificationError('malformed_jws', 'JWS incompleto.');
  }

  let header: unknown;
  try {
    header = decodeSegment(headerSegment);
  } catch {
    throw new IapVerificationError('malformed_header', 'Header JWS non leggibile.');
  }
  if (
    !isRecord(header) ||
    header.alg !== 'ES256' ||
    !Array.isArray(header.x5c) ||
    !header.x5c.length
  ) {
    throw new IapVerificationError('unexpected_header', 'Header JWS inatteso (serve ES256 + x5c).');
  }

  // La catena x5c: certificati DER in base64 standard, [foglia, intermedio, radice].
  const chain: X509Certificate[] = [];
  for (const entry of header.x5c) {
    if (typeof entry !== 'string') {
      throw new IapVerificationError('bad_x5c', 'Catena di certificati non valida.');
    }
    try {
      chain.push(new X509Certificate(Buffer.from(entry, 'base64')));
    } catch {
      throw new IapVerificationError('bad_x5c', 'Certificato nella catena non valido.');
    }
  }
  if (chain.length < 2) {
    throw new IapVerificationError('short_chain', 'Catena di certificati troppo corta.');
  }

  const roots = parsePemCertificates(rootCasPem);
  if (roots.length === 0) {
    throw new IapVerificationError('no_trust_anchor', 'Nessuna Apple Root CA configurata.');
  }

  // 1 + 2: ogni certificato firmato dal successivo, e tutti nel periodo di validità.
  const nowMs = now.getTime();
  for (let i = 0; i < chain.length; i += 1) {
    const cert = chain[i];
    if (!cert) {
      throw new IapVerificationError('bad_x5c', 'Certificato mancante nella catena.');
    }
    const notBefore = new Date(cert.validFromDate).getTime();
    const notAfter = new Date(cert.validToDate).getTime();
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
      throw new IapVerificationError('bad_validity', 'Validità del certificato non leggibile.');
    }
    if (nowMs < notBefore || nowMs > notAfter) {
      throw new IapVerificationError('cert_expired', 'Certificato scaduto o non ancora valido.');
    }
    // I certificati non-foglia (intermedio, radice) devono essere CA: così una foglia non può
    // essere riusata come emittente per firmare un'altra foglia.
    if (i > 0 && cert.ca !== true) {
      throw new IapVerificationError('not_a_ca', 'Un certificato intermedio/radice non è una CA.');
    }
    const issuer = chain[i + 1];
    if (issuer && !cert.verify(issuer.publicKey)) {
      throw new IapVerificationError('chain_signature', 'Firma della catena non valida.');
    }
  }

  // 3: la radice della catena deve coincidere (byte a byte) con una radice fidata configurata.
  const chainRoot = chain[chain.length - 1];
  if (!chainRoot) {
    throw new IapVerificationError('short_chain', 'Radice della catena mancante.');
  }
  const trusted = roots.some((root) => root.raw.equals(chainRoot.raw));
  if (!trusted) {
    throw new IapVerificationError(
      'untrusted_root',
      'La catena non termina su una Apple Root CA fidata.',
    );
  }
  // La radice fidata deve a sua volta aver firmato l'ultimo intermedio (o essere self-signed se è l'unica).
  if (chain.length >= 2) {
    const lastIntermediate = chain[chain.length - 2];
    if (lastIntermediate && !lastIntermediate.verify(chainRoot.publicKey)) {
      throw new IapVerificationError(
        'chain_signature',
        'Intermedio non firmato dalla radice fidata.',
      );
    }
  }

  // 4: firma del JWS con la chiave pubblica della foglia (ES256 = SHA-256 + firma raw r||s).
  const leaf = chain[0];
  if (!leaf) {
    throw new IapVerificationError('bad_x5c', 'Certificato foglia mancante.');
  }
  const signatureValid = cryptoVerify(
    'sha256',
    Buffer.from(`${headerSegment}.${payloadSegment}`),
    { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureSegment, 'base64url'),
  );
  if (!signatureValid) {
    throw new IapVerificationError('bad_signature', 'Firma del JWS non valida.');
  }

  let payload: unknown;
  try {
    payload = decodeSegment(payloadSegment);
  } catch {
    throw new IapVerificationError('malformed_payload', 'Payload JWS non leggibile.');
  }
  if (!isRecord(payload)) {
    throw new IapVerificationError('malformed_payload', 'Payload JWS non è un oggetto.');
  }
  return payload;
}
