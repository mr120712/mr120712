// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.19.
//
// Visitor page views in Polsia's customer-app PostHog project, from the deploy-injected
// token, ingestion origin and app id. The SDK loads after first paint on its own instance;
// this component sends one page view when it starts and one per client-side navigation
// (pathname change), so another PostHog in the app can never take them over. Independent of
// the pixel (polsia-analytics.tsx), which keeps counting full page loads. Any failure stays
// silent: the page never breaks.
'use client';

import { usePathname } from 'next/navigation';
import type { PostHog } from 'posthog-js';
import { useEffect, useRef } from 'react';
import { type PosthogCapture, posthogOptions } from '@/lib/polsia-posthog';

/** The SDK instance name: `posthog.init` keeps it apart from the default instance. */
const INSTANCE = 'polsia';

export function PolsiaPosthog({ token, host, appId }: PosthogCapture) {
  const pathname = usePathname();
  const client = useRef<PostHog | null>(null);
  /** The latest pathname, and the one the last page view was sent for. */
  const currentPath = useRef(pathname);
  const sentPath = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const start = () => {
      import('posthog-js')
        .then(({ default: posthog }) => {
          if (cancelled) return;
          const instance = posthog.init(token, posthogOptions({ host, appId }), INSTANCE);
          if (!instance) return;
          client.current = instance;
          sentPath.current = currentPath.current;
          instance.capture('$pageview');
        })
        .catch(() => {
          // best-effort: analytics must never surface to the visitor
        });
    };
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(start, { timeout: 2000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idle);
      };
    }
    const timer = window.setTimeout(start, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [token, host, appId]);

  useEffect(() => {
    currentPath.current = pathname;
    const instance = client.current;
    if (!instance || pathname === sentPath.current) return;
    sentPath.current = pathname;
    try {
      instance.capture('$pageview');
    } catch {
      // best-effort: analytics must never surface to the visitor
    }
  }, [pathname]);

  return null;
}
