// @polsia:user-owned — «Scarica il profilo» della pagina /app (sezione iPhone e iPad), consapevole
// del contesto: dentro la web app già installata (profilo iOS, Web Clip a schermo intero) il link
// non può funzionare, perché solo Safari consegna un profilo a Impostazioni, quindi al suo posto
// compare una nota; nei browser iOS diversi da Safari (Chrome, Firefox, Edge, app con browser
// interno) il link resta ma con l'invito ad aprire la pagina in Safari. Il server rende sempre il
// pulsante (nessun dato del dispositivo lato server); il contesto si legge nel browser dopo il
// montaggio e cambia solo la presentazione.
'use client';

import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import styles from './ios-profile-download.module.css';

/** Route del profilo di configurazione (src/app/ios/solco.mobileconfig/route.ts). */
export const IOS_PROFILE_PATH = '/ios/solco.mobileconfig';

export type IosProfileEnv = {
  userAgent: string;
  maxTouchPoints?: number;
  /** navigator.standalone di iOS: true nella web app aperta dalla schermata Home. */
  standalone?: boolean;
  /** (display-mode: standalone): app installata (iOS, Android TWA). */
  displayModeStandalone?: boolean;
};

/**
 * - 'installed': iPhone/iPad dentro la web app installata (il profilo c'è già);
 * - 'other-browser': iPhone/iPad in un browser che non è Safari (non può installare profili);
 * - 'safari': iPhone/iPad in Safari, il caso che funziona;
 * - 'not-ios': altro dispositivo (il link resta, serve a chi legge da computer).
 */
export type IosProfileContext = 'installed' | 'other-browser' | 'safari' | 'not-ios';

/** Browser iOS diversi da Safari e browser interni delle app: tutti WebKit, nessuno installa profili. */
const OTHER_IOS_BROWSER =
  /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|Brave|GSA\/|FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|Snapchat|BytedanceWebview|musical_ly|TikTok/i;

/** iPhone, iPad o iPod (iPadOS si presenta come Mac: conta il touch). */
export function isIosDevice(env: IosProfileEnv): boolean {
  return (
    /iPhone|iPad|iPod/i.test(env.userAgent) ||
    (/Macintosh/.test(env.userAgent) && (env.maxTouchPoints ?? 0) > 1)
  );
}

export function iosProfileContext(env: IosProfileEnv): IosProfileContext {
  if (!isIosDevice(env)) return 'not-ios';
  if (env.standalone === true || env.displayModeStandalone === true) return 'installed';
  if (OTHER_IOS_BROWSER.test(env.userAgent)) return 'other-browser';
  return 'safari';
}

/** Legge il contesto dal browser; null fuori dal browser. */
export function readIosProfileEnv(): IosProfileEnv | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  let displayModeStandalone = false;
  try {
    displayModeStandalone =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    displayModeStandalone = false;
  }
  return {
    userAgent: typeof navigator.userAgent === 'string' ? navigator.userAgent : '',
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayModeStandalone,
  };
}

/** L'indirizzo della pagina come si legge a voce: senza "https://". */
function readable(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export function IosProfileDownload({ pageUrl }: { pageUrl: string }) {
  const [context, setContext] = useState<IosProfileContext | null>(null);

  useEffect(() => {
    const env = readIosProfileEnv();
    setContext(env ? iosProfileContext(env) : null);
  }, []);

  if (context === 'installed') {
    return (
      <output className={styles.note}>
        Solco è già installato su questo dispositivo: lo stai usando a schermo intero. Per
        installarlo su un altro iPhone o iPad apri <strong>{readable(pageUrl)}</strong> con Safari.
      </output>
    );
  }

  return (
    <>
      <Button asChild size="lg">
        <a href={IOS_PROFILE_PATH}>
          <Download aria-hidden="true" />
          Scarica il profilo
        </a>
      </Button>
      {context === 'other-browser' ? (
        <output className={styles.note}>
          Questo browser non può installare profili: apri <strong>{readable(pageUrl)}</strong> con
          Safari e tocca di nuovo «Scarica il profilo».
        </output>
      ) : null}
    </>
  );
}
