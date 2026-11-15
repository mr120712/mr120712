// @polsia:user-owned — mattoni della guida per chi inizia (/guida): sezione con titolo e azioni
// finali, passi numerati, nomi dei pulsanti in grassetto, riquadri «Buono a sapersi» e domande
// apribili. Solo markup statico (nessun hook): la guida si legge anche senza JavaScript.

import { ArrowUp, ChevronDown, Lightbulb, type LucideIcon, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import styles from './guide.module.css';
import { GUIDE_TOC_ID, type GuideSectionId, guideSectionTitle } from './guide-sections';

/** Nome di un pulsante o di una voce esattamente come appare nell'app, in grassetto. */
export function Ui({ children }: { children: ReactNode }) {
  return <strong className={styles.ui}>{children}</strong>;
}

/** Piccola icona accanto al nome di un pulsante (la stessa che si vede nell'app). */
export function InlineIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon aria-hidden="true" className={styles.inlineIcon} />;
}

/** Passi numerati: un'azione per passo. */
export function Steps({ children }: { children: ReactNode }) {
  return (
    // Safari/VoiceOver tolgono la semantica di elenco quando i numeri sono disegnati in CSS.
    // biome-ignore lint/a11y/noRedundantRoles: il ruolo esplicito tiene annunciato l'elenco.
    // biome-ignore lint/a11y/useSemanticElements: è già un <ol>; il ruolo è la correzione per Safari.
    <ol className={styles.steps} role="list">
      {children}
    </ol>
  );
}

/** Elenco puntato semplice. */
export function Points({ children }: { children: ReactNode }) {
  return <ul className={styles.points}>{children}</ul>;
}

/** Riquadro «Buono a sapersi» (tone="tip") o «Attenzione» (tone="warning"). */
export function Note({
  tone = 'tip',
  children,
}: {
  tone?: 'tip' | 'warning';
  children: ReactNode;
}) {
  const warning = tone === 'warning';
  const Icon = warning ? TriangleAlert : Lightbulb;
  return (
    <aside className={warning ? `${styles.note} ${styles.noteWarning}` : styles.note}>
      <Icon aria-hidden="true" className={styles.noteIcon} />
      <div>
        <p className={styles.noteTitle}>{warning ? 'Attenzione' : 'Buono a sapersi'}</p>
        {children}
      </div>
    </aside>
  );
}

/**
 * Pulsante-collegamento verso una pagina vera dell'app (o un'ancora della guida). Le ancore (#…)
 * usano un <a> normale, come l'indice: next/link annulla il salto nativo e lascia il punto di
 * partenza della tastiera in cima, così il Tab successivo non entrerebbe nella sezione aperta.
 */
export function GuideAction({
  href,
  children,
  variant = 'default',
}: {
  href: string;
  children: ReactNode;
  variant?: 'default' | 'outline';
}) {
  return (
    <Button asChild variant={variant} className={styles.actionButton}>
      {href.startsWith('#') ? <a href={href}>{children}</a> : <Link href={href}>{children}</Link>}
    </Button>
  );
}

/**
 * Una sezione della guida: titolo (dall'elenco unico di guide-sections), contenuto e, in fondo, i
 * pulsanti per provare subito più il ritorno all'indice.
 */
export function GuideSection({
  id,
  icon: Icon,
  actions,
  children,
}: {
  id: GuideSectionId;
  icon: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `${id}-titolo`;
  return (
    <section id={id} className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>
        <span className={styles.sectionIcon} aria-hidden="true">
          <Icon />
        </span>
        {guideSectionTitle(id)}
      </h2>
      <div className={styles.sectionBody}>{children}</div>
      <div className={styles.sectionFooter}>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
        <a className={styles.backToToc} href={`#${GUIDE_TOC_ID}`}>
          <ArrowUp aria-hidden="true" />
          Torna all’indice
        </a>
      </div>
    </section>
  );
}

/** Domanda apribile: <details>/<summary> funziona con la tastiera e senza JavaScript. */
export function Faq({ question, children }: { question: ReactNode; children: ReactNode }) {
  return (
    <details className={styles.faq}>
      <summary className={styles.faqQuestion}>
        <span>{question}</span>
        <ChevronDown aria-hidden="true" className={styles.faqChevron} />
      </summary>
      <div className={styles.faqAnswer}>{children}</div>
    </details>
  );
}
