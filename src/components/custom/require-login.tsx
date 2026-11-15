// @polsia:user-owned — muro di login: senza una sessione non si accede a nessuna funzionalità.
// Avvolge l'intera app (montato come wrapper più esterno in AppProviders): se non sei loggato e la
// rotta non è pubblica, NON si monta nulla (né nav, né player, né pagina) e si viene reindirizzati
// a /login. Pubbliche senza login: accesso/registrazione, pagine legali, i link CONDIVISI delle
// playlist, dei quiz musicali e dei brani in evidenza (/evidenza/<id>: così chi riceve un link lo
// può aprire), la guida per chi inizia (/guida) e la vetrina del Bot Solco
// (che invita all'accesso; la ricerca e il limite restano imposti dall'API). L'enforcement vero
// dei dati resta lato API.
//
// Su "/" chi NON ha la sessione vede la landing pubblica, che è già nell'HTML del server (anche
// mentre la sessione è in verifica): visitatori e motori di ricerca la leggono senza JavaScript.
// Per non far lampeggiare la landing a chi ha già fatto l'accesso su questo dispositivo, un indizio
// in localStorage (signed-in-hint.ts, scritto qui quando la sessione è nota) viene letto prima del
// primo disegno da head-content.tsx, che segna <html data-solco-signed-in>: finché la sessione è in
// verifica, la landing resta nascosta e si vede il riquadro «Verifica dell'accesso…». Le rotte
// protette senza sessione dichiarano noindex: per Google sono solo un invito al login.
'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { LandingPage } from '@/components/custom/landing-page';
import { useSession } from '@/lib/auth-client';
import { isSafeAuthDestination } from '@/lib/business/auth-form';
import { strictEncode } from '@/lib/business/social-share';
import { SIGNED_IN_HINT_ATTRIBUTE, SIGNED_IN_HINT_KEY } from '@/lib/signed-in-hint';
import styles from './require-login.module.css';

/** Aggiorna l'indizio quando la sessione è nota (con try: lo storage può mancare o rifiutare). */
function rememberSignedIn(signedIn: boolean) {
  try {
    if (signedIn) window.localStorage.setItem(SIGNED_IN_HINT_KEY, '1');
    else window.localStorage.removeItem(SIGNED_IN_HINT_KEY);
  } catch {
    // Storage non disponibile: senza indizio si vede la landing finché la sessione è in verifica.
  }
  if (signedIn) document.documentElement.setAttribute(SIGNED_IN_HINT_ATTRIBUTE, '');
  else document.documentElement.removeAttribute(SIGNED_IN_HINT_ATTRIBUTE);
}

/** Lunghezza massima della ricerca conservata (come la pagina /search). */
const QUERY_MAX = 80;

/**
 * Dove tornare dopo l'accesso: la pagina con tutta la query; se better-auth non l'accetterebbe
 * (troppo lunga, caratteri non ammessi) almeno la ricerca (?q=…), così chi apre un link condiviso
 * ritrova lo stesso brano; altrimenti il solo percorso. null se nemmeno quello è valido.
 */
export function loginDestination(pathname: string, search: string): string | null {
  const full = `${pathname}${search}`;
  if (isSafeAuthDestination(full)) return full;
  const query = new URLSearchParams(search).get('q')?.trim();
  if (query) {
    const onlyQuery = `${pathname}?q=${strictEncode(Array.from(query).slice(0, QUERY_MAX).join(''))}`;
    if (isSafeAuthDestination(onlyQuery)) return onlyQuery;
  }
  return isSafeAuthDestination(pathname) ? pathname : null;
}

/** Rotte raggiungibili SENZA essere loggati (voluto dal prodotto: solo queste). */
const PUBLIC_EXACT = new Set([
  '/login',
  '/signup',
  '/privacy',
  '/terms',
  '/stato',
  '/bot',
  '/impostazioni',
  // Recupero password: chi l'ha dimenticata per definizione non è dentro.
  '/password-dimenticata',
  '/reimposta-password',
  // Quiz musicale condiviso: chi riceve la sfida gira la carta senza un account.
  '/quiz',
  // Guida per chi inizia: va letta anche prima di creare l'account.
  '/guida',
]);
const PUBLIC_PREFIXES = [
  '/login/',
  '/signup/',
  '/privacy/',
  '/terms/',
  // Link PUBBLICI condivisi delle playlist (chi li riceve non ha per forza un account).
  '/playlist/',
  '/quiz/',
  // Link diretti dei brani in evidenza dichiarati: scheda e guscio visibili senza account. La
  // pagina propone «Accedi per ascoltare» (l'API del link manda il brano solo con una sessione), ma
  // è un invito, NON un limite imposto: il proxy dello stream dei brani in evidenza non chiede la
  // sessione e la Home e la ricerca pubbliche già mostrano lo streamUrl a chiunque.
  '/evidenza/',
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
    if (!isPending) rememberSignedIn(authed);
  }, [isPending, authed]);

  useEffect(() => {
    // Sessione nota (non in verifica), rotta protetta diversa da "/", nessun utente → al login,
    // conservando la destinazione così dopo l'accesso si torna dove si voleva andare. Su "/" NON si
    // reindirizza: si mostra la landing pubblica.
    if (open || isPending || atRoot) return;
    // Anche la query: un link condiviso (es. /search?q=artista titolo) riporta alla stessa ricerca.
    const destination = loginDestination(pathname, window.location.search);
    const callback = destination ? `?callbackURL=${encodeURIComponent(destination)}` : '';
    router.replace(`/login${callback}`);
  }, [open, isPending, atRoot, pathname, router]);

  if (open) return <>{children}</>;

  // Non loggato sulla home "/": la landing pubblica, già nell'HTML del server. Stessa posizione e
  // stesso elemento in verifica e dopo, così la landing non si rimonta quando la sessione è nota.
  // In verifica, accanto c'è il riquadro di attesa, mostrato (al posto della landing) solo sui
  // dispositivi con l'indizio di una sessione: vedi custom-style.css.
  if (atRoot) {
    return (
      <>
        <div data-solco-root-landing="" data-pending={isPending || undefined}>
          <LandingPage />
        </div>
        {isPending ? (
          <div data-solco-root-gate="">
            <GateCard pending />
          </div>
        ) : null}
      </>
    );
  }

  // Altre rotte protette e non loggato: niente contenuto. Finché la sessione è in verifica si mostra
  // un caricamento (evita di sbattere fuori un utente loggato prima di saperlo); poi il rimando al login.
  // Per i motori di ricerca (mai loggati) la pagina è solo questo invito: noindex.
  return (
    <>
      <meta name="robots" content="noindex" />
      <GateCard pending={isPending} />
    </>
  );
}

/** Il riquadro del muro di login: «Verifica dell'accesso…» in verifica, poi l'invito ad accedere. */
function GateCard({ pending }: { pending: boolean }) {
  return (
    <output className={styles.gate} aria-live="polite">
      <div className={styles.card}>
        <p className={styles.brand}>Solco</p>
        <p className={styles.message}>
          {pending ? 'Verifica dell’accesso…' : 'Accedi per continuare su Solco.'}
        </p>
        {pending ? null : (
          <a className={styles.action} href="/login">
            Accedi
          </a>
        )}
      </div>
    </output>
  );
}
