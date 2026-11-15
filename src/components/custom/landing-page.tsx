// @polsia:user-owned — landing pubblica mostrata su "/" a chi NON è loggato (il muro di login
// reindirizza le altre rotte). Compatta: titolo, accesso ben visibile e piani subito sotto, senza
// video. In alto il menu "Lingua" (italiano, inglese, spagnolo, francese, tedesco, portoghese).
// Sotto i pulsanti, il contatore pubblico degli iscritti (GET /api/public/iscritti).
'use client';

import { Globe } from 'lucide-react';
import Link from 'next/link';
import { type ChangeEvent, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import { PUBLIC_SIGNUPS_PATH, PublicSignupsSchema } from '@/lib/contracts/public-signups';
import {
  DEFAULT_LANDING_LOCALE,
  formatLandingNumber,
  formatLandingPrice,
  isLandingLocale,
  LANDING_LOCALE_STORAGE_KEY,
  LANDING_LOCALES,
  LANDING_MESSAGES,
  type LandingLocale,
  type LandingPlanId,
  landingSignupsText,
  resolveLandingLocale,
} from '@/lib/i18n/landing';
import styles from './landing-page.module.css';

/** Il piano consigliato (evidenziato). */
const FEATURED_PLAN: LandingPlanId = 'premium';

/** Durata del conteggio animato del numero di iscritti (solo senza movimento ridotto). */
const COUNT_UP_MS = 900;

type SignupsState =
  | { status: 'loading' }
  | { status: 'ready'; total: number; last7Days: number }
  | { status: 'hidden' };

/** true solo se il sistema dichiara "nessuna preferenza" sul movimento (e il browser sa animare). */
function motionAllowed(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    typeof window.requestAnimationFrame === 'function' &&
    window.matchMedia('(prefers-reduced-motion: no-preference)').matches
  );
}

/** Valore mostrato mentre il numero sale da 0 a `target`; con movimento ridotto subito `target`. */
function useCountUp(target: number): number {
  const [value, setValue] = useState(() => (motionAllowed() ? 0 : target));
  useEffect(() => {
    if (!motionAllowed()) {
      setValue(target);
      return;
    }
    let frame = 0;
    let start: number | null = null;
    const step = (time: number) => {
      start ??= time;
      const progress = Math.min(1, (time - start) / COUNT_UP_MS);
      setValue(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

/**
 * Numero e testi del contatore. Per i lettori di schermo una sola frase col numero finale (testo
 * nascosto alla vista); la parte visibile, che durante il conteggio cambia, è nascosta a loro.
 */
function SignupsFigure({
  total,
  last7Days,
  locale,
}: {
  total: number;
  last7Days: number;
  locale: LandingLocale;
}) {
  const shown = useCountUp(total);
  const text = landingSignupsText({ total, last7Days }, locale);
  return (
    <>
      <span className={styles.srOnly}>{text.phrase}</span>
      <span className={styles.signupsMain} aria-hidden="true">
        <strong className={styles.signupsNumber}>
          {/* Il valore finale, invisibile, tiene ferma la larghezza mentre le cifre salgono. */}
          <span className={styles.signupsNumberGhost}>{text.count}</span>
          <span className={styles.signupsNumberValue}>{formatLandingNumber(shown, locale)}</span>
        </strong>
        <span className={styles.signupsLabel}>{text.label}</span>
      </span>
      {text.recent ? (
        <span className={styles.signupsRecent} aria-hidden="true">
          {text.recent}
        </span>
      ) : null}
    </>
  );
}

/**
 * Contatore pubblico degli iscritti. Chiede i numeri dopo il montaggio; finché non arrivano mostra
 * uno scheletro della stessa misura (nessuno spostamento della pagina). Se la richiesta fallisce o
 * il totale è 0 non mostra nulla: mai un numero inventato o di riempimento. Lo spazio dello
 * scheletro però resta, vuoto e invisibile: toglierlo farebbe salire tutto ciò che sta sotto
 * (striscia, note legali, piani) un istante dopo il caricamento. Nessuna regione aria-live: il
 * numero si legge quando ci si arriva, non viene annunciato.
 */
function SignupsStat({ locale }: { locale: LandingLocale }) {
  const [state, setState] = useState<SignupsState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    apiFetch(PUBLIC_SIGNUPS_PATH, { schema: PublicSignupsSchema, signal: controller.signal })
      .then(({ total, last7Days }) => {
        if (controller.signal.aborted) return;
        setState(total > 0 ? { status: 'ready', total, last7Days } : { status: 'hidden' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'hidden' });
      });
    return () => controller.abort();
  }, []);

  const { status } = state;
  const variant =
    status === 'loading' ? styles.signupsLoading : status === 'hidden' ? styles.signupsEmpty : '';
  // Stesso elemento <p> per scheletro, dati e spazio vuoto: l'entrata animata dell'hero non
  // riparte e l'altezza minima resta quella dello scheletro.
  return (
    <p
      className={variant ? `${styles.signups} ${variant}` : styles.signups}
      aria-hidden={status === 'ready' ? undefined : true}
      data-state={status}
    >
      {status === 'ready' ? (
        <SignupsFigure total={state.total} last7Days={state.last7Days} locale={locale} />
      ) : status === 'loading' ? (
        <>
          <span className={styles.signupsMain}>
            <span className={`${styles.signupsBone} ${styles.signupsBoneNumber}`} />
            <span className={`${styles.signupsBone} ${styles.signupsBoneLabel}`} />
          </span>
          <span className={`${styles.signupsBone} ${styles.signupsBoneRecent}`} />
        </>
      ) : null}
    </p>
  );
}

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

/** Lingua del visitatore: scelta di questa visita, ?lang=, la scelta salvata, il browser (client). */
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
  // Primo disegno sempre nella lingua predefinita: è l'HTML del server (quello che leggono Google e
  // chi apre la pagina senza JavaScript) e deve coincidere con l'idratazione. La lingua del
  // visitatore (scelta di questa visita, ?lang=, quella salvata, il browser) arriva subito dopo.
  const [locale, setLocale] = useState<LandingLocale>(DEFAULT_LANDING_LOCALE);
  const t = LANDING_MESSAGES[locale];
  const { plans } = getSolcoProPricing();

  useEffect(() => {
    const preferred = initialLocale();
    if (preferred !== DEFAULT_LANDING_LOCALE) setLocale(preferred);
  }, []);

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
            <SignupsStat locale={locale} />
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
            {/* Guida per chi inizia (/guida, pubblica e in italiano: l'etichetta lo dice). */}
            <p className={styles.legal}>
              <Link
                href="/guida"
                hrefLang="it"
                style={{ display: 'inline-flex', alignItems: 'center', minHeight: 32 }}
              >
                {t.guideLink}
              </Link>
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
