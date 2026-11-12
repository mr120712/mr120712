import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../api/solco_api.dart';
import '../player/player_controller.dart';

/// Il client API (creato una volta, con il cookie-jar persistente).
final apiProvider = FutureProvider<SolcoApi>((ref) => SolcoApi.create());

/// Il lettore audio, legato al client API.
final playerProvider = Provider<PlayerController?>((ref) {
  final api = ref.watch(apiProvider).valueOrNull;
  if (api == null) return null;
  final controller = PlayerController(api);
  ref.onDispose(controller.dispose);
  return controller;
});

/// L'utente connesso (null = non autenticato). Si ricarica dopo login/logout.
final sessionProvider = FutureProvider<SessionUser?>((ref) async {
  final api = await ref.watch(apiProvider.future);
  return api.getSession();
});

/// Tendenze su Audius per la Home.
final trendingProvider = FutureProvider<List<AudiusTrack>>((ref) async {
  final api = await ref.watch(apiProvider.future);
  return api.trending();
});

/// Testo di ricerca corrente.
final searchQueryProvider = StateProvider<String>((ref) => '');

/// Risultati della ricerca (Audius) per il testo corrente.
final searchResultsProvider = FutureProvider<List<AudiusTrack>>((ref) async {
  final query = ref.watch(searchQueryProvider).trim();
  if (query.length < 2) return const [];
  final api = await ref.watch(apiProvider.future);
  return api.search(query);
});

/// La libreria dell'utente: cronologia, radio salvate, podcast seguiti.
/// Si ricarica con `ref.invalidate(libraryProvider)` dopo una modifica.
final libraryProvider = FutureProvider<LibraryData>((ref) async {
  final api = await ref.watch(apiProvider.future);
  return api.getLibrary();
});

/// Le playlist dell'utente.
final collectionsProvider = FutureProvider<List<Playlist>>((ref) async {
  final api = await ref.watch(apiProvider.future);
  return api.getCollections();
});

/// Scoperta radio: testo corrente + stazioni (vuoto = più votate).
final radioQueryProvider = StateProvider<String>((ref) => '');
final radioStationsProvider = FutureProvider<List<RadioStation>>((ref) async {
  final q = ref.watch(radioQueryProvider).trim();
  final api = await ref.watch(apiProvider.future);
  return api.radioStations(query: q.isEmpty ? null : q);
});

/// Scoperta podcast: testo corrente + podcast (vuoto = classifica).
final podcastQueryProvider = StateProvider<String>((ref) => '');
final podcastsProvider = FutureProvider<List<Podcast>>((ref) async {
  final q = ref.watch(podcastQueryProvider).trim();
  final api = await ref.watch(apiProvider.future);
  return api.podcasts(query: q.isEmpty ? null : q);
});

/// Dettaglio di un podcast (episodi), per id.
final podcastDetailProvider = FutureProvider.family<PodcastDetail, String>((ref, id) async {
  final api = await ref.watch(apiProvider.future);
  return api.podcastDetail(id);
});

/// Ricerca YouTube: testo corrente + risultati (solo all'invio, consenso esplicito).
final youtubeQueryProvider = StateProvider<String>((ref) => '');
final youtubeResultsProvider = FutureProvider<List<YouTubeVideo>>((ref) async {
  final q = ref.watch(youtubeQueryProvider).trim();
  if (q.isEmpty) return const [];
  final api = await ref.watch(apiProvider.future);
  return api.youtubeSearch(q);
});
