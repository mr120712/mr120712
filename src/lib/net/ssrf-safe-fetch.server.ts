// @polsia:user-owned — fetch SSRF-safe con "DNS pinning".
//
// Il problema che risolve: un controllo che risolve l'host e poi lascia che `fetch`
// lo RI-risolva è aggirabile (DNS rebinding / TOCTOU): fra il controllo e la
// connessione l'host può rispondere con un indirizzo interno. Qui la risoluzione
// DNS e la connessione usano LO STESSO indirizzo, perché la validazione avviene
// dentro il `lookup` che Node usa per aprire la connessione: non c'è una seconda
// risoluzione da ingannare.
//
// Si usa come `fetcher` nelle rotte che scaricano o sondano URL non del tutto
// fidati (enclosure dei podcast, feed RSS, probe audio). Garanzie: solo HTTPS,
// solo porta 443, nessun indirizzo privato/non instradabile (IPv4, IPv6 e
// IPv4-mapped), nessun reindirizzamento automatico (il chiamante li segue con
// redirect:'manual', ri-validando ogni salto). Il certificato TLS resta validato
// sul nome host (SNI), non sull'IP.
import 'server-only';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

/**
 * `true` se l'indirizzo IP non è instradabile pubblicamente: loopback, reti private
 * (RFC1918), CGNAT, link-local, multicast, e le forme IPv6 equivalenti (comprese le
 * IPv4-mapped come `::ffff:10.0.0.1`). Un valore che non è un IP valido è trattato
 * come non sicuro (true), così non può mai passare.
 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) o IPv4-compatible (::a.b.c.d): estrai e ricontrolla.
    const embedded = /^(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
    if (embedded?.[1]) return isPrivateAddress(embedded[1]);
    return (
      lower === '::1' || // loopback
      lower === '::' || // unspecified
      lower.startsWith('fc') || // unique local fc00::/7
      lower.startsWith('fd') ||
      lower.startsWith('fe8') || // link-local fe80::/10 (fe80–febf)
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('ff') // multicast ff00::/8
    );
  }
  if (kind !== 4) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 || // "this" network 0.0.0.0/8
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local 169.254.0.0/16
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 192 && b === 0) || // 192.0.0.0/24 (IETF protocol assignments)
    a >= 224 // multicast 224.0.0.0/4 + riservati 240.0.0.0/4 + broadcast
  );
}

/** Rifiuta gli indirizzi se vuoti o se anche solo uno è privato. Puro, testabile. */
export function hasOnlyPublicAddresses(addresses: readonly string[]): boolean {
  return addresses.length > 0 && !addresses.some(isPrivateAddress);
}

/**
 * Controlli di forma dell'URL, indipendenti dal DNS: solo HTTPS, nessuna credenziale,
 * host non locale/interno, porta vuota o 443. Lancia su violazione, altrimenti torna l'URL.
 */
export function assertSafeHttpsUrl(raw: string | URL): URL {
  const url = typeof raw === 'string' ? new URL(raw) : raw;
  if (url.protocol !== 'https:') throw new Error('must use https');
  if (url.username || url.password) throw new Error('credentials not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('private host');
  }
  if (url.port && url.port !== '443') throw new Error('port not allowed');
  return url;
}

/**
 * Il `lookup` che Node usa per aprire la connessione: risolve e RIFIUTA se un
 * indirizzo è privato. Essendo la stessa risoluzione usata per connettersi, non
 * esiste una finestra TOCTOU (DNS rebinding) fra controllo e connessione.
 */
const ssrfLookup = ((hostname: string, options: { all?: boolean }, callback: unknown) => {
  const cb = callback as (
    err: NodeJS.ErrnoException | null,
    address?: string | LookupAddress[],
    family?: number,
  ) => void;
  const literal = isIP(hostname);
  if (literal) {
    if (isPrivateAddress(hostname)) {
      cb(new Error('blocked private address'));
      return;
    }
    if (options.all) cb(null, [{ address: hostname, family: literal }]);
    else cb(null, hostname, literal);
    return;
  }
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      cb(err);
      return;
    }
    const list = addresses as LookupAddress[];
    if (!hasOnlyPublicAddresses(list.map((entry) => entry.address))) {
      cb(new Error('blocked private address'));
      return;
    }
    if (options.all) {
      cb(null, list);
      return;
    }
    const first = list[0];
    if (!first) {
      cb(new Error('blocked private address'));
      return;
    }
    cb(null, first.address, first.family);
  });
}) as unknown as LookupFunction;

function toHeaderRecord(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = new Headers(init);
  headers.forEach((value, key) => {
    // `host` lo imposta Node dall'URL; non lasciarlo sovrascrivere.
    if (key.toLowerCase() !== 'host') out[key] = value;
  });
  return out;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * `fetch` compatibile che connette SOLO a indirizzi pubblici, pinnando la
 * risoluzione DNS alla connessione. NON segue i reindirizzamenti (il chiamante usa
 * redirect:'manual' e ri-valida ogni salto). Pensato per GET; un corpo stringa è
 * supportato per completezza.
 */
export const ssrfSafeFetch = ((input: string | URL | Request, init?: RequestInit) => {
  return new Promise<Response>((resolve, reject) => {
    let url: URL;
    try {
      const target = input instanceof Request ? input.url : input;
      url = assertSafeHttpsUrl(target);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('invalid url'));
      return;
    }

    const options: RequestOptions = {
      protocol: 'https:',
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: toHeaderRecord(init?.headers),
      servername: url.hostname,
      lookup: ssrfLookup,
    };
    if (init?.signal) options.signal = init.signal;

    const req = httpsRequest(options, (res) => {
      const status = res.statusCode ?? 502;
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else if (value != null) headers.set(key, value);
      }
      if (NULL_BODY_STATUS.has(status)) {
        res.resume();
        resolve(new Response(null, { status, headers }));
        return;
      }
      const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, headers }));
    });

    req.on('error', (error) => reject(error));

    const body = init?.body;
    if (typeof body === 'string') req.end(body);
    else req.end();
  });
}) as typeof fetch;
