// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/web-search@0.2.0. Drift = commit rejected.
//
// Typed sample responses of the Polsia web proxy, for unit tests: the app's
// sandbox cannot call the proxy. Same shapes as real answers (raw markdown
// snippets, hosts with and without `www.`, HTML entities in titles, empty
// titles, pages opening on an off-topic banner), invented text. Data and
// types only: no test runner, no network.
//
// Two ways to use them:
// - jsdom test: mock the client module and return the parsed responses.
//     vi.mock('@/modules/web-search/client', async (importOriginal) => ({
//       ...(await importOriginal<typeof import('@/modules/web-search/client')>()),
//       search: vi.fn(async () => SAMPLE_SEARCH_RESPONSE),
//     }));
// - node test (`// @vitest-environment node` on the first line: `search` and
//   `fetchPage` refuse to run where `window` exists): stub `fetch` with a wire
//   body and its status, and mock `@/lib/env` (validated at import in node).
//     vi.mock('@/lib/env', () => ({ env: { POLSIA_API_BASE_URL: 'https://polsia.test', POLSIA_API_KEY: 'test-key' } }));
//     vi.stubGlobal('fetch', async () => Response.json(SAMPLE_PAGE_BODY));
//     const { status, body } = SAMPLE_ERROR_RESPONSES.quotaExceeded;
//     vi.stubGlobal('fetch', async () => Response.json(body, { status }));

import type {
  FetchPageResponse,
  FetchPageResponseBody,
  SearchResponse,
  SearchResponseBody,
  WebSearchErrorBody,
  WebSearchErrorCode,
} from '@/modules/web-search/schema';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** Read at call time: the proxy called its provider for this search. */
const SEARCH_FETCHED_AT = '2026-10-02T09:14:05.000Z';
/** About 6 h before the call: the provider served its own copy of the page. */
const PAGE_FETCHED_AT = '2026-10-02T03:29:15.000Z';
/** Served from the proxy's one-hour cache: the date of the first read. */
const CACHED_PAGE_FETCHED_AT = '2026-10-02T08:47:51.000Z';

const SHOP = 'https://www.citymobility.example';

/** Customer reviews and listing lines that make the sample pages long. */
const PAGE_REVIEW_COUNT = 24;
const REVIEW_MAX_STARS = 5;
const LISTING_LINE_COUNT = 400;
const LISTING_FIRST_PRICE_EUR = 299;
/** Where the truncated sample page is cut (the real proxy cuts far later). */
const TRUNCATED_PAGE_CHARS = 9_000;

/** Raw markdown extract of a price comparison page, as search snippets are (1 000 to 2 000 chars). */
const PRICE_SNIPPET = [
  '# Voltra S4 Pro (2nd gen)  ',
  '[Max load: 120 kg](#specs) · [Range: 55 km](#specs) · [Compare](https://scooterprices.example/compare?ids=4411)',
  '## Price history  ',
  'The chart shows the lowest price seen across tracked shops over the last 90 days. [How we track prices](https://scooterprices.example/help/price-history)',
  '## Product information  ',
  'The best price for the Voltra S4 Pro (2nd gen) is currently 579.00 EUR, seen at 3 of 9 shops. Delivery is free at 6 shops. Prices may have changed since our last check.',
  '| Shop | Price | Delivery | Stock |',
  '| --- | --- | --- | --- |',
  '| [Rolling Store](https://scooterprices.example/go/rolling-store/4411) | 579.00 EUR | free | in stock |',
  '| [City Mobility](https://scooterprices.example/go/citymobility/4411) | 589.99 EUR | free | in stock |',
  '| [Volt Outlet](https://scooterprices.example/go/volt-outlet/4411) | 612.00 EUR | 9.90 EUR | 2 to 4 days |',
  '## Specs  ',
  '- Motor: 350 W rated, 700 W peak',
  '- Battery: 474 Wh, charge time 8.5 h',
  '- Top speed: 25 km/h (limited by law)',
  '- Weight: 17.4 kg, foldable stem',
  '[See all 42 specs](https://scooterprices.example/voltra-s4-pro/specs)',
  '## User reviews  ',
  '4.4 / 5 from 1,208 reviews. "Solid build, the brake lever squeaks after a month." [Read all reviews](https://scooterprices.example/voltra-s4-pro/reviews)',
].join('\n');

/** A search answer: raw snippets, one host without `www.`, one with, one deeper subdomain. */
export const SAMPLE_SEARCH_RESPONSE: SearchResponse = {
  results: [
    {
      title: 'Voltra S4 Pro: today&#x27;s best price from 9 shops',
      url: 'https://scooterprices.example/voltra-s4-pro',
      snippet: PRICE_SNIPPET,
    },
    {
      title: 'Voltra S4 Pro electric scooter, 2nd gen | City Mobility',
      url: `${SHOP}/scooters/voltra-s4-pro`,
      snippet: [
        '[Skip to content](#main)',
        '# Voltra S4 Pro electric scooter, 2nd gen',
        '589.99 EUR ~~649.00 EUR~~  ',
        'In stock, ships within 24 h. [Free delivery](https://www.citymobility.example/help/delivery) from 50 EUR.',
        '## Description  ',
        'A foldable commuter scooter with a 474 Wh battery and tubeless 10 inch tyres.',
      ].join('\n'),
    },
    {
      title: '',
      url: 'https://forum.urbanride.example/t/voltra-s4-pro-range-test/1182',
      snippet: [
        '## Range test: Voltra S4 Pro, 3 weeks of commuting',
        'Posted by **kilometre_counter**  ',
        'Real range at 20 km/h with an 80 kg rider: 38 km, not the 55 km of the box. [Full log](https://forum.urbanride.example/t/1182/log)',
      ].join('\n'),
    },
  ],
  cached: false,
  fetchedAt: SEARCH_FETCHED_AT,
};

