# Solco — app mobile nativa (Flutter)

Primo scheletro di un'app nativa (iOS + Android da un solo codice) che **riusa il
backend di Solco** (`https://solcomusic.vercel.app`). Il sito web resta invariato:
questa è una cartella separata, accanto a `android/` (la TWA attuale) e `ios/`
(l'app SwiftUI).

> ⚠️ **Non compilata né provata in questa sessione.** L'SDK Flutter non è
> installato nell'ambiente di sviluppo di Solco, quindi il codice è scritto con
> cura ma **va compilato e provato su una macchina con Flutter**. Aspettati
> qualche piccolo aggiustamento di versione dei pacchetti al primo `flutter pub get`.

## Cosa fa già (versione 0.4)

- **Accesso** con email e password, contro le API di Solco (`better-auth`): login,
  registrazione, sessione che sopravvive al riavvio (cookie salvato sul dispositivo).
- **Home**: le tendenze su Audius (`GET /api/music/home`) + riga "Sfoglia" con Radio,
  Podcast e YouTube.
- **Cerca**: ricerca brani su Audius (`GET /api/music/search-all`).
- **Libreria** (`GET /api/music/library` + `GET /api/music/collections`): cronologia
  (riascolto di Audius/radio/podcast, "svuota"), playlist (dettaglio + "riproduci"),
  radio salvate (riproducibili) e podcast seguiti (aprono gli episodi), con rimozione.
- **Radio**: scoperta (cerca o stazioni più votate) e riproduzione in diretta
  (badge "IN DIRETTA", niente seek) — `GET /api/music/radio` + stream proxy.
- **Podcast**: scoperta (cerca o classifica), dettaglio con gli episodi e riproduzione
  — `GET /api/music/podcasts(/<id>)` + stream proxy.
- **YouTube**: ricerca (`search-all` con consenso esplicito) e riproduzione con il
  **player UFFICIALE** (IFrame Player API in un `WebView`, `youtube_player_iframe`):
  niente download né estrazione, conforme ai termini. All'avvio mette in pausa il
  lettore audio; lista "Successivi" per passare al prossimo video.
- **Lettore audio**: stream Audius/radio/podcast con **just_audio**, in **background** e
  con i comandi sulla **schermata di blocco** (just_audio_background). **Mini-player**
  (toccalo per il **lettore a schermo intero**) con copertina grande, seek,
  precedente/play/successivo, **shuffle**, **ripetizione** (coda/uno), **coda** e
  avanzamento automatico. Unità unificata `PlayableItem` per tutte le fonti. Gli
  ascolti vengono registrati nella cronologia (`POST /api/music/library` → `record_play`).
- **Mutazioni abilitate da nativo**: le rotte che modificano dati controllano
  `same-origin`; il client imposta l'header `Origin = baseUrl` sulle richieste non-GET,
  così le POST passano il controllo CSRF — come fa l'SDK. Perché funzioni,
  `kSolcoBaseUrl` deve combaciare con `NEXT_PUBLIC_APP_URL` del deploy.
- Tema scuro con i colori del marchio (navy + lime).

## Cosa manca (prossimi passi)

- Riproduzione dei brani di playlist importati da YouTube / liste testuali.
- Offline ("La tua musica" e "scarica il permesso").
- Accesso con Google (OAuth: va aperto in un browser di sistema con un deep link).
- Premium / pagamenti (in-app: Apple/Google richiedono i loro acquisti in-app).
- Cartelle delle playlist, preferiti come sezione dedicata, "non mi interessa".

> **YouTube/WebView:** `youtube_player_iframe` tira dentro `webview_flutter`. Su
> Android serve `minSdkVersion` ≥ 19 e il permesso `INTERNET` (già richiesto da
> `just_audio_background`); su iOS nessuna configurazione extra. Li sistema
> `flutter create .` + `flutter pub get`.

## Come avviarla

Questa cartella contiene solo `pubspec.yaml` e `lib/`. Le cartelle di piattaforma
(`android/`, `ios/`, …) si generano con Flutter:

```bash
cd flutter
flutter create .          # genera android/ ios/ ecc. attorno a questo lib/
flutter pub get
flutter run               # con un dispositivo o emulatore collegato
```

Per Android, abilita in `android/app/src/main/AndroidManifest.xml` i permessi che
`just_audio_background` richiede (INTERNET, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK,
WAKE_LOCK) e la MediaButtonReceiver — vedi la documentazione di `just_audio_background`.
Per iOS, in `ios/Runner/Info.plist` aggiungi `UIBackgroundModes` con `audio`.

Per puntare a un backend locale durante lo sviluppo, cambia `kSolcoBaseUrl` in
`lib/api/solco_api.dart`.

## Struttura

```
lib/
  main.dart                 avvio, auth-gate, navigazione (Home/Cerca/Libreria/Profilo)
  theme.dart                colori del marchio
  api/
    models.dart             PlayableItem (unità riproducibile), AudiusTrack,
                            SessionUser, HistoryEntry, SavedStation, FollowedPodcast,
                            LibraryData, Playlist, RadioStation, Podcast,
                            PodcastEpisode, PodcastDetail, YouTubeVideo
    solco_api.dart          client (dio + cookie + Origin sulle mutazioni) verso /api
  state/app_state.dart      provider Riverpod (api, sessione, tendenze, ricerca,
                            libreria, playlist, radio, podcast, youtube, player)
  player/player_controller.dart  lettore just_audio: coda di PlayableItem, shuffle,
                            ripetizione, seek, avanzamento automatico, registrazione ascolti
  screens/                  login, home, cerca, libreria, playlist, player_screen
                            (lettore a schermo intero), radio, podcast, podcast_detail,
                            youtube, youtube_player (WebView), profilo
  widgets/                  track_tile, mini_player (apre il lettore a schermo intero)
```
