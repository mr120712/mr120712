// @polsia:user-owned — fine della guida (/guida): «Problemi comuni» come domande apribili
// (<details>, leggibili senza JavaScript), il glossario «Parole utili» e «Serve altro aiuto?».

import { BookOpen, CircleHelp, LifeBuoy, Play } from 'lucide-react';
import Link from 'next/link';
import { FREE_TRIAL_DAYS } from '@/lib/business/free-trial';
import { FEATURED_FREE_MONTHLY_PLAYS, FREE_MONTHLY_PLAYS } from '@/lib/business/play-quota';
import styles from './guide.module.css';
import { Faq, GuideAction, GuideSection, InlineIcon, Points, Ui } from './guide-parts';

/** Contatto che l'app mostra per account, privacy ed eliminazione dei dati (pagina Privacy). */
const CONTACT_EMAIL = 'solcomusic@polsia.app';

export function GuideProblems() {
  return (
    <GuideSection
      id="problemi"
      icon={CircleHelp}
      actions={<GuideAction href="/stato">Controlla se Solco funziona</GuideAction>}
    >
      <p>Tocca una domanda per vedere la risposta. Toccala di nuovo per chiuderla.</p>
      <div className={styles.faqList}>
        <Faq question="Ogni pagina mi porta alla pagina «Accedi»">
          <p>
            Quasi tutto Solco chiede un account gratuito. Accedi, oppure registrati: dopo, Solco ti
            riporta alla pagina che volevi aprire. Senza account si aprono solo poche pagine, come
            questa guida, Privacy, Termini, Impostazioni, Stato e i link che altri ti mandano
            (playlist e quiz).
          </p>
        </Faq>
        <Faq question="Il lettore dice «Per ascoltare serve un account gratuito.»">
          <p>
            Per ascoltare qualsiasi cosa, anche radio e video, serve un account. Crealo con{' '}
            <Ui>Inizia gratis</Ui> o <Link href="/signup">Registrati</Link>: è gratis e non chiede
            la carta.
          </p>
        </Faq>
        <Faq question="«Email o password non corretti.»">
          <p>
            Ricontrolla email e password: maiuscole e minuscole contano. Se non ricordi la password,
            tocca <Ui>Password dimenticata?</Ui>. Se ti eri registrato con Google, tocca{' '}
            <Ui>Continua con Google</Ui>.
          </p>
        </Faq>
        <Faq question="Non arriva l’email per cambiare la password">
          <p>
            Controlla di aver scritto l’email del tuo account e guarda nella cartella spam. Il link
            vale un’ora: se è scaduto, tocca <Ui>Chiedi un nuovo link</Ui>.
          </p>
        </Faq>
        <Faq question="«Hai fatto troppi tentativi. Attendi qualche minuto e riprova.»">
          <p>È una protezione per il tuo account. Aspetta qualche minuto e riprova.</p>
        </Faq>
        <Faq question={`«Hai usato i ${FREE_MONTHLY_PLAYS} ascolti gratuiti di questo mese.»`}>
          <p>
            Hai finito gli ascolti gratuiti di brani e podcast. Radio dal vivo, video YouTube e i
            tuoi file in <Ui>La tua musica</Ui> restano senza limiti. Il conteggio riparte il mese
            prossimo. Se vuoi ascoltare senza limiti, puoi provare Premium gratis per{' '}
            {FREE_TRIAL_DAYS} giorni dalla pagina <Link href="/piani">Piani</Link>.
          </p>
        </Faq>
        <Faq
          question={`«Hai usato i ${FEATURED_FREE_MONTHLY_PLAYS} ascolti gratuiti dei brani in evidenza di questo mese.»`}
        >
          <p>
            I brani in evidenza della Home hanno un conteggio a parte: con un account Free puoi
            avviarne {FEATURED_FREE_MONTHLY_PLAYS} al mese, e riprendere lo stesso brano entro 30
            minuti non conta di nuovo. Il conteggio riparte il mese prossimo. Brani di Audius,
            podcast, radio dal vivo, video YouTube e i tuoi file continuano come prima.
          </p>
        </Faq>
        <Faq question="La musica si ferma quando blocco il telefono">
          <p>
            Succede con i video YouTube: YouTube non permette l’ascolto in background. Tocca{' '}
            <Ui>Ascolta in background</Ui> per passare alla versione solo audio, se esiste. Brani di
            Audius, podcast, radio e i tuoi file continuano anche a schermo bloccato.
          </p>
        </Faq>
        <Faq question="La musica si ferma quando finisce l’elenco dei brani">
          <p>
            È normale: all’inizio <Ui>Autoplay continuo</Ui> è spento. Accendilo nelle{' '}
            <Link href="/impostazioni">Impostazioni</Link>, oppure tocca il simbolo ∞ nel lettore.
          </p>
        </Faq>
        <Faq question="Ho ricaricato la pagina e la musica non riparte">
          <p>
            Il lettore ricorda il brano ma resta in pausa: tocca Play <InlineIcon icon={Play} /> nel
            lettore in basso. Su iPhone è il telefono che chiede questo tocco.
          </p>
        </Faq>
        <Faq question="Non trovo i miei «Mi piace»">
          <p>
            In Solco si chiamano <Ui>Preferiti</Ui>: sono la prima raccolta nella scheda{' '}
            <Ui>Playlist</Ui> della <Link href="/library">Libreria</Link>. Si riempiono con il cuore
            accanto ai video musicali.
          </p>
        </Faq>
        <Faq question="Non riesco a condividere una playlist">
          <p>
            Per creare un link serve un’email confermata. Tocca{' '}
            <Ui>Invia di nuovo il link di verifica</Ui>, apri l’email che ricevi e riprova. I
            Preferiti non si possono condividere: restano sempre privati.
          </p>
        </Faq>
        <Faq question="Le impostazioni sul telefono sono diverse da quelle sul computer">
          <p>
            <Ui>Autoplay continuo</Ui> e <Ui>Risparmio dati</Ui> valgono solo sul dispositivo dove
            li scegli. Impostali su ogni telefono o computer che usi.
          </p>
        </Faq>
        <Faq question="Android non installa l’app">
          <p>
            Apri il file scaricato e, se Android lo chiede, consenti al browser di installare app
            sconosciute. Se avevi una versione vecchia di Solco, disinstallala prima. Serve Android
            7.0 o successivo.
          </p>
        </Faq>
        <Faq question="L’iPhone dice che il profilo è «non verificato»">
          <p>
            È normale: il profilo non è firmato da Apple e aggiunge solo l’icona di Solco, non
            installa programmi. Usa Safari, con iOS 15 o successivo.
          </p>
        </Faq>
        <Faq question={`Non vedo «Prova gratis ${FREE_TRIAL_DAYS} giorni», ma solo «Abbonati a…»`}>
          <p>
            La prova gratuita vale una sola volta per account. Se il tuo account ha già avuto un
            abbonamento, la prova non viene più offerta.
          </p>
        </Faq>
        <Faq question="Dopo il pagamento vedo «Pagamento in elaborazione»">
          <p>
            Il pagamento è ancora in conferma. Ricarica la pagina tra qualche minuto, con lo stesso
            account.
          </p>
        </Faq>
        <Faq question="La radio si interrompe o non parte">
          <p>
            Se la rete cambia (per esempio dal Wi-Fi ai dati) Solco riprova da solo. Se compare «La
            stazione radio non risponde in questo momento. Prova un’altra stazione.», scegli
            un’altra stazione.
          </p>
        </Faq>
        <Faq question="Un video YouTube non parte e passa al successivo">
          <p>
            Alcuni video non si possono guardare fuori da YouTube, o non sono più disponibili: in
            quel caso il lettore passa da solo al brano successivo.
          </p>
        </Faq>
        <Faq question="Su iPhone i miei file in «La tua musica» sono spariti">
          <p>
            Safari può cancellare i file di un sito che apri di rado. Aggiungi Solco alla schermata
            Home e aggiungi di nuovo i brani dall’icona di Solco.
          </p>
        </Faq>
        <Faq question="Voglio eliminare l’account ma non riesco ad accedere">
          <p>
            Prova prima <Ui>Password dimenticata?</Ui>. Se non basta, scrivi a{' '}
            <a className={styles.email} href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
            , meglio dall’indirizzo email del tuo account. Non mandare mai password o codici.
          </p>
        </Faq>
      </div>
    </GuideSection>
  );
}

