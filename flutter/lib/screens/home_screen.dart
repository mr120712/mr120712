import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/track_tile.dart';
import 'podcasts_screen.dart';
import 'radio_screen.dart';

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
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                      child: Row(
                        children: [
                          Expanded(
                            child: _BrowseCard(
                              icon: Icons.radio,
                              label: 'Radio',
                              onTap: () => Navigator.of(context).push(
                                MaterialPageRoute<void>(builder: (_) => const RadioScreen()),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: _BrowseCard(
                              icon: Icons.podcasts,
                              label: 'Podcast',
                              onTap: () => Navigator.of(context).push(
                                MaterialPageRoute<void>(builder: (_) => const PodcastsScreen()),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Padding(
                      padding: EdgeInsets.fromLTRB(16, 12, 16, 8),
                      child: Text('Tendenze su Audius',
                          style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                    ),
                  ],
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

class _BrowseCard extends StatelessWidget {
  const _BrowseCard({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    return Material(
      color: kSolcoNavyCard,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Column(
            children: [
              Icon(icon, color: kSolcoLime, size: 28),
              const SizedBox(height: 6),
              Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
            ],
          ),
        ),
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
