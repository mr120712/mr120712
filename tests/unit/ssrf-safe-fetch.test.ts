// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  assertSafeHttpsUrl,
  hasOnlyPublicAddresses,
  isPrivateAddress,
  ssrfSafeFetch,
} from '@/lib/net/ssrf-safe-fetch.server';

describe('isPrivateAddress', () => {
  const privateCases = [
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254', // metadata/link-local
    '100.64.0.1', // CGNAT
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.1',
    '224.0.0.1', // multicast
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'febf::1',
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.1', // IPv4-mapped private
    'not-an-ip', // non-IP → treated unsafe
  ];
  for (const addr of privateCases) {
    it(`rejects ${addr}`, () => expect(isPrivateAddress(addr)).toBe(true));
  }

  const publicCases = [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // just below the private 172.16/12 block
    '172.32.0.1', // just above
    '203.0.113.7',
    '2606:4700:4700::1111', // Cloudflare IPv6
    '::ffff:8.8.8.8', // IPv4-mapped public
  ];
  for (const addr of publicCases) {
    it(`allows ${addr}`, () => expect(isPrivateAddress(addr)).toBe(false));
  }
});

describe('hasOnlyPublicAddresses', () => {
  it('false for empty', () => expect(hasOnlyPublicAddresses([])).toBe(false));
  it('false if any is private', () =>
    expect(hasOnlyPublicAddresses(['8.8.8.8', '10.0.0.1'])).toBe(false));
  it('true if all public', () => expect(hasOnlyPublicAddresses(['8.8.8.8', '1.1.1.1'])).toBe(true));
});

describe('assertSafeHttpsUrl', () => {
  it('accepts a normal https url', () => {
    expect(assertSafeHttpsUrl('https://feeds.example.com/rss').hostname).toBe('feeds.example.com');
  });
  it('accepts explicit port 443 (URL normalizes it away)', () => {
    const url = assertSafeHttpsUrl('https://feeds.example.com:443/rss');
    expect(url.hostname).toBe('feeds.example.com');
    expect(url.port).toBe('');
  });
  it('rejects http', () => expect(() => assertSafeHttpsUrl('http://feeds.example.com')).toThrow());
  it('rejects credentials', () =>
    expect(() => assertSafeHttpsUrl('https://user:pass@feeds.example.com')).toThrow());
  it('rejects localhost', () => expect(() => assertSafeHttpsUrl('https://localhost/x')).toThrow());
  it('rejects .internal', () =>
    expect(() => assertSafeHttpsUrl('https://svc.internal/x')).toThrow());
  it('rejects a non-443 port', () =>
    expect(() => assertSafeHttpsUrl('https://feeds.example.com:8443/x')).toThrow());
});

describe('ssrfSafeFetch guards before any connection', () => {
  it('rejects a non-https url without hitting the network', async () => {
    await expect(ssrfSafeFetch('http://example.com')).rejects.toThrow();
  });
  it('rejects credentials in the url', async () => {
    await expect(ssrfSafeFetch('https://user:pass@example.com')).rejects.toThrow();
  });
  it('rejects a non-443 port', async () => {
    await expect(ssrfSafeFetch('https://example.com:9000/x')).rejects.toThrow();
  });
});
