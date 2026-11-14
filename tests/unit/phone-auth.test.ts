// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  accountLabel,
  hasVerifiedContact,
  isPhoneAccount,
  isPhoneAccountEmail,
  isValidE164,
  maskPhoneNumber,
  needsEmailVerification,
  normalizePhoneNumber,
  phoneAccountEmail,
  phoneAccountName,
} from '@/lib/business/phone-auth';

describe('numeri di telefono (E.164, tutti i paesi)', () => {
  it('accetta solo il formato internazionale valido', () => {
    expect(isValidE164('+393331234567')).toBe(true);
    expect(isValidE164('+14155552671')).toBe(true);
    expect(isValidE164('+447911123456')).toBe(true);
    expect(isValidE164('3331234567')).toBe(false); // senza prefisso
    expect(isValidE164('+0331234567')).toBe(false); // prefisso non può iniziare con 0
    expect(isValidE164('+39 333 123 4567')).toBe(false); // spazi: va normalizzato prima
    expect(isValidE164('+1234567')).toBe(false); // troppo corto
    expect(isValidE164('+1234567890123456')).toBe(false); // troppo lungo
    expect(isValidE164('+39333abc4567')).toBe(false);
  });

  it('normalizza quello che scrive l’utente', () => {
    expect(normalizePhoneNumber('333 123 4567')).toBe('+393331234567');
    expect(normalizePhoneNumber('(333) 123-4567')).toBe('+393331234567');
    expect(normalizePhoneNumber('+39 333.123.4567')).toBe('+393331234567');
    expect(normalizePhoneNumber('0044 7911 123456')).toBe('+447911123456');
    expect(normalizePhoneNumber('7911 123456', '+44')).toBe('+447911123456');
    expect(normalizePhoneNumber('4155552671', '+1')).toBe('+14155552671');
  });

  it('rifiuta input e prefissi non validi', () => {
    expect(normalizePhoneNumber('')).toBeNull();
    expect(normalizePhoneNumber('abc')).toBeNull();
    expect(normalizePhoneNumber('12', '+39')).toBeNull();
    expect(normalizePhoneNumber('3331234567', 'pippo')).toBeNull();
    expect(normalizePhoneNumber('3331234567', '+0')).toBeNull();
  });

  it('account creati col telefono: email non consegnabile, unica, riconoscibile', () => {
    const email = phoneAccountEmail('+393331234567');
    expect(email).toBe('393331234567@telefono.solcomusic.invalid');
    expect(email.endsWith('.invalid')).toBe(true);
    expect(phoneAccountEmail('+393331234568')).not.toBe(email);
    expect(isPhoneAccountEmail(email)).toBe(true);
    expect(isPhoneAccountEmail('mario@example.com')).toBe(false);
    expect(isPhoneAccountEmail(null)).toBe(false);
  });

  it('il nome iniziale non contiene mai il numero', () => {
    expect(phoneAccountName()).not.toMatch(/\d/);
  });

  it('maschera il numero mostrato in pagina', () => {
    expect(maskPhoneNumber('+393331234567')).toBe('+39 ••• ••• 4567');
    expect(maskPhoneNumber('+393331234567')).not.toContain('333123');
  });
});

describe('identità dell’account (telefono o email)', () => {
  const phoneUser = {
    email: '393331234567@telefono.solcomusic.invalid',
    emailVerified: false,
    name: 'Ascoltatore Solco',
    phoneNumber: '+393331234567',
    phoneNumberVerified: true,
  };
  const emailUser = { email: 'mario@example.com', emailVerified: false, name: 'Mario' };

  it('mostra il numero mascherato, mai l’email provvisoria', () => {
    expect(accountLabel(phoneUser)).toBe('+39 ••• ••• 4567');
    expect(accountLabel({ ...phoneUser, phoneNumber: null })).toBe('Account con telefono');
    expect(accountLabel(emailUser)).toBe('mario@example.com');
    expect(isPhoneAccount(phoneUser)).toBe(true);
    expect(isPhoneAccount(emailUser)).toBe(false);
  });

  it('non chiede di verificare un’email che non esiste; il telefono confermato vale', () => {
    expect(needsEmailVerification(phoneUser)).toBe(false);
    expect(needsEmailVerification(emailUser)).toBe(true);
    expect(needsEmailVerification({ ...emailUser, emailVerified: true })).toBe(false);
    expect(hasVerifiedContact(phoneUser)).toBe(true);
    expect(hasVerifiedContact(emailUser)).toBe(false);
    expect(hasVerifiedContact({ ...phoneUser, phoneNumberVerified: false })).toBe(false);
  });
});
