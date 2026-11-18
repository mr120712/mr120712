// @polsia:user-owned
// @vitest-environment node
//
// «Skynet» contro le AI travestite (src/lib/security/crawler-verify.ts): un client che si dichiara
// motore di ricerca passa solo se l'indirizzo risolve (DNS inverso) a un dominio ufficiale che
// risolve (DNS diretto) allo stesso indirizzo. DNS finto: nessuna rete nei test.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_LIMIT,
  type CrawlerDns,
  canonicalIp,
  claimedSearchEngine,
  DNS_TIMEOUT_MS,
  REJECTED_TTL_MS,
  resetCrawlerCache,
  VERIFIED_TTL_MS,
  verifySearchCrawler,
} from '@/lib/security/crawler-verify';

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BINGBOT = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
const APPLEBOT = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Applebot/0.1';
const GOOGLE_IP = '66.249.66.1';
const GOOGLE_HOST = 'crawl-66-249-66-1.googlebot.com';

/** DNS finto: tabelle inverse e dirette, con il conto delle domande. */
function fakeDns(
  reverse: Record<string, string[]>,
  forward: Record<string, string[]>,
  clock = { t: 1_000_000 },
): CrawlerDns & { calls: string[]; clock: { t: number } } {
  const calls: string[] = [];
  return {
    calls,
    clock,
    now: () => clock.t,
    reverse: async (ip) => {
      calls.push(`PTR ${ip}`);
      const names = reverse[ip];
      if (!names) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return names;
    },
    lookup: async (host) => {
      calls.push(`A ${host}`);
      return forward[host] ?? [];
    },
  };
}

beforeEach(() => {
  resetCrawlerCache();
});

describe('motori di ricerca dichiarati', () => {
  it('riconosce Google, Bing, Apple, Yandex e Baidu dallo User-Agent; nessun altro', () => {
    expect(claimedSearchEngine(GOOGLEBOT)?.name).toBe('Google');
    expect(
      claimedSearchEngine('Mozilla/5.0 (compatible; Google-Site-Verification/1.0)')?.name,
    ).toBe('Google');
    expect(claimedSearchEngine(BINGBOT)?.name).toBe('Bing');
    expect(claimedSearchEngine(APPLEBOT)?.name).toBe('Apple');
    expect(claimedSearchEngine('Mozilla/5.0 (compatible; YandexBot/3.0)')?.name).toBe('Yandex');
    expect(claimedSearchEngine('Mozilla/5.0 (compatible; Baiduspider/2.0)')?.name).toBe('Baidu');
    expect(claimedSearchEngine('Mozilla/5.0 (compatible; GPTBot/1.2)')).toBeNull();
    expect(claimedSearchEngine('WhatsApp/2.23.20.0 A')).toBeNull();
    expect(claimedSearchEngine(null)).toBeNull();
  });

  it('indirizzi in forma canonica; il resto non è un IP', () => {
    expect(canonicalIp(' 66.249.66.1 ')).toBe('66.249.66.1');
    expect(canonicalIp('2001:4860:4801:0010:0000:0000:0000:0001')).toBe('2001:4860:4801:10::1');
    expect(canonicalIp('googlebot.com')).toBeNull();
    expect(canonicalIp(null)).toBeNull();
  });
});

