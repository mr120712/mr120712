// @polsia:user-owned
import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Informativa privacy',
  description: 'Informazioni sul trattamento dei dati personali nei servizi Solco.',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <article className={styles.content}>
        <p className={styles.eyebrow}>Solco · Privacy</p>
        <h1 className={styles.title}>Informativa privacy</h1>
        <p className={styles.updated}>Bozza per revisione del proprietario · 8 novembre 2026</p>

        <p className={styles.notice}>
          Questa pagina descrive i trattamenti rilevabili dal codice attuale. Prima della
          distribuzione pubblica, il proprietario deve confermare l’identità legale del titolare, le
          basi giuridiche, i tempi di conservazione, i responsabili esterni e ogni trattamento
          effettivamente attivo in produzione. I dati indicati come da confermare non sono
          dichiarazioni legali definitive.
        </p>

        <div className={styles.body}>
          <section>
            <h2>Titolare e contatti</h2>
            <p>
              Il servizio è Solco. La denominazione legale e l’indirizzo del titolare devono essere
              confermati dal proprietario prima della pubblicazione. Per richieste sulla privacy o
              per chiedere la cancellazione di un account, scrivi a{' '}
              <Link href="mailto:solcomusic@polsia.app">solcomusic@polsia.app</Link>.
            </p>
          </section>

          <section>
            <h2>Dati trattati</h2>
            <ul>
              <li>
                <strong>Account e accesso:</strong> nome, indirizzo email, credenziali gestite dal
                servizio di autenticazione e dati tecnici di sessione. Il modello account prevede
                anche indirizzo IP e user agent della sessione quando disponibili.
              </li>
              <li>
                <strong>Diario d’ascolto:</strong> album e artista scelti, identificativo e metadati
                già registrati, data d’ascolto, voto, nota personale e contesto facoltativo.
              </li>
              <li>
                <strong>Preferiti e playlist:</strong> identificativo, fonte e metadati necessari a
                mostrare brani Audius o video YouTube nelle raccolte private dell’account. Puoi
                rimuovere gli elementi o le playlist. I metadati YouTube vengono rimossi dopo 29
                giorni; l’identificativo video resta nella raccolta per consentire l’apertura
                successiva nel player ufficiale.
              </li>
              <li>
                <strong>Profili e community:</strong> nome, ruolo fan o artista e relazioni di
                follow vengono conservati per le funzioni community. Il profilo, la lista dei
                follower e la lista dei profili seguiti sono privati all’inizio; puoi renderli
                pubblici e modificare le rispettive visibilità da Profilo. Solco mostra solo i dati
                resi pubblici e non condivide il diario d’ascolto tramite queste liste.
              </li>
              <li>
                <strong>Ricerche musicali:</strong> la stessa query viene cercata su Audius; dopo il
                consenso esplicito viene inviata anche alla YouTube Data API v3. I risultati sono
                consultabili nelle schede «Solco» e «YouTube». YouTube restituisce titolo, canale,
                descrizione, data e attribuzione disponibili. I soli risultati di ricerca restano in
                una cache volatile per due minuti e non vengono salvati nel database. Le ricerche
                REST e le tendenze Audius vengono richieste quando è configurata AUDIUS_API_KEY lato
                server; la chiave non viene esposta al browser. Se la credenziale manca o la fonte
                non risponde, Solco mostra uno stato non configurato o non disponibile senza
                risultati sostitutivi. Se Audius conferma l’accesso allo stream, Solco inoltra
                l’audio al player senza archiviarlo e senza richiedere Solco Pro.
              </li>
              <li>
                <strong>Assistenza automatizzata:</strong> la domanda inviata alla chat di supporto
                viene trasmessa al proxy AI di Polsia per preparare la risposta; la chat non viene
                salvata nel database applicativo dal percorso attuale.
              </li>
              <li>
                <strong>Misurazione delle visite:</strong> se l’ambiente di distribuzione abilita
                l’analytics Polsia, il browser conserva in local storage un identificativo casuale e
                lo invia con le visite al servizio Polsia. Il proprietario deve confermare
                configurazione, finalità e base giuridica in produzione.
              </li>
            </ul>
          </section>

          <section>
            <h2>Finalità e basi giuridiche</h2>
            <p>
              I dati account e il diario servono a fornire le funzioni richieste dall’utente; le
              ricerche servono a mostrare risultati di catalogo; le domande alla chat servono a
              restituire assistenza. La base giuridica applicabile a ciascuna finalità, inclusa
              l’eventuale analytics, deve essere confermata dal titolare in base ai servizi attivi e
              ai mercati scelti.
            </p>
          </section>

          <section>
            <h2>Destinatari e servizi esterni</h2>
            <p>
              Il codice usa Better Auth e il database dell’app per account, diario e raccolte, l’API
              REST Audius quando è configurata la credenziale server-side, YouTube Data API v3 dopo
              consenso esplicito per la ricerca e il player ufficiale YouTube incorporato per la
              riproduzione selezionata e il proxy AI di Polsia per la chat di assistenza. La query e
              i metadati richiesti sono ricevuti da YouTube al momento della ricerca; al caricamento
              del player YouTube può ricevere dal browser dati tecnici e di utilizzo. Solco non
              estrae o archivia media YouTube. Puoi consultare la{' '}
              <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">
                Privacy Policy Google
              </a>{' '}
              e i{' '}
              <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">
                Termini YouTube
              </a>{' '}
              e i{' '}
              <a
                href="https://developers.google.com/youtube/terms/api-services-terms-of-service"
                target="_blank"
                rel="noreferrer"
              >
                Termini dei servizi API YouTube
              </a>{' '}
              e le{' '}
              <a
                href="https://developers.google.com/youtube/terms/developer-policies"
                target="_blank"
                rel="noreferrer"
              >
                Norme per gli sviluppatori YouTube
              </a>
              . Per Audius consulta i{' '}
              <a href="https://audius.co/documents/TermsOfUse.pdf" target="_blank" rel="noreferrer">
                Termini di utilizzo Audius
              </a>{' '}
              e la{' '}
              <a href="https://docs.audius.co/api/" target="_blank" rel="noreferrer">
                documentazione API REST Audius
              </a>{' '}
              e l’
              <a
                href="https://audius.co/documents/PrivacyPolicy.pdf"
                target="_blank"
                rel="noreferrer"
              >
                informativa privacy Audius
              </a>
              . Titolare, base giuridica applicabile, conservazione e flussi effettivi del player
              devono essere confermati prima della pubblicazione. L’analytics Polsia viene usata
              solo se configurata nell’ambiente. Solco Pro è previsto a 24,00 EUR una tantum tramite
              checkout Stripe ospitato da Polsia, con un mese di accesso e senza rinnovo. L’acquisto
              resta disattivato finché il titolare non completa configurazione e verifica Stripe dal
              widget Business e Polsia non supporta la creazione e verifica server-side dei
              pagamenti in EUR. I payout restano gestiti da Polsia/Stripe; non è richiesta una
              verifica bancaria separata per l’accesso. Il proprietario deve verificare i contratti,
              l’elenco aggiornato dei responsabili e i flussi realmente attivi prima di compilare
              Data safety.
            </p>
          </section>

          <section>
            <h2>Conservazione e cancellazione</h2>
            <p>
              I dati dell’account e le registrazioni restano nel database dell’app fino alla
              cancellazione dell’account. La richiesta autenticata elimina account, sessioni,
              diario, raccolte, dati dei prodotti e relativi controlli dal database applicativo. I
              tempi di eliminazione da backup, log e sistemi esterni, e ogni conservazione
              necessaria per obblighi legali o contabili, devono essere confermati dal proprietario
              e descritti qui prima della release. La cancellazione dell’account non equivale alla
              chiusura di un eventuale rapporto commerciale esterno.
            </p>
            <p>
              Puoi avviare la cancellazione da{' '}
              <Link href="/delete-account">solcomusic.app/delete-account</Link> oppure, dopo aver
              effettuato l’accesso, dalla pagina del profilo.
            </p>
          </section>

          <section>
            <h2>Sicurezza e aggiornamenti</h2>
            <p>
              Solco limita le operazioni sul diario alla sessione autenticata e comunica con il
              database tramite il server dell’app. Il proprietario deve completare la verifica dei
              responsabili, delle misure effettive e dei tempi di conservazione. Questa informativa
              va aggiornata quando cambiano funzioni o servizi esterni.
            </p>
          </section>
        </div>

        <div className={styles.actions}>
          <Button asChild variant="outline">
            <Link href="/delete-account">Richiesta di eliminazione account</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/">Torna a Solco</Link>
          </Button>
        </div>
      </article>
    </main>
  );
}
