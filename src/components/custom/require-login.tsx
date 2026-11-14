// @polsia:user-owned — muro di login: senza una sessione non si accede a nessuna funzionalità.
// Avvolge l'intera app (montato come wrapper più esterno in AppProviders): se non sei loggato e la
// rotta non è pubblica, NON si monta nulla (né nav, né player, né pagina) e si viene reindirizzati
// a /login. Pubbliche senza login: accesso/registrazione, pagine legali, i link CONDIVISI delle
// playlist (così chi riceve un link lo può aprire) e la vetrina del Bot Solco (che invita all'accesso;
// la ricerca e il limite restano imposti dall'API). L'enforcement vero dei dati resta lato API.
'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { LandingPage } from '@/components/custom/landing-page';
import { useSession } from '@/lib/auth-client';
import { isSafeAuthDestination } from '@/lib/business/auth-form';
import styles from './require-login.module.css';

/** Rotte raggiungibili SENZA essere loggati (voluto dal prodotto: solo queste). */
const PUBLIC_EXACT = new Set(['/login', '/signup', '/privacy', '/terms', '/stato', '/bot']);
const PUBLIC_PREFIXES = [
  '/login/',
  '/signup/',
  '/privacy/',
  '/terms/',
  // Link PUBBLICI condivisi delle playlist (chi li riceve non ha per forza un account).
  '/playlist/',
];

export function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function RequireLogin({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const authed = Boolean(session?.user);
  const open = authed || isPublicRoute(pathname);
  const atRoot = pathname === '/';

  useEffect(() => {
    // Sessione nota (non in verifica), rotta protetta diversa da "/", nessun utente → al login,
    // conservando la destinazione così dopo l'accesso si torna dove si voleva andare. Su "/" NON si
    // reindirizza: si mostra la landing pubblica.
    if (open || isPending || atRoot) return;
    const callback = isSafeAuthDestination(pathname)
      ? `?callbackURL=${encodeURIComponent(pathname)}`
      : '';
    router.replace(`/login${callback}`);
  }, [open, isPending, atRoot, pathname, router]);

  if (open) return <>{children}</>;

  // Non loggato sulla home "/": landing pubblica con il video e il pulsante di accesso.
  if (!isPending && atRoot) return <LandingPage />;

  // Altre rotte protette e non loggato: niente contenuto. Finché la sessione è in verifica si mostra
  // un caricamento (evita di sbattere fuori un utente loggato prima di saperlo); poi il rimando al login.
  return (
    <output className={styles.gate} aria-live="polite">
      <div className={styles.card}>
        <p className={styles.brand}>Solco</p>
        <p className={styles.message}>
          {isPending ? 'Verifica dell’accesso…' : 'Accedi per continuare su Solco.'}
        </p>
        {isPending ? null : (
          <a className={styles.action} href="/login">
            Accedi
          </a>
        )}
      </div>
    </output>
  );
}