/** A search that matched nothing. */
export const SAMPLE_EMPTY_SEARCH_RESPONSE: SearchResponse = {
  results: [],
  cached: false,
  fetchedAt: SEARCH_FETCHED_AT,
};

const PAGE_BANNER = [
  '[Skip to content](#main)',
  '',
  `> Autumn sale: a free helmet with every scooter until Sunday. [Shop the sale](${SHOP}/sale)`,
  '',
  `[Sign in](${SHOP}/account) | [Stores](${SHOP}/stores) | [Cart (0)](${SHOP}/cart)`,
  '',
  `- [Scooters](${SHOP}/scooters)`,
  `- [E-bikes](${SHOP}/e-bikes)`,
  `- [Helmets](${SHOP}/helmets)`,
  `- [Spare parts](${SHOP}/parts)`,
  '',
].join('\n');

const PAGE_REVIEWS = Array.from(
  { length: PAGE_REVIEW_COUNT },
  (_, i) =>
    `- **Rider ${i + 1}**, ${(i % REVIEW_MAX_STARS) + 1} / ${REVIEW_MAX_STARS}: folds in seconds, the app pairing took two tries. [Helpful](${SHOP}/reviews/${i + 1}/vote)`,
).join('\n');

/** A product page: an off-topic banner first, the facts after it. */
export const SAMPLE_PAGE: FetchPageResponse = {
  markdown: [
    PAGE_BANNER,
    '# Voltra S4 Pro electric scooter, 2nd gen',
    '',
    '589.99 EUR ~~649.00 EUR~~',
    '',
    'In stock, ships within 24 h. Free delivery from 50 EUR.',
    '',
    '## Specifications',
    '',
    '| Spec | Value |',
    '| --- | --- |',
    '| Battery | 474 Wh |',
    '| Range | up to 55 km |',
    '| Top speed | 25 km/h |',
    '| Weight | 17.4 kg |',
    '',
    '## Customer reviews',
    '',
    PAGE_REVIEWS,
    '',
    `[Terms](${SHOP}/terms) | [Privacy](${SHOP}/privacy) | [Cookie settings](${SHOP}/cookies)`,
  ].join('\n'),
  title: 'Voltra S4 Pro electric scooter, 2nd gen | City Mobility',
  truncated: false,
  cached: false,
  fetchedAt: PAGE_FETCHED_AT,
};

const LISTING = Array.from(
  { length: LISTING_LINE_COUNT },
  (_, i) =>
    `- [Scooter model ${i + 1}](${SHOP}/scooters/model-${i + 1}) ${(LISTING_FIRST_PRICE_EUR + i).toFixed(2)} EUR, in stock`,
).join('\n');

/** A page too long for the proxy: the markdown stops mid-line, `truncated` is true. */
export const SAMPLE_TRUNCATED_PAGE: FetchPageResponse = {
  markdown: `${PAGE_BANNER}# All scooters\n\n${LISTING}`.slice(0, TRUNCATED_PAGE_CHARS),
  title: 'All scooters | City Mobility',
  truncated: true,
  cached: true,
  fetchedAt: CACHED_PAGE_FETCHED_AT,
};

/** Wire bodies of the samples above, as `fetch` receives them (HTTP 200). */
export const SAMPLE_SEARCH_BODY: SearchResponseBody = { ok: true, ...SAMPLE_SEARCH_RESPONSE };
export const SAMPLE_EMPTY_SEARCH_BODY: SearchResponseBody = {
  ok: true,
  ...SAMPLE_EMPTY_SEARCH_RESPONSE,
};
export const SAMPLE_PAGE_BODY: FetchPageResponseBody = { ok: true, ...SAMPLE_PAGE };
export const SAMPLE_TRUNCATED_PAGE_BODY: FetchPageResponseBody = {
  ok: true,
  ...SAMPLE_TRUNCATED_PAGE,
};

/** A proxy error: its HTTP status and JSON body. */
export interface SampleErrorResponse {
  status: number;
  body: WebSearchErrorBody & { error: WebSearchErrorCode };
}

/** Proxy errors, keyed by what they mean; comments name the error the client throws. */
export const SAMPLE_ERROR_RESPONSES = {
  /** `InvalidUrlError`: private, malformed or unresolvable URL. Do not retry it. */
  invalidUrl: {
    status: HTTP_BAD_REQUEST,
    body: {
      ok: false,
      error: 'invalid_url',
      detail: 'invalid public web url: http://10.0.0.12/admin',
    },
  },
  /** `WebSearchError`, code `invalid_request`. */
  invalidRequest: {
    status: HTTP_BAD_REQUEST,
    body: {
      ok: false,
      error: 'invalid_request',
      detail: 'domain must be a bare hostname: citymobility.example/scooters',
    },
  },
  /** `PageUnavailableError`: skip this URL. */
  pageUnavailable: {
    status: HTTP_UNPROCESSABLE,
    body: { ok: false, error: 'page_unavailable' },
  },
  /** `QuotaExceededError`: stops `runBatch`; retry the next UTC day. */
  quotaExceeded: {
    status: HTTP_TOO_MANY_REQUESTS,
    body: { ok: false, error: 'quota_exceeded' },
  },
  /** `WebSearchUnavailableError`, code `provider_unavailable`: transient. */
  providerUnavailable: {
    status: HTTP_SERVICE_UNAVAILABLE,
    body: { ok: false, error: 'provider_unavailable' },
  },
  /** `WebSearchNotEnabledError`: stops `runBatch`. */
  notEnabled: {
    status: HTTP_NOT_FOUND,
    body: { ok: false, error: 'not_enabled' },
  },
} satisfies Record<string, SampleErrorResponse>;
