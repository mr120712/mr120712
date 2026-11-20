// @polsia:user-owned — gate di collegamento account Solco ↔ bot Telegram. L'utente loggato ottiene
// un CODICE monouso, casuale e a breve scadenza, salvato su DB e legato al suo userId; il bot lo
// riceve via deep-link (t.me/<bot>?start=<code>) e, verificandolo, sa quale utente collegare.
// Sicurezza del gate:
//   • imprevedibile: 24 byte casuali (192 bit) in base64url → 32 caratteri;
//   • compatibile con Telegram: charset A-Za-z0-9_- e ≤64 caratteri (il limite del parametro ?start=);
//   • monouso: il consumo È la cancellazione della riga (un replay non trova nulla);
//   • a scadenza breve: 15 minuti per aprire il bot e premere Start;
//   • legato lato server all'esatto userId: il client non può scegliere chi collegare;
//   • un solo codice attivo per utente: ogni nuovo codice invalida i precedenti.
import 'server-only';
import { randomBytes } from 'node:crypto';

/** Validità del codice di collegamento (il tempo per aprire il bot e premere Start). */
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;

// 24 byte → 32 caratteri base64url: imprevedibile e ben dentro il limite di 64 di Telegram.
const CODE_BYTES = 24;
// Il bot accetta solo codici di questa forma prima di toccare il DB (guardia a buon mercato).
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Superficie minima di Prisma che serve al gate: tenerla stretta rende il modulo testabile. */
export interface LinkChallengeStore {
  telegramLinkChallenge: {
    deleteMany(args: { where: { userId: string } }): Promise<unknown>;
    create(args: { data: { code: string; userId: string; expiresAt: Date } }): Promise<unknown>;
    delete(args: { where: { code: string } }): Promise<{ userId: string; expiresAt: Date }>;
  };
}

/** Un codice casuale url-safe (A-Za-z0-9_-), 32 caratteri. */
export function generateTelegramLinkCode(): string {
  return randomBytes(CODE_BYTES).toString('base64url');
}

/** Forma accettabile per un codice ricevuto dal bot (prima di interrogare il DB). */
export function isValidTelegramLinkCode(code: string): boolean {
  return CODE_RE.test(code);
}

/**
 * Crea una sfida monouso per `userId`: invalida gli eventuali codici pendenti dello stesso utente e
 * ne salva uno nuovo con scadenza. Ritorna il codice da mettere nel deep-link.
 */
export async function createTelegramLinkChallenge(
  db: LinkChallengeStore,
  userId: string,
  now: number = Date.now(),
): Promise<string> {
  const code = generateTelegramLinkCode();
  // Un solo codice attivo per utente: libera i precedenti prima di crearne uno nuovo.
  await db.telegramLinkChallenge.deleteMany({ where: { userId } });
  await db.telegramLinkChallenge.create({
    data: { code, userId, expiresAt: new Date(now + LINK_CODE_TTL_MS) },
  });
  return code;
}

/**
 * Consuma il codice ricevuto dal bot e ritorna lo userId da collegare, oppure null se è malformato,
 * inesistente (già usato), o scaduto. Monouso: la cancellazione È il consumo, quindi un replay dello
 * stesso codice non collega nulla. Non lancia mai.
 */
export async function consumeTelegramLinkChallenge(
  db: LinkChallengeStore,
  code: string,
  now: number = Date.now(),
): Promise<string | null> {
  if (!isValidTelegramLinkCode(code)) return null;
  let row: { userId: string; expiresAt: Date };
  try {
    // delete su un campo @unique: atomico. Se il codice non esiste (già consumato), lancia → null.
    row = await db.telegramLinkChallenge.delete({ where: { code } });
  } catch {
    return null;
  }
  if (!row || row.expiresAt.getTime() < now) return null;
  return row.userId;
}