const GLOSSARY: ReadonlyArray<{ term: string; definition: string }> = [
  {
    term: 'Account',
    definition: 'Il tuo spazio personale su Solco, con email e password. È gratuito.',
  },
  {
    term: 'APK',
    definition:
      'Il file che installa l’app di Solco su un telefono Android. Lo scarichi dalla pagina Installa l’app.',
  },
  {
    term: 'App',
    definition:
      'Un programma per il telefono. L’app di Solco è un’icona sulla schermata Home che apre Solco a schermo intero.',
  },
  {
    term: 'Audius',
    definition:
      'Un catalogo di musica di artisti indipendenti. I suoi brani si ascoltano interi, anche a schermo bloccato.',
  },
  {
    term: 'Autoplay continuo',
    definition: 'Quando i brani finiscono, Solco continua da solo con brani consigliati.',
  },
  {
    term: 'Browser',
    definition: 'Il programma con cui apri i siti, per esempio Chrome o Safari.',
  },
  {
    term: 'Coda',
    definition: 'L’elenco dei brani che suoneranno dopo quello che stai ascoltando.',
  },
  { term: 'Cronologia', definition: 'L’elenco dei brani che hai ascoltato.' },
  {
    term: 'In background',
    definition: 'La musica continua mentre usi un’altra app o mentre lo schermo è spento.',
  },
  {
    term: 'Libreria',
    definition:
      'La pagina con le tue cose: Preferiti, playlist, radio salvate e podcast che segui.',
  },
  {
    term: 'Lettore (player)',
    definition: 'La barra in basso che suona la musica, con i pulsanti Play, Pausa e Avanti.',
  },
  { term: 'Offline', definition: 'Senza connessione a internet.' },
  { term: 'Playlist', definition: 'Un elenco di brani da ascoltare uno dopo l’altro.' },
  {
    term: 'Podcast',
    definition:
      'Un programma parlato a puntate, da ascoltare quando vuoi. Ogni puntata si chiama episodio.',
  },
  {
    term: 'Preferiti',
    definition: 'La tua raccolta dei brani del cuore. La riempi toccando il cuore.',
  },
  {
    term: 'Premium',
    definition: 'I piani a pagamento di Solco, con ascolti illimitati. Free è il piano gratuito.',
  },
  {
    term: 'Profilo (iPhone)',
    definition:
      'Un piccolo file di impostazioni che aggiunge l’icona di Solco alla schermata Home dell’iPhone. Non è il tuo Profilo di Solco.',
  },
  { term: 'Radio dal vivo', definition: 'Stazioni radio vere, che trasmettono in diretta.' },
  {
    term: 'Schermata Home',
    definition: 'La pagina del telefono con le icone delle app. Non è la Home di Solco.',
  },
  {
    term: 'YouTube',
    definition:
      'Il sito dei video. In Solco i suoi video musicali suonano nel lettore ufficiale di YouTube e si fermano se blocchi il telefono.',
  },
];

