// @polsia:user-owned — lega un acquisto in-app all'account Solco.
//
// Al momento dell'acquisto l'app passa allo store un "account token": Apple lo mette nella
// transazione come `appAccountToken` (deve essere un UUID), Google come
// `obfuscatedExternalAccountId`. Lato server lo RICALCOLIAMO dall'id utente autenticato e lo
// confrontiamo: così una ricevuta valida comprata da un altro Apple ID / account Google non può
// essere inviata per sbloccare un account Solco diverso (anti-replay / anti-transfer).
//
// Il token è un UUIDv5 deterministico dell'id utente: nessuno stato da salvare, riproducibile sia
// quando l'app lo chiede sia in fase di verifica.
import { createHash, timingSafeEqual } from 'node:crypto';

/** Namespace fisso di Solco per gli UUIDv5 degli account token (non è un segreto). */
const SOLCO_IAP_NAMESPACE = '6b6f2a7e-6d61-5f73-6f6c-636f2d696170';

function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespaceBytes).update(Buffer.from(name, 'utf8')).digest();
  const bytes = hash.subarray(0, 16);
  // Versione 5 (nibble alto del byte 6) e variante RFC 4122 (due bit alti del byte 8).
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Il token (UUID in minuscolo) che lega gli acquisti in-app a questo utente. */
export function iapAccountToken(userId: string): string {
  return uuidv5(userId, SOLCO_IAP_NAMESPACE);
}

/** true se il token fornito dallo store appartiene a questo utente (confronto a tempo costante). */
export function iapAccountTokenMatches(token: string | null | undefined, userId: string): boolean {
  if (!token) return false;
  const expected = iapAccountToken(userId);
  const given = token.trim().toLowerCase();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
