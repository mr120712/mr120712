// @polsia:user-owned — «Skynet» contro le AI travestite da motori di ricerca. Il trucco più usato
// dagli scraper AI per saltare le verifiche è copiare lo User-Agent di Googlebot: lo UA lo scrive il
// client. Qui un client che si dichiara motore di ricerca (Googlebot, Bingbot, Applebot, YandexBot,
// Baiduspider) passa solo se il suo indirizzo appartiene davvero a quel motore: DNS inverso su un
// dominio ufficiale e DNS diretto che riporta allo stesso indirizzo, il metodo indicato da Google,
// Bing, Apple, Yandex e Baidu. Chi non supera la prova fa la verifica come tutti.
//
// Gira nel proxy (src/proxy.ts → uam-gate.ts, runtime Node.js). Fallisce chiuso: DNS lento o in
// errore = non verificato (Googlebot riprova; un attaccante non può sfruttare un DNS che non
// risponde). Risultati in memoria: 24 ore se confermato, 10 minuti se no, al massimo
// CACHE_LIMIT voci. Nessun indirizzo esce da qui: niente log, niente database.
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

export type SearchEngine = { name: string; userAgent: RegExp; domains: readonly string[] };

/** Motori di ricerca che si possono verificare via DNS (domini ufficiali dichiarati da loro). */
export const SEARCH_ENGINES: readonly SearchEngine[] = [
  {
    name: 'Google',
    userAgent:
      /googlebot|google-inspectiontool|google-site-verification|storebot-google|adsbot-google/i,
    domains: ['googlebot.com', 'google.com'],
  },
  { name: 'Bing', userAgent: /bingbot|bingpreview|msnbot|adidxbot/i, domains: ['search.msn.com'] },
  { name: 'Apple', userAgent: /applebot/i, domains: ['applebot.apple.com'] },
  { name: 'Yandex', userAgent: /yandexbot/i, domains: ['yandex.ru', 'yandex.net', 'yandex.com'] },
  { name: 'Baidu', userAgent: /baiduspider/i, domains: ['baidu.com', 'baidu.jp'] },
];

export const DNS_TIMEOUT_MS = 1_500;
export const VERIFIED_TTL_MS = 24 * 60 * 60 * 1000;
export const REJECTED_TTL_MS = 10 * 60 * 1000;
export const CACHE_LIMIT = 2_000;
const MAX_UA_LENGTH = 512;

export type CrawlerDns = {
  reverse: (ip: string) => Promise<string[]>;
  /** Tutti gli indirizzi (IPv4 e IPv6) di un nome. */
  lookup: (hostname: string) => Promise<string[]>;
  now: () => number;
};

const systemDns: CrawlerDns = {
  reverse: (ip) => dnsPromises.reverse(ip),
  lookup: async (hostname) =>
    (await dnsPromises.lookup(hostname, { all: true, verbatim: true })).map(
      (entry) => entry.address,
    ),
  now: () => Date.now(),
};

const cache = new Map<string, { verified: boolean; until: number }>();

/** Svuota la memoria dei risultati (per i test). */
export function resetCrawlerCache(): void {
  cache.clear();
}

/** Il motore di ricerca che lo User-Agent dichiara, se è uno di quelli verificabili. */
export function claimedSearchEngine(userAgent: string | null | undefined): SearchEngine | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, MAX_UA_LENGTH);
  return SEARCH_ENGINES.find((engine) => engine.userAgent.test(ua)) ?? null;
}

/** Forma canonica di un indirizzo (IPv6 compresso, minuscolo); null se non è un IP. */
export function canonicalIp(ip: string | null | undefined): string | null {
  const text = ip?.trim() ?? '';
  const version = isIP(text);
  if (version === 4) return text;
  if (version !== 6) return null;
  try {
    return new URL(`http://[${text}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('dns_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function onOfficialDomain(host: string, engine: SearchEngine): boolean {
  return engine.domains.some((domain) => host.endsWith(`.${domain}`));
}

async function confirm(ip: string, engine: SearchEngine, dns: CrawlerDns): Promise<boolean> {
  try {
    const names = await withTimeout(dns.reverse(ip), DNS_TIMEOUT_MS);
    for (const name of names.slice(0, 5)) {
      // Il DNS inverso può chiudere il nome con il punto finale: stessa forma per entrambe le prove.
      const host = name.toLowerCase().replace(/\.$/, '');
      if (!onOfficialDomain(host, engine)) continue;
      const addresses = await withTimeout(dns.lookup(host), DNS_TIMEOUT_MS);
      if (addresses.some((address) => canonicalIp(address) === ip)) return true;
    }
  } catch {
    // Nessun nome inverso, DNS in errore o lento: non verificato (fallisce chiuso).
  }
  return false;
}

/**
 * true solo per un vero motore di ricerca: lo User-Agent dichiara Google, Bing, Apple, Yandex o
 * Baidu E l'indirizzo (x-real-ip, scritto da Vercel) risolve a un loro dominio ufficiale che a sua
 * volta risolve allo stesso indirizzo.
 */
export async function verifySearchCrawler(
  ip: string | null | undefined,
  userAgent: string | null | undefined,
  dns: CrawlerDns = systemDns,
): Promise<boolean> {
  const engine = claimedSearchEngine(userAgent);
  const address = canonicalIp(ip);
  if (!engine || !address) return false;
  const key = `${engine.name}|${address}`;
  const now = dns.now();
  const cached = cache.get(key);
  if (cached && cached.until > now) return cached.verified;
  const verified = await confirm(address, engine, dns);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, { verified, until: now + (verified ? VERIFIED_TTL_MS : REJECTED_TTL_MS) });
  return verified;
}
