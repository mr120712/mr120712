import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/mini_player.dart';
import 'player_screen.dart';

/// Dettaglio di una playlist: i brani, con riproduzione dei soli brani Audius.
class PlaylistScreen extends ConsumerWidget {
  const PlaylistScreen({super.key, required this.playlist});
  final Playlist playlist;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final audiusTracks = playlist.audiusTracks;
    return Scaffold(
      appBar: AppBar(title: Text(playlist.name)),
      bottomNavigationBar: const MiniPlayer(),
      body: Column(
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
            child: playlist.items.isEmpty
                ? const Center(
                    child: Text('Playlist vuota.', style: TextStyle(color: Colors.white60)))
                : ListView.builder(
                    itemCount: playlist.items.length,
                    itemBuilder: (context, i) {
                      final item = playlist.items[i];
                      final playable = item.isAudius;
                      return ListTile(
                        leading: _ItemArt(url: item.artworkUrl),
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
                        trailing: Icon(playable ? Icons.play_arrow : Icons.lock_outline,
                            color: playable ? Colors.white70 : Colors.white24, size: 20),
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
      ),
    );
  }

  String _sourceLabel(String source) => switch (source) {
        'youtube' => 'YouTube',
        'song' => 'da cercare',
        _ => source,
      };

  void _openPlayer(BuildContext context) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => const PlayerScreen(),
    ));
  }
}

class _ItemArt extends StatelessWidget {
  const _ItemArt({required this.url});
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
      const ColoredBox(color: kSolcoNavyCard, child: Icon(Icons.music_note, color: kSolcoLime));
}
