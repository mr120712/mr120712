// @polsia:user-owned — avviso «Solo per admin» in cima ai risultati della ricerca: dice
// all'amministratore che dei brani in evidenza corrispondono alla query ma NON compaiono perché non
// sono dichiarati in diritti.json, oppure che diritti.json manca, non è valido o lo store non si
// legge. Chi non è admin (con email verificata) non vede nulla e non fa nessuna richiesta: il
// componente non monta nemmeno l'effetto di rete. I dati arrivano da un endpoint PRIVATO
// (GET /api/admin/featured-rights/search-hint, mai dentro search-all che è in cache condivisa), in
// parallelo alla ricerca; una query nuova annulla la richiesta in volo e un errore (anche un 429 o
// un 403) nasconde l'avviso in silenzio. Solo conteggi: i titoli li elenca «Diritti e testi».
//
// NIENTE SALTI DEI RISULTATI. Nessun segnaposto finché non c'è nulla da dire. Quando la query cambia
// e un avviso è già a schermo:
// - un avviso che non dipende dalla query (manifest assente o non valido, store non leggibile)
//   resta com'è finché arriva la risposta nuova;
// - un conteggio della query precedente non resta mai: lo STESSO riquadro, alla stessa altezza,
//   dice «controllo i brani in evidenza…» (aria-busy) finché arriva la risposta nuova;
// - se la query nuova non ha nulla da dire, il riquadro sparisce solo quando search-all sostituisce
//   l'elenco (`resultsUpdating` torna false), insieme ai risultati nuovi;
// - un avviso NUOVO (prima non c'era) non compare sopra i risultati vecchi mentre arrivano quelli
//   nuovi: compare con loro. Se l'avviso arriva dopo i risultati, compare allora (non c'è modo di
//   saperlo prima).
//
// POCHE RICHIESTE. La ricerca manda la query dopo 350 ms di pausa, e chi digita piano su un telefono
// fa una pausa a ogni lettera: una richiesta a /api/admin per lettera supera il limite del firewall
// (richieste al minuto per IP su /api/admin) e l'IP dell'amministratore resta bloccato per minuti.
// Perciò la prima richiesta parte subito e le successive aspettano almeno
// ADMIN_SEARCH_HINT_MIN_SPACING_MS dall'ultima, con la query più recente. Una richiesta in attesa
// non è in volo: se intanto l'elenco nuovo è a schermo, il riquadro è andato via con quello vecchio
// e ricompare solo se poi l'avviso ha qualcosa da dire.
'use client';

import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import {
  ADMIN_RIGHTS_PAGE_PATH,
  ADMIN_SEARCH_HINT_PATH,
  type AdminSearchHint as AdminSearchHintData,
  type AdminSearchHintManifest,
  AdminSearchHintSchema,
} from '@/lib/contracts/admin-search-hint';
import styles from './admin-search-hint.module.css';

export type AdminSearchHintNotice = {
  /** Il testo dopo «Solo per admin · ». */
  text: string;
  /** true = in fondo il link alla pagina «Diritti e testi». */
  link: boolean;
};

/** Il testo del riquadro mentre arriva la risposta della query nuova (mai il conteggio vecchio). */
export const ADMIN_SEARCH_HINT_CHECKING_TEXT = 'controllo i brani in evidenza…';

/**
 * Distanza minima fra due richieste dell'avviso: al massimo 20 al minuto, qualunque sia il ritmo di
 * scrittura (il firewall blocca per minuti l'IP che supera il limite di richieste su /api/admin).
 * La prima richiesta parte subito; una query cambiata prima della pausa aspetta il resto del tempo.
 */
export const ADMIN_SEARCH_HINT_MIN_SPACING_MS = 3_000;

/** La richiesta per la query a schermo: in attesa della pausa minima, in volo, oppure conclusa. */
type Phase = 'waiting' | 'in_flight' | 'settled';

/**
 * Il testo dell'avviso per la risposta e la query, oppure null quando non c'è nulla da dire
 * (manifest valido e nessun brano pertinente nascosto).
 */
export function adminSearchHintNotice(
  hint: AdminSearchHintData,
  query: string,
): AdminSearchHintNotice | null {
  switch (hint.manifest) {
    case 'missing':
      return {
        text: "diritti.json non c'è: nessun brano in evidenza compare nella ricerca.",
        link: true,
      };
    case 'invalid':
      return {
        text: 'diritti.json non è valido: nessun brano in evidenza compare nella ricerca.',
        link: true,
      };
    case 'unavailable':
      return { text: 'Non riesco a leggere lo store dei brani in evidenza.', link: false };
    default: {
      const count = hint.matchedUndeclared;
      if (count <= 0) return null;
      return {
        text:
          count === 1
            ? `1 brano in evidenza corrisponde a «${query}» ma non è dichiarato in diritti.json, quindi non compare.`
            : `${count} brani in evidenza corrispondono a «${query}» ma non sono dichiarati in diritti.json, quindi non compaiono.`,
        link: true,
      };
    }
  }
}

/** L'ultima risposta arrivata, con la query a cui risponde (hint null = errore: niente avviso). */
type Answer = { query: string; hint: AdminSearchHintData | null };

/** Che cosa mostra il riquadro: un avviso, oppure «controllo…» mentre arriva la risposta nuova. */
type Display =
  | (AdminSearchHintNotice & {
      kind: 'notice';
      manifest: AdminSearchHintManifest;
      /** Manifest assente/non valido o store non leggibile: vale per qualunque query. */
      queryIndependent: boolean;
    })
  | { kind: 'checking' };

const CHECKING: Display = { kind: 'checking' };

