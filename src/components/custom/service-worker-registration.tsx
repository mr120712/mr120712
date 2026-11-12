// @polsia:user-owned — registra il Service Worker di public/sw.js (guscio offline di Solco).
//
// Solo in produzione e solo se il browser lo supporta; non lancia mai errori. Si registra dopo
// l'evento load, per non togliere banda alla prima visita. Fuori produzione toglie un sw.js
// rimasto da una prova con `npm start` sulla stessa origine. Gli aggiornamenti
// non interrompono mai l'ascolto: la nuova versione aspetta ("waiting") e si attiva con
// SKIP_WAITING solo quando la pagina va in secondo piano o alla navigazione successiva; la pagina
// si ricarica al massimo una volta e mai se c'è un brano in riproduzione o in pausa nei controlli
// di sistema. Vedi docs/offline.md.

'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

export const SERVICE_WORKER_URL = '/sw.js';
export const SERVICE_WORKER_SCOPE = '/';
export const SKIP_WAITING_MESSAGE = { type: 'SKIP_WAITING' } as const;
/** Ogni quanto, al massimo, chiedere al browser se c'è un sw.js nuovo quando si torna sull'app. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Le cache create da public/sw.js: le altre cache del sito non si toccano. */
export const SERVICE_WORKER_CACHE_PREFIXES = ['solco-shell-', 'solco-static-'] as const;

export type ServiceWorkerHandle = {
  /** Da chiamare a ogni cambio di pagina lato client (navigazione successiva). */
  onNavigation: () => void;
  dispose: () => void;
};

export type StartServiceWorkerOptions = {
  /** Ricarica la pagina (iniettabile nei test: jsdom non permette di sostituire location). */
  reload?: () => void;
  now?: () => number;
};

const NOOP_HANDLE: ServiceWorkerHandle = { onNavigation: () => {}, dispose: () => {} };

/**
 * C'è musica attiva? Un elemento <audio>/<video> che suona, oppure una sessione multimediale in
 * riproduzione o in pausa (schermata di blocco, notifica Android): ricaricare la cancellerebbe.
 */
export function isMediaActive(doc: Document = document): boolean {
  try {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    const state = session?.playbackState;
    if (state === 'playing' || state === 'paused') return true;
    for (const media of Array.from(doc.querySelectorAll('audio, video'))) {
      const element = media as HTMLMediaElement;
      if (!element.paused && !element.ended) return true;
    }
    return false;
  } catch {
    // Nel dubbio, non ricaricare.
    return true;
  }
}

function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function isOwnWorker(worker: ServiceWorker | null | undefined): boolean {
  if (!worker?.scriptURL) return false;
  try {
    return new URL(worker.scriptURL).pathname === SERVICE_WORKER_URL;
  } catch {
    return false;
  }
}

/**
 * Fuori produzione: toglie il /sw.js rimasto da una prova con `npm start` sulla stessa origine
 * (es. localhost:3000) e le sue cache, che altrimenti servirebbero a `npm run dev` il codice
 * vecchio. Non lancia mai errori.
 */
export async function unregisterStaleServiceWorker(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    if (typeof container?.getRegistrations !== 'function') return;
    const registrations = await container.getRegistrations();
    const stale = registrations.filter((registration) =>
      [registration.active, registration.waiting, registration.installing].some(isOwnWorker),
    );
    if (stale.length === 0) return;
    await Promise.all(stale.map((registration) => registration.unregister().catch(() => false)));
    if (typeof caches === 'undefined') return;
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => SERVICE_WORKER_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)))
        .map((name) => caches.delete(name)),
    );
  } catch {
    // Ignorato: in sviluppo si può sempre togliere a mano (DevTools → Application).
  }
}

/**
 * Registra /sw.js e gestisce gli aggiornamenti. Restituisce sempre un handle (vuoto fuori
 * produzione, senza supporto o in caso di errore).
 */
