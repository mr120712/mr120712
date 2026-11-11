// @polsia:user-owned
import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';
import { buildCsp, R2_UPLOAD_HOST } from '@/lib/csp';
import { posthogCaptureFromEnv, withPosthogConnectSrc } from '@/lib/polsia-analytics-env';
import {
  CAPTURE_POLICY_VERSION,
  captureFilter,
  maskPath,
  posthogOptions,
  scrubUrl,
} from '@/lib/polsia-posthog';

const ENV = {
  POLSIA_ANALYTICS_POSTHOG_TOKEN: 'phc_customerApps123',
  POLSIA_ANALYTICS_POSTHOG_HOST: 'https://ingest.example.com',
  POLSIA_ANALYTICS_APP_ID: '4242',
};
const CAPTURE = { token: 'phc_customerApps123', host: 'https://ingest.example.com', appId: '4242' };

const connectSrc = (csp: string) =>
  csp
    .split(';')
    .find((d) => d.trim().startsWith('connect-src '))
    ?.trim();

function pageview(properties: Record<string, unknown>, extra: Partial<CaptureResult> = {}) {
  return { uuid: 'u1', event: '$pageview', properties, ...extra } as CaptureResult;
}

describe('posthogCaptureFromEnv', () => {
  it('reads the three deploy-injected values', () => {
    expect(posthogCaptureFromEnv(ENV)).toEqual(CAPTURE);
  });

  it.each(['staging:42', 'pr-11311:42', 'preview-srv-d4abc:42'])(
    'accepts the environment-scoped app id used outside production (%s)',
    (appId) => {
      expect(posthogCaptureFromEnv({ ...ENV, POLSIA_ANALYTICS_APP_ID: appId })?.appId).toBe(appId);
    },
  );

  it.each(Object.keys(ENV))(
    'is off when %s is missing (no capture, the pixel is unaffected)',
    (key) => {
      expect(posthogCaptureFromEnv({ ...ENV, [key]: undefined })).toBeNull();
      expect(posthogCaptureFromEnv({ ...ENV, [key]: ' ' })).toBeNull();
    },
  );

  it.each([
    ['POLSIA_ANALYTICS_POSTHOG_TOKEN', 'sk_live_123'],
    ['POLSIA_ANALYTICS_POSTHOG_HOST', 'http://ingest.example.com'],
    ['POLSIA_ANALYTICS_POSTHOG_HOST', 'https://ingest.example.com/e'],
    ['POLSIA_ANALYTICS_POSTHOG_HOST', "https://ingest.example.com; script-src 'unsafe-inline'"],
    ['POLSIA_ANALYTICS_APP_ID', 'abc'],
    ['POLSIA_ANALYTICS_APP_ID', '0'],
    ['POLSIA_ANALYTICS_APP_ID', 'Staging:42'],
    ['POLSIA_ANALYTICS_APP_ID', ':42'],
    ['POLSIA_ANALYTICS_APP_ID', 'pr 1:42'],
  ])('is off when %s is malformed (%s)', (key, value) => {
    expect(posthogCaptureFromEnv({ ...ENV, [key]: value })).toBeNull();
  });
});

describe('connect-src for the ingestion origin', () => {
  it('keeps the base policy exactly when capture is off', () => {
    const csp = buildCsp('n', false, '', withPosthogConnectSrc({}, null));
    expect(connectSrc(csp)).toBe(`connect-src 'self' ${R2_UPLOAD_HOST}`);
  });

  it('adds only the ingestion origin when capture is on, after the app extras', () => {
    const extra = withPosthogConnectSrc({ connectSrc: ['https://api.supabase.co'] }, CAPTURE);
    const csp = buildCsp('n', false, '', extra);
    expect(connectSrc(csp)).toBe(
      `connect-src 'self' ${R2_UPLOAD_HOST} https://api.supabase.co https://ingest.example.com`,
    );
    expect(csp).toContain("script-src 'self' 'nonce-n' 'strict-dynamic';");
  });
});

