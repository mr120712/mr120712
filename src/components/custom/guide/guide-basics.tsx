// @polsia:user-owned — sezioni della guida (/guida) sulle basi: account e accesso, cercare e
// ascoltare, il lettore musicale, ascoltare col telefono bloccato. Etichette copiate dall'app.

import {
  ChevronDown,
  CirclePlay,
  Headphones,
  Infinity as InfinityIcon,
  Lock,
  Pause,
  Play,
  Repeat,
  Search,
  Shuffle,
  SkipForward,
  UserRound,
  X,
} from 'lucide-react';
import { FREE_MONTHLY_PLAYS } from '@/lib/business/play-quota';
import { GuideAction, GuideSection, InlineIcon, Note, Points, Steps, Ui } from './guide-parts';

export function GuideAccount() {
  return (
    <GuideSection
      id="account"
      icon={UserRound}
      actions={
        <>
          <GuideAction href="/login">Accedi</GuideAction>
          <GuideAction href="/profile" variant="outline">
            Apri il tuo profilo
          </GuideAction>
        </>
      }
    >
      <p>
        L’account è il tuo spazio personale su Solco: serve per ascoltare e per ritrovare le tue
        cose su ogni dispositivo. È gratuito.
      </p>

      <h3>Cosa puoi fare senza account</h3>
      <p>
        Puoi leggere questa guida e le pagine <Ui>Privacy</Ui>, <Ui>Termini</Ui>,{' '}
        <Ui>Impostazioni</Ui> e <Ui>Stato</Ui>. Per ascoltare qualsiasi cosa, anche la radio, serve
        un account gratuito: senza, il lettore ti dice «Per ascoltare serve un account gratuito.
        Registrati o accedi.»
      </p>
      <p>
        Se apri una pagina che chiede l’account, Solco ti porta alla pagina di accesso e, dopo, ti
        riporta dove volevi andare.
      </p>

      <h3>Entrare nel tuo account</h3>
      <Steps>
        <li>
          Tocca <Ui>Accedi</Ui> in alto a destra.
        </li>
        <li>
          Scrivi la tua <Ui>Email</Ui> e la tua <Ui>Password</Ui>.
        </li>
        <li>
          Tocca <Ui>Accedi</Ui>. Se ti eri registrato con Google, tocca invece{' '}
          <Ui>Continua con Google</Ui>.
        </li>
      </Steps>
      <p>
        Dopo l’accesso Solco ti porta nella <Ui>Libreria</Ui>. Per andare alla Home tocca il nome{' '}
        <Ui>Solco</Ui> in alto a sinistra.
      </p>

      <h3>Hai dimenticato la password?</h3>
      <Steps>
        <li>
          Nella pagina di accesso tocca <Ui>Password dimenticata?</Ui>
        </li>
        <li>
          Scrivi l’email del tuo account e tocca <Ui>Inviami il link</Ui>.
        </li>
        <li>
          Apri l’email «Reimposta la password di Solco» e tocca <Ui>Scegli una nuova password</Ui>.
        </li>
        <li>
          Scrivi due volte la nuova password e tocca <Ui>Salva la nuova password</Ui>.
        </li>
      </Steps>
      <Note>
        <p>
          Il link vale un’ora e si usa una volta sola. Se l’email non arriva, guarda nella cartella
          spam. Dopo il cambio Solco ti fa uscire da tutti i dispositivi: rientra con la nuova
          password.
        </p>
      </Note>

      <h3>Confermare l’email</h3>
      <p>
        Dopo la registrazione ricevi l’email «Conferma la tua email su Solco» con il pulsante{' '}
        <Ui>Conferma email</Ui>. Non serve per entrare: serve solo se vuoi condividere una playlist
        con un link.
      </p>

      <h3>Il tuo profilo</h3>
      <p>
        Tocca l’icona con la persona <InlineIcon icon={UserRound} /> in alto a destra (si chiama{' '}
        <Ui>Profilo</Ui>). Qui vedi il tuo nome e la tua email. All’inizio il tuo profilo è{' '}
        <Ui>Privato</Ui>: nessun altro lo vede.
      </p>

      <h3>Uscire dall’account</h3>
      <p>
        Tocca <Ui>Esci</Ui> in alto a destra. La musica si ferma subito. Fallo sempre quando usi il
        telefono o il computer di un’altra persona.
      </p>

      <h3>Eliminare l’account</h3>
      <Steps>
        <li>
          Se hai un abbonamento, prima disdicilo con <Ui>Gestisci abbonamento</Ui> nella pagina{' '}
          <Ui>Piani</Ui>.
        </li>
        <li>
          Apri il <Ui>Profilo</Ui> e scorri fino a <Ui>Eliminazione account</Ui>.
        </li>
        <li>Nel campo scrivi ELIMINA ACCOUNT, tutto in maiuscolo.</li>
        <li>
          Tocca <Ui>Elimina definitivamente l’account</Ui>.
        </li>
      </Steps>
      <Note tone="warning">
        <p>
          Non si può tornare indietro: si cancellano playlist, cronologia, premi e giorni di Premium
          gratis. Eliminare l’account non ferma un abbonamento: per questo va disdetto prima.
        </p>
      </Note>
    </GuideSection>
  );
}

