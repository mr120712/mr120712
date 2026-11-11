// @polsia:user-owned — invito a installare l'app Android dalla Home.
'use client';

import { Download, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import styles from './install-app-banner.module.css';

/** Link pubblico della scheda Google Play; vuoto finché l'app non è pubblicata. */
export const GOOGLE_PLAY_URL = '';

export function InstallAppBanner() {
  const [android, setAndroid] = useState(false);
  const [ios, setIos] = useState(false);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setAndroid(/Android/i.test(navigator.userAgent));
    // iPadOS reports itself as Mac: detect touch support too.
    setIos(
      /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1),
    );
    setStandalone(
      window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true ||
        document.referrer.startsWith('android-app://'),
    );
  }, []);

  // Already inside the installed app: nothing to promote.
  if (standalone) return null;

  return (
    <section className={styles.banner} aria-labelledby="install-app-heading">
      <span className={styles.icon} aria-hidden="true">
        <Smartphone />
      </span>
      <div className={styles.copy}>
        <h2 id="install-app-heading">Solco sul tuo telefono</h2>
        <p>
          {ios
            ? 'Aggiungi Solco all’iPhone senza App Store: player, Libreria e radio a schermo intero.'
            : 'Installa l’app: player, Libreria e radio a schermo intero, senza store.'}
        </p>
      </div>
      <div className={styles.actions}>
        {GOOGLE_PLAY_URL ? (
          <Button asChild>
            <a href={GOOGLE_PLAY_URL} target="_blank" rel="noopener noreferrer">
              Scarica da Google Play
            </a>
          </Button>
        ) : null}
        {ios ? (
          <Button asChild>
            <Link href="/app#iphone">
              <Download aria-hidden="true" />
              Installa su iPhone
            </Link>
          </Button>
        ) : android ? (
          <Button asChild variant={GOOGLE_PLAY_URL ? 'outline' : 'default'}>
            <a href="/solco.apk" download="solco.apk">
              <Download aria-hidden="true" />
              Installa l’app
            </a>
          </Button>
        ) : (
          <Button asChild variant={GOOGLE_PLAY_URL ? 'outline' : 'default'}>
            <Link href="/app">
              <Download aria-hidden="true" />
              Installa l’app
            </Link>
          </Button>
        )}
      </div>
    </section>
  );
}
