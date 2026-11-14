// @polsia:user-owned — controlli eseguiti PRIMA degli endpoint di better-auth (vedi il plugin
// solcoAuthGuards in auth-config.ts). Logica separata dal framework, quindi testabile:
//
// - Il numero di telefono di un account si imposta SOLO dimostrando di riceverne gli SMS
//   (/phone-number/verify). Il plugin di better-auth lo accetta anche come campo libero di
//   /sign-up/email e simili: chiunque potrebbe "prenotare" il numero di un altro (che entrando col
//   telefono finirebbe nell'account dell'attaccante) o piazzare il proprio su un account altrui.
//   Qui ogni altro endpoint che lo riceve risponde 400.
// - Endpoint del plugin telefono che Solco non usa: chiusi (404). In particolare il reset password
//   via SMS: senza un invio configurato genererebbe codici a 6 cifre che nessuno riceve ma che si
//   potrebbero tentare a ripetizione per impostare una password su un account altrui.
// - Invio dei codici SMS: solo con Twilio configurato, solo numeri E.164, e limiti condivisi tra
//   le istanze per rete (IPv6: per /64), per numero e per l'intera app (gli SMS costano; tutti i
//   paesi ammessi). L'SMS parte da qui, in attesa della risposta di Twilio: se Twilio rifiuta
//   (numero fisso, paese bloccato…) l'utente lo sa subito invece di aspettare un SMS che non arriva.
// - Verifica del codice e richieste di recupero password: limiti per rete.
import 'server-only';
import { isIP } from 'node:net';
import { isPhoneAccountEmail, isValidE164 } from '@/lib/business/phone-auth';
import {
  consumeRateLimit,
  getRateLimitIdentity,
  type RateLimitAction,
  type RateLimitDecision,
} from '@/lib/business/rate-limit.server';
import { isPhoneLoginConfigured, startSmsVerification } from '@/lib/business/twilio-verify.server';
import { prisma } from '@/lib/db';

export type GuardStatus =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'TOO_MANY_REQUESTS'
  | 'BAD_GATEWAY'
  | 'SERVICE_UNAVAILABLE';
export type GuardRejection = { status: GuardStatus; message: string; code?: string };

type Deps = {
  consume: (action: RateLimitAction, identity: string | null) => Promise<RateLimitDecision>;
  phoneConfigured: () => boolean;
  /** Avvia la verifica SMS (Twilio); false = SMS non partito. */
  sendSms: (phone: string) => Promise<boolean>;
  /** Il numero appartiene già a un account confermato via SMS? */
  isKnownPhone: (phone: string) => Promise<boolean>;
};

async function phoneHasAccount(phone: string): Promise<boolean> {
  try {
    const user = await prisma.user.findFirst({
      where: { phoneNumber: phone, phoneNumberVerified: true },
      select: { id: true },
    });
    return user !== null;
  } catch {
    // Database non raggiungibile: si applica il tetto globale (scelta prudente sui costi).
    return false;
  }
}

const defaultDeps: Deps = {
  consume: (action, identity) => consumeRateLimit(action, identity),
  phoneConfigured: isPhoneLoginConfigured,
  sendSms: (phone) => startSmsVerification(phone),
  isKnownPhone: phoneHasAccount,
};

/** Endpoint del plugin telefono non usati da Solco: chiusi del tutto. */
export const BLOCKED_AUTH_PATHS = new Set([
  '/phone-number/request-password-reset',
  '/phone-number/reset-password',
  '/sign-in/phone-number',
]);

/** Gli unici endpoint che possono ricevere un numero di telefono. */
const PHONE_PATHS = new Set(['/phone-number/send-otp', '/phone-number/verify']);
const PHONE_FIELDS = ['phoneNumber', 'phoneNumberVerified'] as const;

/**
 * Endpoint che impostano l'email di un account: il dominio riservato agli account creati col
 * telefono non si può usare. Altrimenti chiunque potrebbe registrare con email e password
 * l'indirizzo provvisorio del numero di un altro (es. 393331234567@telefono.solcomusic.invalid) e
 * impedirgli per sempre di creare l'account col telefono (l'email è unica nel database).
 */
const EMAIL_FIELD_BY_PATH: Record<string, 'email' | 'newEmail'> = {
  '/sign-up/email': 'email',
  '/change-email': 'newEmail',
  '/admin/create-user': 'email',
  // Nessun link di verifica verso l'email provvisoria di un account col telefono.
  '/send-verification-email': 'email',
};

const NOT_FOUND: GuardRejection = { status: 'NOT_FOUND', message: 'Not found' };
const PHONE_DISABLED: GuardRejection = {
  status: 'NOT_FOUND',
  message: 'L’accesso col telefono non è disponibile.',
};
const INVALID_PHONE: GuardRejection = {
  status: 'BAD_REQUEST',
  message: 'Numero non valido: usa il formato internazionale, es. +39 333 123 4567.',
};
const PHONE_FIELD_NOT_ALLOWED: GuardRejection = {
  status: 'BAD_REQUEST',
  message: 'Il numero di telefono si collega solo confermandolo con il codice SMS.',
  code: 'PHONE_NUMBER_NOT_ALLOWED',
};
const RESERVED_EMAIL: GuardRejection = {
  status: 'BAD_REQUEST',
  message: 'Questo indirizzo email non si può usare.',
};
export const SMS_NOT_SENT: GuardRejection = {
  status: 'BAD_GATEWAY',
  message:
    'Non è stato possibile inviare l’SMS a questo numero. Controlla che sia un cellulare con il prefisso giusto, oppure riprova più tardi.',
  code: 'SMS_NOT_SENT',
};

