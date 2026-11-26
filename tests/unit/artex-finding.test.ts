// @polsia:user-owned — the ARTEX → Solco hardening loop: the shared contract validates findings, a
// reported probe path can never overlap a real Solco route, ingest persists + logs a Skynet event,
// and accepted probes enrich the scanner-rule prompt without changing it when there are none.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { ArtexFindingInputSchema } from '@/lib/contracts/artex-finding';
import {
  collidesWithSolco,
  ingestArtexFinding,
  normalizeProbePath,
} from '@/lib/skynet/artex-findings.server';
import { scannerRulesPrompt } from '@/lib/skynet/scanner-rules';

function fakeDb() {
  const findings: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  return {
    findings,
    events,
    db: {
      artexFinding: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `f${findings.length + 1}`,
            receivedAt: new Date('2026-01-01T00:00:00Z'),
            status: 'open',
            ...data,
          };
          findings.push(row);
          return row;
        }),
        findMany: vi.fn(async () => findings),
      },
      skynetEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          events.push(data);
          return data;
        }),
      },
    } as never,
  };
}

describe('ArtexFinding contract', () => {
  it('accepts a well-formed finding', () => {
    const r = ArtexFindingInputSchema.safeParse({
      target: 'https://staging.example.vercel.app/api/foo',
      severity: 'high',
      category: 'missing-auth',
      title: 'Unauthenticated read on /api/foo',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a bad severity and empty title', () => {
    expect(
      ArtexFindingInputSchema.safeParse({
        target: 'x',
        severity: 'nope',
        category: 'csrf',
        title: 't',
      }).success,
    ).toBe(false);
    expect(
      ArtexFindingInputSchema.safeParse({
        target: 'x',
        severity: 'low',
        category: 'csrf',
        title: '',
      }).success,
    ).toBe(false);
  });
});

describe('never-block-Solco safety', () => {
  it('normalizes paths', () => {
    expect(normalizeProbePath('wp-login.php')).toBe('/wp-login.php');
    expect(normalizeProbePath('/api/foo/?x=1')).toBe('/api/foo');
    expect(normalizeProbePath('/api//foo/')).toBe('/api/foo');
  });

  it('rejects paths that overlap real Solco routes', () => {
    expect(collidesWithSolco('/')).toBe(true);
    expect(collidesWithSolco('/api')).toBe(true); // ancestor of every /api/* route
    expect(collidesWithSolco('/admin')).toBe(true);
  });

  it('accepts genuine scanner probe paths', () => {
    expect(collidesWithSolco('/.env.bak')).toBe(false);
    expect(collidesWithSolco('/wp-login.php')).toBe(false);
    expect(collidesWithSolco('/phpmyadmin/')).toBe(false);
  });
});

describe('ingestArtexFinding', () => {
  it('stores the finding and logs a Skynet event', async () => {
    const { db, findings, events } = fakeDb();
    const out = await ingestArtexFinding(
      {
        target: 'https://s.example/api/x',
        severity: 'critical',
        category: 'missing-auth',
        title: 'No auth',
      },
      db,
    );
    expect(findings).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: 'critical', keys: ['artex', 'missing-auth'] });
    expect(out.probeAccepted).toBe(false);
  });

  it('accepts a safe scanner-probe path into the corpus', async () => {
    const { db } = fakeDb();
    const out = await ingestArtexFinding(
      {
        target: 'https://s.example',
        severity: 'low',
        category: 'scanner-probe',
        title: 'probe',
        probePath: '/.git/config',
      },
      db,
    );
    expect(out.probeAccepted).toBe(true);
    expect(out.probePath).toBe('/.git/config');
    expect(out.probeRejectedReason).toBeUndefined();
  });

  it('refuses a probe path that would overlap Solco', async () => {
    const { db } = fakeDb();
    const out = await ingestArtexFinding(
      {
        target: 'https://s.example',
        severity: 'low',
        category: 'scanner-probe',
        title: 'probe',
        probePath: '/api',
      },
      db,
    );
    expect(out.probeAccepted).toBe(false);
    expect(out.probeRejectedReason).toBeTruthy();
  });
});

describe('scannerRulesPrompt corpus enrichment', () => {
  it('is unchanged when there are no ARTEX probes', () => {
    expect(scannerRulesPrompt('brief', [])).toBe(scannerRulesPrompt('brief'));
  });

  it('appends ARTEX probes into the examples', () => {
    const withProbe = scannerRulesPrompt('brief', ['/totally-unique-artex-probe']);
    expect(withProbe).toContain('/totally-unique-artex-probe');
  });
});
