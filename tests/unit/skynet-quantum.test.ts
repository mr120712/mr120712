// @polsia:user-owned
// @vitest-environment node
//
// «Skynet», il motore post-quantistico (src/lib/skynet/quantum.ts e quantum.server.ts): quali
// domini, quando controllare, un avviso solo a ogni cambio (acceso, assente dopo 3 rifiuti di fila,
// di nuovo attivo), testi; e strette di mano vere contro server TLS locali con e senza ML-KEM
// (saltate se mancano openssl o ML-KEM nel runtime).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, createServer, type Server, type TlsOptions } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  PQ_GROUP,
  parseQuantum,
  QUANTUM_CONFIRM,
  QUANTUM_RECHECK_MS,
  QUANTUM_RETRY_MS,
  type QuantumHost,
  type QuantumSignals,
  quantumDue,
  quantumEventText,
  quantumHosts,
  quantumStep,
  summarizeQuantum,
} from '@/lib/skynet/quantum';
import { probePostQuantum, runtimeSupportsPq } from '@/lib/skynet/quantum.server';

const NOW = new Date('2026-11-17T22:00:00.000Z');
const WWW = 'www.solcomusic.online';
const APEX = 'solcomusic.online';
const both = (www: QuantumHost['result'], apex = www): QuantumHost[] => [
  { host: WWW, result: www },
  { host: APEX, result: apex },
];
const later = (ms: number) => new Date(NOW.getTime() + ms);

function stateAfter(results: QuantumHost[], previous: QuantumSignals | null = null) {
  const { signals } = quantumStep(previous, results, NOW);
  if (!signals) throw new Error('stato mancante');
  return signals;
}

describe('domini e riepilogo', () => {
  it('www più il dominio nudo; un solo dominio negli altri casi', () => {
    expect(quantumHosts('https://www.solcomusic.online')).toEqual([WWW, APEX]);
    expect(quantumHosts('https://solcomusic.online')).toEqual([APEX]);
    expect(quantumHosts('https://www.localhost')).toEqual(['www.localhost']);
    expect(quantumHosts('non un indirizzo')).toEqual([]);
  });

  it('protetto solo se tutti accettano; un rifiuto basta per «assente»; il resto non è verificato', () => {
    expect(summarizeQuantum(both('pq'))).toBe(true);
    expect(summarizeQuantum(both('pq', 'classic-only'))).toBe(false);
    expect(summarizeQuantum(both('classic-only', 'unreachable'))).toBe(false);
    expect(summarizeQuantum(both('pq', 'unreachable'))).toBeNull();
    expect(summarizeQuantum(both('unsupported'))).toBeNull();
    expect(summarizeQuantum([])).toBeNull();
  });
});

describe('quantumStep: un avviso solo a ogni cambio', () => {
  it('primo controllo riuscito: «acceso», poi silenzio', () => {
    const first = quantumStep(null, both('pq'), NOW);
    expect(first.event).toBe('online');
    expect(first.signals).toEqual({
      checkedAt: NOW.toISOString(),
      pq: true,
      group: PQ_GROUP,
      hosts: both('pq'),
      refused: 0,
      announced: 'on',
    });
    expect(quantumStep(first.signals, both('pq'), later(QUANTUM_RECHECK_MS)).event).toBeNull();
  });

  it(`assente solo dopo ${QUANTUM_CONFIRM} rifiuti di fila, una volta; poi «di nuovo attiva»`, () => {
    let state: QuantumSignals | null = stateAfter(both('pq'));
    const events: Array<string | null> = [];
    for (let i = 1; i <= QUANTUM_CONFIRM + 1; i += 1) {
      const step = quantumStep(state, both('pq', 'classic-only'), later(i * 60_000));
      events.push(step.event);
      state = step.signals;
    }
    expect(events).toEqual([null, null, 'lost', null]);
    expect(state).toMatchObject({ pq: false, refused: QUANTUM_CONFIRM + 1, announced: 'off' });
    const back = quantumStep(state, both('pq'), later(QUANTUM_RECHECK_MS * 2));
    expect(back.event).toBe('restored');
    expect(back.signals).toMatchObject({ pq: true, refused: 0, announced: 'on' });
  });

  it('un rifiuto isolato non avvisa; un controllo non riuscito non azzera il conto né avvisa', () => {
    const one = quantumStep(stateAfter(both('pq')), both('classic-only'), later(60_000));
    expect(one.event).toBeNull();
    const blind = quantumStep(one.signals, both('unreachable'), later(120_000));
    expect(blind.event).toBeNull();
    expect(blind.signals).toMatchObject({ pq: null, refused: 1, announced: 'on' });
    expect(quantumStep(blind.signals, both('pq'), later(180_000))).toMatchObject({
      event: null,
      signals: { pq: true, refused: 0 },
    });
  });

  it('mai protetto fin dal primo controllo: un avviso dopo la conferma', () => {
    let state: QuantumSignals | null = null;
    const events: Array<string | null> = [];
    for (let i = 0; i < QUANTUM_CONFIRM; i += 1) {
      const step = quantumStep(state, both('classic-only'), later(i * 60_000));
      events.push(step.event);
      state = step.signals;
    }
    expect(events).toEqual([null, null, 'lost']);
  });

  it('runtime senza ML-KEM: nessun avviso', () => {
    expect(quantumStep(null, both('unsupported'), NOW)).toMatchObject({
      event: null,
      signals: { pq: null, refused: 0, announced: null },
    });
  });
});

