// @polsia:user-owned — server logic for the ARTEX → Solco hardening loop.
//
// ARTEX runs an AUTHORIZED, defensive assessment on the owner's VPS against the Solco STAGING host
// and POSTs findings to /api/admin/skynet/artex-finding. Here we:
//   1. persist each finding,
//   2. log a Skynet diary event so the owner sees it in Monitoraggio (and via Telegram),
//   3. for a 'scanner-probe' finding, run the SAME never-block-Solco safety check Skynet uses
//      before a probe path can feed the scanner-rule corpus (scanner-rules.ts).
// The corpus augmentation is advisory: checkRule() in scanner-rules.ts still validates every
// generated regex against SOLCO_PATHS, so an accepted probe can never produce a rule that blocks
// a real Solco route.
import 'server-only';
import type { ArtexFinding, ArtexFindingInput } from '@/lib/contracts/artex-finding';
import { prisma } from '@/lib/db';
import { SOLCO_PATHS } from '@/lib/skynet/scanner-rules';

type FindingDb = Pick<typeof prisma, 'artexFinding' | 'skynetEvent'>;

/** Normalize a reported path: ensure a single leading slash, drop query/hash, trim. */
export function normalizeProbePath(raw: string): string {
  let p = raw.trim();
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  if (!p.startsWith('/')) p = `/${p}`;
  // collapse duplicate slashes, drop a trailing slash (except root)
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Would adding this probe path risk a scanner rule that blocks a real Solco route? Conservative:
 * reject if it equals, contains, or is contained by any Solco path on a segment boundary. This is
 * the first-line guard; checkRule() in scanner-rules.ts is the hard backstop at generation time.
 */
export function collidesWithSolco(path: string): boolean {
  const p = normalizeProbePath(path);
  if (p === '/' || p === '') return true; // never block the site root
  for (const raw of SOLCO_PATHS) {
    const s = normalizeProbePath(raw);
    if (s === p) return true;
    if (s.startsWith(`${p}/`)) return true; // p is an ancestor of a Solco path
    if (p.startsWith(`${s}/`)) return true; // p lives under a Solco path
  }
  return false;
}

function eventSeverity(severity: ArtexFindingInput['severity']): 'critical' | 'warning' | 'info' {
  if (severity === 'critical') return 'critical';
  if (severity === 'high' || severity === 'medium') return 'warning';
  return 'info';
}

function toContract(row: {
  id: string;
  receivedAt: Date;
  source: string | null;
  target: string;
  severity: string;
  category: string;
  title: string;
  evidence: string | null;
  recommendation: string | null;
  status: string;
  probePath: string | null;
  probeAccepted: boolean;
}): ArtexFinding {
  return {
    id: row.id,
    receivedAt: row.receivedAt.toISOString(),
    source: row.source,
    target: row.target,
    severity: row.severity as ArtexFinding['severity'],
    category: row.category as ArtexFinding['category'],
    title: row.title,
    evidence: row.evidence,
    recommendation: row.recommendation,
    status: row.status as ArtexFinding['status'],
    probePath: row.probePath,
    probeAccepted: row.probeAccepted,
  };
}

export type IngestResult = ArtexFinding & { probeRejectedReason?: string };

/** Persist a finding, log a Skynet event, and (safely) accept any scanner-probe path. */
export async function ingestArtexFinding(
  input: ArtexFindingInput,
  db: FindingDb = prisma,
): Promise<IngestResult> {
  let probePath: string | null = null;
  let probeAccepted = false;
  let probeRejectedReason: string | undefined;

  if (input.category === 'scanner-probe' && input.probePath) {
    const normalized = normalizeProbePath(input.probePath);
    if (collidesWithSolco(normalized)) {
      probePath = normalized;
      probeRejectedReason = 'would overlap a real Solco path; not added to the scanner corpus';
    } else {
      probePath = normalized;
      probeAccepted = true;
    }
  }

  const row = await db.artexFinding.create({
    data: {
      source: input.source ?? null,
      target: input.target,
      severity: input.severity,
      category: input.category,
      title: input.title,
      evidence: input.evidence ?? null,
      recommendation: input.recommendation ?? null,
      probePath,
      probeAccepted,
      // Plain JSON value (drops any undefined) for the Prisma Json column.
      raw: JSON.parse(JSON.stringify(input)),
    },
  });

  // Surface it to the owner's monitoring diary (and Telegram). Best-effort: a logging failure must
  // not fail the ingest.
  try {
    const probeNote = probePath
      ? probeAccepted
        ? ` · probe ${probePath} added to the scanner corpus`
        : ` · probe ${probePath} rejected (${probeRejectedReason})`
      : '';
    await db.skynetEvent.create({
      data: {
        kind: 'update',
        severity: eventSeverity(input.severity),
        title: `ARTEX: ${input.title}`.slice(0, 300),
        report: [
          `Finding on ${input.target} (${input.severity}/${input.category}).`,
          input.recommendation ? `Fix: ${input.recommendation}` : null,
          probeNote || null,
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 4000),
        keys: ['artex', input.category],
      },
    });
  } catch {
    // ignore — the finding is stored either way
  }

  return { ...toContract(row), probeRejectedReason };
}

/** Findings for the admin review panel, newest first. */
export async function listArtexFindings(
  limit = 100,
  db: FindingDb = prisma,
): Promise<ArtexFinding[]> {
  const rows = await db.artexFinding.findMany({
    orderBy: { receivedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 500),
  });
  return rows.map(toContract);
}

/**
 * Accepted ARTEX probe paths to enrich the Skynet scanner-rule corpus. Degrades to [] on any error
 * (e.g. the model not yet migrated in a test env) so rule generation never breaks.
 */
export async function artexProbeSamples(db: FindingDb = prisma): Promise<string[]> {
  try {
    const rows = await db.artexFinding.findMany({
      where: { probeAccepted: true, probePath: { not: null } },
      select: { probePath: true },
      orderBy: { receivedAt: 'desc' },
      take: 40,
    });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
      const p = r.probePath;
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  } catch {
    return [];
  }
}
