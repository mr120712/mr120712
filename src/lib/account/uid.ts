// @polsia:user-owned — UID leggibile degli account Solco (gestione account e assistenza, logica pura:
// client, server e test). Forma: "SOL-" + 8 caratteri dell'alfabeto Crockford base32 in due gruppi
// da 4, es. SOL-7K2M-9QXD. L'alfabeto non ha I, L, O e U: niente confusione con 1 e 0 quando lo si
// legge o lo si detta. È casuale (40 bit), mai derivato da email, nome o id: non rivela nulla
// dell'account né quanti account ci sono. L'unicità la garantisce il database (src/lib/account/
// uid.server.ts riprova in caso di collisione).

/** Prefisso di ogni UID. */
export const ACCOUNT_UID_PREFIX = 'SOL';
/** Alfabeto Crockford base32 (32 simboli: un byte & 31 è uniforme). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Forma canonica di un UID. */
export const ACCOUNT_UID_PATTERN = /^SOL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Un nuovo UID casuale (`randomBytes` si cambia solo nei test). */
export function generateAccountUid(
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
): string {
  const bytes = randomBytes(8);
  let symbols = '';
  for (let index = 0; index < 8; index += 1) symbols += ALPHABET[(bytes[index] ?? 0) & 31];
  return `${ACCOUNT_UID_PREFIX}-${symbols.slice(0, 4)}-${symbols.slice(4)}`;
}

/** True per un UID nella forma canonica. */
export function isAccountUid(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_UID_PATTERN.test(value);
}

/**
 * Un UID scritto come capita (minuscole, spazi, senza trattini o senza "SOL") nella forma canonica,
 * oppure null. Come in Crockford, I e L valgono 1 e O vale 0: "sol 7k2m 9qxd", "7K2M9QXD" e
 * "SOL-7K2M-9QXD" sono lo stesso UID.
 */
export function parseAccountUid(input: string): string | null {
  let compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (compact.startsWith(ACCOUNT_UID_PREFIX) && compact.length === 11) compact = compact.slice(3);
  compact = compact.replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(compact)) return null;
  return `${ACCOUNT_UID_PREFIX}-${compact.slice(0, 4)}-${compact.slice(4)}`;
}
