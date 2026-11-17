# App iOS SOLCO

Il progetto `Solco.xcodeproj` contiene un’app SwiftUI nativa per iOS 17+, con layout iPhone e navigazione adattiva per iPad. L’unica vista web è il player ufficiale YouTube incorporato; non usa una TWA.

## Avvio locale

1. Apri `ios/Solco.xcodeproj` in Xcode.
2. Seleziona lo schema `Solco` e un simulatore iPhone o iPad con iOS 17 o successivo.
3. `SOLCO_API_BASE_URL` punta già al sito ufficiale (`https://www.solcomusic.online`); per un server locale cambialo in **Build Settings** (HTTP è ammesso solo per `localhost` e `127.0.0.1`).
4. Per installare su un dispositivo scegli il tuo team in **Signing & Capabilities**: l'identificativo è `online.solcomusic.solco`, lo stesso dell'app Android, con firma automatica.
5. Premi Run.

Versione e build (`1.3.0`, `4`) seguono quelle dell'APK Android; il test `tests/unit/ios-project.test.ts` controlla che identificativo, dominio e versione restino allineati a `src/lib/android-app.ts`.

## Ottenere l'IPA senza un Mac

Il repository è pubblico, quindi i runner macOS di GitHub Actions sono gratuiti. Da Actions → «iOS (IPA)» → Run workflow:

- `check`: compila per il simulatore e dice solo se il progetto compila.
- `ipa-unsigned`: archivia per iPhone senza firma e pubblica `Solco-unsigned.ipa` tra gli artefatti (14 giorni). **Non si installa** su nessun dispositivo: iOS esegue solo app firmate con un certificato rilasciato da Apple.
- `ipa-signed`: archivia, firma ed esporta `Solco.ipa` per App Store Connect e TestFlight. Servono i quattro segreti descritti in cima a `.github/workflows/ios.yml` (ID del team e chiave API di App Store Connect): li crea il proprietario nel suo account Apple e li salva nei segreti del repository, mai nel codice.

Lo stesso script gira su un Mac: `bash ios/build.sh check|ipa-unsigned|ipa`, e `bash ios/build.sh sign <ipa> "<identità>" <profilo.mobileprovision>` firma un IPA non firmato con un'identità del portachiavi.

## IPA pubblico (sideload con AltStore)

`public/solco.ipa` è l'ultimo build **non firmato** del workflow (`Solco-unsigned.ipa`), scaricabile da `/app` come l'APK. iOS non lo installa da solo: lo firmano AltStore o SideStore con l'Apple ID di chi installa (pulsanti «Installa con AltStore» e il link SideStore in `/app`, schemi `altstore://install?url=` e `sidestore://install?url=`), oppure Xcode. Con un Apple ID gratuito la firma dura 7 giorni e AltStore la rinnova da solo. Per aggiornarlo: scarica l'artefatto del workflow in modalità `ipa-unsigned` e copialo in `public/solco.ipa`; il test `tests/unit/ios-public-ipa.test.ts` controlla che sia Solco nella versione dichiarata da `src/lib/android-app.ts`.

## Installazione dal sito (Ad Hoc)

Un IPA firmato **Ad Hoc** si installa da Safari con un link `itms-services://`, senza App Store, ma solo sugli iPhone e iPad il cui identificativo (UDID) è registrato nell'account Apple Developer (fino a 100 dispositivi l'anno). Solco lo distribuisce dalla pagina `/app` dietro un cancello: serve un account, e il link contiene un token firmato (HMAC, 15 minuti) perché l'installatore di iOS scarica manifest e file senza i cookie del browser.

