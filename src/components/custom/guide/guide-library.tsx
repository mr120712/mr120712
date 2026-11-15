// @polsia:user-owned — sezioni della guida (/guida): la Libreria e le playlist, radio e podcast,
// Solco sul telefono. Solo funzioni raggiungibili oggi; i download solo come li limita l'app.

import { Heart, Library, Play, Radio, Smartphone } from 'lucide-react';
import { FREE_MONTHLY_PLAYS } from '@/lib/business/play-quota';
import { GuideAction, GuideSection, InlineIcon, Note, Points, Steps, Ui } from './guide-parts';

export function GuideLibrary() {
  return (
    <GuideSection
      id="libreria"
      icon={Library}
      actions={<GuideAction href="/library">Apri la Libreria</GuideAction>}
    >
      <p>
        La <Ui>Libreria</Ui> è il posto dove Solco tiene le tue cose: brani preferiti, playlist,
        radio salvate, podcast che segui e cronologia. Sul telefono la apri dalla barra in basso;
        sul computer dal menu <Ui>Altro</Ui>, in alto.
      </p>

      <h3>Le schede della Libreria</h3>
      <Points>
        <li>
          <Ui>Playlist</Ui>: i tuoi Preferiti e le tue playlist.
        </li>
        <li>
          <Ui>Radio</Ui>: le stazioni che hai salvato.
        </li>
        <li>
          <Ui>Podcast</Ui>: i podcast che segui.
        </li>
        <li>
          <Ui>Cronologia</Ui>: i brani che hai ascoltato.
        </li>
      </Points>
      <p>
        In cima alla pagina c’è anche <Ui>La tua musica</Ui>, con i file musicali del tuo
        dispositivo.
      </p>

      <h3>I Preferiti</h3>
      <p>
        I <Ui>Preferiti</Ui> sono la tua raccolta dei brani del cuore: esistono già, non devi
        crearli. Si riempiono quando tocchi il cuore <InlineIcon icon={Heart} /> accanto a un video
        musicale, per esempio in <Ui>Top in classifica</Ui> nella Home o nelle pagine dei generi.
        Per togliere un brano tocca <Ui>Rimuovi</Ui>. I Preferiti restano sempre privati.
      </p>

      <h3>Avere una playlist</h3>
      <p>
        Una playlist è un elenco di brani da ascoltare uno dopo l’altro. Il cuore aggiunge sempre ai
        Preferiti; una playlist nuova nasce in uno di questi modi:
      </p>
      <Points>
        <li>
          Da una playlist YouTube pubblica: incolla il suo link nel campo «Importa: incolla il link
          di una playlist YouTube» e tocca <Ui>Importa playlist</Ui>.
        </li>
        <li>
          Da un elenco scritto da te: apri «Importa un elenco di brani (da Spotify o altri
          servizi)», scrivi un brano per riga, come «Artista - Titolo», e tocca{' '}
          <Ui>Importa elenco</Ui>.
        </li>
        <li>
          Da Spotify, se vedi il riquadro <Ui>Importa da Spotify</Ui>: tocca{' '}
          <Ui>Accedi con Spotify</Ui>, poi <Ui>Scegli le playlist</Ui> e infine{' '}
          <Ui>Importa in Solco</Ui>. Per ora funziona solo con gli account Spotify che Solco ha
          abilitato: se compare «non è ancora tra gli utenti autorizzati», usa l’elenco scritto da
          te del punto qui sopra, che funziona per tutti.
        </li>
        <li>
          Da un amico: apri il link della playlist che ti ha mandato e tocca{' '}
          <Ui>Salva nella mia libreria</Ui>.
        </li>
      </Points>
      <p>
        I brani importati vengono cercati su YouTube nel momento in cui li ascolti, quindi suonano
        come video.
      </p>

      <h3>Condividere una playlist con un amico</h3>
      <Steps>
        <li>
          Tocca <Ui>Condividi</Ui> accanto alla playlist.
        </li>
        <li>
          Leggi cosa vedrà chi apre il link e tocca <Ui>Crea il link</Ui>.
        </li>
        <li>
          Manda il link: sul telefono si apre il menu per condividere, sul computer il link viene
          copiato e lo incolli dove vuoi.
        </li>
      </Steps>
      <p>
        Chi apre il link vede la playlist anche senza account; per ascoltarla deve accedere. Per
        fermare la condivisione tocca <Ui>Smetti di condividere</Ui>. La tua email non viene mai
        mostrata.
      </p>
      <Note>
        <p>
          Per creare un link serve un’email confermata. Se Solco te lo chiede, tocca{' '}
          <Ui>Invia di nuovo il link di verifica</Ui> e apri l’email che ricevi.
        </p>
      </Note>

      <h3>Mettere ordine</h3>
      <Points>
        <li>
          <Ui>Aggiungi descrizione</Ui>: scrivi due righe sulla playlist (al massimo 300 caratteri).
        </li>
        <li>
          Cartelle: scrivi un nome in «Nuova cartella» e tocca <Ui>Crea cartella</Ui>. Poi sposta
          una playlist con il menu accanto al suo titolo.
        </li>
        <li>
          <Ui>Elimina playlist</Ui>: la cancella per sempre, dopo una conferma.
        </li>
      </Points>

      <h3>La cronologia</h3>
      <p>
        Nella scheda <Ui>Cronologia</Ui> trovi i brani che hai ascoltato. Un brano compare dopo 30
        secondi di ascolto. <Ui>Cancella cronologia</Ui> la svuota (e azzera anche le{' '}
        <Ui>Statistiche</Ui>).
      </p>

      <h3>La tua musica: i file del tuo telefono o computer</h3>
      <Steps>
        <li>
          In cima alla Libreria, in <Ui>La tua musica</Ui>, tocca <Ui>Aggiungi brani</Ui>.
        </li>
        <li>
          Scegli i tuoi file musicali (MP3, M4A, AAC, WAV, FLAC o OGG). Su iPhone si scelgono
          dall’app File.
        </li>
      </Steps>
      <p>
        I file restano solo su quel dispositivo, non vengono caricati su Solco, funzionano anche
        senza internet e non contano negli ascolti del piano gratuito.
      </p>
      <Note>
        <p>
          Su iPhone aggiungi prima Solco alla schermata Home (vedi{' '}
          <a href="#app">Solco sul telefono</a>) e poi aggiungi i brani dall’icona di Solco: Safari
          può cancellare i file di un sito che apri di rado.
        </p>
      </Note>

      <h3>Ascoltare senza internet</h3>
      <p>
        Puoi scaricare solo quello che la fonte permette: gli episodi dei podcast (pulsante{' '}
        <Ui>Scarica</Ui>) e i brani di Audius che l’artista ha reso scaricabili (sotto una playlist,{' '}
        <Ui>Scarica per offline</Ui>). Video YouTube e radio restano sempre online. Quello che
        scarichi finisce in <Ui>La tua musica</Ui>.
      </p>
    </GuideSection>
  );
}