function rejection(decision: RateLimitDecision): GuardRejection | null {
  if (decision.allowed) return null;
  return {
    status: decision.status === 429 ? 'TOO_MANY_REQUESTS' : 'SERVICE_UNAVAILABLE',
    message: decision.message,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Il corpo (o il suo `data`, come in /admin/update-user) prova a impostare il telefono? */
function carriesPhoneField(body: unknown): boolean {
  const record = asRecord(body);
  if (!record) return false;
  const nested = asRecord(record.data);
  return PHONE_FIELDS.some((field) => field in record || (nested !== null && field in nested));
}

function phoneFrom(body: unknown): string | null {
  const value = asRecord(body)?.phoneNumber;
  return typeof value === 'string' ? value : null;
}

/**
 * Identità di rete per i limiti anonimi. Un IPv6 diventa il suo /64: un solo cliente ne riceve di
 * solito un intero blocco e potrebbe cambiare indirizzo a ogni richiesta per avere sempre un
 * contatore nuovo. Un IPv4 mappato (::ffff:1.2.3.4) torna IPv4.
 */
export function networkIdentity(headers: Headers | null | undefined): string | null {
  const identity = getRateLimitIdentity(null, headers ?? new Headers());
  if (!identity?.startsWith('ip:')) return identity;
  const address = identity.slice(3).split('%')[0] ?? '';
  if (isIP(address) !== 6) return identity;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) return `ip:${mapped[1]}`;
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  // Un IPv4 in coda (es. 64:ff9b::1.2.3.4) occupa due gruppi, comunque oltre il /64 se compresso.
  const rightGroups = right.reduce((count, part) => count + (part.includes('.') ? 2 : 1), 0);
  const groups =
    halves.length > 1
      ? [...left, ...Array(8 - left.length - rightGroups).fill('0'), ...right]
      : left;
  const prefix = groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':');
  return `ip6:${prefix}::/64`;
}

/**
 * null = la richiesta prosegue; altrimenti l'errore da restituire. Per /phone-number/send-otp,
 * superati i controlli, avvia anche l'invio dell'SMS (il plugin poi non invia nulla).
 */
export async function guardAuthRequest(
  input: { path: string; body: unknown; headers?: Headers | null },
  deps: Deps = defaultDeps,
): Promise<GuardRejection | null> {
  const { path, body } = input;
  if (BLOCKED_AUTH_PATHS.has(path)) return NOT_FOUND;
  if (!PHONE_PATHS.has(path) && carriesPhoneField(body)) return PHONE_FIELD_NOT_ALLOWED;

  const emailField = EMAIL_FIELD_BY_PATH[path];
  if (emailField) {
    const value = asRecord(body)?.[emailField];
    if (typeof value === 'string' && isPhoneAccountEmail(value.trim().toLowerCase())) {
      return RESERVED_EMAIL;
    }
    return null;
  }

  if (path === '/request-password-reset') {
    return rejection(await deps.consume('auth.reset_request.ip', networkIdentity(input.headers)));
  }

  if (!PHONE_PATHS.has(path)) return null;

  // Da qui: endpoint del telefono.
  if (!deps.phoneConfigured()) return PHONE_DISABLED;
  const phone = phoneFrom(body);
  if (!phone || !isValidE164(phone)) return INVALID_PHONE;
  const network = networkIdentity(input.headers);

  if (path === '/phone-number/verify') {
    // Solo login/registrazione: collegare un numero all'account in sessione non è previsto (ora).
    if (asRecord(body)?.updatePhoneNumber === true) return NOT_FOUND;
    return rejection(await deps.consume('auth.phone_verify.ip', network));
  }

  // '/phone-number/send-otp': prima la rete, poi il numero, poi il tetto dell'app. Chi è già
  // bloccato non consuma le quote successive. Poi l'SMS, aspettando l'esito.
  const byNetwork = rejection(await deps.consume('auth.phone_otp.ip', network));
  if (byNetwork) return byNetwork;
  const byPhone = rejection(await deps.consume('auth.phone_otp', `phone:${phone}`));
  if (byPhone) return byPhone;
  // Il tetto dell'app vale solo per i numeri nuovi: chi ha già un account col telefono (e non ha
  // altro modo di entrare) non resta chiuso fuori se qualcuno lo esaurisce con numeri inventati.
  if (!(await deps.isKnownPhone(phone))) {
    const global = rejection(await deps.consume('auth.phone_otp.global', 'global'));
    if (global) return global;
  }
  return (await deps.sendSms(phone)) ? null : SMS_NOT_SENT;
}
