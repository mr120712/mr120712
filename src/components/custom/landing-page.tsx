// @polsia:user-owned — landing pubblica mostrata su "/" a chi NON è loggato (il muro di login
// reindirizza le altre rotte). Hero con il video dell'app e un pulsante di accesso ben visibile.
'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import styles from './landing-page.module.css';

/** Riassunto breve dei vantaggi per piano (i dettagli completi sono su /piani dopo l'accesso). */
const PLAN_SUMMARY: Record<string, { tagline: string; perks: string[]; featured?: boolean }> = {
  free: {
    tagline: 'Per iniziare',
    perks: ['40 ascolti al mese', 'Radio e YouTube senza limiti', 'Libreria e playlist'],
  },
  premium: {
    tagline: 'Il più scelto',
    perks: ['Ascolti illimitati', 'Cerca con l’AI', 'Ascolto in background illimitato'],
    featured: true,
  },
  'premium-plus': {
    tagline: 'Per chi vuole di più',
    perks: ['Tutto Premium', 'Statistiche avanzate e temi extra', 'Creazione di brani'],
  },
  family: {
    tagline: 'Per tutta la famiglia',
    perks: ['Tutti i vantaggi Premium', 'Fino a 6 account', 'Un unico abbonamento'],
  },
};

function formatEuro(cents: number): string {
  if (cents === 0) return 'Gratis';
  return `€${(cents / 100).toFixed(2).replace('.', ',')}`;
}

/** Parole della striscia scorrevole "virale" sotto l'hero. */
const MARQUEE = [
  'Musica',
  'Radio dal vivo',
  'Podcast',
  'Classifiche',
  'In background',
  'Offline',
  'Gratis',
];

export function LandingPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const { plans } = getSolcoProPricing();

  useEffect(() => {
    const videos = [videoRef.current, bgVideoRef.current].filter(
      (video): video is HTMLVideoElement => Boolean(video),
    );
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const video of videos) {
      // muted via proprietà: alcuni browser ignorano l'attributo e bloccano l'autoplay.
      video.muted = true;
      try {
        if (reduce) {
          video.pause();
          continue;
        }
        const started = video.play?.();
        if (started && typeof started.catch === 'function') started.catch(() => undefined);
      } catch {
        // play()/pause() non disponibili (jsdom) o autoplay bloccato: il poster resta visibile.
      }
    }
  }, []);

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        {/* Sfondo: copia SFOCATA del video che riempie tutto lo schermo. */}
        <video
          ref={bgVideoRef}
          className={styles.bgBlur}
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
        {/* Video INTERO centrato sopra lo sfondo sfocato (nessun ritaglio). */}
        <video
          ref={videoRef}
          className={styles.frontVideo}
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
        <div className={styles.scrim} aria-hidden="true" />

        <div className={styles.heroContent}>
          <header className={styles.topbar}>
            <span className={styles.brand}>Solco</span>
            <Link className={styles.topLogin} href="/login">
              Accedi
            </Link>
          </header>

          <div className={styles.copy}>
            <span className={styles.kicker}>Musica · Radio dal vivo · Podcast</span>
            <h1 className={styles.title}>
              Tutta la musica.
              <br />
              <span className={styles.titleAccent}>Un solo player.</span>
            </h1>
            <p className={styles.lead}>
              Brani, radio dal vivo e podcast in un unico posto. Gratis. Accedi e parti.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} href="/signup">
                Inizia gratis
              </Link>
              <Link className={styles.secondary} href="/login">
                Accedi
              </Link>
            </div>
            <div className={styles.marquee} aria-hidden="true">
              <div className={styles.marqueeTrack}>
                {[0, 1].flatMap((set) =>
                  MARQUEE.map((word) => (
                    <span key={`${set}-${word}`} className={styles.marqueeItem}>
                      {word}
                    </span>
                  )),
                )}
              </div>
            </div>
            <p className={styles.legal}>
              Accedendo accetti i <Link href="/terms">Termini</Link> e la{' '}
              <Link href="/privacy">Privacy</Link>.
            </p>
          </div>
        </div>

        <a className={styles.scrollCue} href="#landing-plans-heading" aria-label="Scopri i piani">
          <span>Scopri i piani</span>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </section>

      <div className={styles.inner}>
        <section className={styles.plans} aria-labelledby="landing-plans-heading">
          <div className={styles.plansHead}>
            <p className={styles.eyebrow}>PIANI</p>
            <h2 id="landing-plans-heading" className={styles.plansTitle}>
              Scegli il tuo piano
            </h2>
            <p className={styles.plansLead}>
              Inizia gratis, passa a Premium quando vuoi. Prezzi in euro, al mese.
            </p>
          </div>
          <div className={styles.planGrid}>
            {plans.map((plan) => {
              const summary = PLAN_SUMMARY[plan.id];
              const free = plan.monthlyEuroCents === 0;
              return (
                <div
                  key={plan.id}
                  className={
                    summary?.featured
                      ? `${styles.planCard} ${styles.planFeatured}`
                      : styles.planCard
                  }
                >
                  {summary?.featured ? <span className={styles.planBadge}>Consigliato</span> : null}
                  <p className={styles.planName}>{plan.name}</p>
                  {summary?.tagline ? (
                    <p className={styles.planTagline}>{summary.tagline}</p>
                  ) : null}
                  <p className={styles.planPrice}>
                    <strong>{formatEuro(plan.monthlyEuroCents)}</strong>
                    {free ? null : <span className={styles.planPer}>/mese</span>}
                  </p>
                  {free ? null : (
                    <p className={styles.planYear}>o {formatEuro(plan.annualEuroCents)}/anno</p>
                  )}
                  <ul className={styles.planPerks}>
                    {(summary?.perks ?? []).map((perk) => (
                      <li key={perk}>{perk}</li>
                    ))}
                  </ul>
                  <Link
                    className={summary?.featured ? styles.planCtaPrimary : styles.planCta}
                    href="/login"
                  >
                    {free ? 'Inizia gratis' : 'Accedi e abbonati'}
                  </Link>
                </div>
              );
            })}
          </div>
          <p className={styles.plansNote}>
            Al primo abbonamento hai <strong>10 giorni di Premium gratis</strong>. Puoi disdire
            quando vuoi.
          </p>
        </section>
      </div>
    </main>
  );
}
