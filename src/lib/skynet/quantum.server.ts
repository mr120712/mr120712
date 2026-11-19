// @polsia:user-owned — «Skynet», il motore post-quantistico (parte di rete). Solo strette di mano TLS
// verso i domini di Solco: nessuna richiesta HTTP, nessun dato inviato, niente nel registro del
// firewall. Prima una stretta di mano TLS 1.3 che offre SOLTANTO X25519MLKEM768: se il server la
// accetta, la protezione post-quantistica c'è. Se no, una seconda con i gruppi predefiniti distingue
// il rifiuto del post-quantistico (il sito risponde in modo classico) dal sito irraggiungibile.
// Il certificato viene verificato come in un browser.
import 'server-only';
import { type ConnectionOptions, connect, createSecureContext, type TLSSocket } from 'node:tls';
import { isStandardPqGroup, PQ_GROUP, type PqResult } from './quantum';

const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Tentativi per il gruppo post-quantistico: un intoppo di rete sul primo non deve sembrare un downgrade. */
const PQ_PROBE_ATTEMPTS = 2;

export type PqProbeOptions = {
  port?: number;
  /** Nome per SNI e certificato (predefinito: l'host). */
  servername?: string;
  /** Autorità di certificazione in più: solo per i test con un server locale. */
  ca?: string | Buffer;
  timeoutMs?: number;
};

let runtimeSupport: boolean | null = null;

/** Il runtime conosce ML-KEM (Node con OpenSSL 3.5 o successivo)? */
export function runtimeSupportsPq(): boolean {
  if (runtimeSupport === null) {
    try {
      createSecureContext({ ecdhCurve: PQ_GROUP });
      runtimeSupport = true;
    } catch {
      runtimeSupport = false;
    }
  }
  return runtimeSupport;
}

type Handshake = { ok: true; group: string | null } | { ok: false };

/** Una stretta di mano; groups null = i gruppi predefiniti del runtime. */
function handshake(
  host: string,
  groups: string | null,
  options: PqProbeOptions,
): Promise<Handshake> {
  return new Promise((resolveHandshake) => {
    let settled = false;
    let socket: TLSSocket | undefined;
    const finish = (result: Handshake) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolveHandshake(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false }),
      options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    );
    const connection: ConnectionOptions = {
      host,
      port: options.port ?? 443,
      servername: options.servername ?? host,
      ALPNProtocols: ['h2', 'http/1.1'],
      ...(groups ? { ecdhCurve: groups, minVersion: 'TLSv1.3' } : {}),
      ...(options.ca ? { ca: options.ca } : {}),
    };
    try {
      socket = connect(connection, () => {
        const info = socket?.getEphemeralKeyInfo() as { name?: unknown } | null | undefined;
        finish({ ok: true, group: typeof info?.name === 'string' ? info.name : null });
      });
      socket.once('error', () => finish({ ok: false }));
    } catch {
      finish({ ok: false });
    }
  });
}

/** Il dominio accetta lo scambio di chiavi post-quantistico? */
export async function probePostQuantum(
  host: string,
  options: PqProbeOptions = {},
): Promise<PqResult> {
  if (!runtimeSupportsPq()) return 'unsupported';
  // Offrendo SOLO X25519MLKEM768, una stretta di mano riuscita È lo standard. Due tentativi: un
  // intoppo di rete sul primo non deve sembrare un downgrade (un falso «rifiutato» che, ripetuto,
  // farebbe scattare un allarme).
  for (let attempt = 0; attempt < PQ_PROBE_ATTEMPTS; attempt += 1) {
    if ((await handshake(host, PQ_GROUP, options)).ok) return 'pq';
  }
  const classic = await handshake(host, null, options);
  if (!classic.ok) return 'unreachable';
  // Il primo tentativo può essere caduto per un intoppo: se il secondo, con i gruppi predefiniti, ha
  // negoziato lo standard NIST ML-KEM-768, la protezione c'è. Un ibrido pre-standard (bozza Kyber) o
  // più debole NON conta: sarebbe un downgrade silenzioso spacciato per protezione.
  return isStandardPqGroup(classic.group) ? 'pq' : 'classic-only';
}
