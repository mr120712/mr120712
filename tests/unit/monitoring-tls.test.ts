// @polsia:user-owned — controllo «Crittografia HTTPS» del monitoraggio esterno
// (scripts/monitor/check-site.ts): valutazione di protocollo, cifratura, chiave e scadenza del
// certificato, rifiuto di TLS 1.0/1.1, record CAA; strette di mano finte, più una prova vera contro un
// server TLS locale con un certificato generato al momento (saltata se manca openssl).
// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CaaRecord,
  checkTls,
  cipherLabel,
  createDeps,
  evaluateTls,
  lookupCaa,
  probeTls,
  TLS_FAIL_DAYS,
  TLS_WARN_DAYS,
  type TlsInspection,
  type TlsProbeRequest,
  type TlsProbeResult,
} from '../../scripts/monitor/check-site';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function handshake(overrides: Partial<Extract<TlsProbeResult, { ok: true }>> = {}): TlsProbeResult {
  return {
    ok: true,
    protocol: 'TLSv1.3',
    cipher: 'TLS_AES_256_GCM_SHA384',
    group: 'X25519',
    authorized: true,
    authorizationError: null,
    certificate: {
      keyType: 'EC',
      keyBits: 256,
      curve: 'P-256',
      issuer: "Let's Encrypt E6",
      validTo: new Date(NOW.getTime() + 74 * DAY + 3600_000).toISOString(),
    },
    ...overrides,
  };
}

