// @polsia:user-owned
import type { Metadata } from 'next';
import Link from 'next/link';
import { FREE_MONTHLY_PLAYS } from '@/lib/business/play-quota';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Termini di Solco',
  description: 'Condizioni d’uso della ricerca e riproduzione musicale Audius e YouTube in Solco.',
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  return (
    <main className={styles.page}>
      <article className={styles.content}>
        <p className={styles.eyebrow}>Solco · Termini</p>
        <h1 className={styles.title}>Termini di Solco</h1>
        <p className={styles.updated}>Bozza per revisione del proprietario · 9 novembre 2026</p>

        <p className={styles.notice}>
          Identità legale del titolare, condizioni generali del servizio, basi giuridiche e
          conservazione devono essere confermate dal proprietario prima della pubblicazione.
        </p>

        <div className={styles.body}>
          <section>
            <h2>Ricerca e ascolto da Audius</h2>
            <p>
              Solco usa Audius come fonte della scheda «Solco». La ricerca REST, le tendenze e i
              metadati arrivano dall’API REST ufficiale Audius quando è configurata la credenziale
              server-side AUDIUS_API_KEY. La chiave non viene inviata al client. Se la chiave manca
              o Audius non risponde, Solco mostra la fonte come non configurata o non disponibile e
              non inventa risultati. Lo streaming viene avviato soltanto per i brani per cui la
              risposta ufficiale Audius indica che l’accesso al flusso è consentito.
            </p>
            <p>
              Quando Audius consente lo stream, il brano si ascolta per intero anche con il piano
              Free, nei limiti indicati in «Piani e limite di ascolti». Solco inoltra i byte al
              player senza archiviarli. Si applicano i{' '}
              <a href="https://audius.co/documents/TermsOfUse.pdf" target="_blank" rel="noreferrer">
                Termini di utilizzo Audius
              </a>
              , i termini API applicabili.
            </p>
          </section>

          <section>
            <h2>Piani e limite di ascolti</h2>
            <p>
              Con un account Free puoi avviare fino a {FREE_MONTHLY_PLAYS} ascolti al mese di brani
              Audius e podcast; riprendere lo stesso brano entro 30 minuti non conta come nuovo
              ascolto. Le radio dal vivo e i video YouTube richiedono l’accesso ma non contano nel
              limite. Con Premium gli ascolti di brani Audius e podcast sono illimitati. Prezzi e
              vantaggi di ogni piano sono nella pagina <Link href="/piani">Piani</Link>.
            </p>
          </section>

          <section>
            <h2>Ricerca e player YouTube</h2>
            <p>
              Dopo aver accettato l’invio a YouTube, un invio dalla barra di ricerca trasmette la
              stessa query alla YouTube Data API v3 insieme alla ricerca Audius; i risultati restano
              consultabili nelle schede «Solco» e «YouTube». YouTube fornisce titolo, canale,
              descrizione, data e attribuzione disponibili. Per risparmiare la quota, i risultati di
              una ricerca (testo cercato e metadati dei video, senza dati dell’account) sono
              condivisi tra gli utenti e salvati per 24 ore come risultati attuali; se YouTube non
              si può interrogare, Solco può mostrarli come «Risultati salvati il …», con la loro
              data, solo se ricevuti o ricontrollati con YouTube negli ultimi 7 giorni, e li
              cancella 28 giorni dopo la ricerca (entro 29). Se selezioni un risultato, Solco carica
              esclusivamente il player ufficiale YouTube visibile; i controlli, il branding e gli
              annunci restano gestiti da YouTube.
            </p>
            <p>
              Solco non estrae, scarica, archivia o rende disponibili offline audio o video YouTube.
              Per una raccolta autenticata, i metadati YouTube sono conservati per non più di 29
              giorni. Alla scadenza i metadati vengono rimossi, mentre l’identificativo resta nella
              raccolta così il video salvato può ancora aprire il player ufficiale; puoi rimuovere
              l’elemento in qualsiasi momento.
            </p>
            <p>
              L’uso dell’API e del player è soggetto ai{' '}
              <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">
                Termini di servizio YouTube
              </a>
              , ai{' '}
              <a
                href="https://developers.google.com/youtube/terms/api-services-terms-of-service"
                target="_blank"
                rel="noreferrer"
              >
                Termini dei servizi API YouTube
              </a>{' '}
              e alle{' '}
              <a
                href="https://developers.google.com/youtube/terms/developer-policies"
                target="_blank"
                rel="noreferrer"
              >
                Norme per gli sviluppatori YouTube
              </a>
              .
            </p>
          </section>

          <section>
            <h2>Raccolte e servizi esterni</h2>
            <p>
              Preferiti e playlist sono privati e associati all’account autenticato. Puoi rimuovere
              singoli elementi o eliminare una playlist. Per i dettagli sui dati, sui servizi
              esterni e sulla conservazione consulta l’
              <Link href="/privacy">informativa privacy Solco</Link>.
            </p>
            <p>
              YouTube tratta query e dati tecnici quando usi ricerca o player secondo la propria{' '}
              <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">
                Informativa sulla privacy Google
              </a>
              . Per Audius consulta i{' '}
              <a href="https://docs.audius.co/api/" target="_blank" rel="noreferrer">
                termini e la documentazione API Audius
              </a>{' '}
              e l’
              <a
                href="https://audius.co/documents/PrivacyPolicy.pdf"
                target="_blank"
                rel="noreferrer"
              >
                informativa privacy Audius
              </a>
              .
            </p>
          </section>
        </div>

        <div className={styles.actions}>
          <Link href="/search">Torna alla ricerca musicale</Link>
          <Link href="/">Torna a Solco</Link>
        </div>
      </article>
    </main>
  );
}
