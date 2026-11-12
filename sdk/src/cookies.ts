// @solco/sdk — gestione minima dei cookie di sessione per ambienti non-browser.
//
// Nel browser i cookie li gestisce il browser (`credentials: 'include'`), quindi
// questo barattolo serve solo lato server (Node, Bun, Deno). È volutamente
// semplice: Solco serve l'SDK da una sola origine, perciò i cookie sono tenuti
// per nome, senza logica di dominio/percorso. Basta per conservare la sessione
// better-auth fra una richiesta e l'altra.

export interface StoredCookie {
  value: string;
  /** Epoch ms di scadenza, o null se cookie di sessione. */
  expiresAt: number | null;
}

/** Barattolo di cookie in memoria. Iniettabile e serializzabile. */
export class CookieJar {
  private readonly jar = new Map<string, StoredCookie>();

  constructor(initial?: Record<string, string>) {
    if (initial) {
      for (const [name, value] of Object.entries(initial)) {
        this.jar.set(name, { value, expiresAt: null });
      }
    }
  }

  /** Valore dell'header `Cookie` per la prossima richiesta, o `null` se vuoto. */
  header(now: number = Date.now()): string | null {
    const parts: string[] = [];
    for (const [name, cookie] of this.jar) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.jar.delete(name);
        continue;
      }
      parts.push(`${name}=${cookie.value}`);
    }
    return parts.length > 0 ? parts.join('; ') : null;
  }

  /** Applica una singola riga `Set-Cookie`. Una direttiva di scadenza passata cancella il cookie. */
  applySetCookie(line: string, now: number = Date.now()): void {
    const segments = line.split(';');
    const first = segments[0];
    if (!first) return;
    const eq = first.indexOf('=');
    if (eq <= 0) return;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) return;

    let expiresAt: number | null = null;
    let expired = false;
    for (let i = 1; i < segments.length; i++) {
      const attr = segments[i];
      if (!attr) continue;
      const [rawKey, ...rest] = attr.split('=');
      const key = (rawKey ?? '').trim().toLowerCase();
      const attrValue = rest.join('=').trim();
      if (key === 'max-age') {
        const seconds = Number(attrValue);
        if (Number.isFinite(seconds)) {
          if (seconds <= 0) expired = true;
          else expiresAt = now + seconds * 1000;
        }
      } else if (key === 'expires') {
        const when = Date.parse(attrValue);
        if (!Number.isNaN(when)) {
          if (when <= now) expired = true;
          else expiresAt = when;
        }
      }
    }

    if (expired || value === '') {
      this.jar.delete(name);
      return;
    }
    this.jar.set(name, { value, expiresAt });
  }

  /**
   * Assorbe tutti i `Set-Cookie` di una Response. Usa `Headers.getSetCookie()`
   * (undici/Node 18.14+) quando disponibile, altrimenti l'header singolo.
   */
  absorb(headers: Headers, now: number = Date.now()): void {
    const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
    const lines =
      typeof withGetSetCookie.getSetCookie === 'function'
        ? withGetSetCookie.getSetCookie()
        : splitSingleSetCookie(headers.get('set-cookie'));
    for (const line of lines) this.applySetCookie(line, now);
  }

  /** Cookie correnti come oggetto semplice (per serializzare/ispezionare). */
  toJSON(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, cookie] of this.jar) out[name] = cookie.value;
    return out;
  }

  /** Svuota il barattolo (es. dopo il logout). */
  clear(): void {
    this.jar.clear();
  }
}

/**
 * Divide un header `Set-Cookie` concatenato in righe. Evita di spezzare sulle
 * virgole interne alla direttiva `Expires` (che contiene ", DD Mon YYYY").
 */
function splitSingleSetCookie(value: string | null): string[] {
  if (!value) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== ',') continue;
    const rest = value.slice(i + 1);
    // Una nuova coppia cookie inizia con "token=" prima del prossimo ';'.
    if (/^\s*[^=;,\s]+=/.test(rest)) {
      lines.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) lines.push(tail);
  return lines;
}
