// @polsia:user-owned — segnale di visita per la scheda Visitatori dell'amministrazione: a ogni
// pagina aperta manda a POST /api/visits il solo percorso (e, alla prima pagina, l'indirizzo di
// provenienza, di cui il server tiene l'host). Niente cookie, niente identificativi nel browser,
// niente dati personali; il server conta i visitatori con un'impronta che cambia ogni giorno.
// Non manda nulla se il browser chiede di non essere tracciato (Do Not Track o Global Privacy
// Control), se è un'automazione (webdriver) o nell'area di amministrazione.
'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { type SiteVisitBeacon, VISIT_REFERRER_MAX_LENGTH } from '@/lib/contracts/site-visit';

export const VISIT_ENDPOINT = '/api/visits';

type TrackingNavigator = Pick<Navigator, 'webdriver'> & {
  doNotTrack?: string | null;
  globalPrivacyControl?: boolean;
};

/** False se il browser chiede di non essere tracciato o è guidato da un'automazione. */
export function visitTrackingAllowed(navigatorLike: TrackingNavigator): boolean {
  if (navigatorLike.webdriver) return false;
  if (navigatorLike.doNotTrack === '1') return false;
  if (navigatorLike.globalPrivacyControl === true) return false;
  return true;
}

/** Il percorso da segnalare, o null per le pagine che non si contano (amministrazione). */
export function visitPathFor(pathname: string | null | undefined): string | null {
  if (!pathname || !pathname.startsWith('/')) return null;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return null;
  return pathname;
}

export function VisitBeacon() {
  const pathname = usePathname();
  const lastRef = useRef<string | null>(null);
  const firstRef = useRef(true);

  useEffect(() => {
    const path = visitPathFor(pathname);
    // Lo stesso percorso non si rimanda (effetti ripetuti in sviluppo, ricomposizioni).
    if (!path || lastRef.current === path) return;
    if (!visitTrackingAllowed(navigator)) return;
    lastRef.current = path;
    const body: SiteVisitBeacon = { path };
    if (firstRef.current) {
      firstRef.current = false;
      if (document.referrer) body.referrer = document.referrer.slice(0, VISIT_REFERRER_MAX_LENGTH);
    }
    // keepalive: il segnale parte anche se la pagina viene chiusa subito dopo.
    fetch(VISIT_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }, [pathname]);

  return null;
}