describe('quantumDue: ogni ora, a ogni giro mentre si conferma un rifiuto', () => {
  it('quando tocca controllare', () => {
    const on = stateAfter(both('pq'));
    expect(quantumDue(null, NOW)).toBe(true);
    expect(quantumDue(on, later(QUANTUM_RECHECK_MS - 60_000))).toBe(false);
    expect(quantumDue(on, later(QUANTUM_RECHECK_MS))).toBe(true);

    const doubt = stateAfter(both('classic-only'), on);
    expect(quantumDue(doubt, later(60_000))).toBe(true);
    const lost: QuantumSignals = { ...doubt, refused: QUANTUM_CONFIRM, announced: 'off' };
    expect(quantumDue(lost, later(60_000))).toBe(false);
    expect(quantumDue(lost, later(QUANTUM_RECHECK_MS))).toBe(true);

    const blind = stateAfter(both('unreachable'));
    expect(quantumDue(blind, later(QUANTUM_RETRY_MS - 60_000))).toBe(false);
    expect(quantumDue(blind, later(QUANTUM_RETRY_MS))).toBe(true);

    // Orologio tornato indietro: meglio ricontrollare.
    expect(quantumDue({ ...on, checkedAt: later(60_000).toISOString() }, NOW)).toBe(true);
  });
});

describe('parseQuantum', () => {
  it('rilegge quello che salva e scarta il resto', () => {
    const saved = stateAfter(both('pq'));
    expect(parseQuantum(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(parseQuantum(null)).toBeNull();
    expect(parseQuantum({ checkedAt: 'ieri', pq: true })).toBeNull();
    expect(parseQuantum({ checkedAt: NOW.toISOString(), pq: 'sì' })).toBeNull();
    expect(
      parseQuantum({
        checkedAt: NOW.toISOString(),
        pq: false,
        hosts: [
          { host: WWW, result: 'boh' },
          { host: APEX, result: 'classic-only' },
        ],
        refused: -4,
        announced: 'forse',
      }),
    ).toEqual({
      checkedAt: NOW.toISOString(),
      pq: false,
      group: PQ_GROUP,
      hosts: [{ host: APEX, result: 'classic-only' }],
      refused: 0,
      announced: null,
    });
  });
});

describe('testi degli avvisi', () => {
  it('acceso: domini, standard, browser e ricontrollo orario', () => {
    const text = quantumEventText('online', stateAfter(both('pq')));
    expect(text.severity).toBe('info');
    expect(text.title).toBe(
      'Motore post-quantistico acceso: connessioni protette con X25519MLKEM768',
    );
    expect(text.report).toContain(`${WWW} e ${APEX} accettano`);
    expect(text.report).toContain('NIST FIPS 203');
    expect(text.report).toContain('Safari 26');
    expect(text.report).toContain('ricontrolla ogni ora');
  });

  it('assente: solo i domini che rifiutano, cosa fare, il DNS', () => {
    const signals = stateAfter(both('pq', 'classic-only'));
    const text = quantumEventText('lost', signals);
    expect(text.severity).toBe('warning');
    expect(text.title).toBe(`Connessioni senza protezione post-quantistica: ${APEX}`);
    expect(text.report).toContain(`Da ${QUANTUM_CONFIRM} controlli di fila ${APEX} rifiuta`);
    expect(text.report).toContain('Vercel → progetto → Settings → Domains');
    expect(text.report).toContain('se il DNS è cambiato e non è stato lei, è urgente');
    expect(text.report).not.toContain(WWW);
    const twoHosts = quantumEventText('lost', stateAfter(both('classic-only')));
    expect(twoHosts.report).toContain(`${WWW} e ${APEX} rifiutano`);
  });

  it('di nuovo attiva', () => {
    const text = quantumEventText('restored', stateAfter(both('pq')));
    expect(text).toMatchObject({
      severity: 'info',
      title: 'Protezione post-quantistica di nuovo attiva',
    });
    expect(text.report).toContain('Nessuna azione richiesta');
  });
});

function canRunHandshakes(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    createSecureContext({ ecdhCurve: PQ_GROUP });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!canRunHandshakes())('strette di mano vere (server TLS locali)', () => {
  let dir = '';
  let cert: Buffer;
  const servers: Server[] = [];
  const ports: Record<'pq' | 'classic' | 'tls12', number> = { pq: 0, classic: 0, tls12: 0 };

  async function listen(options: TlsOptions): Promise<number> {
    const server = createServer(options);
    server.on('secureConnection', (socket) => socket.end());
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    return (server.address() as AddressInfo).port;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skynet-pq-'));
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
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
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
    const key = readFileSync(keyPath);
    cert = readFileSync(certPath);
    // Gruppi predefiniti di OpenSSL ≥ 3.5: ML-KEM incluso.
    ports.pq = await listen({ key, cert });
    ports.classic = await listen({ key, cert, ecdhCurve: 'X25519:prime256v1' });
    ports.tls12 = await listen({ key, cert, maxVersion: 'TLSv1.2' });
  });

  afterAll(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  const probe = (port: number, withCa = true) =>
    probePostQuantum('127.0.0.1', {
      port,
      servername: 'localhost',
      timeoutMs: 3000,
      ...(withCa ? { ca: cert } : {}),
    });

  it('il runtime dei test conosce ML-KEM', () => {
    expect(runtimeSupportsPq()).toBe(true);
  });

  it('server con ML-KEM: protezione post-quantistica', async () => {
    expect(await probe(ports.pq)).toBe('pq');
  });

  it('server solo classico (X25519, P-256) o solo TLS 1.2: post-quantistico rifiutato', async () => {
    expect(await probe(ports.classic)).toBe('classic-only');
    expect(await probe(ports.tls12)).toBe('classic-only');
  });

  it('porta chiusa o certificato non valido: non verificabile, mai «rifiutato»', async () => {
    expect(await probe(1)).toBe('unreachable');
    expect(await probe(ports.pq, false)).toBe('unreachable');
  });
});
