// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  productFindFirst: vi.fn(),
  checkCreate: vi.fn(),
  checkUpdate: vi.fn(),
  fetchPage: vi.fn(),
  generateObject: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/db', () => ({
  prisma: {
    product: { findFirst: mocks.productFindFirst },
    productCheck: { create: mocks.checkCreate, update: mocks.checkUpdate },
  },
}));
vi.mock('@/lib/ai/client', () => ({ generateObject: mocks.generateObject }));
vi.mock('@/modules/web-search/client', () => ({
  fetchPage: mocks.fetchPage,
  InvalidUrlError: class InvalidUrlError extends Error {},
  PageUnavailableError: class PageUnavailableError extends Error {},
  QuotaExceededError: class QuotaExceededError extends Error {},
  WebSearchConfigurationError: class WebSearchConfigurationError extends Error {},
  WebSearchError: class WebSearchError extends Error {},
  WebSearchNotEnabledError: class WebSearchNotEnabledError extends Error {},
  WebSearchUnavailableError: class WebSearchUnavailableError extends Error {},
}));

import { POST } from '@/app/api/products/[productId]/checks/route';

const product = {
  id: 'product-1',
  name: 'Album',
  url: 'https://shop.example.test/album',
  expectedPriceCents: 2500,
  expectedAvailability: true,
  updatedAt: new Date('2026-11-01T00:00:00.000Z'),
};

function request(body: string, contentLength?: string) {
  return new Request('https://solco.test/api/products/product-1/checks', {
    method: 'POST',
    headers: {
      origin: 'https://solco.test',
      'content-type': 'application/json',
      ...(contentLength ? { 'content-length': contentLength } : {}),
    },
    body,
  });
}

const params = { params: Promise.resolve({ productId: product.id }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.productFindFirst.mockResolvedValue(product);
  mocks.checkCreate.mockResolvedValue({ id: 'check-1', createdAt: new Date(), checkedAt: null });
  mocks.checkUpdate.mockResolvedValue({ id: 'check-1', createdAt: new Date(), checkedAt: null });
  mocks.fetchPage.mockResolvedValue({
    markdown: 'Prezzo 25 EUR',
    title: 'Album',
    fetchedAt: new Date().toISOString(),
    truncated: false,
  });
  mocks.generateObject.mockResolvedValue({
    price: null,
    currency: null,
    availability: 'unknown',
    priceEvidence: null,
    availabilityEvidence: null,
  });
});

describe('avvio dei controlli prodotto', () => {
  it('nega prima di creare il risultato o chiamare web-search e AI', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json(
        { error: 'rate_limited', message: 'Riprova tra 600 secondi.', retryAfterSeconds: 600 },
        { status: 429, headers: { 'Retry-After': '600' } },
      ),
    );

    const response = await POST(request('{}'), params);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('600');
    expect(mocks.productFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: product.id, shop: { userId: 'user-1' } } }),
    );
    expect(mocks.checkCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPage).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it('fa prevalere autenticazione, integrità dell’input e dimensione massima', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    const unauthenticated = await POST(request('{}'), params);
    expect(unauthenticated.status).toBe(401);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.productFindFirst).not.toHaveBeenCalled();

    const invalid = await POST(request('{"unexpected":true}'), params);
    expect(invalid.status).toBe(400);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();

    const oversized = await POST(request('{}', '2048'), params);
    expect(oversized.status).toBe(413);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkCreate).not.toHaveBeenCalled();
  });
});
