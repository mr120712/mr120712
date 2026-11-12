import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_state.dart';
import '../widgets/track_tile.dart';

class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});
  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  final _controller = TextEditingController();
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    // Mentre si scrive si cerca solo su Audius (gratis); YouTube resta al sito.
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      ref.read(searchQueryProvider.notifier).state = value;
    });
  }

  @override
  Widget build(BuildContext context) {
    final results = ref.watch(searchResultsProvider);
    final player = ref.watch(playerProvider);
    final query = ref.watch(searchQueryProvider);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            controller: _controller,
            onChanged: _onChanged,
            textInputAction: TextInputAction.search,
            decoration: const InputDecoration(
              hintText: 'Cerca brani, artisti…',
              prefixIcon: Icon(Icons.search),
            ),
          ),
        ),
        Expanded(
          child: results.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => const Center(child: Text('Ricerca non riuscita. Riprova.')),
            data: (tracks) {
              if (query.trim().length < 2) {
                return const Center(child: Text('Scrivi almeno due lettere per cercare.'));
              }
              if (tracks.isEmpty) {
                return const Center(child: Text('Nessun risultato su Audius.'));
              }
              return ListView.builder(
                itemCount: tracks.length,
                itemBuilder: (context, i) => TrackTile(
                  track: tracks[i],
                  playing: player?.current?.qualifiedId == tracks[i].qualifiedId,
                  onTap: () => player?.playQueue(tracks, i),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
