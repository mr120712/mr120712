// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/web-search@0.2.0. Drift = commit rejected.
//
// Wire schemas for the Polsia web proxy (/api/v2/app-web/*). Safe to import
// from client components: zod only, no env, no secrets, no network.

import { z } from 'zod';

/** Upper bound on `domains` per search. */
export const MAX_SEARCH_DOMAINS = 10;
/** Bounds on `count`, the number of results returned per search. */
export const MIN_SEARCH_COUNT = 1;
export const MAX_SEARCH_COUNT = 20;
/** Bounds on `waitMs`, the render delay granted to JS-heavy pages before reading. */
export const MIN_FETCH_WAIT_MS = 0;
export const MAX_FETCH_WAIT_MS = 10_000;

/** Business error codes the proxy answers with `{ ok: false, error }`. */
export const WEB_SEARCH_ERROR_CODES = [
  'not_enabled',
  'quota_exceeded',
  'invalid_request',
  'invalid_url',
  'page_unavailable',
  'provider_unavailable',
] as const;
export type WebSearchErrorCode = (typeof WEB_SEARCH_ERROR_CODES)[number];

/** `example.com` or `shop.example.co.uk`: a bare hostname, no scheme, no path. */
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOSTNAME_PATTERN, 'expected a bare hostname such as "example.com"');

export const searchInputSchema = z.object({
  query: z.string().trim().min(1, 'query is required'),
  /** Restrict results to these hosts (e.g. retailer sites). */
  domains: z.array(domainSchema).min(1).max(MAX_SEARCH_DOMAINS).optional(),
  count: z.number().int().min(MIN_SEARCH_COUNT).max(MAX_SEARCH_COUNT).optional(),
});

export const fetchPageInputSchema = z.object({
  url: z.string().url(),
  /** Milliseconds to wait for client-side rendering before the page is read. */
  waitMs: z.number().int().min(MIN_FETCH_WAIT_MS).max(MAX_FETCH_WAIT_MS).optional(),
});

/**
 * ISO 8601 UTC date the content was really read (see `ReadDate`). Absent from
 * an older proxy; a null or malformed value is dropped so the call time is used.
 */
const readDateSchema = z.string().datetime().nullish().catch(undefined);

export const searchResultSchema = z.object({
  title: z.string(),
  /** Kept as a plain string: one odd provider URL must not fail the whole page of results. */
  url: z.string(),
  snippet: z.string(),
});

export const searchResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(searchResultSchema),
  /** True when the proxy served its shared cache instead of calling the provider. */
  cached: z.boolean(),
  fetchedAt: readDateSchema,
});

export const fetchPageResponseSchema = z.object({
  ok: z.literal(true),
  markdown: z.string(),
  /** Page title; an untitled page degrades to an empty string rather than failing the parse. */
  title: z.string().catch(''),
  /** True when the markdown was cut at the proxy's size bound. */
  truncated: z.boolean(),
  cached: z.boolean(),
  fetchedAt: readDateSchema,
});

export const webSearchErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  /** Why the proxy refused the request (400 only), e.g. `invalid public web url: <url>`. */
  detail: z.string().optional(),
});

export type SearchInput = z.infer<typeof searchInputSchema>;
export type FetchPageInput = z.infer<typeof fetchPageInputSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;

/** `fetchedAt` as `search` and `fetchPage` return it: always set. */
interface ReadDate {
  /**
   * ISO 8601 UTC date the content was really read: hours before the call when
   * the provider served its own copy, identical across cache hits. Record it
   * as the check date. The call time when the proxy predates the field.
   */
  fetchedAt: string;
}

export type SearchResponse = Omit<z.infer<typeof searchResponseSchema>, 'ok' | 'fetchedAt'> &
  ReadDate;
export type FetchPageResponse = Omit<z.infer<typeof fetchPageResponseSchema>, 'ok' | 'fetchedAt'> &
  ReadDate;
export type WebSearchErrorBody = z.infer<typeof webSearchErrorSchema>;
/** Wire bodies of a successful call, as the proxy sends them. */
export type SearchResponseBody = z.infer<typeof searchResponseSchema>;
export type FetchPageResponseBody = z.infer<typeof fetchPageResponseSchema>;
