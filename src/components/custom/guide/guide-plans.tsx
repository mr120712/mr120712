// @polsia:user-owned — sezioni della guida (/guida): piani Free e Premium (numeri presi dal codice
// dei piani, così restano giusti) e le altre funzioni raggiungibili da un utente normale.

import {
  Activity,
  BarChart3,
  Bot,
  Crown,
  Disc3,
  GraduationCap,
  type LucideIcon,
  MessageCircle,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { FREE_TRIAL_DAYS } from '@/lib/business/free-trial';
import {
  FEATURED_FREE_MONTHLY_PLAYS,
  FREE_MONTHLY_PLAYS,
  REPLAY_WINDOW_MS,
} from '@/lib/business/play-quota';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import styles from './guide.module.css';
import { GuideAction, GuideSection, Note, Points, Steps, Ui } from './guide-parts';

const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });

/** Prezzi del piano Premium (mensile e annuale) come li mostra la pagina Piani. */
function premiumPrices(): { monthly: string; annual: string } | null {
  const premium = getSolcoProPricing().plans.find((plan) => plan.id === 'premium');
  if (!premium) return null;
  return {
    monthly: euro.format(premium.monthlyEuroCents / 100),
    annual: euro.format(premium.annualEuroCents / 100),
  };
}

const REPLAY_MINUTES = Math.round(REPLAY_WINDOW_MS / 60_000);

export function GuidePlans() {
  const prices = premiumPrices();
  return (
    <GuideSection
      id="piani"
      icon={Crown}
      actions={
        <>
          <GuideAction href="/piani">Vedi i piani</GuideAction>
          <GuideAction href="/premi" variant="outline">
            Invita amici
          </GuideAction>
        </>
      }
    >
      <p>
        Solco ha un piano gratuito (<Ui>Free</Ui>) e piani a pagamento (<Ui>Premium</Ui>). Non paghi
        nulla finché non scegli tu un piano e confermi il pagamento. Solco non aggiunge pubblicità
        in nessun piano.
      </p>

      <h3>Cosa include il piano gratuito</h3>
      <Points>
        <li>{FREE_MONTHLY_PLAYS} ascolti al mese di brani di Audius ed episodi di podcast.</li>
        <li>
          {FEATURED_FREE_MONTHLY_PLAYS} avvii al mese dei brani in evidenza della Home, con un
          conteggio a parte: non tolgono nulla ai {FREE_MONTHLY_PLAYS}.
        </li>
        <li>Radio dal vivo e video YouTube senza limiti: non contano nei {FREE_MONTHLY_PLAYS}.</li>
        <li>
          Anche i tuoi file in <Ui>La tua musica</Ui> non contano.
        </li>
        <li>Riascoltare lo stesso brano entro {REPLAY_MINUTES} minuti non conta di nuovo.</li>
        <li>Il conteggio riparte all’inizio di ogni mese.</li>
      </Points>
      <p>
        Quando li finisci, il lettore dice «Hai usato i {FREE_MONTHLY_PLAYS} ascolti gratuiti di
        questo mese.» Puoi continuare con radio, video YouTube e i tuoi file. Finiti i{' '}
        {FEATURED_FREE_MONTHLY_PLAYS} avvii dei brani in evidenza, il lettore lo dice allo stesso
        modo e il conteggio riparte il mese prossimo.
      </p>

      <h3>Cosa aggiunge Premium</h3>
      <Points>
        <li>Ascolti illimitati di brani di Audius e podcast, anche a schermo bloccato.</li>
        <li>
          Se la vedi, <Ui>Cerca con l’AI</Ui>: descrivi a parole la musica che vuoi (per esempio
          «jazz rilassato per una cena tra amici») e Solco la cerca per te.
        </li>
        <li>
          Se lo vedi nella Libreria, <Ui>Organizza con l’AI</Ui>: incolli un testo lungo, come una
          scaletta, e Solco ne ricava una playlist.
        </li>
      </Points>
      {prices ? (
        <p>
          Premium costa {prices.monthly} al mese, oppure {prices.annual} all’anno. Gli altri piani a
          pagamento e tutti i prezzi sono nella pagina <Ui>Piani</Ui>.
        </p>
      ) : null}

      <h3>Provare Premium gratis per {FREE_TRIAL_DAYS} giorni</h3>
      <Steps>
        <li>
          Apri <Ui>Piani</Ui> dal menu.
        </li>
        <li>
          Scegli un piano e tocca <Ui>Prova gratis {FREE_TRIAL_DAYS} giorni</Ui>.
        </li>
        <li>
          Nella pagina sicura di pagamento inserisci la carta (oppure usa Apple Pay o Google Pay) e
          conferma.
        </li>
      </Steps>
      <Note tone="warning">
        <p>
          Durante la prova non paghi nulla. Alla fine dei {FREE_TRIAL_DAYS} giorni il pagamento
          parte da solo: se non vuoi continuare, disdici prima. La prova vale una sola volta per
          account.
        </p>
      </Note>

      <h3>Disdire o cambiare piano</h3>
      <Steps>
        <li>
          Apri <Ui>Piani</Ui>.
        </li>
        <li>
          Tocca <Ui>Gestisci abbonamento</Ui>.
        </li>
        <li>Nella pagina che si apre scegli se disdire o cambiare piano.</li>
      </Steps>
      <p>
        Dopo la disdetta Premium resta attivo fino alla fine del periodo già pagato, poi non paghi
        più nulla.
      </p>

      <h3>Premium gratis</h3>
      <Points>
        <li>
          In <Ui>Invita amici</Ui> trovi il tuo link personale. Quando un amico si registra con il
          tuo link e paga il suo primo abbonamento Premium (cioè dopo i suoi {FREE_TRIAL_DAYS}{' '}
          giorni di prova), ricevete 30 giorni di Premium gratis a testa.
        </li>
        <li>
          Nella stessa pagina: ogni 10 giorni in cui ascolti almeno 10 minuti ricevi 1 giorno di
          Premium.
        </li>
      </Points>
    </GuideSection>
  );
}

