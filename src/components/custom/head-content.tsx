// @polsia:user-owned — extra <head> rendered by the framework layout (null by default).
// Add <meta>/<link> here (verification, preconnect) — React hoists them. For scripts use
// next/script with the passed `nonce` (CSP-safe). Edit freely.

export function HeadContent({ nonce }: { nonce?: string }) {
  void nonce;
  return (
    <>
      <link
        rel="preload"
        href="/fonts/space-grotesk/space-grotesk-600-normal-latin.woff2"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
      />
      {/* iPhone/iPad: icon and full-screen mode when Solco is added to the Home screen. */}
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-title" content="Solco" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black" />
    </>
  );
}
