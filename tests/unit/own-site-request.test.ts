// @polsia:user-owned — «viene da Solco stesso?»: Sec-Fetch-Site decide quando basta; cross-site
// passa solo con Origin/Referer di Solco (web app iOS); origini proprie da env e dalla richiesta;
// riassunto per il log senza dati personali.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OWN_SITES,
  describeSiteHeaders,
  exactOrigin,
  isFromOwnSite,
  NAVIGATION_OWN_SITES,
  ownSiteEvidence,
  ownSiteOrigins,
} from '@/lib/security/own-site-request';

const OWN = new Set(['https://www.solcomusic.online', 'https://solcomusic.vercel.app']);
const h = (values: Record<string, string>) => new Headers(values);

describe('exactOrigin', () => {
  it('riduce URL e origini alla sola origine http(s)', () => {
    expect(exactOrigin('https://www.solcomusic.online/library?x=1#y')).toBe(
      'https://www.solcomusic.online',
    );
    expect(exactOrigin(' https://WWW.Solcomusic.online ')).toBe('https://www.solcomusic.online');
    expect(exactOrigin('http://localhost:3000/app')).toBe('http://localhost:3000');
  });

  it('rifiuta wildcard, credenziali, altri schemi, "null" e valori vuoti', () => {
    expect(exactOrigin('https://*.solcomusic.online')).toBeNull();
    expect(exactOrigin('https://user:pass@solcomusic.online')).toBeNull();
    expect(exactOrigin('javascript:alert(1)')).toBeNull();
    expect(exactOrigin('ftp://solcomusic.online')).toBeNull();
    expect(exactOrigin('null')).toBeNull();
    expect(exactOrigin('')).toBeNull();
    expect(exactOrigin(null)).toBeNull();
    expect(exactOrigin(undefined)).toBeNull();
    expect(exactOrigin(`https://${'a'.repeat(3000)}.example`)).toBeNull();
  });
});

describe('ownSiteOrigins', () => {
  it('unisce NEXT_PUBLIC_APP_URL, le origini esatte fidate e l’host della richiesta', () => {
    const request = new Request('https://internal.local/api/x', {
      headers: { 'x-forwarded-host': 'www.solcomusic.online', host: 'internal.local' },
    });
    const own = ownSiteOrigins(
      {
        NEXT_PUBLIC_APP_URL: 'https://www.solcomusic.online',
        BETTER_AUTH_TRUSTED_ORIGINS:
          'https://solcomusic.vercel.app, https://solcomusic.online ,https://*.evil.example,non-url',
      },
      request,
    );
    expect([...own].sort()).toEqual([
      'https://internal.local',
      'https://solcomusic.online',
      'https://solcomusic.vercel.app',
      'https://www.solcomusic.online',
    ]);
  });

  it('rispetta x-forwarded-proto http, ignora host malformati e funziona senza richiesta', () => {
    const request = new Request('http://localhost:3000/api/x', {
      headers: { host: 'localhost:3000', 'x-forwarded-proto': 'http' },
    });
    expect([...ownSiteOrigins({}, request)]).toEqual(['http://localhost:3000']);
    const bad = new Request('https://solco.test/api/x', {
      headers: { host: 'evil.example/..', 'x-forwarded-host': 'a b' },
    });
    expect([...ownSiteOrigins({}, bad)]).toEqual(['https://solco.test']);
    expect([...ownSiteOrigins({ NEXT_PUBLIC_APP_URL: 'https://solco.test/' })]).toEqual([
      'https://solco.test',
    ]);
    expect(ownSiteOrigins({}).size).toBe(0);
  });
});