function ExtraCard({
  href,
  title,
  icon: Icon,
  children,
}: {
  href: string;
  title: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <li className={styles.card}>
      <span className={styles.cardIcon} aria-hidden="true">
        <Icon />
      </span>
      <div>
        <h3 className={styles.cardTitle}>
          <Link href={href}>{title}</Link>
        </h3>
        <p>{children}</p>
      </div>
    </li>
  );
}

export function GuideExtras() {
  return (
    <GuideSection
      id="altro"
      icon={Sparkles}
      actions={<GuideAction href="/flashcards">Gioca con le Flashcard</GuideAction>}
    >
      <p>
        Quando ti senti a tuo agio, prova anche queste pagine. Quasi tutte sono nel menu;
        Impostazioni e Stato invece sono in fondo a pagine come Cerca o Libreria, nel piè di pagina.
        Puoi aprirle anche da qui.
      </p>
      {/* Safari/VoiceOver tolgono la semantica di elenco a un elenco con list-style: none. */}
      {/* biome-ignore lint/a11y/noRedundantRoles: il ruolo esplicito tiene annunciato l'elenco. */}
      {/* biome-ignore lint/a11y/useSemanticElements: è già un <ul>; il ruolo è la correzione per Safari. */}
      <ul className={styles.cards} role="list">
        <ExtraCard href="/statistiche" title="Statistiche" icon={BarChart3}>
          Un riepilogo di quanto e cosa hai ascoltato: artisti più ascoltati, brani diversi, tempo
          di ascolto.
        </ExtraCard>
        <ExtraCard href="/community" title="Community" icon={Users}>
          Profili di fan e artisti da seguire con <Ui>Segui</Ui>. Per comparire anche tu, nel tuo
          Profilo scegli <Ui>Pubblico</Ui> e tocca <Ui>Salva impostazioni</Ui>.
        </ExtraCard>
        <ExtraCard href="/messages" title="Messaggi" icon={MessageCircle}>
          Messaggi privati con chi ha un profilo pubblico: dal suo profilo tocca{' '}
          <Ui>Scrivi un messaggio</Ui>.
        </ExtraCard>
        <ExtraCard href="/flashcards" title="Flashcard" icon={GraduationCap}>
          Un gioco a carte per imparare generi e storia della musica: gira la carta e tocca{' '}
          <Ui>Lo sapevo</Ui> o <Ui>Da ripassare</Ui>.
        </ExtraCard>
        <ExtraCard href="/classici" title="Classici" icon={Disc3}>
          Playlist per decennio, da <Ui>Anni 60</Ui> ad <Ui>Anni 90</Ui>, fatte con brani di artisti
          indipendenti (non le incisioni originali).
        </ExtraCard>
        <ExtraCard href="/bot" title="Bot" icon={Bot}>
          Scrivi cosa vuoi ascoltare, per esempio «lofi per studiare», e tocca <Ui>Chiedi</Ui>. Con
          il piano gratuito hai 30 ricerche al mese.
        </ExtraCard>
        <ExtraCard href="/impostazioni" title="Impostazioni" icon={Settings}>
          <Ui>Autoplay continuo</Ui> e <Ui>Risparmio dati</Ui>. Valgono solo sul dispositivo che
          stai usando.
        </ExtraCard>
        <ExtraCard href="/stato" title="Stato" icon={Activity}>
          Ti dice se Solco funziona in questo momento: utile quando qualcosa non va.
        </ExtraCard>
      </ul>
    </GuideSection>
  );
}