export function GuideSearch() {
  return (
    <GuideSection
      id="cercare"
      icon={Search}
      actions={
        <>
          <GuideAction href="/search">Prova a cercare</GuideAction>
          <GuideAction href="/generi" variant="outline">
            Sfoglia i generi
          </GuideAction>
        </>
      }
    >
      <h3>La Home</h3>
      <p>
        In cima alla Home c’è la domanda «Cosa ascoltiamo oggi?», con un campo per cercare e alcuni
        pulsanti rapidi. Scorrendo verso il basso trovi classifiche, radio consigliate, podcast e
        generi musicali.
      </p>
      <p>
        Sotto il campo di ricerca ci sono gli stati d’animo: <Ui>Relax</Ui>, <Ui>Energia</Ui>,{' '}
        <Ui>Allenamento</Ui>, <Ui>Concentrazione</Ui>, <Ui>Festa</Ui> e altri. Toccane uno per avere
        brani, radio e podcast adatti. Per tornare a tutto, tocca <Ui>Tutto</Ui>.
      </p>

      <h3>Cercare un brano, una radio o un podcast</h3>
      <Steps>
        <li>
          Tocca <Ui>Cerca</Ui>.
        </li>
        <li>Scrivi cosa cerchi: un titolo, un artista, il nome di una radio o di un podcast.</li>
        <li>
          Premi Invio, oppure tocca <Ui>Cerca</Ui>.
        </li>
        <li>
          Per vedere un solo tipo di risultato tocca <Ui>Brani</Ui>, <Ui>Radio</Ui> o{' '}
          <Ui>Podcast</Ui>. <Ui>Tutto</Ui> li mostra di nuovo tutti.
        </li>
        <li>
          Tocca il tondo con il triangolo <InlineIcon icon={Play} /> per ascoltare. Un podcast
          invece si apre toccando il suo titolo.
        </li>
      </Steps>
      <p>
        Accanto a ogni risultato c’è una piccola etichetta che dice da dove arriva, per esempio{' '}
        <Ui>Audius</Ui>, <Ui>YouTube</Ui>, <Ui>Radio</Ui> o <Ui>Podcast</Ui>. Perché conta? Lo
        spieghiamo in <a href="#schermo-bloccato">Ascoltare col telefono bloccato</a>.
      </p>

      <h3>Hai una canzone su Spotify o in un’altra app?</h3>
      <Steps>
        <li>In Spotify tocca Condividi e poi Copia link.</li>
        <li>
          In Solco apri <Ui>Cerca</Ui> e trova il riquadro «Ascolta in Solco un brano da Spotify o
          da un’altra app».
        </li>
        <li>Incolla tutto il testo copiato, oppure scrivi «Artista - Titolo».</li>
        <li>
          Tocca <Ui>Ascolta in Solco</Ui>: Solco cerca lo stesso brano e lo fa partire.
        </li>
      </Steps>

      <h3>Generi e playlist già pronte</h3>
      <p>
        Apri <Ui>Generi</Ui> dal menu: trovi playlist pronte, divise per genere. Dentro un genere
        tocca <Ui>Riproduci tutto</Ui> per ascoltarle in ordine, oppure <Ui>Casuale</Ui> per
        mescolarle.
      </p>
    </GuideSection>
  );
}

