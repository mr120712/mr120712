// @polsia:user-owned — shared zod contract for ARTEX findings, imported by BOTH the ingest/review
// route (src/app/api/admin/skynet/artex-finding) and any admin panel that lists them. A shape change
// here is a tsc error on both sides, not silent drift.
import { z } from 'zod';

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export const FINDING_CATEGORIES = [
  'missing-auth',
  'broken-access-control',
  'csrf',
  'cors',
  'csp',
  'security-headers',
  'info-leak',
  'injection',
  'scanner-probe',
  'other',
] as const;

export const FINDING_STATUSES = ['open', 'fixed', 'accepted_risk'] as const;

/** What ARTEX POSTs to /api/admin/skynet/artex-finding. Defensive assessment only. */
export const ArtexFindingInputSchema = z.object({
  /** Label of the reporting ARTEX instance/host (never a secret). */
  source: z.string().trim().max(200).optional(),
  /** The assessed host/endpoint/path. */
  target: z.string().trim().min(1).max(500),
  severity: z.enum(FINDING_SEVERITIES),
  category: z.enum(FINDING_CATEGORIES),
  title: z.string().trim().min(1).max(300),
  /** Short evidence summary — request/response shape. No credentials, no PoC exploit. */
  evidence: z.string().trim().max(5000).optional(),
  recommendation: z.string().trim().max(2000).optional(),
  /** Only for category 'scanner-probe': an attacker path to feed the Skynet scanner corpus. */
  probePath: z.string().trim().max(500).optional(),
});

export type ArtexFindingInput = z.infer<typeof ArtexFindingInputSchema>;

/** A stored finding as returned to the admin panel. */
export const ArtexFindingSchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  source: z.string().nullable(),
  target: z.string(),
  severity: z.enum(FINDING_SEVERITIES),
  category: z.enum(FINDING_CATEGORIES),
  title: z.string(),
  evidence: z.string().nullable(),
  recommendation: z.string().nullable(),
  status: z.enum(FINDING_STATUSES),
  probePath: z.string().nullable(),
  probeAccepted: z.boolean(),
});

export type ArtexFinding = z.infer<typeof ArtexFindingSchema>;

export const ArtexFindingListSchema = z.object({
  items: z.array(ArtexFindingSchema),
});

export type ArtexFindingList = z.infer<typeof ArtexFindingListSchema>;
