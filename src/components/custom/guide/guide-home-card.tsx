// @polsia:user-owned — invito alla guida nella Home di chi ha fatto l'accesso: «Nuovo su Solco?».
// Si chiude con la X e resta chiuso su questo dispositivo (localStorage). Se lo storage non c'è o
// è bloccato (navigazione privata) la chiusura vale per questa visita: la pagina funziona lo stesso.
'use client';

import { BookOpen, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import styles from './guide-home-card.module.css';

/** Chiave di localStorage: '1' = invito chiuso su questo dispositivo. */
export const GUIDE_CARD_STORAGE_KEY = 'solco:guida-home:chiusa';

/** Chiusura fatta in questa visita: vale anche quando lo storage non è disponibile. */
let dismissedThisVisit = false;
const listeners = new Set<() => void>();

function readDismissed(): boolean {
  if (dismissedThisVisit) return true;
  try {
    return window.localStorage.getItem(GUIDE_CARD_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Chiuso in un'altra scheda: sparisce anche qui.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function dismiss() {
  dismissedThisVisit = true;
  try {
    window.localStorage.setItem(GUIDE_CARD_STORAGE_KEY, '1');
  } catch {
    // Storage non disponibile: resta chiuso per questa visita (dismissedThisVisit).
  }
  for (const listener of listeners) listener();
}

/** Sul server (e durante l'idratazione) l'invito non si mostra: niente salti per chi l'ha chiuso. */
const hiddenOnServer = () => true;

export function GuideHomeCard() {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, hiddenOnServer);
  // Chiuso adesso con la X (non in un'altra scheda né in una visita precedente): al posto del
  // riquadro resta una riga che riceve il focus, così tastiera e lettori di schermo non finiscono
  // in cima alla pagina e sanno dove ritrovare la guida.
  const [closedHere, setClosedHere] = useState(false);
  const closedNoteRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (closedHere) closedNoteRef.current?.focus();
  }, [closedHere]);

  if (dismissed) {
    return closedHere ? (
      <p ref={closedNoteRef} tabIndex={-1} className={styles.closedNote}>
        Fatto. La guida resta nel menu e in fondo alla Home, alla voce «Guida».
      </p>
    ) : null;
  }

  return (
    <section className={styles.card} aria-labelledby="guida-home-titolo">
      <span className={styles.icon} aria-hidden="true">
        <BookOpen />
      </span>
      <div className={styles.copy}>
        <h2 id="guida-home-titolo">Nuovo su Solco?</h2>
        <p>Come cercare, ascoltare e salvare la musica, spiegato passo per passo.</p>
      </div>
      <div className={styles.actions}>
        <Button asChild>
          <Link href="/guida">Apri la guida passo per passo</Link>
        </Button>
      </div>
      <button
        type="button"
        className={styles.close}
        onClick={() => {
          setClosedHere(true);
          dismiss();
        }}
        aria-label="Chiudi l’invito alla guida"
        title="Chiudi"
      >
        <X aria-hidden="true" />
      </button>
    </section>
  );
}