describe('ownSiteEvidence / isFromOwnSite', () => {
  it('senza Fetch Metadata passa (decide la sessione); stesso sito passa', () => {
    expect(ownSiteEvidence(h({}), OWN)).toBe('no-metadata');
    for (const site of DEFAULT_OWN_SITES) {
      expect(ownSiteEvidence(h({ 'sec-fetch-site': site }), OWN)).toBe('fetch-metadata');
    }
    expect(ownSiteEvidence(h({ 'sec-fetch-site': ' Same-Origin ' }), OWN)).toBe('fetch-metadata');
  });

  it('cross-site passa solo con Origin o Referer di Solco (web app iOS)', () => {
    expect(
      ownSiteEvidence(
        h({ 'sec-fetch-site': 'cross-site', origin: 'https://www.solcomusic.online' }),
        OWN,
      ),
    ).toBe('origin');
    expect(
      ownSiteEvidence(
        h({ 'sec-fetch-site': 'cross-site', referer: 'https://www.solcomusic.online/search?q=a' }),
        OWN,
      ),
    ).toBe('referer');
    expect(
      ownSiteEvidence(
        h({ 'sec-fetch-site': 'cross-site', referer: 'https://solcomusic.vercel.app/' }),
        OWN,
      ),
    ).toBe('referer');
    // Hotlinking: Referer di un altro sito, nessun Referer, Origin "null" o un host simile.
    expect(
      ownSiteEvidence(
        h({ 'sec-fetch-site': 'cross-site', referer: 'https://altro.example/pagina' }),
        OWN,
      ),
    ).toBeNull();
    expect(ownSiteEvidence(h({ 'sec-fetch-site': 'cross-site' }), OWN)).toBeNull();
    expect(ownSiteEvidence(h({ 'sec-fetch-site': 'cross-site', origin: 'null' }), OWN)).toBeNull();
    expect(
      ownSiteEvidence(
        h({
          'sec-fetch-site': 'cross-site',
          referer: 'https://www.solcomusic.online.evil.example/',
        }),
        OWN,
      ),
    ).toBeNull();
    expect(
      ownSiteEvidence(
        h({
          'sec-fetch-site': 'cross-site',
          origin: 'https://evil.example',
          referer: 'https://www.solcomusic.online/',
        }),
        OWN,
      ),
    ).toBe('referer');
    expect(isFromOwnSite(h({ 'sec-fetch-site': 'cross-site' }), OWN)).toBe(false);
    expect(isFromOwnSite(h({ 'sec-fetch-site': 'same-origin' }), OWN)).toBe(true);
  });

  it('avvii OAuth: same-site non basta da solo, ma passa con Referer dell’origine esatta', () => {
    expect(ownSiteEvidence(h({ 'sec-fetch-site': 'same-site' }), OWN, NAVIGATION_OWN_SITES)).toBe(
      null,
    );
    expect(
      ownSiteEvidence(
        h({ 'sec-fetch-site': 'same-site', referer: 'https://status.solcomusic.online/' }),
        OWN,
        NAVIGATION_OWN_SITES,
      ),
    ).toBeNull();
    expect(
      ownSiteEvidence(
        h({ 'sec-fetch-site': 'same-site', referer: 'https://www.solcomusic.online/library' }),
        OWN,
        NAVIGATION_OWN_SITES,
      ),
    ).toBe('referer');
    expect(ownSiteEvidence(h({ 'sec-fetch-site': 'none' }), OWN, NAVIGATION_OWN_SITES)).toBe(
      'fetch-metadata',
    );
  });

  it('con nessuna origine propria, cross-site resta rifiutato', () => {
    expect(
      isFromOwnSite(
        h({ 'sec-fetch-site': 'cross-site', referer: 'https://www.solcomusic.online/' }),
        new Set(),
      ),
    ).toBe(false);
  });
});

describe('describeSiteHeaders', () => {
  it('riassume solo categorie: niente host, URL o testo del client', () => {
    const summary = describeSiteHeaders(
      h({
        'sec-fetch-site': 'cross-site',
        'sec-fetch-dest': 'audio',
        origin: 'https://evil.example',
        referer: 'https://www.solcomusic.online/search?q=segreto',
      }),
      OWN,
    );
    expect(summary).toBe('site=cross-site dest=audio origin=altro referer=proprio');
    expect(summary).not.toContain('evil');
    expect(summary).not.toContain('segreto');
  });

  it('valori assenti, non validi o inattesi diventano parole fisse', () => {
    expect(describeSiteHeaders(h({}), OWN)).toBe(
      'site=assente dest=assente origin=assente referer=assente',
    );
    expect(
      describeSiteHeaders(
        h({ 'sec-fetch-site': 'x<script>', 'sec-fetch-dest': 'Document', referer: 'non un url' }),
        OWN,
      ),
    ).toBe('site=altro dest=document origin=assente referer=non-valido');
  });
});