const rejected: TlsProbeResult = { ok: false, code: 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION' };
const refusedCipher: TlsProbeResult = { ok: false, code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' };

function inspection(overrides: Partial<TlsInspection> = {}): TlsInspection {
  return {
    main: handshake(),
    tls12: handshake({ protocol: 'TLSv1.2', cipher: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256' }),
    tls11: rejected,
    tls10: rejected,
    aes256: handshake(),
    chacha: handshake({ cipher: 'TLS_CHACHA20_POLY1305_SHA256' }),
    cbc: refusedCipher,
    noForwardSecrecy: refusedCipher,
    caa: [],
    ...overrides,
  };
}

describe('evaluateTls', () => {
  it('TLS moderno: tutto in ordine, con i fatti che servono per rispondere', () => {
    const outcome = evaluateTls(inspection(), NOW);
    expect(outcome.status).toBe('ok');
    expect(outcome.detail).toBe(
      "TLS 1.3, AES-256-GCM, scambio X25519; certificato ECDSA P-256 di Let's Encrypt E6, " +
        'scade tra 74 gg; TLS 1.0/1.1 rifiutati; TLS 1.3 offre AES-256 e ChaCha20; anche TLS 1.2; ' +
        'nessun record CAA',
    );
  });

  it('una chiave RSA da 2048 bit va bene, una da 1024 no', () => {
    const rsa = (bits: number) =>
      inspection({
        main: handshake({
          certificate: {
            keyType: 'RSA',
            keyBits: bits,
            curve: null,
            issuer: "Let's Encrypt R11",
            validTo: new Date(NOW.getTime() + 60 * DAY).toISOString(),
          },
        }),
      });
    expect(evaluateTls(rsa(2048), NOW)).toMatchObject({ status: 'ok' });
    expect(evaluateTls(rsa(2048), NOW).detail).toContain(
      "certificato RSA 2048 bit di Let's Encrypt R11",
    );
    const weak = evaluateTls(rsa(1024), NOW);
    expect(weak.status).toBe('fail');
    expect(weak.detail).toMatch(/^chiave RSA debole \(1024 bit\)/);
  });

  it('scadenza: avviso sotto i 21 giorni, errore critico sotto i 7, scaduto', () => {
    const expiring = (days: number) =>
      inspection({
        main: handshake({
          certificate: {
            keyType: 'EC',
            keyBits: 256,
            curve: 'P-256',
            issuer: "Let's Encrypt E6",
            validTo: new Date(NOW.getTime() + days * DAY + 60_000).toISOString(),
          },
        }),
      });
    expect(evaluateTls(expiring(TLS_WARN_DAYS), NOW).status).toBe('ok');
    const soon = evaluateTls(expiring(TLS_WARN_DAYS - 6), NOW);
    expect(soon).toMatchObject({ status: 'warn' });
    expect(soon.detail).toMatch(
      /^certificato in scadenza tra 15 giorni \(rinnovo automatico in ritardo\)/,
    );
    const urgent = evaluateTls(expiring(TLS_FAIL_DAYS - 2), NOW);
    expect(urgent).toMatchObject({ status: 'fail', critical: true });
    expect(urgent.detail).toMatch(/^certificato in scadenza tra 5 giorni/);
    expect(evaluateTls(expiring(-3), NOW).detail).toMatch(/^certificato scaduto/);
  });

  it('certificato non valido per il sito: errore critico', () => {
    const outcome = evaluateTls(
      inspection({
        main: handshake({ authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
      }),
      NOW,
    );
    expect(outcome).toMatchObject({ status: 'fail', critical: true });
    expect(outcome.detail).toMatch(/^certificato non valido \(ERR_TLS_CERT_ALTNAME_INVALID\)/);
  });

  it('TLS 1.0 o 1.1 ancora accettati: avviso, non errore (Vercel non si configura)', () => {
    const outcome = evaluateTls(inspection({ tls10: handshake({ protocol: 'TLSv1' }) }), NOW);
    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toMatch(/^accetta ancora TLS 1\.0 \|/);
  });

  it('un limite del nostro client non è un verdetto sul server', () => {
    const outcome = evaluateTls(
      inspection({ tls10: { ok: false, code: 'ERR_SSL_NO_PROTOCOLS_AVAILABLE' } }),
      NOW,
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.detail).toContain('TLS 1.0/1.1 non verificabili');
  });

  it('protocollo vecchio negoziato, cifratura non AEAD, CBC e scambio senza PFS', () => {
    const old = evaluateTls(
      inspection({ main: handshake({ protocol: 'TLSv1.1', cipher: 'ECDHE-RSA-AES128-SHA' }) }),
      NOW,
    );
    expect(old.status).toBe('fail');
    expect(old.detail).toMatch(/^protocollo debole \(TLS 1\.1\); cifratura non AEAD \(AES-128\)/);
    const legacySuites = evaluateTls(
      inspection({ cbc: handshake({ protocol: 'TLSv1.2' }), noForwardSecrecy: handshake() }),
      NOW,
    );
    expect(legacySuites.status).toBe('ok');
    expect(legacySuites.detail).toContain('accetta CBC per vecchi client');
    expect(legacySuites.detail).toContain('accetta scambio RSA senza PFS');
  });

  it('CAA: elencati quando ci sono, «non letto» quando il DNS non risponde', () => {
    expect(evaluateTls(inspection({ caa: ['issue letsencrypt.org'] }), NOW).detail).toContain(
      'CAA: issue letsencrypt.org',
    );
    expect(evaluateTls(inspection({ caa: null }), NOW).detail).toContain('CAA non letto');
  });

  it('stretta di mano fallita: errore', () => {
    expect(evaluateTls(inspection({ main: { ok: false, code: 'ECONNRESET' } }), NOW)).toEqual({
      status: 'fail',
      detail: 'Connessione HTTPS non riuscita (ECONNRESET)',
    });
  });
});

describe('cipherLabel', () => {
  it('nomi brevi delle cifrature', () => {
    expect(cipherLabel('TLS_AES_256_GCM_SHA384')).toBe('AES-256-GCM');
    expect(cipherLabel('TLS_AES_128_GCM_SHA256')).toBe('AES-128-GCM');
    expect(cipherLabel('TLS_CHACHA20_POLY1305_SHA256')).toBe('ChaCha20-Poly1305');
    expect(cipherLabel('TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384')).toBe('AES-256-GCM');
    expect(cipherLabel('ECDHE-RSA-AES128-SHA')).toBe('AES-128');
    expect(cipherLabel(null)).toBe('cifratura sconosciuta');
  });
});

describe('checkTls', () => {
  it('prova le versioni e le suite giuste sull’host del sito, poi legge i CAA', async () => {
    const requests: TlsProbeRequest[] = [];
    const caaLookups: string[] = [];
    const deps = createDeps('https://www.solcomusic.online', {
      now: () => NOW,
      tlsProbe: async (request) => {
        requests.push(request);
        if (request.maxVersion === 'TLSv1' || request.maxVersion === 'TLSv1.1') return rejected;
        if (request.ciphers && !request.ciphers.startsWith('TLS_')) return refusedCipher;
        return handshake();
      },
      resolveCaa: async (name) => {
        caaLookups.push(name);
        return name === 'solcomusic.online'
          ? [{ critical: 0, issue: 'letsencrypt.org' } satisfies CaaRecord]
          : [];
      },
    });
    const outcome = await checkTls(deps);
    expect(outcome.status).toBe('ok');
    expect(outcome.detail).toContain('CAA: issue letsencrypt.org');
    expect(requests.every((r) => r.host === 'www.solcomusic.online' && r.port === 443)).toBe(true);
    expect(requests.map(({ host: _h, port: _p, ...rest }) => rest)).toEqual([
      {},
      { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' },
      { minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT:@SECLEVEL=0' },
      { minVersion: 'TLSv1', maxVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' },
      { minVersion: 'TLSv1.3', ciphers: 'TLS_AES_256_GCM_SHA384' },
      { minVersion: 'TLSv1.3', ciphers: 'TLS_CHACHA20_POLY1305_SHA256' },
      {
        maxVersion: 'TLSv1.2',
        ciphers:
          'ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA',
      },
      {
        maxVersion: 'TLSv1.2',
        ciphers: 'AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
      },
    ]);
    // Il nome stesso, poi il dominio: lì ci sono i record.
    expect(caaLookups).toEqual(['www.solcomusic.online', 'solcomusic.online']);
  });

  it('se la prima stretta di mano fallisce non prova il resto', async () => {
    let count = 0;
    const deps = createDeps('https://www.solcomusic.online', {
      tlsProbe: async () => {
        count += 1;
        return { ok: false, code: 'ECONNREFUSED' };
      },
      resolveCaa: async () => [],
    });
    expect(await checkTls(deps)).toEqual({
      status: 'fail',
      detail: 'Connessione HTTPS non riuscita (ECONNREFUSED)',
    });
    expect(count).toBe(1);
  });

  it('un sito in http non viene verificato in TLS: avviso', async () => {
    const deps = createDeps('http://localhost:3000', { tlsProbe: async () => handshake() });
    expect((await checkTls(deps)).status).toBe('warn');
  });
});

describe('lookupCaa', () => {
  it('nessun record a nessun livello: elenco vuoto; DNS in errore: null', async () => {
    expect(await lookupCaa({ resolveCaa: async () => [] }, 'www.solcomusic.online')).toEqual([]);
    expect(
      await lookupCaa(
        {
          resolveCaa: async () => {
            throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
          },
        },
        'www.solcomusic.online',
      ),
    ).toBeNull();
  });

  it('i record del nome stesso hanno la precedenza sul dominio', async () => {
    const seen: string[] = [];
    const caa = await lookupCaa(
      {
        resolveCaa: async (name) => {
          seen.push(name);
          return [
            { critical: 0, issue: 'letsencrypt.org' },
            { critical: 0, issuewild: '' },
            { critical: 0, iodef: 'mailto:security@example.com' },
          ];
        },
      },
      'www.solcomusic.online',
    );
    expect(caa).toEqual(['issue letsencrypt.org', 'issuewild ;', 'iodef']);
    expect(seen).toEqual(['www.solcomusic.online']);
  });
});

// ---------- Stretta di mano vera contro un server TLS locale ----------

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasOpenssl())('probeTls (server locale)', () => {
  let dir: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'solco-tls-'));
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '30',
        '-subj',
        '/O=Solco Test/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
    server = createServer({
      key: readFileSync(key),
      cert: readFileSync(cert),
      minVersion: 'TLSv1.2',
    });
    server.on('secureConnection', (socket) => socket.end());
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('legge protocollo, cifratura, chiave EC P-256, emittente e scadenza', async () => {
    const result = await probeTls({ host: '127.0.0.1', port });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.protocol).toBe('TLSv1.3');
    expect(result.cipher).toMatch(/^TLS_(AES_256_GCM|CHACHA20_POLY1305|AES_128_GCM)_SHA\d+$/);
    // Autofirmato e senza il nome «127.0.0.1»: letto, non accettato.
    expect(result.authorized).toBe(false);
    expect(result.authorizationError).toMatch(/^[A-Z_]+$/);
    expect(result.certificate).toMatchObject({
      keyType: 'EC',
      keyBits: 256,
      curve: 'P-256',
      issuer: 'Solco Test localhost',
    });
    const days = (Date.parse(result.certificate?.validTo ?? '') - Date.now()) / DAY;
    expect(days).toBeGreaterThan(28);
    expect(days).toBeLessThanOrEqual(30);
  });

  it('il server che parte da TLS 1.2 rifiuta TLS 1.0, e il rifiuto non è «non verificabile»', async () => {
    const result = await probeTls({
      host: '127.0.0.1',
      port,
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1',
      ciphers: 'DEFAULT:@SECLEVEL=0',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).not.toBe('ERR_SSL_NO_PROTOCOLS_AVAILABLE');
    expect(result.code).toMatch(/^[A-Z0-9_]+$/);
  });

  it('TLS 1.2 forzato e suite AES-256 di TLS 1.3', async () => {
    const tls12 = await probeTls({ host: '127.0.0.1', port, maxVersion: 'TLSv1.2' });
    expect(tls12).toMatchObject({ ok: true, protocol: 'TLSv1.2' });
    const aes256 = await probeTls({
      host: '127.0.0.1',
      port,
      minVersion: 'TLSv1.3',
      ciphers: 'TLS_AES_256_GCM_SHA384',
    });
    expect(aes256).toMatchObject({
      ok: true,
      protocol: 'TLSv1.3',
      cipher: 'TLS_AES_256_GCM_SHA384',
    });
  });

  it('porta chiusa: errore con il codice di rete', async () => {
    const closed = await probeTls({ host: '127.0.0.1', port: 1 }, 3000);
    expect(closed).toEqual({ ok: false, code: 'ECONNREFUSED' });
  });
});
