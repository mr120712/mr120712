// @polsia:user-owned — accesso col numero di telefono: regole pure (nessun I/O), condivise tra il
// modulo di login e il server. Tutti i paesi sono ammessi (scelta di prodotto): il formato è
// l'E.164 internazionale (+<prefisso><numero>, 8–15 cifre in tutto).

/** Formato E.164: "+", prima cifra 1–9, poi 7–14 cifre (8–15 in totale). */
const E164 = /^\+[1-9]\d{7,14}$/;

/** true se il numero è in formato internazionale E.164 valido. */
export function isValidE164(phoneNumber: string): boolean {
  return E164.test(phoneNumber);
}

/**
 * Normalizza ciò che l'utente scrive: toglie spazi, trattini, punti e parentesi; "00" iniziale
 * diventa "+"; senza prefisso internazionale si usa quello scelto (default Italia +39). Ritorna
 * null se il risultato non è un E.164 valido.
 */
export function normalizePhoneNumber(input: string, defaultCountryCode = '+39'): string | null {
  const compact = input.trim().replace(/[\s().-]/g, '');
  if (!compact) return null;
  let candidate: string;
  if (compact.startsWith('+')) candidate = compact;
  else if (compact.startsWith('00')) candidate = `+${compact.slice(2)}`;
  else {
    const prefix = defaultCountryCode.trim().replace(/[^\d+]/g, '');
    if (!/^\+[1-9]\d{0,3}$/.test(prefix)) return null;
    candidate = `${prefix}${compact}`;
  }
  return isValidE164(candidate) ? candidate : null;
}

/**
 * Email provvisoria di un account creato col telefono (better-auth ne richiede una). Dominio
 * riservato ".invalid" (RFC 2606): non è consegnabile, quindi nessuna email partirà mai verso
 * terzi, e non può coincidere con l'indirizzo reale di qualcuno. Unica per numero.
 */
export function phoneAccountEmail(phoneNumber: string): string {
  return `${phoneNumber.replace(/\D/g, '')}@telefono.solcomusic.invalid`;
}

/** true per gli account creati col telefono (email provvisoria, mai da mostrare o usare). */
export function isPhoneAccountEmail(email: string | null | undefined): boolean {
  return (
    typeof email === 'string' && email.trim().toLowerCase().endsWith('@telefono.solcomusic.invalid')
  );
}

/**
 * Nome iniziale dell'account creato col telefono. Mai il numero intero: il nome può comparire in
 * profili e community. Si può cambiare dal profilo.
 */
export function phoneAccountName(): string {
  return 'Ascoltatore Solco';
}

/** Numero mascherato per l'interfaccia (es. "+39 ••• ••• 4567"). */
export function maskPhoneNumber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length < 4) return '•••';
  return `+${digits.slice(0, 2)} ••• ••• ${digits.slice(-4)}`;
}

/** I campi dell'utente in sessione che servono qui (better-auth li restituisce tutti). */
export type AccountIdentity = {
  email?: string | null;
  emailVerified?: boolean | null;
  name?: string | null;
  phoneNumber?: unknown;
  phoneNumberVerified?: unknown;
};

/** Account creato col telefono: niente email reale da mostrare, verificare o usare. */
export function isPhoneAccount(user: AccountIdentity | null | undefined): boolean {
  return isPhoneAccountEmail(user?.email);
}

/** Come mostrare l'account: email, oppure il numero mascherato (mai l'email provvisoria). */
export function accountLabel(user: AccountIdentity | null | undefined): string {
  if (!user) return 'Account';
  if (isPhoneAccount(user)) {
    return typeof user.phoneNumber === 'string' && isValidE164(user.phoneNumber)
      ? maskPhoneNumber(user.phoneNumber)
      : 'Account con telefono';
  }
  return user.email || user.name || 'Account';
}

/** Va chiesto di verificare l'email? Mai per gli account col telefono (non hanno un'email). */
export function needsEmailVerification(user: AccountIdentity | null | undefined): boolean {
  return Boolean(user) && user?.emailVerified !== true && !isPhoneAccount(user);
}

/** Identità confermata (email verificata o numero confermato via SMS), come lato server. */
export function hasVerifiedContact(user: AccountIdentity | null | undefined): boolean {
  return user?.emailVerified === true || user?.phoneNumberVerified === true;
}
