import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_state.dart';
import '../widgets/track_tile.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final trending = ref.watch(trendingProvider);
    final player = ref.watch(playerProvider);
    return RefreshIndicator(
      onRefresh: () async => ref.refresh(trendingProvider.future),
      child: trending.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _ErrorState(
          message: 'Impossibile caricare le tendenze.',
          onRetry: () => ref.invalidate(trendingProvider),
        ),
        data: (tracks) {
          if (tracks.isEmpty) {
            return const Center(child: Text('Nessun brano in tendenza al momento.'));
          }
          return ListView.builder(
            padding: const EdgeInsets.only(top: 8, bottom: 16),
            itemCount: tracks.length + 1,
            itemBuilder: (context, i) {
              if (i == 0) {
                return const Padding(
                  padding: EdgeInsets.fromLTRB(16, 8, 16, 8),
                  child: Text('Tendenze su Audius',
                      style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                );
              }
              final track = tracks[i - 1];
              return TrackTile(
                track: track,
                playing: player?.current?.qualifiedId == track.qualifiedId,
                onTap: () => player?.playQueue(tracks, i - 1),
              );
            },
          );
        },
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: onRetry, child: const Text('Riprova')),
        ],
      ),
    );
  }
}
