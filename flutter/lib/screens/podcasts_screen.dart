import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'podcast_detail_screen.dart';

/// Scoperta podcast: cerca o sfoglia la classifica, apri un podcast per gli episodi.
class PodcastsScreen extends ConsumerStatefulWidget {
  const PodcastsScreen({super.key});
  @override
  ConsumerState<PodcastsScreen> createState() => _PodcastsScreenState();
}

class _PodcastsScreenState extends ConsumerState<PodcastsScreen> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _open(Podcast podcast) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => PodcastDetailScreen(podcastId: podcast.id, fallback: podcast),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final podcasts = ref.watch(podcastsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Podcast')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: TextField(
              controller: _controller,
              textInputAction: TextInputAction.search,
              onSubmitted: (value) =>
                  ref.read(podcastQueryProvider.notifier).state = value.trim(),
              decoration: InputDecoration(
                hintText: 'Cerca un podcast…',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _controller.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _controller.clear();
                          ref.read(podcastQueryProvider.notifier).state = '';
                        },
                      ),
              ),
            ),
          ),
          Expanded(
            child: podcasts.when(
              loading: () => const Center(child: CircularProgressIndicator(color: kSolcoLime)),
              error: (e, _) => const Center(
                child: Text('Impossibile caricare i podcast.',
                    style: TextStyle(color: Colors.white60)),
              ),
              data: (list) {
                if (list.isEmpty) {
                  return const Center(
                    child: Text('Nessun podcast trovato.',
                        style: TextStyle(color: Colors.white60)),
                  );
                }
                return ListView.builder(
                  itemCount: list.length,
                  itemBuilder: (context, i) {
                    final p = list[i];
                    return ListTile(
                      leading: _PodcastArt(url: p.artworkUrl),
                      title: Text(p.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: p.author != null
                          ? Text(p.author!, maxLines: 1, overflow: TextOverflow.ellipsis)
                          : null,
                      trailing: const Icon(Icons.chevron_right, color: Colors.white38),
                      onTap: () => _open(p),
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

class _PodcastArt extends StatelessWidget {
  const _PodcastArt({required this.url});
  final String? url;
  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(
        width: 48,
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

  Widget _fallback() =>
      const ColoredBox(color: kSolcoNavyCard, child: Icon(Icons.podcasts, color: kSolcoLime));
}
