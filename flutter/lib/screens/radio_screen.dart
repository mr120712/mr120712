import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'player_screen.dart';

/// Scoperta radio: cerca o sfoglia le stazioni più votate, e riproduci in diretta.
class RadioScreen extends ConsumerStatefulWidget {
  const RadioScreen({super.key});
  @override
  ConsumerState<RadioScreen> createState() => _RadioScreenState();
}

class _RadioScreenState extends ConsumerState<RadioScreen> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _playStation(List<RadioStation> stations, int index) {
    ref.read(playerProvider)?.playItems(stations.map((s) => s.toPlayable()).toList(), index);
    Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => const PlayerScreen(),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final stations = ref.watch(radioStationsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Radio')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: TextField(
              controller: _controller,
              textInputAction: TextInputAction.search,
              onSubmitted: (value) =>
                  ref.read(radioQueryProvider.notifier).state = value.trim(),
              decoration: InputDecoration(
                hintText: 'Cerca una radio…',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _controller.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _controller.clear();
                          ref.read(radioQueryProvider.notifier).state = '';
                        },
                      ),
              ),
            ),
          ),
          Expanded(
            child: stations.when(
              loading: () => const Center(child: CircularProgressIndicator(color: kSolcoLime)),
              error: (e, _) => Center(
                child: Text('Impossibile caricare le radio.',
                    style: const TextStyle(color: Colors.white60)),
              ),
              data: (list) {
                if (list.isEmpty) {
                  return const Center(
                    child: Text('Nessuna radio trovata.',
                        style: TextStyle(color: Colors.white60)),
                  );
                }
                return ListView.builder(
                  itemCount: list.length,
                  itemBuilder: (context, i) {
                    final s = list[i];
                    return ListTile(
                      leading: _StationArt(url: s.artworkUrl),
                      title: Text(s.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(
                        [s.country, if (s.tags.isNotEmpty) s.tags.first]
                            .whereType<String>()
                            .join(' · '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: const Icon(Icons.play_arrow, color: Colors.white70),
                      onTap: () => _playStation(list, i),
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

class _StationArt extends StatelessWidget {
  const _StationArt({required this.url});
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
      const ColoredBox(color: kSolcoNavyCard, child: Icon(Icons.radio, color: kSolcoLime));
}