function sameDisplay(left: Display | null, right: Display | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === 'checking' || right.kind === 'checking') return left.kind === right.kind;
  return (
    left.text === right.text &&
    left.link === right.link &&
    left.manifest === right.manifest &&
    left.queryIndependent === right.queryIndependent
  );
}

/**
 * Il prossimo stato del riquadro, da quello a schermo, dall'ultima risposta e dalla ricerca.
 * `waiting`: la richiesta per la query a schermo aspetta la pausa minima e non è ancora partita.
 */
function nextDisplay(
  shown: Display | null,
  answer: Answer | null,
  query: string,
  resultsUpdating: boolean,
  waiting: boolean,
): Display | null {
  if (!query) return null;
  if (answer && answer.query === query) {
    const notice = answer.hint ? adminSearchHintNotice(answer.hint, query) : null;
    if (notice && answer.hint) {
      // Un avviso nuovo non spinge giù i risultati vecchi: compare con quelli nuovi.
      if (!shown && resultsUpdating) return null;
      return {
        kind: 'notice',
        ...notice,
        manifest: answer.hint.manifest,
        queryIndependent: answer.hint.manifest !== 'valid',
      };
    }
    // Nulla da dire per la query nuova: il riquadro va via insieme all'elenco vecchio.
    return shown && resultsUpdating ? CHECKING : null;
  }
  // Risposta della query nuova in arrivo, o richiesta in attesa della pausa minima.
  if (!shown) return null;
  if (shown.kind === 'notice' && shown.queryIndependent) return shown;
  // Richiesta non ancora partita e l'elenco nuovo è già a schermo: il riquadro va via con l'elenco
  // vecchio (se poi l'avviso ha qualcosa da dire, ricompare allora).
  if (waiting && !resultsUpdating) return null;
  return CHECKING;
}

/** Monta l'avviso solo per gli admin con email verificata (gli altri: nulla, nessuna richiesta). */
export function AdminSearchHint({
  query,
  resultsUpdating = false,
}: {
  query: string;
  /** true mentre search-all cerca la query nuova e a schermo c'è ancora l'elenco precedente. */
  resultsUpdating?: boolean;
}) {
  const { data } = useSession();
  const user = data?.user;
  if (!isAuthorizedAdmin(user)) return null;
  return <AdminSearchHintBox query={query} resultsUpdating={resultsUpdating} />;
}

function AdminSearchHintBox({
  query,
  resultsUpdating,
}: {
  query: string;
  resultsUpdating: boolean;
}) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [phase, setPhase] = useState<Phase>('settled');
  // Quando è partita l'ultima richiesta (anche se poi annullata): la prossima aspetta la pausa minima.
  const lastRequestAt = useRef<number | null>(null);
  // Ciò che è a schermo (serve a sapere se un riquadro c'era già quando la query cambia).
  const [shown, setShown] = useState<Display | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // L'altezza dell'ultimo avviso mostrato: «controllo…» la mantiene, così nulla si sposta.
  const noticeHeight = useRef(0);

  useEffect(() => {
    if (!query) {
      setAnswer(null);
      setPhase('settled');
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      timer = null;
      lastRequestAt.current = Date.now();
      setPhase('in_flight');
      apiFetch(`${ADMIN_SEARCH_HINT_PATH}?${new URLSearchParams({ q: query }).toString()}`, {
        schema: AdminSearchHintSchema,
        signal: controller.signal,
      })
        .then((hint) => {
          if (!controller.signal.aborted) setAnswer({ query, hint });
        })
        .catch(() => {
          // Errore, 401/403/429 o risposta fuori contratto: l'avviso sparisce, senza messaggi.
          if (!controller.signal.aborted) setAnswer({ query, hint: null });
        })
        .finally(() => {
          if (!controller.signal.aborted) setPhase('settled');
        });
    };
    const sinceLast =
      lastRequestAt.current === null
        ? Number.POSITIVE_INFINITY
        : Date.now() - lastRequestAt.current;
    if (sinceLast >= ADMIN_SEARCH_HINT_MIN_SPACING_MS) {
      send();
    } else {
      // Query cambiata prima della pausa minima: parte quando il tempo è passato, con questa query.
      setPhase('waiting');
      timer = setTimeout(send, ADMIN_SEARCH_HINT_MIN_SPACING_MS - sinceLast);
    }
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [query]);

  const display = nextDisplay(shown, answer, query, resultsUpdating, phase === 'waiting');
  // Aggiornamento durante il render (stato derivato dal render precedente): React rifà subito il
  // render, prima di disegnare, e il secondo calcolo dà lo stesso risultato.
  if (!sameDisplay(display, shown)) setShown(display);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (display?.kind === 'checking') {
      box.style.minHeight = noticeHeight.current > 0 ? `${noticeHeight.current}px` : '';
    } else {
      box.style.minHeight = '';
      noticeHeight.current = box.offsetHeight;
    }
  });

  if (!display) return null;
  const checking = display.kind === 'checking';

  return (
    <div
      ref={boxRef}
      className={styles.notice}
      role="note"
      aria-busy={checking ? 'true' : undefined}
      data-manifest={checking ? 'checking' : display.manifest}
    >
      <TriangleAlert aria-hidden="true" className={styles.icon} />
      <p className={styles.text}>
        <strong className={styles.label}>Solo per admin</strong> ·{' '}
        {checking ? ADMIN_SEARCH_HINT_CHECKING_TEXT : display.text}
        {!checking && display.link ? (
          <>
            {' '}
            <Link href={ADMIN_RIGHTS_PAGE_PATH} className={styles.link}>
              Apri Diritti e testi
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}
