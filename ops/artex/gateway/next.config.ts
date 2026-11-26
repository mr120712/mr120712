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
  // Next 16's experimental.serverActions is NOT enabled; the gateway has one
  // server form (magic-link request) and it posts to a route handler.
  experimental: {
    // Stream request body through the proxy without buffering.
    proxyTimeout: 120_000,
  },
  // No image optimization — the gateway serves no images of its own, and the
  // ARTEX UI serves its own assets which the proxy passes through verbatim.
  images: { unoptimized: true },
};

export default nextConfig;
