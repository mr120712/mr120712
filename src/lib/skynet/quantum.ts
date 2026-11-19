// @polsia:user-owned — «Skynet», il motore post-quantistico (parte pura). Un computer quantistico
// abbastanza grande romperebbe lo scambio di chiavi classico di HTTPS (X25519, curve ellittiche):
// chi registra oggi il traffico potrebbe decifrarlo domani («registra ora, decifra dopo»). Lo
// scambio ibrido X25519MLKEM768 (ML-KEM, standard NIST FIPS 203, unito a X25519) resiste anche a
// quello. La rete di Vercel lo offre ai browser recenti; il motore controlla ogni ora che i domini di
// Solco lo accettino davvero (quantum.server.ts) e avvisa gli amministratori una volta sola a ogni
// cambio: protezione accesa, assente, di nuovo attiva.
//
// Come il resto di Skynet il motore avvisa soltanto: la protezione la dà la rete di Vercel, non il
// codice di Solco. Le firme e le cifrature interne di Solco (HMAC-SHA-256, AES-256-GCM, scrypt) sono
// simmetriche e già resistenti: un computer quantistico ne dimezza al massimo la sicurezza
// (algoritmo di Grover) e 256 bit restano abbondanti.

export const PQ_GROUP = 'X25519MLKEM768';
/**
 * Gruppo di scambio chiavi considerato «protetto»: lo standard NIST ML-KEM-768 (FIPS 203), da solo o
 * nell'ibrido con X25519. Un gruppo post-quantistico pre-standard (bozza Kyber) o diverso NON conta:
 * è più debole o non verificato, e accettarlo come protezione nasconderebbe un downgrade silenzioso.
 * Tollerante sui nomi che il runtime può usare per lo standard, ma rifiuta esplicitamente le bozze.
 */
export function isStandardPqGroup(group: string | null | undefined): boolean {
  if (typeof group !== 'string' || group.length === 0) return false;
  const g = group.toUpperCase();
  if (g.includes('KYBER') || g.includes('DRAFT')) return false;
  return g === PQ_GROUP.toUpperCase() || g.includes('MLKEM768') || g.includes('ML-KEM-768');
}
/** Con lo stato già comunicato (protezione attiva, o assente e segnalata) si ricontrolla ogni ora. */
export const QUANTUM_RECHECK_MS = 60 * 60 * 1000;
/** Se la verifica non è riuscita (rete, runtime) si riprova dopo 10 minuti. */
export const QUANTUM_RETRY_MS = 10 * 60 * 1000;
/** Rifiuti di fila (un controllo a giro) prima di avvisare: niente allarmi per un singolo intoppo. */
export const QUANTUM_CONFIRM = 3;

/**
 * pq: il dominio accetta lo scambio post-quantistico; classic-only: lo rifiuta ma risponde con
 * quello classico; unreachable: nessuna stretta di mano riuscita; unsupported: il runtime non
 * conosce ML-KEM (OpenSSL più vecchio della 3.5).
 */
export const PQ_RESULTS = ['pq', 'classic-only', 'unreachable', 'unsupported'] as const;
export type PqResult = (typeof PQ_RESULTS)[number];
export type QuantumHost = { host: string; result: PqResult };

export type QuantumSignals = {
  checkedAt: string;
  /** true: ogni dominio accetta X25519MLKEM768; false: almeno uno lo rifiuta; null: non verificato. */
  pq: boolean | null;
  group: string;
  hosts: QuantumHost[];
  /** Controlli con il post-quantistico rifiutato (un controllo non riuscito non azzera il conto). */
  refused: number;
  /** Ultimo stato comunicato agli amministratori: un avviso solo quando cambia. */
  announced: 'on' | 'off' | null;
};

export type QuantumEvent = 'online' | 'lost' | 'restored';
export type QuantumStep = { signals: QuantumSignals | null; event: QuantumEvent | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPqResult(value: unknown): value is PqResult {
  return typeof value === 'string' && (PQ_RESULTS as readonly string[]).includes(value);
}

/** I domini da controllare: quello del sito e, per www.<dominio>, anche il dominio nudo. */
export function quantumHosts(origin: string): string[] {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return [];
  }
  if (!host) return [];
  const apex = host.startsWith('www.') ? host.slice(4) : null;
  return apex?.includes('.') ? [host, apex] : [host];
}

/** Lo stato salvato nel giro precedente (lastSignals.quantum); null se manca o non è valido. */
export function parseQuantum(raw: unknown): QuantumSignals | null {
  if (!isRecord(raw)) return null;
  const { checkedAt, pq, group, hosts, refused, announced } = raw;
  if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) return null;
  if (pq !== true && pq !== false && pq !== null) return null;
  return {
    checkedAt,
    pq,
    group: typeof group === 'string' && group ? group : PQ_GROUP,
    hosts: Array.isArray(hosts)
      ? hosts.flatMap((item) =>
          isRecord(item) && typeof item.host === 'string' && isPqResult(item.result)
            ? [{ host: item.host, result: item.result }]
            : [],
        )
      : [],
    refused:
      typeof refused === 'number' && Number.isInteger(refused) && refused > 0
        ? Math.min(refused, 100_000)
        : 0,
    announced: announced === 'on' || announced === 'off' ? announced : null,
  };
}