export function GuideRadioPodcast() {
  return (
    <GuideSection
      id="radio-podcast"
      icon={Radio}
      actions={
        <>
          <GuideAction href="/radio">Apri le radio</GuideAction>
          <GuideAction href="/podcasts" variant="outline">
            Apri i podcast
          </GuideAction>
        </>
      }
    >
      <h3>Radio dal vivo</h3>
      <Steps>
        <li>
          Tocca <Ui>Radio</Ui> (sul telefono è nella barra in basso).
        </li>
        <li>
          Cerca una stazione per nome nel campo «Cerca una stazione», oppure tocca un genere, come{' '}
          <Ui>Pop</Ui>, <Ui>Rock</Ui> o <Ui>Jazz</Ui>.
        </li>
        <li>
          Se vuoi radio di altri paesi, cambia <Ui>Italia</Ui> nel menu accanto (c’è anche{' '}
          <Ui>Tutto il mondo</Ui>).
        </li>
        <li>
          Tocca Play <InlineIcon icon={Play} /> sulla stazione per ascoltarla.
        </li>
        <li>
          Tocca il cuore <InlineIcon icon={Heart} /> per salvarla: la ritrovi in cima, in «Le tue
          radio», e nella Libreria.
        </li>
      </Steps>
      <p>
        Le radio sono senza limiti e non contano negli ascolti del piano gratuito. Possono avere la
        pubblicità della stazione.
      </p>

      <h3>Podcast</h3>
      <p>
        Un podcast è un programma parlato a puntate, da ascoltare quando vuoi. Ogni puntata si
        chiama episodio.
      </p>
      <Steps>
        <li>
          Tocca <Ui>Podcast</Ui>.
        </li>
        <li>
          Cerca un programma nel campo «Cerca un podcast», o scegline uno tra quelli in classifica.
        </li>
        <li>
          Tocca il podcast per aprirlo, poi tocca <Ui>Ultimo episodio</Ui>, oppure Play{' '}
          <InlineIcon icon={Play} /> accanto a un episodio.
        </li>
        <li>
          Tocca <Ui>Segui</Ui> per ritrovarlo nella Libreria.
        </li>
      </Steps>
      <p>
        Con il piano gratuito ogni episodio che fai partire conta nei {FREE_MONTHLY_PLAYS} ascolti
        del mese. Dalla schermata di blocco puoi tornare indietro di 15 secondi o andare avanti di
        30.
      </p>
    </GuideSection>
  );
}