export function GuideGlossary() {
  return (
    <GuideSection
      id="parole"
      icon={BookOpen}
      actions={
        <GuideAction href="#primi-passi" variant="outline">
          Torna ai primi passi
        </GuideAction>
      }
    >
      <dl className={styles.glossary}>
        {GLOSSARY.map((entry) => (
          <div key={entry.term} className={styles.glossaryItem}>
            <dt>{entry.term}</dt>
            <dd>{entry.definition}</dd>
          </div>
        ))}
      </dl>
    </GuideSection>
  );
}

export function GuideMoreHelp() {
  return (
    <GuideSection
      id="aiuto"
      icon={LifeBuoy}
      actions={
        <>
          <GuideAction href="/stato">Controlla lo stato di Solco</GuideAction>
          <GuideAction href="/privacy" variant="outline">
            Leggi la Privacy
          </GuideAction>
        </>
      }
    >
      <Points>
        <li>
          Rileggi i <a href="#problemi">Problemi comuni</a>: le domande più frequenti sono lì.
        </li>
        <li>
          <Ui>Assistenza</Ui>: è il pulsante in basso a destra (sul telefono è un tondo con il
          fumetto). Scrivi la tua domanda nel campo «Scrivi una domanda su Solco…» e inviala.
          Risponde un assistente automatico, basato sull’intelligenza artificiale, solo su come si
          usa Solco: la tua domanda viene inviata a un servizio esterno di intelligenza artificiale,
          quindi non scriverci dati personali. Non c’è nelle pagine di accesso, di registrazione e
          in Cerca.
        </li>
        <li>
          <Link href="/stato">Stato</Link>: ti dice se in questo momento Solco ha un problema.
        </li>
        <li>
          Per domande sul tuo account, sulla privacy o per cancellare i tuoi dati scrivi a{' '}
          <a className={styles.email} href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          , meglio dall’indirizzo email del tuo account. Non mandare mai password o codici.
        </li>
      </Points>
    </GuideSection>
  );
}