export function GuidePlayer() {
  return (
    <GuideSection
      id="lettore"
      icon={CirclePlay}
      actions={<GuideAction href="/radio">Ascolta una radio adesso</GuideAction>}
    >
      <p>
        Il lettore musicale (in inglese «player») è la barra che compare in basso quando fai partire
        un brano. Resta lì mentre cambi pagina, così la musica non si interrompe.
      </p>

      <h3>Il lettore piccolo, in basso</h3>
      <Points>
        <li>
          <InlineIcon icon={Play} /> / <InlineIcon icon={Pause} /> Play e Pausa: fa partire o ferma
          la musica.
        </li>
        <li>
          <InlineIcon icon={SkipForward} /> <Ui>Brano successivo</Ui>: passa al prossimo.
        </li>
        <li>
          <InlineIcon icon={InfinityIcon} /> <Ui>Autoplay continuo</Ui>: quando i brani finiscono,
          Solco continua da solo con brani consigliati.
        </li>
        <li>
          <InlineIcon icon={X} /> <Ui>Chiudi il player</Ui>: ferma la musica e chiude il lettore.
        </li>
      </Points>
      <p>Tocca la copertina o il titolo del brano per aprire il lettore grande.</p>

      <h3>Il lettore grande</h3>
      <Points>
        <li>
          <InlineIcon icon={ChevronDown} /> <Ui>Riduci il player</Ui>: torna al lettore piccolo.
        </li>
        <li>
          La barra sotto il titolo: trascinala per andare avanti o indietro nel brano. Per le radio
          c’è scritto <Ui>In diretta</Ui>.
        </li>
        <li>
          <InlineIcon icon={Shuffle} /> <Ui>Riproduzione casuale</Ui>: mescola l’ordine dei brani.
        </li>
        <li>
          <InlineIcon icon={Repeat} /> Ripeti: a ogni tocco cambia. <Ui>Ripeti: tutta la coda</Ui>,
          poi <Ui>Ripeti: solo questo brano</Ui>, poi <Ui>Ripeti: disattivato</Ui>.
        </li>
        <li>
          <Ui>Velocità (slowed / sped up)</Ui>: rallenta o accelera il brano, da 0.8× a 1.5×.
        </li>
        <li>
          <Ui>Coda</Ui>: l’elenco dei brani che suoneranno dopo. Tocca un brano per farlo partire
          subito.
        </li>
        <li>
          <Ui>Ascolta altrove</Ui>: apre lo stesso brano su altri servizi, come Spotify o YouTube
          Music. Lì vale il tuo account di quel servizio.
        </li>
        <li>
          <Ui>Condividi</Ui>: manda il brano a un amico, per esempio su WhatsApp.
        </li>
      </Points>
      <p>
        Con il piano gratuito il lettore grande mostra anche quanti ascolti hai già usato: «Ascolti
        gratuiti questo mese: X di {FREE_MONTHLY_PLAYS}.» Per esempio «5 di {FREE_MONTHLY_PLAYS}»
        vuol dire che ne hai usati 5 e te ne restano {FREE_MONTHLY_PLAYS - 5}.
      </p>
      <Note>
        <p>
          Se ricarichi la pagina, il lettore ricorda l’ultimo brano: tocca Play{' '}
          <InlineIcon icon={Play} /> per ripartire. I video YouTube e i brani importati ricominciano
          dall’inizio; gli altri, come i brani di Audius, i podcast e i tuoi file, ripartono dal
          punto in cui eri.
        </p>
      </Note>
    </GuideSection>
  );
}

export function GuideLockedScreen() {
  return (
    <GuideSection
      id="schermo-bloccato"
      icon={Lock}
      actions={<GuideAction href="/impostazioni">Apri le Impostazioni</GuideAction>}
    >
      <p>
        Vuoi ascoltare con lo schermo spento, o mentre usi un’altra app? Dipende da dove arriva il
        brano.
      </p>

      <h3>Cosa continua a suonare</h3>
      <Points>
        <li>
          I brani di <Ui>Audius</Ui>: nella Home li riconosci dalla scritta «ANCHE IN BACKGROUND».
        </li>
        <li>Gli episodi dei podcast.</li>
        <li>Le radio dal vivo.</li>
        <li>
          I tuoi file in <Ui>La tua musica</Ui> (vedi{' '}
          <a href="#libreria">La tua Libreria e le playlist</a>).
        </li>
      </Points>
      <p>
        Dalla schermata di blocco, dalle notifiche o con i tasti delle cuffie puoi mettere in pausa
        e cambiare brano.
      </p>

      <h3>Cosa si ferma: i video YouTube</h3>
      <p>
        I video di YouTube suonano solo con Solco aperto davanti a te: YouTube non permette
        l’ascolto in background. Se blocchi il telefono o cambi app, il video si ferma.
      </p>
      <Steps>
        <li>
          Prima di bloccare il telefono, tocca il pulsante con le cuffie{' '}
          <InlineIcon icon={Headphones} />, <Ui>Ascolta in background</Ui>. Solco cerca lo stesso
          brano in versione solo audio e lo mette al posto del video.
        </li>
        <li>
          Se compare «Questo brano non è disponibile per l’ascolto in background.», quel brano si
          può ascoltare solo come video, con lo schermo acceso.
        </li>
        <li>
          Se torni su Solco dopo che il video si è fermato, tocca{' '}
          <Ui>Continua in background con Audius</Ui> oppure <Ui>Riprendi il video</Ui>.
        </li>
      </Steps>

      <h3>Perché la musica non si fermi a fine elenco</h3>
      <p>
        Accendi <Ui>Autoplay continuo</Ui> nelle <Ui>Impostazioni</Ui> (le trovi in fondo a pagine
        come Cerca o Libreria, oppure con il pulsante qui sotto). In alternativa, nel lettore tocca
        il simbolo dell’infinito <InlineIcon icon={InfinityIcon} />. Quando i brani in coda
        finiscono, Solco continua con brani consigliati, anche a schermo bloccato. All’inizio è
        spento.
      </p>
      <Note>
        <p>
          Su iPhone, se dopo aver ricaricato la pagina la musica non riparte da sola, apri Solco e
          tocca Play <InlineIcon icon={Play} />: è il telefono che chiede un tocco.
        </p>
        <p>
          Con il piano gratuito anche gli ascolti a schermo bloccato di brani e podcast contano nei{' '}
          {FREE_MONTHLY_PLAYS} del mese (vedi <a href="#piani">Piani: Free e Premium</a>).
        </p>
      </Note>
    </GuideSection>
  );
}