export function GuidePhoneApp() {
  return (
    <GuideSection
      id="app"
      icon={Smartphone}
      actions={<GuideAction href="/app">Installa l’app</GuideAction>}
    >
      <p>
        Solco funziona già nel browser del telefono, cioè il programma che usi per aprire i siti
        (Chrome, Safari…). Se vuoi, puoi aggiungere l’icona di Solco alla schermata Home: si apre a
        schermo intero, come un’app, senza passare dagli store.
      </p>
      <p>
        Trovi tutto nella pagina <Ui>Installa l’app</Ui>: nel menu (sul telefono il pulsante con tre
        righe in alto a destra, sul computer <Ui>Altro</Ui>) e tra i pulsanti rapidi della Home.
        Serve aver fatto l’accesso.
      </p>

      <h3>Android</h3>
      <Steps>
        <li>
          Dal telefono Android apri <Ui>Installa l’app</Ui> e tocca <Ui>Scarica l’APK</Ui>. L’APK è
          il file che installa l’app di Solco su Android.
        </li>
        <li>Apri il file scaricato.</li>
        <li>Se Android lo chiede, consenti al browser di installare app sconosciute.</li>
        <li>
          Tocca <Ui>Installa</Ui>, poi apri Solco dalla schermata Home.
        </li>
      </Steps>
      <Note>
        <p>
          Serve Android 7.0 o successivo. Se avevi già una versione vecchia di Solco, disinstallala
          prima. Dopo, l’app si aggiorna da sola insieme al sito.
        </p>
      </Note>

      <h3>iPhone e iPad</h3>
      <p>
        Qui il «profilo» è un piccolo file di impostazioni che aggiunge l’icona di Solco alla
        schermata Home. Non c’entra con il tuo <Ui>Profilo</Ui> di Solco.
      </p>
      <Steps>
        <li>
          Apri <Ui>Installa l’app</Ui> con Safari e tocca <Ui>Scarica il profilo</Ui>.
        </li>
        <li>
          Quando Safari lo chiede, tocca <Ui>Consenti</Ui>.
        </li>
        <li>
          Apri l’app Impostazioni del telefono e tocca <Ui>Profilo scaricato</Ui>, in alto.
        </li>
        <li>
          Tocca <Ui>Installa</Ui> e inserisci il codice del telefono.
        </li>
      </Steps>
      <p>
        In alternativa, in Safari tocca Condividi e poi <Ui>Aggiungi alla schermata Home</Ui>.
        Funziona con iOS 15 o successivo, solo con Safari.
      </p>
      <Note>
        <p>
          L’iPhone dice che il profilo è «non verificato»? È normale: il profilo non installa
          programmi, aggiunge solo l’icona di Solco. Lo togli da Impostazioni › Generali › VPN e
          gestione dispositivi.
        </p>
        <p>
          La prima volta che apri l’app potrebbe chiederti di accedere: usa lo stesso account di
          sempre.
        </p>
      </Note>
    </GuideSection>
  );
}
