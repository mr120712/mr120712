# App iOS SOLCO

Il progetto `Solco.xcodeproj` contiene un’app SwiftUI nativa per iOS 17+, con layout iPhone e navigazione adattiva per iPad. L’unica vista web è il player ufficiale YouTube incorporato; non usa una TWA.

## Avvio locale

1. Apri `ios/Solco.xcodeproj` in Xcode.
2. Seleziona lo schema `Solco` e un simulatore iPhone o iPad con iOS 17 o successivo.
3. In **Build Settings**, imposta `SOLCO_API_BASE_URL` sull’origine HTTPS dell’app SOLCO distribuita. Per un dispositivo locale, usa un host raggiungibile dal dispositivo; HTTP è ammesso solo per `localhost` e `127.0.0.1`.
4. Sostituisci `PRODUCT_BUNDLE_IDENTIFIER` (`app.polsia.solco.fan`) e configura la firma Apple prima di installare su un dispositivo.
5. Premi Run.

Il valore di `SOLCO_API_BASE_URL` non è incluso nel repository. Senza questa impostazione l’app mostra uno stato di connessione non configurata e non avvia audio. Il bundle identifier è provvisorio e va sostituito con quello assegnato al prodotto.

Il primo avvio presenta tre schermate informative. Il completamento viene conservato in `UserDefaults` tramite `AppStorage`; per riprovare l’onboarding, cancella i dati dell’app o rimuovi `solco.onboarding.completed` dal simulatore.

Le stringhe italiane sono raccolte in `Solco/Resources/it.lproj/Localizable.strings`. Per aggiungere l’inglese, crea `Solco/Resources/en.lproj/Localizable.strings` con le stesse chiavi e aggiungi la cartella al gruppo `Solco` del progetto. In assenza di traduzione inglese resta disponibile il testo italiano.

La scheda «Solco» usa ricerca, tendenze e streaming Audius tramite le API server-side di Solco. La scheda «YouTube» usa la YouTube Data API v3 per la ricerca e il player ufficiale incorporato per la riproduzione. `AUDIUS_API_KEY` e `YOUTUBE_DATA_API_KEY` sono credenziali server-side e non vanno inserite nell’app iOS. Le playlist e i preferiti richiedono l’accesso a un account Solco. L’audio Audius supporta la riproduzione in background; il player YouTube resta visibile e viene sospeso quando l’app passa in background.

## Riproduzione in background

Il player nativo (`AudiusMusicPlayer` in `Solco/AudioPlayers.swift`) riproduce solo i brani Audius degli album con Solco Pro e diritti verificati. Segue il comportamento delle app musicali Apple:

