import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/solco_api.dart';
import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/mini_player.dart';
import 'player_screen.dart';

/// Sezione dedicata ai Preferiti: i brani salvati col cuore, riproducibili e rimovibili.
class FavoritesScreen extends ConsumerWidget {
  const FavoritesScreen({super.key});

  void _openPlayer(BuildContext context) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => const PlayerScreen(),
    ));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final collectionsAsync = ref.watch(collectionsProvider);
    final favorites = ref.watch(favoritesProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Preferiti')),
      bottomNavigationBar: const MiniPlayer(),
      body: collectionsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator(color: kSolcoLime)),
        error: (_, __) => const Center(
          child: Text('Impossibile caricare i Preferiti.',
              style: TextStyle(color: Colors.white60)),
        ),
        data: (_) {
          final fav = favorites;
          if (fav == null || fav.items.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(28),
                child: Text(
                  'Nessun preferito.\nTocca il cuore su un brano per aggiungerlo.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white60),
                ),
              ),
            );
          }
          final audiusTracks = fav.audiusTracks;
          return Column(
            children: [
              if (audiusTracks.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                  child: Row(
                    children: [
                      FilledButton.icon(
                        icon: const Icon(Icons.play_arrow),
                        label: const Text('Riproduci'),
                        onPressed: () {
                          ref.read(playerProvider)?.playQueue(audiusTracks, 0);
                          _openPlayer(context);
                        },
                      ),
                      const SizedBox(width: 12),
                      Text('${audiusTracks.length} brani Audius',
                          style: const TextStyle(color: Colors.white54, fontSize: 13)),
                    ],
                  ),
                ),
              Expanded(
                child: ListView.builder(
                  itemCount: fav.items.length,
                  itemBuilder: (context, i) {
                    final item = fav.items[i];
                    final playable = item.isAudius;
                    return ListTile(
                      leading: _FavArt(url: item.artworkUrl),
                      title: Text(item.title ?? 'Senza titolo',
                          maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(
                        playable
                            ? (item.creatorName ?? '')
                            : '${item.creatorName ?? ''} · ${_sourceLabel(item.source)}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: playable ? Colors.white54 : Colors.white38),
                      ),
                      trailing: IconButton(
                        icon: const Icon(Icons.favorite, color: kSolcoLime, size: 20),
                        tooltip: 'Togli dai Preferiti',
                        onPressed: () async {
                          final messenger = ScaffoldMessenger.of(context);
                          try {
                            final api = await ref.read(apiProvider.future);
                            await api.removeCollectionItem(fav.id, item.id);
                            ref.invalidate(collectionsProvider);
                            messenger.showSnackBar(
                                const SnackBar(content: Text('Rimosso dai Preferiti.')));
                          } catch (e) {
                            messenger.showSnackBar(SnackBar(
                              content: Text(
                                  e is SolcoApiException ? e.message : 'Operazione non riuscita.'),
                            ));
                          }
                        },
                      ),
                      onTap: () {
                        if (!playable) {
                          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                            content: Text('Questo brano si ascolta dal sito.'),
                          ));
                          return;
                        }
                        final startIndex = audiusTracks
                            .indexWhere((t) => t.qualifiedId == item.audiusTrack!.qualifiedId);
                        ref
                            .read(playerProvider)
                            ?.playQueue(audiusTracks, startIndex < 0 ? 0 : startIndex);
                        _openPlayer(context);
                      },
                    );
                  },
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  String _sourceLabel(String source) => switch (source) {
        'youtube' => 'YouTube',
        'song' => 'Brano importato',
        _ => 'Audius',
      };
}

class _FavArt extends StatelessWidget {
  const _FavArt({this.url});
  final String? url;
  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: SizedBox(
        width: 48,
        height: 48,
        child: url != null
            ? CachedNetworkImage(imageUrl: url!, fit: BoxFit.cover)
            : const ColoredBox(color: kSolcoNavyCard, child: Icon(Icons.music_note, color: kSolcoLime)),
      ),
    );
  }
}
