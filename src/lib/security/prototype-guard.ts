// @polsia:user-owned — difese contro il "prototype pollution".
// Due livelli:
//  1) Sanificazione dell'input: si rimuovono le chiavi pericolose (__proto__, constructor, prototype)
//     dai dati JSON non fidati, così un payload malevolo non può inquinare Object.prototype quando
//     i dati vengono fusi/assegnati a valle.
//  2) Congelamento dei prototype nativi (Object/Array/Function…): anche se un dato malevolo passasse,
//     scrivere su un prototype congelato fallisce (mitigazione raccomandata da OWASP).
// Nessun import 'server-only': è JS puro, usabile sia lato server sia (se serve) lato client.

/** Chiavi vietate nei dati JSON non fidati: sono i vettori classici del prototype pollution. */
export const POLLUTION_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copia profonda di un valore JSON SENZA le chiavi pericolose. Non muta l'originale. Gli oggetti
 * ricostruiti non ereditano chiavi inquinate (le voci __proto__/constructor/prototype vengono
 * semplicemente omesse). Gli array e i primitivi passano invariati (ricorsione sugli array).
 */
export function sanitizePrototypePollution<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePrototypePollution(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const clean: Record<string, unknown> = {};
    // getOwnPropertyNames vede anche un'eventuale chiave propria "__proto__" creata da JSON.parse;
    // le chiavi vietate non vengono mai lette né ricopiate.
    for (const key of Object.getOwnPropertyNames(value)) {
      if (POLLUTION_KEYS.includes(key)) continue;
      clean[key] = sanitizePrototypePollution((value as Record<string, unknown>)[key]);
    }
    return clean as unknown as T;
  }
  return value;
}

/**
 * JSON.parse che SCARTA le chiavi pericolose durante il parsing (il reviver, ricevendo la chiave
 * "__proto__"/"constructor"/"prototype", restituisce undefined → la proprietà non viene creata).
 * JSON.parse di per sé non inquina il prototype; qui si evita anche che quelle chiavi esistano.
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, val) => (POLLUTION_KEYS.includes(key) ? undefined : val));
}

/**
 * Target del rafforzamento: SOLO Object.prototype, il vero bersaglio del prototype pollution.
 * NB: NON si usa Object.freeze. Congelare Object.prototype rende non scrivibili toString/valueOf e
 * rompe librerie legittime che fanno `obj.toString = …` (es. Prisma: "Cannot assign to read only
 * property 'toString'"). Si usa invece Object.seal, che rende il prototype NON ESTENSIBILE: non si
 * possono AGGIUNGERE nuove proprietà (ed è così che il prototype pollution inietta chiavi arbitrarie
 * come "isAdmin"), mentre le proprietà esistenti restano scrivibili e il resto dell'app funziona.
 */
function defaultPrototypeTargets(): object[] {
  return [Object.prototype];
}

let hardened = false;

/**
 * Rende i prototype indicati (default: Object.prototype) NON ESTENSIBILI con Object.seal, così non
 * si possono più aggiungere proprietà: il prototype pollution a runtime viene neutralizzato senza
 * rompere il codice che assegna proprietà proprie agli oggetti. Idempotente e difensivo (ogni target
 * a sé; un errore su uno non blocca gli altri).
 */
export function hardenGlobalPrototypes(targets: object[] = defaultPrototypeTargets()): void {
  for (const target of targets) {
    try {
      if (target && !Object.isSealed(target)) Object.seal(target);
    } catch {
      // Target non sigillabile in questo ambiente: si prosegue con gli altri.
    }
  }
  hardened = true;
}

/** True se hardenGlobalPrototypes è già stato eseguito in questo processo. */
export function prototypesHardened(): boolean {
  return hardened;
}
