# Solco — app mobile nativa (Flutter)

Primo scheletro di un'app nativa (iOS + Android da un solo codice) che **riusa il
backend di Solco** (`https://solcomusic.vercel.app`). Il sito web resta invariato:
questa è una cartella separata, accanto a `android/` (la TWA attuale) e `ios/`
(l'app SwiftUI).

> ⚠️ **Non compilata né provata in questa sessione.** L'SDK Flutter non è
> installato nell'ambiente di sviluppo di Solco, quindi il codice è scritto con
> cura ma **va compilato e provato su una macchina con Flutter**. Aspettati
> qualche piccolo aggiustamento di versione dei pacchetti al primo `flutter pub get`.

## Cosa fa già (versione 0.1)

- **Accesso** con email e password, contro le API di Solco (`better-auth`): login,
  registrazione, sessione che sopravvive al riavvio (cookie salvato sul dispositivo).
- **Home**: le tendenze su Audius (`GET /api/music/home`).
- **Cerca**: ricerca brani su Audius (`GET /api/music/search-all`). Mentre si scrive
  si interroga solo Audius, come sul sito; YouTube resta al sito.
- **Lettore**: riproduce lo stream Audius servito da Solco
  (`/api/music/audius/tracks/<id>/stream`) con **just_audio**, in **background** e con
  i comandi sulla **schermata di blocco** (just_audio_background). Mini-player con
  play/pausa e avanti.
- Tema scuro con i colori del marchio (navy + lime).

## Cosa manca (prossimi passi)

- Libreria, playlist, preferiti, cronologia.
- Ricerca YouTube (player ufficiale in un `WebView`), radio e podcast.
- Offline ("La tua musica" e "scarica il permesso").
- Accesso con Google (OAuth: va aperto in un browser di sistema con un deep link).
- Premium / pagamenti (in-app: Apple/Google richiedono i loro acquisti in-app).
- Conteggio degli ascolti (`POST /api/music/plays`): le rotte che **modificano** dati
  su Solco controllano `same-origin`. Da un'app nativa quelle POST vanno abilitate lato
  backend (un'eccezione per l'app, o un token). La **riproduzione** (GET dello stream)
  funziona già perché non è una rotta di modifica.

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
  main.dart                 avvio, auth-gate, navigazione, mini-player
  theme.dart                colori del marchio
  api/
    models.dart             AudiusTrack, SessionUser
    solco_api.dart          client (dio + cookie di sessione) verso /api di Solco
  state/app_state.dart      provider Riverpod (api, sessione, tendenze, ricerca, player)
  player/player_controller.dart  lettore just_audio (background + lock screen)
  screens/                  login, home, cerca, profilo
  widgets/                  track_tile, mini_player
```
