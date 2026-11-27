import type { NextConfig } from 'next';

/**
 * Minimal Next.js config for the ARTEX gateway.
 *
 * The gateway owns the host (artex.solcomusic.online) completely: Caddy sends every
 * request here; we authenticate it (Better Auth magic link allowlisted to one admin
 * email) and only then rewrite to the catch-all /_proxy/* route that forwards to
 * ARTEX at http://artex:8787 on the compose network. No standalone output — we ship
 * .next + node_modules + prisma to a thin runner image.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  poweredByHeader: false,
  // ARTEX is a Next.js app upstream and also serves its own chunks at
  // /_next/*. Without a distinct assetPrefix the gateway's chunks and
  // ARTEX's chunks both live at /_next/static/* on the same hostname and
  // overwrite each other, which shows up as a blank page after login
  // (ARTEX's HTML points at /_next/* but the gateway serves its own
  // chunks there). Isolate the gateway's chunks under a prefix so
  // /_next/* stays available for the proxy to forward to ARTEX.
  assetPrefix: '/__gw_assets',
  experimental: {
    proxyTimeout: 120_000,
  },
  images: { unoptimized: true },
};

export default nextConfig;
