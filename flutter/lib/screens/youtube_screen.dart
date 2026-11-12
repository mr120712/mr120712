import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/mini_player.dart';
import 'youtube_player_screen.dart';

/// Ricerca YouTube e riproduzione col player ufficiale (WebView). La ricerca
/// parte solo all'invio (consenso esplicito), come sul sito.
class YouTubeScreen extends ConsumerStatefulWidget {
  const YouTubeScreen({super.key});
  @override
  ConsumerState<YouTubeScreen> createState() => _YouTubeScreenState();
}

class _YouTubeScreenState extends ConsumerState<YouTubeScreen> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _openPlayer(List<YouTubeVideo> videos, int index) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => YouTubePlayerScreen(videos: videos, startIndex: index),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final results = ref.watch(youtubeResultsProvider);
    final hasQuery = ref.watch(youtubeQueryProvider).trim().isNotEmpty;
    return Scaffold(
      appBar: AppBar(title: const Text('YouTube')),
      bottomNavigationBar: const MiniPlayer(),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: TextField(
              controller: _controller,
              textInputAction: TextInputAction.search,
              onSubmitted: (value) =>
                  ref.read(youtubeQueryProvider.notifier).state = value.trim(),
              decoration: InputDecoration(
                hintText: 'Cerca su YouTube…',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _controller.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _controller.clear();
                          ref.read(youtubeQueryProvider.notifier).state = '';
                        },
                      ),
              ),
            ),
          ),
          Expanded(
            child: !hasQuery
                ? const _Hint()
                : results.when(
                    loading: () =>
                        const Center(child: CircularProgressIndicator(color: kSolcoLime)),
                    error: (e, _) => const Center(
                      child: Text('Ricerca YouTube non riuscita.',
                          style: TextStyle(color: Colors.white60)),
                    ),
                    data: (videos) {
                      if (videos.isEmpty) {
                        return const Center(
                          child: Text('Nessun video trovato.',
                              style: TextStyle(color: Colors.white60)),
                        );
                      }
                      return ListView.builder(
                        itemCount: videos.length,
                        itemBuilder: (context, i) {
                          final v = videos[i];
                          return ListTile(
                            leading: _Thumb(url: v.thumbnailUrl),
                            title: Text(v.title, maxLines: 2, overflow: TextOverflow.ellipsis),
                            subtitle: Text(v.channelTitle,
                                maxLines: 1, overflow: TextOverflow.ellipsis),
                            trailing: const Icon(Icons.play_arrow, color: Colors.white70),
                            onTap: () => _openPlayer(videos, i),
                          );
                        },
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint();
  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Text(
          'Cerca un video su YouTube.\nSi riproduce col player ufficiale.',
          textAlign: TextAlign.center,
          style: TextStyle(color: Colors.white54),
        ),
      ),
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.url});
  final String? url;
  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: SizedBox(
        width: 72,
        height: 48,
        child: url != null
            ? CachedNetworkImage(
                imageUrl: url!,
                fit: BoxFit.cover,
                placeholder: (_, __) => const ColoredBox(color: kSolcoNavyCard),
                errorWidget: (_, __, ___) => _fallback(),
              )
            : _fallback(),
      ),
    );
  }

  Widget _fallback() => const ColoredBox(
        color: kSolcoNavyCard,
        child: Icon(Icons.ondemand_video, color: kSolcoLime),
      );
}
