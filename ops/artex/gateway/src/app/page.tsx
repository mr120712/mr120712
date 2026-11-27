/**
 * Root page. Reached only if the middleware's rewrite to /_proxy/ did not fire
 * (misconfigured or disabled). Serves as a last-resort landing that redirects
 * via client JS to /login.
 */
'use client';

import { useEffect } from 'react';

export default function Home() {
  useEffect(() => {
    window.location.replace('/gw-login');
  }, []);
  return (
    <main>
      <h1>ARTEX Gateway</h1>
      <p>Redirecting…</p>
    </main>
  );
}
