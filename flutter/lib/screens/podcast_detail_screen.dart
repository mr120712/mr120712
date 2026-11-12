import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'player_screen.dart';

/// Dettaglio di un podcast: intestazione + episodi, con riproduzione.
class PodcastDetailScreen extends ConsumerWidget {
  const PodcastDetailScreen({super.key, required this.podcastId, this.fallback});
  final String podcastId;
  final Podcast? fallback;

  List<PlayableItem> _episodeItems(PodcastDetail detail) {
    final podcast = detail.podcast ?? fallback;
    final title = podcast?.title ?? 'Podcast';
    final artwork = podcast?.artworkUrl;
    return detail.episodes
        .map((e) => e.toPlayable(
              podcastId: podcastId,
              podcastTitle: title,
              podcastArtwork: artwork,
            ))
        .toList();
  }

  void _play(BuildContext context, WidgetRef ref, PodcastDetail detail, int index) {
    ref.read(playerProvider)?.playItems(_episodeItems(detail), index);
    Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => const PlayerScreen(),
    ));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detailAsync = ref.watch(podcastDetailProvider(podcastId));
    return Scaffold(
      appBar: AppBar(title: Text(fallback?.title ?? 'Podcast')),
      body: detailAsync.when(
        loading: () => const Center(child: CircularProgressIndicator(color: kSolcoLime)),
        error: (e, _) => const Center(
          child: Text('Impossibile caricare il podcast.',
              style: TextStyle(color: Colors.white60)),
        ),
        data: (detail) {
          final podcast = detail.podcast ?? fallback;
          final episodes = detail.episodes;
          return ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              _Header(podcast: podcast, episodeCount: episodes.length),
              if (episodes.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                  child: FilledButton.icon(
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Riproduci dal primo'),
                    onPressed: () => _play(context, ref, detail, 0),
                  ),
                ),
              if (episodes.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(
                    child: Text('Nessun episodio disponibile.',
                        style: TextStyle(color: Colors.white60)),
                  ),
                ),
              ...episodes.asMap().entries.map((entry) {
                final i = entry.key;
                final e = entry.value;
                return ListTile(
                  leading: const Icon(Icons.play_circle_outline, color: Colors.white70),
                  title: Text(e.title, maxLines: 2, overflow: TextOverflow.ellipsis),
                  subtitle: Text(
                    _episodeSubtitle(e),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Colors.white54),
                  ),
                  onTap: () => _play(context, ref, detail, i),
                );
              }),
            ],
          );
        },
      ),
    );
  }

  String _episodeSubtitle(PodcastEpisode e) {
    final parts = <String>[];
    if (e.publishedAt != null && e.publishedAt!.length >= 10) {
      parts.add(e.publishedAt!.substring(0, 10));
    }
    if (e.durationSeconds != null) {
      final m = (e.durationSeconds! / 60).round();
      parts.add('$m min');
    }
    return parts.join(' · ');
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.podcast, required this.episodeCount});
  final Podcast? podcast;
  final int episodeCount;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: SizedBox(
              width: 88,
              height: 88,
              child: podcast?.artworkUrl != null
                  ? CachedNetworkImage(imageUrl: podcast!.artworkUrl!, fit: BoxFit.cover)
                  : const ColoredBox(
                      color: kSolcoNavyCard,
                      child: Icon(Icons.podcasts, color: kSolcoLime, size: 36)),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(podcast?.title ?? 'Podcast',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                if (podcast?.author != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(podcast!.author!,
                        style: const TextStyle(color: Colors.white60)),
                  ),
                const SizedBox(height: 6),
                Text('$episodeCount episodi',
                    style: const TextStyle(color: Colors.white38, fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