/** true se ogni dominio accetta il post-quantistico, false se almeno uno lo rifiuta. */
export function summarizeQuantum(hosts: QuantumHost[]): boolean | null {
  if (hosts.length === 0) return null;
  if (hosts.some((host) => host.result === 'classic-only')) return false;
  return hosts.every((host) => host.result === 'pq') ? true : null;
}

/** Tocca controllare in questo giro? Ogni ora; a ogni giro mentre si conferma un rifiuto. */
export function quantumDue(previous: QuantumSignals | null, now: Date): boolean {
  if (!previous) return true;
  const age = now.getTime() - Date.parse(previous.checkedAt);
  if (!Number.isFinite(age) || age < 0) return true;
  if (previous.pq === false && previous.announced !== 'off') return true;
  if (previous.pq === null) return age >= QUANTUM_RETRY_MS;
  return age >= QUANTUM_RECHECK_MS;
}

/** Il nuovo stato dopo un controllo, e l'avviso da dare (uno solo a ogni cambio). */
export function quantumStep(
  previous: QuantumSignals | null,
  hosts: QuantumHost[],
  now: Date,
): QuantumStep {
  const pq = summarizeQuantum(hosts);
  const base = { checkedAt: now.toISOString(), pq, group: PQ_GROUP, hosts };
  const announced = previous?.announced ?? null;
  if (pq === true) {
    return {
      signals: { ...base, refused: 0, announced: 'on' },
      event: announced === 'on' ? null : announced === 'off' ? 'restored' : 'online',
    };
  }
  if (pq === false) {
    const refused = (previous?.refused ?? 0) + 1;
    const alert = refused >= QUANTUM_CONFIRM && announced !== 'off';
    return {
      signals: { ...base, refused, announced: alert ? 'off' : announced },
      event: alert ? 'lost' : null,
    };
  }
  // Non verificato (rete o runtime): nessun avviso, il conto dei rifiuti resta com'era.
  return { signals: { ...base, refused: previous?.refused ?? 0, announced }, event: null };
}

function hostList(hosts: string[]): string {
  if (hosts.length <= 1) return hosts[0] ?? 'il sito';
  return `${hosts.slice(0, -1).join(', ')} e ${hosts[hosts.length - 1]}`;
}

/** Titolo, gravità e rapporto dell'avviso (diario e Telegram), in italiano semplice. */
export function quantumEventText(
  event: QuantumEvent,
  signals: QuantumSignals,
): { severity: 'warning' | 'info'; title: string; report: string } {
  const all = signals.hosts.map((host) => host.host);
  if (event === 'lost') {
    const refused = signals.hosts
      .filter((host) => host.result === 'classic-only')
      .map((host) => host.host);
    const many = refused.length > 1;
    return {
      severity: 'warning',
      title: `Connessioni senza protezione post-quantistica: ${hostList(refused)}`,
      report: [
        `Da ${QUANTUM_CONFIRM} controlli di fila ${hostList(refused)} ${many ? 'rifiutano' : 'rifiuta'} lo scambio di chiavi post-quantistico ${signals.group} e ${many ? 'accettano' : 'accetta'} solo quello classico.`,
        'Il sito resta cifrato e sicuro contro gli attacchi di oggi: il rischio è che il traffico registrato adesso venga decifrato in futuro con un computer quantistico.',
        'In Solco non c’è nulla da cambiare: la protezione la dà la rete di Vercel.',
        '',
        'Cosa fare:',
        '- Controlli in Vercel → progetto → Settings → Domains che il dominio punti ancora a Vercel: se il DNS è cambiato e non è stato lei, è urgente.',
        `- Se punta a Vercel, scriva al supporto di Vercel citando ${signals.group}.`,
      ].join('\n'),
    };
  }
  if (event === 'restored') {
    return {
      severity: 'info',
      title: 'Protezione post-quantistica di nuovo attiva',
      report: `${hostList(all)} ${all.length > 1 ? 'accettano' : 'accetta'} di nuovo lo scambio di chiavi post-quantistico ${signals.group}. Nessuna azione richiesta.`,
    };
  }
  return {
    severity: 'info',
    title: `Motore post-quantistico acceso: connessioni protette con ${signals.group}`,
    report: [
      `Skynet ha verificato che ${hostList(all)} ${all.length > 1 ? 'accettano' : 'accetta'} lo scambio di chiavi post-quantistico ${signals.group} (ML-KEM, standard NIST FIPS 203, insieme a X25519).`,
      'Il traffico dei browser recenti (Chrome ed Edge 131, Firefox 132, Safari 26 e successivi) è protetto anche contro un futuro computer quantistico: chi lo registrasse oggi non potrà decifrarlo domani.',
      'Le firme e le cifrature interne di Solco (HMAC-SHA-256, AES-256-GCM, scrypt) sono già resistenti.',
      'Skynet ricontrolla ogni ora e la avvisa se la protezione si spegne.',
    ].join('\n'),
  };
}