- **Sessione audio.** Categoria `.playback` (non silenziata dall’interruttore Suoneria/Silenzioso) con `UIBackgroundModes = audio` in `Info.plist`. La sessione si attiva quando parte la riproduzione e si disattiva con `notifyOthersOnDeactivation` a fine coda, con `stop()` (da collegare all’uscita dall’account) e quando l’accesso non è più verificato, così l’app interrotta (per esempio un’app podcast) può riprendere. Se l’app passa in background con la musica in pausa, o viene messa in pausa mentre è in background, la sessione viene rilasciata subito senza avvisare le altre app, come raccomanda Apple per le sessioni non mixabili: così iOS non deve disattivarla quando sospende l’app e non arriva la notifica di interruzione tardiva che potrebbe annullare il primo Play dalla schermata di blocco. Se la sessione è occupata (chiamata in corso) compare «Audio occupato…», senza perdere la coda.
- **Stato reale.** Icona play/pausa, indicatore di caricamento e velocità mostrata nella schermata di blocco leggono `AVPlayer.timeControlStatus`: dopo una chiamata o dopo aver scollegato le cuffie l’app mostra «in pausa», non un falso «in riproduzione». Durante il buffering compare un indicatore di avanzamento.
- **Schermata di blocco e Centro di Controllo.** Titolo, artista, copertina, durata, posizione nella coda, play, pausa, brano precedente/successivo e barra di avanzamento trascinabile. «Successivo» è disattivato sull’ultimo brano. Salti a intervalli, avanti/indietro veloce e cambio velocità non sono offerti. Il tempo trascorso viene aggiornato a ogni play, pausa, salto e cambio brano: il sistema lo calcola da solo tra un aggiornamento e l’altro.
- **Cuffie, AirPods, auto.** A seconda dell’accessorio (cuffie a filo, AirPods con i gesti scelti nelle Impostazioni, Bluetooth, CarPlay) i comandi arrivano come `playCommand`, `pauseCommand`, `togglePlayPauseCommand`, `nextTrackCommand` o `previousTrackCommand`; il player li gestisce tutti. «Play» riproduce soltanto e «Pausa» mette soltanto in pausa.
- **Interruzioni.** Chiamate, Siri e sveglie mettono in pausa. Alla fine dell’interruzione l’audio riparte solo se iOS segnala `shouldResume` e la musica era in riproduzione prima; un caricamento in corso viene annullato e ripreso allo stesso modo. Un secondo «inizio interruzione» non cancella una ripresa già in attesa.
- **Cambio di uscita.** Scollegare le cuffie, spegnere le cuffie Bluetooth o lasciare CarPlay mette in pausa e annulla ogni ripresa automatica: la musica non passa mai all’altoparlante da sola. Collegare un nuovo dispositivo non avvia la riproduzione.
- **Coda a schermo bloccato.** Tra un brano e il successivo l’app tiene un’attività in background (mai silenzio artificiale) per il controllo dei diritti, il caricamento e il buffering del brano: la chiede circa 10 secondi prima della fine del brano in corso, quando l’app è ancora attiva per l’audio, e la rilascia solo quando il successivo suona davvero (`timeControlStatus == .playing`), alla pausa o in caso di errore. La verifica ha un limite di 15 secondi; se iOS revoca l’attività prima, l’app la chiude e non viene terminata. Comandi rapidi in sequenza non possono far suonare un brano diverso da quello mostrato. A fine coda l’ultimo brano si ferma riavvolto all’inizio. «Precedente» riavvia il brano se sono passati più di 3 secondi o se è il primo della coda.
- **Errori di rete o di accesso.** Mentre lo stream attende dati compare l’indicatore di caricamento. Se AVPlayer segnala che lo stream è fallito (rete persa, Solco Pro scaduto) la riproduzione si ferma con un messaggio invece di restare bloccata in silenzio.
- **Reset dei servizi multimediali.** Dopo un reset del demone audio il player viene ricostruito e la sessione riconfigurata; la musica non riparte finché l’utente non preme Play, e allora il brano riparte dall’inizio.
- **Diritti e conteggi.** Solco Pro e i diritti del brano vengono verificati (`/playback`) prima di ogni avvio, di ogni ripresa (anche quella automatica dopo una chiamata) e di ogni passaggio al brano successivo. Il cookie di sessione arriva allo stream tramite l’opzione pubblica `AVURLAssetHTTPCookiesKey`. L’app nativa non usa il contatore del piano gratuito (40 ascolti al mese) né il tempo d’ascolto dei premi: quelli riguardano solo l’app web.
- **YouTube.** Il player YouTube ufficiale non suona mai in background né solo come audio, e non usa Picture in Picture. Viene rimosso quando l’app non è attiva (`scenePhase != .active`); quando SwiftUI lo rimuove, il contenuto multimediale della web view viene messo in pausa e svuotato. Finché l’app è attiva, però, resta montato anche se si cambia scheda o si apre un’altra schermata (vedi sotto).

`AudiusMusicPlayer.stop()` ferma l’audio, svuota la coda e cancella la scheda Now Playing. Da completare in `DiscoveryView.swift` e `MusicScreens.swift`: chiamare `audio.stop()` dopo l’uscita dall’account, chiudere il player YouTube con `.onDisappear` quando si cambia scheda o si apre un’altra schermata, mettere in pausa Audius quando si apre un video YouTube e chiudere il video quando parte Audius.

### Prove su dispositivo

Il simulatore non riproduce chiamate, cuffie e comandi remoti. Su un iPhone reale, con un account Solco Pro:

1. Avvia un album, blocca lo schermo: titolo, artista, copertina, avanzamento e pausa/play funzionano dalla schermata di blocco e dal Centro di Controllo; trascinare la barra sposta la riproduzione. Metti in pausa, lascia lo schermo bloccato per qualche minuto e premi Play dalla schermata di blocco: la musica riparte al primo tocco.
2. A schermo bloccato lascia finire un brano: il successivo parte senza sbloccare. Sull’ultimo brano «Successivo» è disattivato e a fine album la musica si ferma.
3. Ricevi una chiamata (o attiva Siri) durante l’ascolto: la musica si ferma, l’icona mostra «play» e riprende da sola dopo aver rifiutato la chiamata. Se la musica era in pausa prima della chiamata resta in pausa.
4. Scollega le cuffie a filo o spegni le cuffie Bluetooth durante l’ascolto: pausa immediata, nessun suono dall’altoparlante, nemmeno dopo una chiamata.
5. Tasto centrale delle cuffie, gesti degli AirPods (come configurati nelle Impostazioni) e, se disponibile, CarPlay: play/pausa e brano successivo/precedente.
6. Impostazioni > Sviluppatore > Reimposta servizi multimediali durante l’ascolto: la musica si ferma; premendo Play il brano riparte dall’inizio.
7. Avvia Solco durante una chiamata: compare «Audio occupato…» e la coda resta.
8. Apri un video YouTube, poi passa in background o apri il Centro Notifiche: il video si ferma e non si sente nulla. Solo dopo la modifica in `DiscoveryView.swift`/`MusicScreens.swift`: cambia scheda con il video aperto e verifica che non si senta.
9. Disattiva la rete durante un brano lungo: finito il buffer compare l’indicatore di caricamento; se AVPlayer dichiara fallito lo stream, compare il messaggio di riproduzione interrotta e la schermata di blocco mostra la pausa.
