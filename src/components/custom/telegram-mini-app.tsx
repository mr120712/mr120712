// @polsia:user-owned — integrazione Telegram Mini App. Quando Solco è aperta DENTRO Telegram
// (deep link ?startapp o pulsante-menu del bot), carica l'SDK ufficiale e si comporta da Mini App
// nativa: ready()/expand(), la chrome di Telegram prende i colori di Solco, viewport e safe-area
// seguono la finestra, e il BackButton di Telegram naviga indietro. Fuori da Telegram NON carica
// nulla (nessuna richiesta a telegram.org per i normali visitatori web).
//
// CSP: lo script dell'SDK è iniettato dal bundle (già fidato dal nonce) → consentito da
// `strict-dynamic` senza aprire `script-src` a host esterni. L'SDK parla col client via postMessage,
// quindi non servono sorgenti connect/frame aggiuntive.
'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  isTelegramLaunch,
  TELEGRAM_WEBAPP_SDK_URL,
  type TelegramWebApp,
} from '@/lib/telegram-mini-app';

/** Sfondo corrente di Solco come #RRGGBB (il browser risolve sempre in rgb). Null se non leggibile. */
function readBackgroundHex(): string | null {
  try {
    const rgb = getComputedStyle(document.body).backgroundColor;
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
    if (!match) return null;
    const toHex = (value: string | undefined) =>
      Number(value ?? 0)
        .toString(16)
        .padStart(2, '0');
    return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
  } catch {
    return null;
  }
}

/** Fa combaciare header e sfondo della chrome di Telegram con lo sfondo di Solco. */
function syncChrome(tg: TelegramWebApp): void {
  const bg = readBackgroundHex();
  if (!bg) return;
  try {
    tg.setBackgroundColor?.(bg);
  } catch {
    /* API non supportata su client vecchi: ignora */
  }
  try {
    tg.setHeaderColor?.(bg);
  } catch {
    /* idem */
  }
}

/** Espone l'altezza stabile della finestra Telegram come variabile CSS (--tg-viewport-stable-height). */
function applyViewport(tg: TelegramWebApp): void {
  const height = tg.viewportStableHeight ?? tg.viewportHeight;
  if (typeof height === 'number' && height > 0) {
    document.documentElement.style.setProperty('--tg-viewport-stable-height', `${height}px`);
  }
}

function initMiniApp(tg: TelegramWebApp): void {
  try {
    tg.ready?.();
  } catch {
    /* ignora */
  }
  try {
    tg.expand?.();
  } catch {
    /* ignora */
  }
  try {
    tg.disableVerticalSwipes?.();
  } catch {
    /* ignora: evita la chiusura accidentale durante lo scroll, se supportato */
  }
  const root = document.documentElement;
  root.dataset.telegramMiniApp = '1';
  if (tg.colorScheme) root.dataset.telegramColorScheme = tg.colorScheme;
  syncChrome(tg);
  applyViewport(tg);
  tg.onEvent?.('viewportChanged', () => applyViewport(tg));
  tg.onEvent?.('themeChanged', () => syncChrome(tg));
}

/** Schermate "radice": lì il BackButton di Telegram resta nascosto. */
const ROOT_ROUTES = new Set(['/', '/bot', '/search', '/radio', '/podcasts', '/library']);

export function TelegramMiniApp() {
  const pathname = usePathname();
  const webAppRef = useRef<TelegramWebApp | null>(null);
  const [ready, setReady] = useState(false);

  // Rileva Telegram e inizializza una sola volta (carica l'SDK solo se serve).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const existing = window.Telegram?.WebApp;
    if (!isTelegramLaunch(window.location.hash, existing)) return;

    let cancelled = false;
    const start = (tg: TelegramWebApp) => {
      if (cancelled) return;
      webAppRef.current = tg;
      initMiniApp(tg);
      setReady(true);
    };

    if (existing) {
      start(existing);
      return;
    }

    const onLoad = () => {
      const tg = window.Telegram?.WebApp;
      if (tg) start(tg);
    };
    let script = document.querySelector<HTMLScriptElement>('script[data-telegram-sdk]');
    if (script) {
      if (window.Telegram?.WebApp) onLoad();
      else script.addEventListener('load', onLoad);
    } else {
      script = document.createElement('script');
      script.src = TELEGRAM_WEBAPP_SDK_URL;
      script.async = true;
      script.dataset.telegramSdk = '1';
      script.addEventListener('load', onLoad);
      document.head.appendChild(script);
    }
    const added = script;
    return () => {
      cancelled = true;
      added.removeEventListener('load', onLoad);
    };
  }, []);

  // BackButton di Telegram legato alla navigazione: visibile fuori dalle schermate radice.
  useEffect(() => {
    if (!ready) return;
    const back = webAppRef.current?.BackButton;
    if (!back) return;
    if (ROOT_ROUTES.has(pathname)) {
      try {
        back.hide?.();
      } catch {
        /* ignora */
      }
      return;
    }
    const handler = () => {
      try {
        window.history.back();
      } catch {
        /* ignora */
      }
    };
    try {
      back.onClick?.(handler);
      back.show?.();
    } catch {
      /* ignora */
    }
    return () => {
      try {
        back.offClick?.(handler);
        back.hide?.();
      } catch {
        /* ignora */
      }
    };
  }, [pathname, ready]);

  return null;
}
