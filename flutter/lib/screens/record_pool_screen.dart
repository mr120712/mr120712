import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../api/solco_api.dart';
import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/mini_player.dart';
import 'player_screen.dart';

/// Record Pool: brani royalty-free che gli artisti hanno reso scaricabili su Audius
/// (Open Music License). Si ascoltano e si scaricano dentro Solco.
class RecordPoolScreen extends ConsumerStatefulWidget {
  const RecordPoolScreen({super.key});
  @override
  ConsumerState<RecordPoolScreen> createState() => _RecordPoolScreenState();
}

class _RecordPoolScreenState extends ConsumerState<RecordPoolScreen> {
  String _genre = '';

  void _openPlayer() {
    Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => const PlayerScreen(),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final poolAsync = ref.watch(recordPoolProvider(_genre));
    final player = ref.watch(playerProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Record Pool')),
      bottomNavigationBar: const MiniPlayer(),
      body: Column(
        children: [
          SizedBox(
            height: 52,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              itemCount: recordPoolGenres.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (context, i) {
                final genre = recordPoolGenres[i];
                final selected = genre.slug == _genre;
                return ChoiceChip(
                  label: Text(genre.label),
                  selected: selected,
                  onSelected: (_) => setState(() => _genre = genre.slug),
                );
              },
            ),
          ),
          Expanded(
            child: poolAsync.when(
              loading: () => const Center(child: CircularProgressIndicator(color: kSolcoLime)),
              error: (_, __) => const Center(
                child: Text('Il pool non è raggiungibile in questo momento.',
                    style: TextStyle(color: Colors.white60)),
              ),
              data: (tracks) {
                if (tracks.isEmpty) {
                  return const Center(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('Nessun brano scaricabile per questo genere adesso.',
                          textAlign: TextAlign.center, style: TextStyle(color: Colors.white60)),
                    ),
                  );
                }
                return ListView.builder(
                  itemCount: tracks.length,
                  itemBuilder: (context, i) {
                    final track = tracks[i];
                    final playing = player?.current?.qualifiedId == track.qualifiedId;
                    return ListTile(
                      leading: _PoolArt(url: track.artworkUrl),
                      title: Text(track.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(track.artistName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: Colors.white54)),
                      trailing: _PoolDownloadButton(track: track),
                      onTap: () {
                        player?.playQueue(tracks, i);
                        _openPlayer();
                      },
                      selected: playing,
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

class _PoolArt extends StatelessWidget {
  const _PoolArt({this.url});
  final String? url;
  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
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

/// Pulsante di download per un brano del pool (tutti scaricabili: il server li ha filtrati).
class _PoolDownloadButton extends ConsumerWidget {
  const _PoolDownloadButton({required this.track});
  final AudiusTrack track;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final downloads = ref.watch(downloadsProvider).valueOrNull ?? const <DownloadedTrack>[];
    final already = downloads.any((d) => d.qualifiedId == track.qualifiedId);
    if (already) {
      return const Icon(Icons.download_done, color: kSolcoLime);
    }
    return IconButton(
      icon: const Icon(Icons.download_outlined),
      tooltip: 'Scarica per offline',
      onPressed: () async {
        final messenger = ScaffoldMessenger.of(context);
        messenger.showSnackBar(const SnackBar(content: Text('Scarico…')));
        try {
          final store = await ref.read(offlineStoreProvider.future);
          await store.download(track.toPlayable());
          ref.invalidate(downloadsProvider);
          messenger.hideCurrentSnackBar();
          messenger.showSnackBar(const SnackBar(content: Text('Scaricato per offline.')));
        } catch (e) {
          messenger.hideCurrentSnackBar();
          messenger.showSnackBar(SnackBar(
            content: Text(e is SolcoApiException ? e.message : 'Download non riuscito.'),
          ));
        }
      },
    );
  }
}
