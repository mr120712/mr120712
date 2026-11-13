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

export function LandingPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { plans } = getSolcoProPricing();

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
      <section className={styles.hero}>
        {/* Sfondo video a tutta pagina (decorativo, muto, in loop) + velo per la leggibilità. */}
        <video
          ref={videoRef}
          className={styles.bgVideo}
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
        </div>
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
