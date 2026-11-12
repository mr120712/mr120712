import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../player/player_controller.dart';
import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/mini_player.dart';
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
      bottomNavigationBar: const MiniPlayer(),
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
                  trailing: e.hasTranscript
                      ? IconButton(
                          icon: const Icon(Icons.notes, color: Colors.white54),
                          tooltip: 'Trascrizione',
                          onPressed: () => showModalBottomSheet<void>(
                            context: context,
                            isScrollControlled: true,
                            backgroundColor: kSolcoNavyCard,
                            shape: const RoundedRectangleBorder(
                              borderRadius:
                                  BorderRadius.vertical(top: Radius.circular(18)),
                            ),
                            builder: (_) => _TranscriptSheet(
                              podcastId: podcastId,
                              episodeKey: e.key,
                              episodeTitle: e.title,
                            ),
                          ),
                        )
                      : null,
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

/// Foglio della trascrizione di un episodio. Se l'episodio è quello in ascolto
/// ed è temporizzata, evidenzia il segmento corrente e un tocco salta a quel
/// punto ("segui la trascrizione" come su Spotify).
class _TranscriptSheet extends ConsumerWidget {
  const _TranscriptSheet({
    required this.podcastId,
    required this.episodeKey,
    required this.episodeTitle,
  });
  final String podcastId;
  final String episodeKey;
  final String episodeTitle;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final transcriptAsync = ref.watch(transcriptProvider((podcastId, episodeKey)));
    final player = ref.watch(playerProvider);
    final qualifiedId = 'podcast:$podcastId~$episodeKey';
    final isCurrent = player?.current?.qualifiedId == qualifiedId;

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.78),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 10),
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: Colors.white24,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
              child: Row(
                children: [
                  const Icon(Icons.notes, color: kSolcoLime, size: 18),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text('Trascrizione',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(episodeTitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Colors.white54, fontSize: 13)),
              ),
            ),
            Flexible(
              child: transcriptAsync.when(
                loading: () => const Padding(
                  padding: EdgeInsets.all(28),
                  child: Center(child: CircularProgressIndicator(color: kSolcoLime)),
                ),
                error: (_, __) => const Padding(
                  padding: EdgeInsets.all(24),
                  child: Text('Trascrizione non disponibile in questo momento.',
                      style: TextStyle(color: Colors.white60)),
                ),
                data: (t) {
                  if (!t.available || t.cues.isEmpty) {
                    return const Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('Questo episodio non ha una trascrizione leggibile.',
                          style: TextStyle(color: Colors.white60)),
                    );
                  }
                  final canSeek = t.timed && isCurrent && player != null;
                  if (canSeek) {
                    return _TimedCues(cues: t.cues, player: player);
                  }
                  return _StaticCues(cues: t.cues);
                },
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 8, 20, 14),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('Trascrizione fornita dall’editore del podcast.',
                    style: TextStyle(color: Colors.white30, fontSize: 11)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Elenco statico di segmenti (episodio non in ascolto o formato non temporizzato).
class _StaticCues extends StatelessWidget {
  const _StaticCues({required this.cues});
  final List<TranscriptCue> cues;
  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      itemCount: cues.length,
      itemBuilder: (_, i) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        child: Text(cues[i].text,
            style: const TextStyle(color: Colors.white70, fontSize: 14, height: 1.5)),
      ),
    );
  }
}

/// Segmenti sincronizzati con la posizione: evidenzia quello corrente; un tocco salta.
class _TimedCues extends StatelessWidget {
  const _TimedCues({required this.cues, required this.player});
  final List<TranscriptCue> cues;
  final PlayerController player;

  int _activeIndex(Duration position) {
    final seconds = position.inMilliseconds / 1000.0;
    var index = -1;
    for (var i = 0; i < cues.length; i++) {
      final start = cues[i].startSeconds;
      if (start == null) continue;
      if (start <= seconds) {
        index = i;
      } else {
        break;
      }
    }
    return index;
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<Duration>(
      stream: player.positionStream,
      initialData: Duration.zero,
      builder: (_, snapshot) {
        final active = _activeIndex(snapshot.data ?? Duration.zero);
        return ListView.builder(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          itemCount: cues.length,
          itemBuilder: (_, i) {
            final cue = cues[i];
            final isActive = i == active;
            final start = cue.startSeconds;
            VoidCallback? onTap;
            if (start != null) {
              final ms = (start * 1000).round();
              onTap = () => player.seek(Duration(milliseconds: ms));
            }
            return InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: onTap,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
                decoration: BoxDecoration(
                  color: isActive ? kSolcoLime.withOpacity(0.14) : null,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  cue.text,
                  style: TextStyle(
                    color: isActive ? Colors.white : Colors.white60,
                    fontSize: 14,
                    height: 1.5,
                    fontWeight: isActive ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }
}