1. Registra i dispositivi: developer.apple.com → Certificates, Identifiers & Profiles → Devices (l'UDID si legge dal Finder o da Impostazioni › Generali › Info).
2. Avvia il workflow «iOS (IPA)» in modalità `ipa-adhoc` (con i quattro segreti) e scarica l'artefatto `Solco.ipa`; su un Mac: `SOLCO_IOS_EXPORT_METHOD=ad-hoc bash ios/build.sh ipa`.
3. In `/admin/app-ios` carica l'IPA: il server lo ispeziona (identificativo `online.solcomusic.solco`, versione uguale a quella del sito, firma presente, profilo Ad Hoc, Enterprise o di sviluppo), lo conserva nello store privato (Vercel Blob, prefisso `ios-app/`) e lo attiva; un IPA senza firma o firmato per l'App Store viene rifiutato.
4. Gli utenti con account vedono in `/app` il pulsante «Installa l'app»: `GET /api/ios/install` rilascia il link, `GET /api/ios/manifest?t=…` il manifest e `GET /api/ios/ipa?t=…` il file, con limiti per account.

Il collegamento formale tra app e sito è `/.well-known/apple-app-site-association` (Associated Domains): si accende impostando `APPLE_TEAM_ID` su Vercel (l'ID del team, 10 caratteri) e dichiara `webcredentials` (Safari e app condividono le password salvate) e `applinks` senza regole finché l'app non gestirà i percorsi del sito. I domini sono nel file `Solco/Solco.entitlements`, che Xcode applica con la firma automatica.

## Certificati

Un certificato «valido» per iOS esiste solo dentro l'Apple Developer Program (99 € l'anno, intestato al proprietario): è Apple a rilasciarlo, insieme al profilo di provisioning che lega l'app all'identificativo e al team. Non si può generare, copiare o «iniettare» in un IPA da fuori: un IPA firmato con un certificato altrui, scaduto o revocato non si apre, e Apple revoca i certificati condivisi. Le vie corrette sono tre: Xcode sul proprio Mac (firma automatica), il workflow `ipa-signed` con la chiave API (Xcode crea certificati e profili gestiti da Apple) oppure Xcode Cloud da App Store Connect. L'app arriva sugli iPhone tramite TestFlight o l'App Store, dopo la revisione.

Il primo avvio presenta tre schermate informative. Il completamento viene conservato in `UserDefaults` tramite `AppStorage`; per riprovare l’onboarding, cancella i dati dell’app o rimuovi `solco.onboarding.completed` dal simulatore.

Le stringhe italiane sono raccolte in `Solco/Resources/it.lproj/Localizable.strings`. Per aggiungere l’inglese, crea `Solco/Resources/en.lproj/Localizable.strings` con le stesse chiavi e aggiungi la cartella al gruppo `Solco` del progetto. In assenza di traduzione inglese resta disponibile il testo italiano.

La scheda «Solco» usa ricerca, tendenze e streaming Audius tramite le API server-side di Solco. La scheda «YouTube» usa la YouTube Data API v3 per la ricerca e il player ufficiale incorporato per la riproduzione. `AUDIUS_API_KEY` e `YOUTUBE_DATA_API_KEY` sono credenziali server-side e non vanno inserite nell’app iOS. Le playlist e i preferiti richiedono l’accesso a un account Solco. L’audio Audius supporta la riproduzione in background; il player YouTube resta visibile e viene sospeso quando l’app passa in background.

## Riproduzione in background

Il player nativo (`AudiusMusicPlayer` in `Solco/AudioPlayers.swift`) riproduce solo i brani Audius degli album con Solco Pro e diritti verificati. Segue il comportamento delle app musicali Apple:

- **Sessione audio.** Categoria `.playback` (non silenziata dall’interruttore Suoneria/Silenzioso) con `UIBackgroundModes = audio` in `Info.plist`. La sessione si attiva quando parte la riproduzione e si disattiva con `notifyOthersOnDeactivation` a fine coda, con `stop()` (chiamato dopo l’uscita dall’account) e quando l’accesso non è più verificato, così l’app interrotta (per esempio un’app podcast) può riprendere. Se l’app passa in background con la musica in pausa, o viene messa in pausa mentre è in background, la sessione viene rilasciata subito senza avvisare le altre app, come raccomanda Apple per le sessioni non mixabili: così iOS non deve disattivarla quando sospende l’app e non arriva la notifica di interruzione tardiva che potrebbe annullare il primo Play dalla schermata di blocco. Se la sessione è occupata (chiamata in corso) compare «Audio occupato…», senza perdere la coda.
- **Stato reale.** Icona play/pausa, indicatore di caricamento e velocità mostrata nella schermata di blocco leggono `AVPlayer.timeControlStatus`: dopo una chiamata o dopo aver scollegato le cuffie l’app mostra «in pausa», non un falso «in riproduzione». Durante il buffering compare un indicatore di avanzamento.
- **Schermata di blocco e Centro di Controllo.** Titolo, artista, copertina, durata, posizione nella coda, play, pausa, brano precedente/successivo e barra di avanzamento trascinabile. «Successivo» è disattivato sull’ultimo brano. Salti a intervalli, avanti/indietro veloce e cambio velocità non sono offerti. Il tempo trascorso viene aggiornato a ogni play, pausa, salto e cambio brano: il sistema lo calcola da solo tra un aggiornamento e l’altro.
- **Cuffie, AirPods, auto.** A seconda dell’accessorio (cuffie a filo, AirPods con i gesti scelti nelle Impostazioni, Bluetooth, CarPlay) i comandi arrivano come `playCommand`, `pauseCommand`, `togglePlayPauseCommand`, `nextTrackCommand` o `previousTrackCommand`; il player li gestisce tutti. «Play» riproduce soltanto e «Pausa» mette soltanto in pausa.
- **Interruzioni.** Chiamate, Siri e sveglie mettono in pausa. Alla fine dell’interruzione l’audio riparte solo se iOS segnala `shouldResume` e la musica era in riproduzione prima; un caricamento in corso viene annullato e ripreso allo stesso modo. Un secondo «inizio interruzione» non cancella una ripresa già in attesa.
- **Cambio di uscita.** Scollegare le cuffie, spegnere le cuffie Bluetooth o lasciare CarPlay mette in pausa e annulla ogni ripresa automatica: la musica non passa mai all’altoparlante da sola. Collegare un nuovo dispositivo non avvia la riproduzione.
- **Coda a schermo bloccato.** Tra un brano e il successivo l’app tiene un’attività in background (mai silenzio artificiale) per il controllo dei diritti, il caricamento e il buffering del brano: la chiede circa 10 secondi prima della fine del brano in corso, quando l’app è ancora attiva per l’audio, e la rilascia solo quando il successivo suona davvero (`timeControlStatus == .playing`), alla pausa o in caso di errore. La verifica ha un limite di 15 secondi; se iOS revoca l’attività prima, l’app la chiude e non viene terminata. Comandi rapidi in sequenza non possono far suonare un brano diverso da quello mostrato. A fine coda l’ultimo brano si ferma riavvolto all’inizio. «Precedente» riavvia il brano se sono passati più di 3 secondi o se è il primo della coda.
- **Errori di rete o di accesso.** Mentre lo stream attende dati compare l’indicatore di caricamento. Se AVPlayer segnala che lo stream è fallito (rete persa, Solco Pro scaduto) la riproduzione si ferma con un messaggio invece di restare bloccata in silenzio.
- **Reset dei servizi multimediali.** Dopo un reset del demone audio il player viene ricostruito e la sessione riconfigurata; la musica non riparte finché l’utente non preme Play, e allora il brano riparte dall’inizio.
- **Diritti e conteggi.** Solco Pro e i diritti del brano vengono verificati (`/playback`) prima di ogni avvio, di ogni ripresa (anche quella automatica dopo una chiamata) e di ogni passaggio al brano successivo. Il cookie di sessione arriva allo stream tramite l’opzione pubblica `AVURLAssetHTTPCookiesKey`. L’app nativa non usa il contatore del piano gratuito (40 ascolti al mese) né il tempo d’ascolto dei premi: quelli riguardano solo l’app web.
- **YouTube.** Il player YouTube ufficiale non suona mai in background né solo come audio, e non usa Picture in Picture. Viene rimosso quando l’app non è attiva (`scenePhase != .active`) e quando la sua schermata non è più visibile: `DiscoveryView` e `PlayerLandingView` (Raccolte) azzerano il video aperto con `.onDisappear`, quindi cambiare scheda, aprire un’altra schermata o scegliere un’altra sezione nella barra laterale dell’iPad lo chiude. Quando SwiftUI lo rimuove, il contenuto multimediale della web view viene messo in pausa e svuotato (`dismantleUIView`). Con l’app attiva, la chiusura dopo un cambio di scheda dipende da SwiftUI, che deve aggiornare subito una schermata già uscita dalla finestra, e WebKit non garantisce di fermare un video quando la web view lascia la finestra: la prova 9 su dispositivo deve passare prima di ogni rilascio. Se fallisce, `YouTubeOfficialPlayer` (in `AudioPlayers.swift`) deve usare una sottoclasse di `WKWebView` che in `didMoveToWindow()`, quando `window == nil`, chiama `pauseAllMediaPlayback`.
- **Un solo audio alla volta.** Aprire il player YouTube mette in pausa Audius (`audio.pause()`, che annulla anche un avvio o una ripresa in verifica). Se Audius riparte con il video aperto (mini-player, cuffie, AirPods), il video YouTube si chiude (modificatore `ClosesYouTubeWhenAudiusPlays`). Lo stesso brano da un’altra fonte (Audius) parte solo con un tocco esplicito.

`AudiusMusicPlayer.stop()` ferma l’audio, svuota la coda e cancella la scheda Now Playing. `AccountView.signOut(stopping:)` (in `DiscoveryView.swift`) lo chiama dopo un’uscita riuscita dall’account; se l’uscita fallisce l’audio non cambia. Il player arriva con `@EnvironmentObject` dall’istanza unica creata in `ContentView`. Scopri, Raccolte e Account non lo osservano direttamente, perché il player pubblica l’avanzamento due volte al secondo: lo osservano solo il modificatore `ClosesYouTubeWhenAudiusPlays` e i piccoli pulsanti avvolti in `WithAudiusPlayer` (entrambi in `MusicScreens.swift`), quindi queste schermate non vengono ricostruite a ogni aggiornamento.

### Prove su dispositivo

Il simulatore non riproduce chiamate, cuffie e comandi remoti. Su un iPhone reale, con un account Solco Pro:

1. Avvia un album, blocca lo schermo: titolo, artista, copertina, avanzamento e pausa/play funzionano dalla schermata di blocco e dal Centro di Controllo; trascinare la barra sposta la riproduzione. Metti in pausa, lascia lo schermo bloccato per qualche minuto e premi Play dalla schermata di blocco: la musica riparte al primo tocco.
2. A schermo bloccato lascia finire un brano: il successivo parte senza sbloccare. Sull’ultimo brano «Successivo» è disattivato e a fine album la musica si ferma.
3. Ricevi una chiamata (o attiva Siri) durante l’ascolto: la musica si ferma, l’icona mostra «play» e riprende da sola dopo aver rifiutato la chiamata. Se la musica era in pausa prima della chiamata resta in pausa.
4. Scollega le cuffie a filo o spegni le cuffie Bluetooth durante l’ascolto: pausa immediata, nessun suono dall’altoparlante, nemmeno dopo una chiamata.
5. Tasto centrale delle cuffie, gesti degli AirPods (come configurati nelle Impostazioni) e, se disponibile, CarPlay: play/pausa e brano successivo/precedente.
6. Impostazioni > Sviluppatore > Reimposta servizi multimediali durante l’ascolto: la musica si ferma; premendo Play il brano riparte dall’inizio.
7. Avvia Solco durante una chiamata: compare «Audio occupato…» e la coda resta.
8. Apri un video YouTube, poi passa in background o apri il Centro Notifiche: il video si ferma e non si sente nulla.
9. **Obbligatoria prima di ogni rilascio.** Avvia un video YouTube in Scopri e poi in Raccolte, e ogni volta cambia scheda (in Scopri anche aprendo un album): non si sente nulla e, tornando, il player è chiuso. Su iPad fai lo stesso scegliendo un’altra sezione nella barra laterale. Se si sente anche solo un istante di audio, non rilasciare: serve la protezione `didMoveToWindow()` descritta sopra.
10. Tocca «Schermo intero» nel player YouTube: il video deve continuare in primo piano. Se si chiude da solo, `.onDisappear` scatta durante la presentazione a schermo intero di WebKit e va rivisto.
11. Con un album Audius in riproduzione apri un video YouTube: Audius va in pausa (icona «play» nel mini-player e nella schermata di blocco). Poi premi Play nel mini-player o sul tasto delle cuffie: Audius riparte e il video YouTube si chiude.
12. Con un album in riproduzione scorri i risultati in Scopri e apri il menu «Playlist»: lo scorrimento resta fluido e il menu non si chiude da solo (le schermate non osservano più il player, che pubblica l’avanzamento due volte al secondo).
13. Con un album in riproduzione esci dall’account (scheda Account): la musica si ferma, il mini-player sparisce e la schermata di blocco non mostra più il brano; un’app podcast interrotta può riprendere.
14. Disattiva la rete durante un brano lungo: finito il buffer compare l’indicatore di caricamento; se AVPlayer dichiara fallito lo stream, compare il messaggio di riproduzione interrotta e la schermata di blocco mostra la pausa.
