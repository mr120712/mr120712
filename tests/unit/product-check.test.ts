import { describe, expect, it } from 'vitest';
import { correctionRows } from '@/lib/business/correction-rows';
import {
  createReadableCheckResult,
  createUnreadableCheckResult,
  extractProductLinks,
  offerExtractionSchema,
  updateLinkCheck,
} from '@/lib/business/product-check';
import { SAMPLE_PAGE, SAMPLE_TRUNCATED_PAGE } from '@/modules/web-search/testing';

const pageRead = {
  title: SAMPLE_PAGE.title,
  sourceUrl: 'https://www.citymobility.example/scooters/voltra-s4-pro',
  fetchedAt: SAMPLE_PAGE.fetchedAt,
  truncated: SAMPLE_PAGE.truncated,
};

describe('product check interpretation', () => {
  it('recognizes explicit facts from the web-search sample and compares them with expected values', () => {
    const facts = offerExtractionSchema.parse({
      price: 589.99,
      currency: 'eur',
      availability: 'available',
      priceEvidence: '589.99 EUR',
      availabilityEvidence: 'In stock, ships within 24 h.',
    });
    const result = createReadableCheckResult({
      expected: { priceCents: 58_999, available: true },
      sourceUrl: pageRead.sourceUrl,
      page: pageRead,
      facts,
      links: extractProductLinks(SAMPLE_PAGE.markdown, pageRead.sourceUrl),
    });

    expect(result.page.status).toBe('readable');
    expect(result.price.status).toBe('match');
    expect(result.availability.status).toBe('match');
    expect(result.links.length).toBeGreaterThan(0);
    expect(
      result.issues.some((issue) => issue.field === 'redirect' && issue.kind === 'unverifiable'),
    ).toBe(true);
  });

  it('marks discordant facts as anomalies and retains detected links for individual review', () => {
    const facts = offerExtractionSchema.parse({
      price: 589.99,
      currency: 'EUR',
      availability: 'available',
      priceEvidence: '589.99 EUR',
      availabilityEvidence: 'In stock',
    });
    const result = createReadableCheckResult({
      expected: { priceCents: 57_900, available: false },
      sourceUrl: pageRead.sourceUrl,
      page: pageRead,
      facts,
      links: extractProductLinks(SAMPLE_PAGE.markdown, pageRead.sourceUrl),
    });

    expect(result.price.status).toBe('anomaly');
    expect(result.availability.status).toBe('anomaly');
    expect(result.issues.map((issue) => issue.field)).toContain('price');
    expect(result.issues.map((issue) => issue.field)).toContain('availability');
  });

  it('does not guess from missing or truncated content and records inaccessible pages as unverifiable', () => {
    const result = createReadableCheckResult({
      expected: { priceCents: 57_900, available: true },
      sourceUrl: pageRead.sourceUrl,
      page: { ...pageRead, truncated: SAMPLE_TRUNCATED_PAGE.truncated },
      facts: null,
      links: extractProductLinks(SAMPLE_TRUNCATED_PAGE.markdown, pageRead.sourceUrl),
    });
    const inaccessible = createUnreadableCheckResult(
      { priceCents: 57_900, available: true },
      pageRead.sourceUrl,
      'Pagina non accessibile nel campione di prova.',
    );

    expect(result.price.status).toBe('unverifiable');
    expect(result.availability.status).toBe('unverifiable');
    expect(result.price.reason).toContain('troncato');
    expect(inaccessible.page.status).toBe('unverifiable');
    expect(
      inaccessible.issues.some((issue) => issue.field === 'page' && issue.kind === 'unverifiable'),
    ).toBe(true);
  });

  it('stores a separate correction row for each anomaly or unverifiable field', () => {
    const result = createUnreadableCheckResult(
      { priceCents: 57_900, available: true },
      pageRead.sourceUrl,
      'La pagina non è accessibile.',
    );
    const rows = correctionRows({
      productId: 'product-1',
      productName: 'Prodotto campione',
      productUrl: pageRead.sourceUrl,
      checkedAt: '2026-10-02T09:14:05.000Z',
      result,
    });

    expect(rows).toHaveLength(result.issues.length);
    expect(rows.map((row) => row.field)).toEqual(['Pagina', 'Prezzo', 'Disponibilità']);
    expect(
      rows.every(
        (row) =>
          row.productUrl === pageRead.sourceUrl && row.reason.length > 0 && row.action.length > 0,
      ),
    ).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(
      result.issues.map((issue) => `product-1:${issue.id}`),
    );
  });

  it('updates a link read and continues to flag its redirect as unverifiable', () => {
    const pending = createReadableCheckResult({
      expected: { priceCents: 58_999, available: true },
      sourceUrl: pageRead.sourceUrl,
      page: pageRead,
      facts: offerExtractionSchema.parse({
        price: 589.99,
        currency: 'EUR',
        availability: 'available',
        priceEvidence: '589.99 EUR',
        availabilityEvidence: 'In stock',
      }),
      links: [{ url: 'https://www.citymobility.example/help/delivery', label: 'Free delivery' }],
    });
    const checked = updateLinkCheck(pending, 0, {
      readable: true,
      title: 'Delivery information',
      checkedAt: pageRead.fetchedAt,
      reason: null,
    });

    expect(checked.links[0]?.status).toBe('readable');
    expect(checked.issues.some((issue) => issue.field === 'link')).toBe(false);
    expect(checked.issues.some((issue) => issue.field === 'redirect')).toBe(true);
  });
});