export function startServiceWorker(options: StartServiceWorkerOptions = {}): ServiceWorkerHandle {
  try {
    if (process.env.NODE_ENV !== 'production') {
      void unregisterStaleServiceWorker();
      return NOOP_HANDLE;
    }
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return NOOP_HANDLE;
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker) return NOOP_HANDLE;

    const container = navigator.serviceWorker;
    const reload = options.reload ?? (() => window.location.reload());
    const now = options.now ?? (() => Date.now());

    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;
    /** Una nuova versione è installata e aspetta. */
    let updateWaiting = false;
    /** Perché è stato inviato SKIP_WAITING (null: non ancora inviato). */
    let applyReason: 'hidden' | 'navigation' | null = null;
    let reloaded = false;
    let lastUpdateCheck = now();
    let watchedInstalling: ServiceWorker | null = null;
    let registerStarted = false;

    const applyUpdate = (reason: 'hidden' | 'navigation') => {
      if (disposed || !updateWaiting || applyReason) return;
      const waiting = registration?.waiting;
      if (!waiting) return;
      applyReason = reason;
      try {
        waiting.postMessage(SKIP_WAITING_MESSAGE);
      } catch {
        applyReason = null;
      }
    };

    const markWaiting = () => {
      // Senza un controller è la prima installazione: niente da aggiornare.
      if (disposed || !container.controller || !registration?.waiting) return;
      updateWaiting = true;
      if (isPageHidden()) applyUpdate('hidden');
    };

    const onInstallingStateChange = () => {
      if (watchedInstalling?.state === 'installed') markWaiting();
    };

    const onUpdateFound = () => {
      try {
        watchedInstalling?.removeEventListener('statechange', onInstallingStateChange);
        watchedInstalling = registration?.installing ?? null;
        watchedInstalling?.addEventListener('statechange', onInstallingStateChange);
      } catch {
        // Ignorato: l'aggiornamento verrà rilevato alla prossima registrazione.
      }
    };

    const onControllerChange = () => {
      if (disposed || reloaded || !applyReason) return;
      // Ricarica una sola volta: alla navigazione successiva o con la pagina nascosta, e mai con
      // musica attiva (la nuova versione resta comunque attiva per le prossime richieste).
      const allowed = applyReason === 'navigation' || isPageHidden();
      if (!allowed || isMediaActive()) return;
      reloaded = true;
      try {
        reload();
      } catch {
        // Ignorato.
      }
    };

    const onVisibilityChange = () => {
      if (disposed) return;
      if (isPageHidden()) {
        applyUpdate('hidden');
        return;
      }
      if (registration && now() - lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS) {
        lastUpdateCheck = now();
        registration.update().catch(() => undefined);
      }
    };

    const register = () => {
      if (disposed || registerStarted) return;
      registerStarted = true;
      Promise.resolve()
        .then(() => container.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE }))
        .then((result) => {
          if (disposed || !result) return;
          registration = result;
          registration.addEventListener('updatefound', onUpdateFound);
          if (registration.installing) onUpdateFound();
          markWaiting();
        })
        .catch(() => undefined);
    };

    container.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // L'installazione scarica decine di file: dopo l'evento load, così non toglie banda a
    // immagini, font e video della prima visita.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    return {
      onNavigation: () => {
        try {
          applyUpdate('navigation');
        } catch {
          // Ignorato.
        }
      },
      dispose: () => {
        disposed = true;
        try {
          container.removeEventListener('controllerchange', onControllerChange);
          document.removeEventListener('visibilitychange', onVisibilityChange);
          window.removeEventListener('load', register);
          registration?.removeEventListener('updatefound', onUpdateFound);
          watchedInstalling?.removeEventListener('statechange', onInstallingStateChange);
        } catch {
          // Ignorato.
        }
      },
    };
  } catch {
    return NOOP_HANDLE;
  }
}

/** Montato una volta da global-mounts.tsx. Non mostra nulla. */
export function ServiceWorkerRegistration() {
  const pathname = usePathname();
  const handle = useRef<ServiceWorkerHandle | null>(null);
  const lastPathname = useRef(pathname);

  useEffect(() => {
    const current = startServiceWorker();
    handle.current = current;
    return () => {
      current.dispose();
      handle.current = null;
    };
  }, []);

  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    handle.current?.onNavigation();
  }, [pathname]);

  return null;
}
