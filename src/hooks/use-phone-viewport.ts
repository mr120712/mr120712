// @polsia:user-owned — «siamo su un telefono?»: media query sicura per i menu premium (dropdown o
// bottom sheet). Sicura in SSR e in idratazione (sul server e al primo render vale `false`) e anche
// dove `matchMedia` non esiste (jsdom, webview datate): in quel caso resta il layout desktop.
'use client';

import { useCallback, useSyncExternalStore } from 'react';

/** Larghezza «telefono»: sotto i 640 px i menu con molte opzioni si aprono in un bottom sheet. */
export const PHONE_VIEWPORT_QUERY = '(max-width: 639px)';

function canMatchMedia() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/** Segue una media query CSS qualsiasi; `false` sul server, in idratazione e senza matchMedia. */
export function useMediaQueryMatch(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!canMatchMedia()) return () => {};
      const list = window.matchMedia(query);
      // Safari < 14 conosce solo addListener: in quel caso il valore si aggiorna al prossimo render.
      if (typeof list.addEventListener !== 'function') return () => {};
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (canMatchMedia() ? window.matchMedia(query).matches === true : false),
    () => false,
  );
}

/** `true` su viewport stretti (telefoni): vedi PHONE_VIEWPORT_QUERY. */
export function usePhoneViewport(): boolean {
  return useMediaQueryMatch(PHONE_VIEWPORT_QUERY);
}
