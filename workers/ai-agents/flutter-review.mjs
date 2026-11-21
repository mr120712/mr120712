// @polsia:user-owned — 6 specialist agents + 1 lead review the PERFORMANCE of Solco's Android app
// (flutter/, the native Flutter app: Riverpod + dio + just_audio + cached_network_image). They read
// only the app's own source (Dart, pubspec, Android manifest): the repo holds no secrets there.
import { readFile } from 'node:fs/promises';

export const FLUTTER_SUBJECT =
  'Sei un ingegnere Flutter/Android esperto di prestazioni e revisioni l’app Android nativa di ' +
  'Solco (cartella flutter/): Flutter 3.22+, Riverpod, dio con cookie di sessione better-auth, ' +
  'just_audio + just_audio_background, cached_network_image, youtube_player_iframe (WebView, player ' +
  'UFFICIALE: niente download né estrazione), in_app_purchase (Play Billing, verifica lato server). ' +
  'Il backend è www.solcomusic.online. Pensa a telefoni Android di fascia media (4 GB di RAM, rete ' +
  'mobile lenta). Guarda: avvio a freddo, jank (frame oltre 16 ms), rebuild inutili, lavoro pesante ' +
  'sul thread UI (parsing JSON grande: compute/isolate), memoria delle immagini (memCacheWidth), ' +
  'liste non lazy, richieste ripetute senza cache, batteria e dimensione dell’APK. Per ogni proposta ' +
  'indica il FILE e la funzione o il widget, il guadagno atteso, il rischio e il cambio concreto ' +
  '(un breve frammento Dart quando serve). Basati SOLO sul codice ricevuto: non inventare file, ' +
  'pacchetti o misure. Non proporre di indebolire sicurezza, accesso, verifica degli acquisti o ' +
  'i termini del player YouTube.';

/** The 6 specialists: each sees only its files (every Dart file is read by exactly one of them). */
export const FLUTTER_SPECIALISTS = [
  {
    id: 'startup',
    title: 'Avvio a freddo, stato globale e configurazione Android',
    files: [
      'flutter/lib/main.dart',
      'flutter/lib/state/app_state.dart',
      'flutter/lib/state/settings.dart',
      'flutter/lib/theme.dart',
      'flutter/pubspec.yaml',
      'flutter/android-config/AndroidManifest.xml',
      'flutter/android-config/network_security_config.xml',
    ],
  },
  {
    id: 'network',
    title: 'Rete, API e parsing JSON',
    files: ['flutter/lib/api/solco_api.dart', 'flutter/lib/api/models.dart'],
  },
  {
    id: 'player',
    title: 'Player audio, riproduzione in background e schermata del player',
    files: [
      'flutter/lib/player/player_controller.dart',
      'flutter/lib/screens/player_screen.dart',
      'flutter/lib/widgets/mini_player.dart',
      'flutter/lib/widgets/lyrics_sheet.dart',
    ],
  },
  {
    id: 'lists',
    title: 'Liste, rendering, rebuild e immagini delle schermate principali',
    files: [
      'flutter/lib/screens/home_screen.dart',
      'flutter/lib/screens/library_screen.dart',
      'flutter/lib/widgets/featured_sections.dart',
      'flutter/lib/widgets/track_tile.dart',
      'flutter/lib/screens/favorites_screen.dart',
      'flutter/lib/screens/playlist_screen.dart',
      'flutter/lib/screens/search_screen.dart',
    ],
  },
  {
    id: 'media',
    title: 'Offline, podcast, radio e cataloghi (disco, memoria, rete)',
    files: [
      'flutter/lib/offline/offline_store.dart',
      'flutter/lib/screens/podcast_detail_screen.dart',
      'flutter/lib/screens/podcasts_screen.dart',
      'flutter/lib/screens/radio_screen.dart',
      'flutter/lib/screens/classics_screen.dart',
      'flutter/lib/screens/record_pool_screen.dart',
    ],
  },
  {
    id: 'webview-account',
    title: 'WebView YouTube, acquisti in-app e schermate dell’account',
    files: [
      'flutter/lib/screens/youtube_screen.dart',
      'flutter/lib/screens/youtube_player_screen.dart',
      'flutter/lib/billing/iap_controller.dart',
      'flutter/lib/screens/premium_screen.dart',
      'flutter/lib/screens/premi_screen.dart',
      'flutter/lib/screens/profile_screen.dart',
      'flutter/lib/screens/login_screen.dart',
      'flutter/lib/screens/settings_screen.dart',
    ],
  },
].map((agent) => ({
  ...agent,
  facts: (m) => agent.files.map((path) => `===== ${path} =====\n${m.files[path] ?? '(file non trovato)'}`).join('\n\n'),
}));

export const FLUTTER_LEAD_PROMPT =
  'Sei il capo squadra. Unisci i rapporti dei 6 specialisti in UN piano per l’app Android: le 10 ' +
  'correzioni più utili in ordine di impatto per l’utente (avvio, fluidità, memoria, rete, batteria). ' +
  'Per ognuna: file e funzione/widget, impatto (alto/medio/basso), sforzo, rischio e il cambio ' +
  'concreto (breve frammento Dart se serve). Scarta i doppioni e ciò che il codice non dimostra. ' +
  'Chiudi con come misurarle (flutter run --profile, DevTools, timeline dei frame).';

/** Every file the specialists read, keyed by repo path. */
export async function collectFlutter({ root } = {}) {
  const paths = [...new Set(FLUTTER_SPECIALISTS.flatMap((a) => a.files))];
  const contents = await Promise.all(paths.map((path) => readFile(new URL(path, root), 'utf8').catch(() => null)));
  const files = Object.fromEntries(paths.map((path, i) => [path, contents[i]]).filter(([, text]) => text !== null));
  return { measuredAt: new Date().toISOString(), files, missing: paths.filter((path) => !(path in files)) };
}
