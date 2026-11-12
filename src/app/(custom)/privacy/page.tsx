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
                <strong>Playlist condivise:</strong> se scegli «Condividi» su una playlist (serve un
                indirizzo email verificato), Solco ti mostra prima cosa vedrà chi apre il link e poi
                crea un link casuale. Chiunque abbia il link può vedere il nome della playlist, la
                prima parola del nome del tuo account (mai l’email) e i brani che contiene, e
                salvarne una copia, finché non scegli «Smetti di condividere» o elimini la playlist.
                Da quel momento il link si disattiva, ma per qualche minuto può ancora rispondere
                perché pagina e anteprima restano brevemente nella cache. Le copie già salvate da
                altri restano nelle loro Librerie, e le anteprime già comparse in chat o social
                restano conservate da quelle app. L’anteprima usa solo copertine Audius, mai
                miniature di YouTube. Le pagine delle playlist condivise non vengono indicizzate dai
                motori di ricerca. I Preferiti restano sempre privati.
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
                descrizione, data e attribuzione disponibili. Per risparmiare la quota di YouTube i
                risultati di una ricerca (testo cercato e metadati dei video, senza dati
                dell’account) vengono salvati nel database e riusati per chiunque faccia la stessa
                ricerca: per 24 ore come risultati attuali; dopo, solo se YouTube non si può
                interrogare, come «Risultati salvati il …» con la loro data, purché siano stati
                ricevuti o ricontrollati con YouTube negli ultimi 7 giorni (il ricontrollo toglie i
                video eliminati, privati o non più disponibili in Italia e aggiorna titoli e
                canali). Vengono cancellati 28 giorni dopo la ricerca, in ogni caso entro 29. Le
                classifiche YouTube per paese vengono riusate per 2 ore e, se YouTube non risponde,
                mostrate al massimo fino a 24 ore dopo che YouTube le ha inviate; la pulizia
                giornaliera le cancella entro il giorno successivo. Per limitare le ricerche
                giornaliere Solco conta le ricerche YouTube di ogni account o, senza accesso,
                dell’indirizzo IP della connessione (salvati come hash); la pulizia giornaliera
                cancella i contatori fermi da 2 giorni. Le ricerche REST e le tendenze Audius
                vengono richieste quando è configurata AUDIUS_API_KEY lato server; la chiave non
                viene esposta al browser. Se la credenziale manca o la fonte non risponde, Solco
                mostra uno stato non configurato o non disponibile senza risultati sostitutivi. Se
                Audius conferma l’accesso allo stream, Solco inoltra l’audio al player senza
                archiviarlo e senza richiedere Solco Pro.
              </li>
              <li>
                <strong>Cronologia di ascolto:</strong> con l’accesso, Solco registra i brani che
                ascolti (identificativo, titolo, artista, copertina, fonte, numero e data
                dell’ultimo ascolto) per mostrarli nella Libreria; puoi cancellarla da lì. Per i
                video YouTube, titolo, canale e miniatura sono dati di YouTube: la voce non viene
                più mostrata 28 giorni dopo che YouTube ha inviato quei dati e la pulizia
                giornaliera la cancella entro il giorno successivo, anche se nel frattempo riascolti
                il brano. Se Solco non può stabilire quando YouTube li ha inviati (per esempio un
                brano rimasto a lungo nella coda del player), la voce non viene mostrata.
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
            <p>
              Video TikTok: alcune pagine mostrano video TikTok pubblici scelti da Solco. Il player
              ufficiale di TikTok viene caricato solo se tocchi “Carica video TikTok”: da quel
              momento TikTok riceve dal tuo browser dati tecnici e di navigazione e può usare
              cookie, secondo l’
              <a
                href="https://www.tiktok.com/legal/privacy-policy-eea"
                target="_blank"
                rel="noreferrer"
              >
                informativa privacy di TikTok
              </a>
              . Solco non scarica né conserva video o audio di TikTok.
            </p>
            <p>
              Ricerca con l’AI (inclusa in Premium): la descrizione che scrivi viene inviata ad
              Anthropic (modello Claude) tramite la sua API per preparare le ricerche. Le ricerche
              risultanti vengono poi eseguite sulle fonti di Solco: YouTube (Google), Audius,
              Jamendo, Radio Browser e la ricerca podcast di Apple (iTunes). Non inviamo ad
              Anthropic il tuo nome, la tua email o altri dati dell’account. Il piano preparato (le
              ricerche e la frase di presentazione) resta salvato nel database di Solco per al
              massimo 7 giorni, legato al tuo account e cancellato insieme all’account; solo i piani
              degli esempi già pronti sono condivisi tra gli utenti. Consulta l’
              <a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noreferrer">
                informativa privacy di Anthropic
              </a>
              .
            </p>
            <p>
              Spotify: dalla Libreria puoi collegare il tuo account Spotify per trasferire in Solco
              le tue playlist e i brani salvati. Solco chiede a Spotify solo i permessi di lettura
              delle playlist, comprese quelle collaborative, e dei brani salvati
              (playlist-read-private, playlist-read-collaborative e user-library-read): non modifica
              nulla su Spotify e non riproduce audio da Spotify. <strong>Cosa viene letto:</strong>{' '}
              l’elenco delle tue playlist, comprese quelle che segui (per ciascuna: nome, nome del
              proprietario, copertina, numero di brani e se Spotify consente di leggerne i brani), e
              il numero dei brani salvati, mostrati solo mentre scegli cosa importare e mai salvati;
              quando confermi l’importazione, i brani delle playlist che hai scelto e, se lo
              selezioni, i tuoi brani salvati. <strong>Cosa viene conservato:</strong> solo le
              playlist che importi, come tue playlist Solco, con titolo, artista, durata e link a
              Spotify di ogni brano (al massimo 200 brani per playlist); restano finché non le
              elimini o non elimini l’account. Come per gli elenchi importati da file, quando
              ascolti un brano Solco ne cerca titolo e artista su YouTube. I token di accesso di
              Spotify sono conservati cifrati nel database, non vengono mai inviati al browser e
              vengono cancellati quando scolleghi Spotify o elimini l’account.{' '}
              <strong>Come scollegare:</strong> usa il pulsante «Disconnetti Spotify» nella{' '}
              <Link href="/library">Libreria</Link> e, se vuoi, revoca l’accesso di Solco anche
              dalla pagina{' '}
              <a href="https://www.spotify.com/account/apps/" target="_blank" rel="noreferrer">
                App del tuo account Spotify
              </a>
              . I dati ricevuti da Spotify non vengono inviati alla ricerca con l’AI, alla chat di
              assistenza né ad altri servizi di intelligenza artificiale e non sono usati per
              addestrare modelli. Consulta l’
              <a
                href="https://www.spotify.com/legal/privacy-policy/"
                target="_blank"
                rel="noreferrer"
              >
                informativa privacy di Spotify
              </a>
              .
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
