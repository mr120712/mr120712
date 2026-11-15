// @polsia:user-owned — inizio della guida (/guida): titolo, «In breve», indice con le ancore e i
// «Primi passi in 5 minuti» (account → cerca → ascolta → salva → telefono).

import { BookOpen, CircleHelp, Heart, Play, Rocket } from 'lucide-react';
import Link from 'next/link';
import { FREE_MONTHLY_PLAYS } from '@/lib/business/play-quota';
import styles from './guide.module.css';
import { GuideAction, GuideSection, InlineIcon, Note, Steps, Ui } from './guide-parts';
import { GUIDE_SECTIONS, GUIDE_TOC_ID } from './guide-sections';

export function GuideHeader() {
  return (
    <header className={styles.header}>
      <p className={styles.eyebrow}>
        <BookOpen aria-hidden="true" />
        Solco · Guida
      </p>
      <h1 className={styles.title}>Guida per iniziare</h1>
      <p className={styles.lead}>
        Tutto quello che serve per ascoltare musica su Solco, spiegato passo per passo, con i nomi
        esatti dei pulsanti. Puoi leggerla anche senza account.
      </p>
      <div className={styles.actions}>
        <GuideAction href="#primi-passi">
          <Rocket aria-hidden="true" />
          Inizia dai primi passi
        </GuideAction>
        <GuideAction href="#problemi" variant="outline">
          <CircleHelp aria-hidden="true" />
          Ho un problema
        </GuideAction>
      </div>
    </header>
  );
}

export function GuideBrief() {
  return (
    <section id="in-breve" className={styles.brief} aria-labelledby="in-breve-titolo">
      <h2 id="in-breve-titolo" className={styles.briefTitle}>
        In breve
      </h2>
      <p>
        Solco è un sito, che puoi usare anche come app sul telefono, per ascoltare in un solo posto
        brani musicali, radio dal vivo da tutto il mondo e podcast. Si usa con un account gratuito:
        paghi solo se un giorno scegli tu un piano Premium e confermi il pagamento.
      </p>
      <ul className={styles.points}>
        <li>
          Per ascoltare serve un account gratuito. Si crea in un minuto e non chiede la carta.
        </li>
        <li>
          Con il piano gratuito hai {FREE_MONTHLY_PLAYS} ascolti al mese di brani e podcast. Le
          radio dal vivo e i video YouTube sono senza limiti.
        </li>
        <li>
          Se trovi una parola che non conosci, guardala in <a href="#parole">Parole utili</a>, in
          fondo alla pagina.
        </li>
      </ul>
    </section>
  );
}

export function GuideToc() {
  return (
    <nav id={GUIDE_TOC_ID} className={styles.toc} aria-labelledby="indice-titolo">
      <h2 id="indice-titolo" className={styles.tocTitle}>
        In questa guida
      </h2>
      <ol className={styles.tocList}>
        {GUIDE_SECTIONS.map((section) => (
          <li key={section.id}>
            <a href={`#${section.id}`}>{section.title}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function GuideFirstSteps() {
  return (
    <GuideSection
      id="primi-passi"
      icon={Rocket}
      actions={
        <>
          <GuideAction href="/signup">Crea il tuo account gratuito</GuideAction>
          <GuideAction href="/login" variant="outline">
            Ho già un account: Accedi
          </GuideAction>
        </>
      }
    >
      <p>Cinque passi, uno alla volta. In ogni passo fai una sola cosa.</p>

      <h3>1. Crea il tuo account gratuito</h3>
      <Steps>
        <li>
          Nella pagina iniziale di Solco tocca <Ui>Inizia gratis</Ui>.
        </li>
        <li>
          Scrivi il tuo <Ui>Nome</Ui>, la tua <Ui>Email</Ui> e una <Ui>Password</Ui> di almeno 8
          caratteri.
        </li>
        <li>
          Tocca <Ui>Crea account</Ui>. Entri subito, senza pagare nulla.
        </li>
      </Steps>
      <Note>
        <p>
          Non vuoi inventare una nuova password? Tocca <Ui>Continua con Google</Ui> e usa il tuo
          account Google.
        </p>
      </Note>

      <h3>2. Cerca un brano</h3>
      <Steps>
        <li>
          Tocca <Ui>Cerca</Ui>: sul telefono è nella barra in basso, sul computer nella barra in
          alto.
        </li>
        <li>Scrivi il titolo di una canzone o il nome di un artista.</li>
        <li>
          Premi Invio sulla tastiera, oppure tocca il pulsante <Ui>Cerca</Ui>.
        </li>
      </Steps>

      <h3>3. Fai partire la musica</h3>
      <Steps>
        <li>
          Tocca il tondo con il triangolo <InlineIcon icon={Play} /> accanto al brano che vuoi.
        </li>
        <li>In basso compare il lettore musicale, con il titolo del brano.</li>
        <li>Per vederlo più grande, tocca il titolo del brano nel lettore.</li>
      </Steps>

      <h3>4. Salva quello che ti piace</h3>
      <Steps>
        <li>
          Vai alla Home: sul telefono tocca <Ui>Home</Ui> nella barra in basso, sul computer tocca{' '}
          <Ui>Solco</Ui> in alto a sinistra.
        </li>
        <li>
          Scorri fino a <Ui>Top in classifica</Ui>.
        </li>
        <li>
          Tocca il cuore <InlineIcon icon={Heart} /> accanto a un video musicale. Compare il
          messaggio «Aggiunto ai Preferiti.»
        </li>
        <li>
          Lo ritrovi quando vuoi in <Ui>Libreria</Ui>, nella raccolta <Ui>Preferiti</Ui>.
        </li>
      </Steps>

      <h3>5. Metti Solco sul telefono</h3>
      <Steps>
        <li>
          Dal telefono apri il menu (il pulsante con tre righe, in alto a destra) e tocca{' '}
          <Ui>Installa l’app</Ui>.
        </li>
        <li>
          Segui le istruzioni per il tuo telefono, Android o iPhone: te le spieghiamo passo per
          passo in <a href="#app">Solco sul telefono (app)</a>.
        </li>
      </Steps>
      <p className={styles.muted}>
        Hai già un account? Salta il passo 1 e tocca <Link href="/login">Accedi</Link>.
      </p>
    </GuideSection>
  );
}
