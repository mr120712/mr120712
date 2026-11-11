// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.19.
//
// Visitor page views in Polsia's customer-app PostHog project: the SDK options of the
// framework tracker (src/components/polsia-posthog.tsx) and the capture policy every event
// passes before it leaves the browser. Only the policy's events leave, with its properties:
// no query string, no hash, no token in a path, no page title, location no finer than the
// country. Every event carries the deploy-injected app id and the policy version. Client-safe:
// no env names here (src/lib/polsia-analytics-env.ts).

import type { CaptureResult, PostHogConfig } from 'posthog-js';

/** What the deploy injects when the company's capture is on. */
export type PosthogCapture = {
  /** The shared customer-app project's public token: it can only add events. */
  token: string;
  /** Polsia's ingestion origin, also allowed in the CSP `connect-src`. */
  host: string;
  /** This app's id in Polsia, the `app_id` of every event (`staging:123` outside production). */
  appId: string;
};

/** Token-bearing page routes of Polsia's modules: the secret path segment is masked. */
const SECRET_ROUTES: readonly RegExp[] = [/^(\/shop\/orders\/)[^/]+/, /^(\/downloads\/)[^/]+/];
const MASKED_SEGMENT = '[token]';

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const UTM_MAX_LENGTH = 200;

/**
 * Bumped with every change to the capture policy below. Every event carries it as
 * `polsia_policy`, so an analysis across apps on different template versions knows which
 * properties an event can have.
 */
export const CAPTURE_POLICY_VERSION = 1;

/** The properties every event in the capture policy may carry. */
const COMMON_PROPERTIES = [
  // Ingestion: project, visitor, session, deduplication, SDK.
  'token',
  'distinct_id',
  '$device_id',
  '$session_id',
  '$window_id',
  '$insert_id',
  '$time',
  '$lib',
  '$lib_version',
  // Anonymous visitors: PostHog creates no person profile for them.
  '$is_identified',
  '$process_person_profile',
  // Device and browser; the user agent lets PostHog flag bots.
  '$browser',
  '$browser_version',
  '$browser_language',
  '$browser_language_prefix',
  '$os',
  '$os_version',
  '$device',
  '$device_type',
  '$raw_user_agent',
  '$screen_height',
  '$screen_width',
  '$viewport_height',
  '$viewport_width',
  // Local time of day. The named time zone is left out: location stays at country level.
  '$timezone_offset',
];

/**
 * The capture policy: each event that may leave the browser, with the properties it may carry
 * besides the common ones. Every other event, and every other property, is dropped.
 */
const CAPTURE_POLICY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    '$pageview',
    new Set([
      ...COMMON_PROPERTIES,
      // The page (URLs scrubbed and paths masked below).
      '$current_url',
      '$host',
      '$pathname',
      '$referrer',
      '$referring_domain',
      // Seconds spent on the previous page of this tab, and its path.
      '$prev_pageview_duration',
      '$prev_pageview_pathname',
      ...UTM_KEYS,
    ]),
  ],
]);

/** Properties holding a URL, scrubbed of query and hash; and holding a path, masked. */
const URL_PROPERTIES = ['$current_url', '$referrer'];
const PATH_PROPERTIES = ['$pathname', '$prev_pageview_pathname'];

/** `pathname` with the secret segment of a token-bearing route masked. */
export function maskPath(pathname: string): string {
  const route = SECRET_ROUTES.find((pattern) => pattern.test(pathname));
  return route ? pathname.replace(route, `$1${MASKED_SEGMENT}`) : pathname;
}

/** A URL without its query string and hash, its path masked; null when it is not a URL. */
export function scrubUrl(value: string): string | null {
  if (value === '$direct') return value;
  try {
    const url = new URL(value);
    return `${url.origin}${maskPath(url.pathname)}`;
  } catch {
    return null;
  }
}

/**
 * The `before_send` filter: the capture policy's events and properties only, scrubbed URLs and
 * masked paths, plus `app_id`, `polsia_policy` and, on a page view, `polsia_load`: `full` for
 * the page load's first page view (the one the pixel counts too), `navigation` for each
 * client-side navigation the tracker sends after it. null drops the event.
 */
export function captureFilter(
  appId: string,
): (event: CaptureResult | null) => CaptureResult | null {
  let fullLoadSent = false;
  return (event) => {
    const allowed = event ? CAPTURE_POLICY.get(event.event) : undefined;
    if (!event || !allowed) return null;
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event.properties ?? {})) {
      if (allowed.has(key) && value !== null && value !== undefined) {
        properties[key] = value;
      }
    }
    for (const key of URL_PROPERTIES) {
      const value = properties[key];
      if (value === undefined) continue;
      const scrubbed = typeof value === 'string' ? scrubUrl(value) : null;
      if (scrubbed === null) delete properties[key];
      else properties[key] = scrubbed;
    }
    for (const key of PATH_PROPERTIES) {
      const value = properties[key];
      if (typeof value === 'string') properties[key] = maskPath(value);
    }
    for (const key of UTM_KEYS) {
      const value = properties[key];
      if (typeof value === 'string') properties[key] = value.slice(0, UTM_MAX_LENGTH);
    }
    properties.app_id = appId;
    properties.polsia_policy = CAPTURE_POLICY_VERSION;
    if (event.event === '$pageview') {
      properties.polsia_load = fullLoadSent ? 'navigation' : 'full';
      fullLoadSent = true;
    }
    // No $set / $set_once: Polsia sets no person property.
    return { uuid: event.uuid, event: event.event, properties, timestamp: event.timestamp };
  };
}

/**
 * The SDK options. Persistence stays per origin, so sibling `*.polsia.app` apps never share a
 * visitor id (`polsia.app` is not on the Public Suffix List). The tracker sends page views
 * itself: the SDK's history patch serves only the first PostHog instance of a page. Nothing
 * else is captured and nothing is fetched from PostHog: no flags call, no remote config, no
 * extension script (the CSP's 'strict-dynamic' would not stop one).
 */
export function posthogOptions(capture: Pick<PosthogCapture, 'host' | 'appId'>) {
  return {
    api_host: capture.host,
    person_profiles: 'identified_only',
    persistence: 'localStorage',
    cross_subdomain_cookie: false,
    capture_pageview: false,
    capture_pageleave: false,
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false,
    disable_scroll_properties: true,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    before_send: captureFilter(capture.appId),
  } satisfies Partial<PostHogConfig>;
}
