// @polsia:user-owned — landing pubblica mostrata su "/" a chi NON è loggato (il muro di login
// reindirizza le altre rotte). Compatta: titolo, accesso ben visibile e piani subito sotto, senza
// video. In alto il menu "Lingua" (italiano, inglese, spagnolo, francese, tedesco, portoghese).
'use client';

import { Globe } from 'lucide-react';
import Link from 'next/link';
import { type ChangeEvent, useEffect, useState } from 'react';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import {
  DEFAULT_LANDING_LOCALE,
  formatLandingPrice,
  isLandingLocale,
  LANDING_LOCALE_STORAGE_KEY,
  LANDING_LOCALES,
  LANDING_MESSAGES,
  type LandingLocale,
  type LandingPlanId,
  resolveLandingLocale,
} from '@/lib/i18n/landing';
import styles from './landing-page.module.css';

/** Il piano consigliato (evidenziato). */
const FEATURED_PLAN: LandingPlanId = 'premium';

function readStoredLocale(): string | null {
  try {
    return window.localStorage.getItem(LANDING_LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Scelta fatta in questa visita: vale anche se la landing viene rimontata (es. la sessione viene
 * ricontrollata) e quando lo storage non è disponibile (navigazione privata).
 */
let chosenThisVisit: LandingLocale | null = null;

/** Lingua iniziale: scelta di questa visita, ?lang=, la scelta salvata, il browser (client). */
function initialLocale(): LandingLocale {
  if (typeof window === 'undefined') return DEFAULT_LANDING_LOCALE;
  if (chosenThisVisit) return chosenThisVisit;
  return resolveLandingLocale({
    param: new URLSearchParams(window.location.search).get('lang'),
    stored: readStoredLocale(),
    browser: typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [],
  });
}

export function LandingPage() {
  const [locale, setLocale] = useState<LandingLocale>(initialLocale);
  const t = LANDING_MESSAGES[locale];
  const { plans } = getSolcoProPricing();

  // <html lang> segue la lingua mostrata (lettori di schermo, traduttori, sillabazione); tornando
  // all'app (dopo l'accesso) si ripristina quella dell'app.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('lang');
    root.setAttribute('lang', locale);
    return () => {
      if (previous) root.setAttribute('lang', previous);
      else root.removeAttribute('lang');
    };
  }, [locale]);

  const changeLocale = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (!isLandingLocale(next)) return;
    chosenThisVisit = next;
    setLocale(next);
    try {
      window.localStorage.setItem(LANDING_LOCALE_STORAGE_KEY, next);
    } catch {
      // Storage non disponibile: la scelta vale per questa visita (chosenThisVisit).
    }
    // Un ?lang= nel link non deve riportare indietro la lingua appena scelta.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('lang')) {
        url.searchParams.set('lang', next);
        window.history.replaceState(window.history.state, '', url);
      }
    } catch {
      // URL non aggiornabile: la scelta resta comunque in chosenThisVisit.
    }
  };

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroContent}>
          <header className={styles.topbar}>
            <span className={styles.brand}>Solco</span>
            <div className={styles.topActions}>
              <label className={styles.language}>
                <Globe aria-hidden="true" className={styles.languageIcon} />
                <span className={styles.srOnly}>{t.languageLabel}</span>
                <select
                  className={styles.languageSelect}
                  value={locale}
                  onChange={changeLocale}
                  aria-label={t.languageLabel}
                >
                  {LANDING_LOCALES.map((option) => (
                    <option key={option.code} value={option.code} lang={option.code}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <Link className={styles.topLogin} href="/login">
                {t.login}
              </Link>
            </div>
          </header>

          <div className={styles.copy}>
            <span className={styles.kicker}>{t.kicker}</span>
            <h1 className={styles.title}>
              {t.titleLine1}
              <br />
              <span className={styles.titleAccent}>{t.titleLine2}</span>
            </h1>
            <p className={styles.lead}>{t.lead}</p>
            <div className={styles.actions}>
              <Link className={styles.primary} href="/signup">
                {t.ctaStart}
              </Link>
              <Link className={styles.secondary} href="/login">
                {t.ctaLogin}
              </Link>
            </div>
            <div className={styles.marquee} aria-hidden="true">
              <div className={styles.marqueeTrack}>
                {[0, 1].flatMap((set) =>
                  t.marquee.map((word) => (
                    <span key={`${set}-${word}`} className={styles.marqueeItem}>
                      {word}
                    </span>
                  )),
                )}
              </div>
            </div>
            <p className={styles.legal}>
              {t.legal.before}
              <Link href="/terms">{t.legal.terms}</Link>
              {t.legal.middle}
              <Link href="/privacy">{t.legal.privacy}</Link>
              {t.legal.after}
              {t.appLanguageNote ? ` ${t.appLanguageNote}` : null}
            </p>
          </div>
        </div>
      </section>

      <div className={styles.inner}>
        <section className={styles.plans} aria-labelledby="landing-plans-heading">
          <div className={styles.plansHead}>
            <p className={styles.eyebrow}>{t.plansEyebrow}</p>
            <h2 id="landing-plans-heading" className={styles.plansTitle}>
              {t.plansTitle}
            </h2>
            <p className={styles.plansLead}>{t.plansLead}</p>
          </div>
          <div className={styles.planGrid}>
            {plans.map((plan) => {
              const summary = Object.hasOwn(t.plans, plan.id)
                ? t.plans[plan.id as LandingPlanId]
                : undefined;
              const featured = plan.id === FEATURED_PLAN;
              const free = plan.monthlyEuroCents === 0;
              return (
                <div
                  key={plan.id}
                  className={
                    featured ? `${styles.planCard} ${styles.planFeatured}` : styles.planCard
                  }
                >
                  {featured ? <span className={styles.planBadge}>{t.recommended}</span> : null}
                  <p className={styles.planName}>{plan.name}</p>
                  {summary?.tagline ? (
                    <p className={styles.planTagline}>{summary.tagline}</p>
                  ) : null}
                  <p className={styles.planPrice}>
                    <strong>{formatLandingPrice(plan.monthlyEuroCents, locale)}</strong>
                    {free ? null : <span className={styles.planPer}>{t.perMonth}</span>}
                  </p>
                  {free ? null : (
                    <p className={styles.planYear}>
                      {t.perYear(formatLandingPrice(plan.annualEuroCents, locale))}
                    </p>
                  )}
                  <ul className={styles.planPerks}>
                    {(summary?.perks ?? []).map((perk) => (
                      <li key={perk}>{perk}</li>
                    ))}
                  </ul>
                  <Link className={featured ? styles.planCtaPrimary : styles.planCta} href="/login">
                    {free ? t.planCtaFree : t.planCtaPaid}
                  </Link>
                </div>
              );
            })}
          </div>
          <p className={styles.plansNote}>
            {t.note.before}
            <strong>{t.note.strong}</strong>
            {t.note.after}
          </p>
        </section>
      </div>
    </main>
  );
}
