import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/mini_player.dart';
import '../widgets/track_tile.dart';
import 'player_screen.dart';

/// Classici per decennio: playlist curate dal catalogo lecito di Solco (Audius), nello stile
/// di ogni decennio. Non sono le incisioni originali protette.
class ClassicsScreen extends ConsumerStatefulWidget {
  const ClassicsScreen({super.key});
  @override
  ConsumerState<ClassicsScreen> createState() => _ClassicsScreenState();
}

class _ClassicsScreenState extends ConsumerState<ClassicsScreen> {
  String _decade = '60s';

  void _openPlayer() {
    Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => const PlayerScreen(),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final classicsAsync = ref.watch(classicsProvider(_decade));
    final player = ref.watch(playerProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Classici')),
      bottomNavigationBar: const MiniPlayer(),
      body: Column(
        children: [
          SizedBox(
            height: 52,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              itemCount: classicsDecades.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (context, i) {
                final decade = classicsDecades[i];
                return ChoiceChip(
                  label: Text(decade.label),
                  selected: decade.slug == _decade,
                  onSelected: (_) => setState(() => _decade = decade.slug),
                );
              },
            ),
          ),
          Expanded(
            child: classicsAsync.when(
              loading: () => const Center(child: CircularProgressIndicator(color: kSolcoLime)),
              error: (_, __) => const Center(
                child: Text('I classici non sono raggiungibili in questo momento.',
                    style: TextStyle(color: Colors.white60)),
              ),
              data: (result) {
                if (result.playlists.isEmpty) {
                  return const Center(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('Nessuna playlist disponibile per questo decennio adesso.',
                          textAlign: TextAlign.center, style: TextStyle(color: Colors.white60)),
                    ),
                  );
                }
                return ListView(
                  padding: const EdgeInsets.only(bottom: 16),
                  children: [
                    if (result.tagline.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                        child: Text(result.tagline,
                            style: const TextStyle(color: Colors.white70)),
                      ),
                    for (final playlist in result.playlists) ...[
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 18, 16, 2),
                        child: Text(playlist.title,
                            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                      ),
                      if (playlist.description.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                          child: Text(playlist.description,
                              style: const TextStyle(color: Colors.white54, fontSize: 13)),
                        ),
                      for (int i = 0; i < playlist.tracks.length; i++)
                        TrackTile(
                          track: playlist.tracks[i],
                          playing: player?.current?.qualifiedId == playlist.tracks[i].qualifiedId,
                          onTap: () {
                            player?.playQueue(playlist.tracks, i);
                            _openPlayer();
                          },
                        ),
                    ],
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
