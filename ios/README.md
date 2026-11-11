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