describe('verifica DNS', () => {
  it('vero Googlebot: DNS inverso su googlebot.com e diretto sullo stesso indirizzo', async () => {
    const dns = fakeDns({ [GOOGLE_IP]: [GOOGLE_HOST] }, { [GOOGLE_HOST]: [GOOGLE_IP] });
    expect(await verifySearchCrawler(GOOGLE_IP, GOOGLEBOT, dns)).toBe(true);
    expect(dns.calls).toEqual([`PTR ${GOOGLE_IP}`, `A ${GOOGLE_HOST}`]);
  });

  it('finto Googlebot: nessun nome inverso, dominio imitato o DNS diretto altrove', async () => {
    // Nessun nome inverso (lo scraper è su un server qualsiasi).
    expect(await verifySearchCrawler('203.0.113.9', GOOGLEBOT, fakeDns({}, {}))).toBe(false);
    resetCrawlerCache();
    // Nome scelto dall'attaccante che finisce come quello di Google, ma non è suo.
    const fake = 'crawl-1.googlebot.com.scraper.example';
    expect(
      await verifySearchCrawler(
        '203.0.113.9',
        GOOGLEBOT,
        fakeDns({ '203.0.113.9': [fake, 'googlebot.com'] }, { [fake]: ['203.0.113.9'] }),
      ),
    ).toBe(false);
    resetCrawlerCache();
    // Il nome inverso dice googlebot.com, ma il DNS diretto di Google non porta a questo indirizzo.
    expect(
      await verifySearchCrawler(
        '203.0.113.9',
        GOOGLEBOT,
        fakeDns({ '203.0.113.9': [GOOGLE_HOST] }, { [GOOGLE_HOST]: [GOOGLE_IP] }),
      ),
    ).toBe(false);
  });

  it('un dominio vero ma di un altro motore non basta (Googlebot da search.msn.com)', async () => {
    const host = 'msnbot-1.search.msn.com';
    const dns = fakeDns({ '40.77.167.1': [host] }, { [host]: ['40.77.167.1'] });
    expect(await verifySearchCrawler('40.77.167.1', GOOGLEBOT, dns)).toBe(false);
    resetCrawlerCache();
    expect(await verifySearchCrawler('40.77.167.1', BINGBOT, dns)).toBe(true);
  });

  it('IPv6: confronto sulla forma canonica', async () => {
    const ip = '2001:4860:4801:10::1';
    const host = 'crawl-2001-4860-4801-10--1.googlebot.com';
    const dns = fakeDns({ [ip]: [`${host}.`] }, { [host]: ['2001:4860:4801:0010::0001'] });
    expect(await verifySearchCrawler(ip, GOOGLEBOT, dns)).toBe(true);
  });

  it('DNS lento: non verificato (fallisce chiuso)', async () => {
    vi.useFakeTimers();
    try {
      const dns = fakeDns({}, {});
      dns.reverse = () => new Promise(() => {});
      const pending = verifySearchCrawler(GOOGLE_IP, GOOGLEBOT, dns);
      await vi.advanceTimersByTimeAsync(DNS_TIMEOUT_MS + 1);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('senza motore dichiarato o senza indirizzo valido: nessuna domanda al DNS', async () => {
    const dns = fakeDns({}, {});
    expect(await verifySearchCrawler(GOOGLE_IP, 'Mozilla/5.0 Safari/604.1', dns)).toBe(false);
    expect(await verifySearchCrawler('non-un-ip', GOOGLEBOT, dns)).toBe(false);
    expect(await verifySearchCrawler(null, GOOGLEBOT, dns)).toBe(false);
    expect(dns.calls).toEqual([]);
  });
});

describe('memoria dei risultati', () => {
  it('confermato: 24 ore senza ridomandare; respinto: 10 minuti', async () => {
    const dns = fakeDns({ [GOOGLE_IP]: [GOOGLE_HOST] }, { [GOOGLE_HOST]: [GOOGLE_IP] });
    expect(await verifySearchCrawler(GOOGLE_IP, GOOGLEBOT, dns)).toBe(true);
    dns.clock.t += VERIFIED_TTL_MS - 1;
    expect(await verifySearchCrawler(GOOGLE_IP, GOOGLEBOT, dns)).toBe(true);
    expect(dns.calls).toHaveLength(2);
    dns.clock.t += 2;
    await verifySearchCrawler(GOOGLE_IP, GOOGLEBOT, dns);
    expect(dns.calls).toHaveLength(4);

    const fake = fakeDns({}, {});
    expect(await verifySearchCrawler('203.0.113.9', GOOGLEBOT, fake)).toBe(false);
    fake.clock.t += REJECTED_TTL_MS - 1;
    expect(await verifySearchCrawler('203.0.113.9', GOOGLEBOT, fake)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    fake.clock.t += 2;
    await verifySearchCrawler('203.0.113.9', GOOGLEBOT, fake);
    expect(fake.calls).toHaveLength(2);
  });

  it(`al massimo ${CACHE_LIMIT} voci: le più vecchie escono`, async () => {
    const dns = fakeDns({}, {});
    for (let i = 0; i <= CACHE_LIMIT; i += 1) {
      await verifySearchCrawler(
        `10.${Math.floor(i / 65_536)}.${Math.floor(i / 256) % 256}.${i % 256}`,
        GOOGLEBOT,
        dns,
      );
    }
    dns.calls.length = 0;
    // La prima voce è uscita: si ridomanda.
    await verifySearchCrawler('10.0.0.0', GOOGLEBOT, dns);
    expect(dns.calls).toEqual(['PTR 10.0.0.0']);
  });
});