describe('URL scrubbing', () => {
  it('drops the query string and the hash', () => {
    expect(scrubUrl('https://acme.polsia.app/reset?token=abc&email=a@b.co#step')).toBe(
      'https://acme.polsia.app/reset',
    );
    expect(scrubUrl('$direct')).toBe('$direct');
    expect(scrubUrl('not a url')).toBeNull();
  });

  it.each([
    ['/shop/orders/7f3c9a', '/shop/orders/[token]'],
    ['/shop/orders/7f3c9a/receipt', '/shop/orders/[token]/receipt'],
    ['/downloads/dl_8x2k', '/downloads/[token]'],
    ['/admin/shop/orders/12', '/admin/shop/orders/12'],
    ['/shop/orders', '/shop/orders'],
  ])('masks the token of a secret module route: %s', (path, masked) => {
    expect(maskPath(path)).toBe(masked);
  });
});

describe('captureFilter', () => {
  it.each(['$autocapture', '$pageleave', '$identify', '$exception', 'signed_up', 'toString'])(
    'drops %s: only events in the capture policy leave',
    (event) => {
      expect(
        captureFilter('4242')({ uuid: 'u', event, properties: {} } as CaptureResult),
      ).toBeNull();
    },
  );

  it('keeps the policy properties only, scrubbed and masked, with the app id and policy version', () => {
    const out = captureFilter('4242')(
      pageview(
        {
          token: 'phc_customerApps123',
          distinct_id: 'anon-1',
          $process_person_profile: false,
          $current_url: 'https://acme.polsia.app/shop/orders/7f3c9a?session=x#top',
          $pathname: '/shop/orders/7f3c9a',
          $referrer: 'https://news.example.com/story?id=9',
          $referring_domain: 'news.example.com',
          $browser: 'Chrome',
          $browser_version: null,
          $timezone: 'America/Chicago',
          $timezone_offset: 300,
          $prev_pageview_duration: 12.5,
          $prev_pageview_pathname: '/downloads/dl_8x2k',
          $prev_pageview_max_scroll: 900,
          title: 'Order for jane@example.com',
          gclid: 'abc',
          email: 'jane@example.com',
          $session_entry_url: 'https://acme.polsia.app/?token=x',
          utm_source: 'n'.repeat(300),
        },
        { $set_once: { $initial_current_url: 'https://acme.polsia.app/?token=x' } },
      ),
    );

    expect(out).toEqual({
      uuid: 'u1',
      event: '$pageview',
      timestamp: undefined,
      properties: {
        token: 'phc_customerApps123',
        distinct_id: 'anon-1',
        $process_person_profile: false,
        $current_url: 'https://acme.polsia.app/shop/orders/[token]',
        $pathname: '/shop/orders/[token]',
        $referrer: 'https://news.example.com/story',
        $referring_domain: 'news.example.com',
        $browser: 'Chrome',
        $timezone_offset: 300,
        $prev_pageview_duration: 12.5,
        $prev_pageview_pathname: '/downloads/[token]',
        utm_source: 'n'.repeat(200),
        app_id: '4242',
        polsia_policy: CAPTURE_POLICY_VERSION,
        polsia_load: 'full',
      },
    });
  });

  it('marks the first page view as the full load and the next ones as navigations', () => {
    const filter = captureFilter('4242');
    const loads = [1, 2, 3].map(() => filter(pageview({}))?.properties.polsia_load);
    expect(loads).toEqual(['full', 'navigation', 'navigation']);
  });
});

describe('posthogOptions', () => {
  it('captures anonymous page views only, per origin, with nothing fetched from PostHog', () => {
    const options = posthogOptions(CAPTURE);
    expect(options).toMatchObject({
      api_host: 'https://ingest.example.com',
      person_profiles: 'identified_only',
      persistence: 'localStorage',
      cross_subdomain_cookie: false,
      capture_pageview: false,
      capture_pageleave: false,
      autocapture: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
    });
    expect(options.before_send(pageview({}))?.properties.app_id).toBe('4242');
  });
});
