// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.19.
//
// The deploy-injected PostHog capture config. Polsia injects it only for the live app of a
// company whose capture is on; previews and test copies never get it. Server-only: the
// root layout passes the values to the client tracker as props, and proxy.ts allows the
// ingestion origin in connect-src. Client code never reads these names.

import type { CspExtraSources } from '@/lib/csp';
import type { PosthogCapture } from '@/lib/polsia-posthog';

const TOKEN = /^phc_[A-Za-z0-9]+$/;
/** A bare https origin: it is written into the CSP header. */
const ORIGIN = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/;
/** Polsia's app id; outside production it carries the environment (`staging:123`, `pr-11311:123`). */
const APP_ID = /^(?:[a-z0-9-]{1,64}:)?[1-9]\d{0,15}$/;

/** The capture config, or null when a value is missing or malformed: no PostHog capture. */
export function posthogCaptureFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): PosthogCapture | null {
  const token = env.POLSIA_ANALYTICS_POSTHOG_TOKEN?.trim();
  const host = env.POLSIA_ANALYTICS_POSTHOG_HOST?.trim();
  const appId = env.POLSIA_ANALYTICS_APP_ID?.trim();
  if (!token || !host || !appId) return null;
  if (!TOKEN.test(token) || !ORIGIN.test(host) || !APP_ID.test(appId)) return null;
  return { token, host, appId };
}

/**
 * The app's CSP extras plus the ingestion origin in connect-src, only when capture is
 * configured: the base policy, which every app's own csp.test.ts pins, never changes.
 */
export function withPosthogConnectSrc(
  extra: CspExtraSources,
  capture: PosthogCapture | null,
): CspExtraSources {
  if (!capture) return extra;
  return { ...extra, connectSrc: [...(extra.connectSrc ?? []), capture.host] };
}
