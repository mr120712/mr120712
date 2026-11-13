// @polsia:user-owned — landing pubblica mostrata su "/" a chi NON è loggato (il muro di login
// reindirizza le altre rotte). Hero con il video dell'app e un pulsante di accesso ben visibile.
'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import styles from './landing-page.module.css';

export function LandingPage() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // muted impostato anche via proprietà: alcuni browser ignorano l'attributo e bloccano l'autoplay.
    video.muted = true;
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      if (reduce) {
        video.pause();
        return;
      }
      const started = video.play?.();
      if (started && typeof started.catch === 'function') started.catch(() => undefined);
    } catch {
      // play()/pause() non disponibili (jsdom) o autoplay bloccato: il poster resta visibile.
    }
  }, []);

  return (
    <main className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.topbar}>
          <span className={styles.brand}>Solco</span>
          <Link className={styles.topLogin} href="/login">
            Accedi
          </Link>
        </header>

        <div className={styles.hero}>
          <div className={styles.copy}>
            <h1 className={styles.title}>La tua musica, in un solo posto.</h1>
            <p className={styles.lead}>
              Brani, radio dal vivo e podcast in un unico player. Accedi per iniziare ad ascoltare.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} href="/login">
                Accedi
              </Link>
              <Link className={styles.secondary} href="/signup">
                Crea un account
              </Link>
            </div>
            <p className={styles.legal}>
              Accedendo accetti i <Link href="/terms">Termini</Link> e la{' '}
              <Link href="/privacy">Privacy</Link>.
            </p>
          </div>

          <div className={styles.frame}>
            {/* Decorativo: nessun audio, in loop. Poster per il primo frame / motion ridotto. */}
            <video
              ref={videoRef}
              className={styles.video}
              src="/landing/intro.mp4"
              poster="/landing/intro-poster.jpg"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
