// @polsia:user-owned

import { z } from 'zod';
import {
  type CheckIssue,
  type FactCheck,
  type LinkCheck,
  type ProductCheckResult,
  productCheckResultSchema,
} from '@/lib/contracts/workspace';

export const offerExtractionSchema = z
  .object({
    price: z.number().nonnegative().nullable().catch(null),
    currency: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().length(3))
      .nullable()
      .catch(null),
    availability: z.enum(['available', 'unavailable', 'unknown']).catch('unknown'),
    priceEvidence: z.string().trim().max(300).nullable().catch(null),
    availabilityEvidence: z.string().trim().max(300).nullable().catch(null),
  })
  .strict();

export type OfferExtraction = z.infer<typeof offerExtractionSchema>;
export interface ProductLink {
  url: string;
  label: string;
}

export interface ExpectedOffer {
  priceCents: number;
  available: boolean;
}

export interface PageReadSummary {
  title: string;
  sourceUrl: string;
  fetchedAt: string;
  truncated: boolean;
}

const REDIRECT_LIMITATION =
  'Il lettore web non restituisce l’URL finale né la catena dei redirect.';

export function formatEuro(cents: number): string {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

export function extractProductLinks(markdown: string, baseUrl: string): ProductLink[] {
  const found: ProductLink[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: string, label: string) => {
    try {
      const url = new URL(rawUrl, baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      url.hash = '';
      const normalized = url.toString();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      found.push({ url: normalized, label: label.trim().slice(0, 160) || normalized });
    } catch {
      return;
    }
  };

  const markdownLink = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu;
  for (const match of markdown.matchAll(markdownLink)) {
    if (match[1] === '!') continue;
    const label = match[2] ?? '';
    const target = match[3] ?? '';
    add(target, label);
  }

  const htmlLink = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>(.*?)<\/a>/giu;
  for (const match of markdown.matchAll(htmlLink)) {
    add(match[2] ?? '', (match[3] ?? '').replace(/<[^>]*>/gu, ' '));
  }

  const autoLink = /<((?:https?):\/\/[^>]+)>/gu;
  for (const match of markdown.matchAll(autoLink)) add(match[1] ?? '', match[1] ?? '');

  return found;
}

function createFactCheck(
  status: FactCheck['status'],
  expected: string,
  observed: string | null,
  evidence: string | null,
  reason: string | null,
): FactCheck {
  return { status, expected, observed, evidence, reason };
}

function createIssue(input: CheckIssue): CheckIssue {
  return input;
}

function buildIssues(
  _expected: ExpectedOffer,
  page: ProductCheckResult['page'],
  price: FactCheck,
  availability: FactCheck,
  links: LinkCheck[],
): CheckIssue[] {
  const issues: CheckIssue[] = [];

  if (page.status === 'unverifiable') {
    issues.push(
      createIssue({
        id: 'page',
        field: 'page',
        kind: 'unverifiable',
        expected: 'Pagina leggibile',
        observed: null,
        reason: page.reason ?? 'La pagina non è stata letta.',
        action: 'Apri l’URL e verifica che la pagina sia pubblica e consultabile.',
        url: page.sourceUrl,
      }),
    );
  }

  if (price.status !== 'match') {
    issues.push(
      createIssue({
        id: 'price',
        field: 'price',
        kind: price.status === 'anomaly' ? 'anomaly' : 'unverifiable',
        expected: price.expected,
        observed: price.observed,
        reason: price.reason ?? 'Il prezzo non coincide con il dato atteso.',
        action:
          price.status === 'anomaly'
            ? 'Confronta il prezzo mostrato e correggi il dato del negozio se necessario.'
            : 'Controlla manualmente il prezzo e la valuta pubblicati nella pagina.',
        url: page.sourceUrl,
      }),
    );
  }

  if (availability.status !== 'match') {
    issues.push(
      createIssue({
        id: 'availability',
        field: 'availability',
        kind: availability.status === 'anomaly' ? 'anomaly' : 'unverifiable',
        expected: availability.expected,
        observed: availability.observed,
        reason: availability.reason ?? 'La disponibilità non coincide con il dato atteso.',
        action:
          availability.status === 'anomaly'
            ? 'Verifica lo stato mostrato e aggiorna la disponibilità nel negozio.'
            : 'Controlla manualmente la disponibilità pubblicata nella pagina.',
        url: page.sourceUrl,
      }),
    );
  }

  for (const [index, link] of links.entries()) {
    if (link.status !== 'readable') {
      issues.push(
        createIssue({
          id: `link-${index}`,
          field: 'link',
          kind: 'unverifiable',
          expected: 'Destinazione leggibile',
          observed: link.title,
          reason: link.reason ?? 'La lettura del link non è stata completata.',
          action: 'Apri il collegamento e controlla la pagina di destinazione.',
          url: link.url,
        }),
      );
    }
    issues.push(
      createIssue({
        id: `redirect-${index}`,
        field: 'redirect',
        kind: 'unverifiable',
        expected: 'Nessun redirect inatteso',
        observed: null,
        reason: REDIRECT_LIMITATION,
        action: 'Apri il collegamento e verifica la destinazione finale nel browser.',
        url: link.url,
      }),
    );
  }

  return issues;
}

export function createPendingCheckResult(expected: ExpectedOffer): ProductCheckResult {
  const page: ProductCheckResult['page'] = {
    status: 'pending',
    title: null,
    sourceUrl: null,
    fetchedAt: null,
    truncated: false,
    reason: 'La lettura della pagina non è ancora terminata.',
  };
  const price = createFactCheck(
    'unverifiable',
    formatEuro(expected.priceCents),
    null,
    null,
    'La pagina non è ancora stata letta.',
  );
  const availability = createFactCheck(
    'unverifiable',
    expected.available ? 'Disponibile' : 'Non disponibile',
    null,
    null,
    'La pagina non è ancora stata letta.',
  );
  return productCheckResultSchema.parse({
    expected: { ...expected, currency: 'EUR' },
    page,
    price,
    availability,
    links: [],
    issues: buildIssues(expected, page, price, availability, []),
  });
}

export function createUnreadableCheckResult(
  expected: ExpectedOffer,
  sourceUrl: string,
  reason: string,
): ProductCheckResult {
  const pending = createPendingCheckResult(expected);
  const page: ProductCheckResult['page'] = {
    ...pending.page,
    status: 'unverifiable',
    sourceUrl,
    reason,
  };
  const price = {
    ...pending.price,
    reason: 'Il prezzo non è leggibile senza il contenuto della pagina.',
  };
  const availability = {
    ...pending.availability,
    reason: 'La disponibilità non è leggibile senza il contenuto della pagina.',
  };
  return productCheckResultSchema.parse({
    ...pending,
    page,
    price,
    availability,
    issues: buildIssues(expected, page, price, availability, []),
  });
}

export function createReadableCheckResult(input: {
  expected: ExpectedOffer;
  sourceUrl: string;
  page: PageReadSummary;
  facts: OfferExtraction | null;
  links: ProductLink[];
  extractionReason?: string;
}): ProductCheckResult {
  const { expected, facts, page, sourceUrl } = input;
  const expectedPrice = formatEuro(expected.priceCents);
  let price: FactCheck;
  if (!facts?.price || !facts.currency) {
    const reason =
      input.extractionReason ??
      (page.truncated
        ? 'Il testo disponibile è troncato e non contiene un prezzo leggibile con valuta.'
        : 'Il prezzo o la valuta non sono leggibili nel contenuto restituito.');
    price = createFactCheck(
      'unverifiable',
      expectedPrice,
      facts?.price ? `${facts.price.toLocaleString('it-IT')} (valuta non rilevata)` : null,
      facts?.priceEvidence ?? null,
      reason,
    );
  } else {
    const observedCents = Math.round(facts.price * 100);
    const observed =
      facts.currency === 'EUR'
        ? formatEuro(observedCents)
        : `${facts.currency} ${facts.price.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const matches = facts.currency === 'EUR' && observedCents === expected.priceCents;
    price = createFactCheck(
      matches ? 'match' : 'anomaly',
      expectedPrice,
      observed,
      facts.priceEvidence,
      matches ? null : 'Prezzo o valuta pubblicati diversi dal valore atteso.',
    );
  }

  let availability: FactCheck;
  if (!facts || facts.availability === 'unknown') {
    availability = createFactCheck(
      'unverifiable',
      expected.available ? 'Disponibile' : 'Non disponibile',
      null,
      facts?.availabilityEvidence ?? null,
      input.extractionReason ??
        (page.truncated
          ? 'Il testo disponibile è troncato e non indica chiaramente la disponibilità.'
          : 'La disponibilità non è esplicita nel contenuto restituito.'),
    );
  } else {
    const observedAvailable = facts.availability === 'available';
    const matches = observedAvailable === expected.available;
    availability = createFactCheck(
      matches ? 'match' : 'anomaly',
      expected.available ? 'Disponibile' : 'Non disponibile',
      observedAvailable ? 'Disponibile' : 'Non disponibile',
      facts.availabilityEvidence,
      matches ? null : 'Disponibilità pubblicata diversa dal valore atteso.',
    );
  }

  const pageStatus: ProductCheckResult['page'] = {
    status: 'readable',
    title: page.title || null,
    sourceUrl,
    fetchedAt: page.fetchedAt,
    truncated: page.truncated,
    reason: page.truncated ? 'Il contenuto restituito è parziale.' : null,
  };
  const linkChecks: LinkCheck[] = input.links.map((link) => ({
    ...link,
    status: 'pending',
    title: null,
    reason: null,
    checkedAt: null,
    redirectStatus: 'unverifiable',
  }));
  return productCheckResultSchema.parse({
    expected: { ...expected, currency: 'EUR' },
    page: pageStatus,
    price,
    availability,
    links: linkChecks,
    issues: buildIssues(expected, pageStatus, price, availability, linkChecks),
  });
}

export function updateLinkCheck(
  result: ProductCheckResult,
  linkIndex: number,
  input: { readable: boolean; title: string | null; checkedAt: string; reason: string | null },
): ProductCheckResult {
  const links = result.links.map((link, index) =>
    index === linkIndex
      ? {
          ...link,
          status: input.readable ? ('readable' as const) : ('unverifiable' as const),
          title: input.title,
          reason: input.readable
            ? null
            : (input.reason ?? 'Il contenuto del link non è leggibile.'),
          checkedAt: input.checkedAt,
        }
      : link,
  );
  return productCheckResultSchema.parse({
    ...result,
    links,
    issues: buildIssues(result.expected, result.page, result.price, result.availability, links),
  });
}
