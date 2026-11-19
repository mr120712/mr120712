import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../player/player_controller.dart';
import '../state/app_state.dart';
import '../theme.dart';

/// Il «Testo» di un brano in evidenza (stile Spotify). Se è sincronizzato evidenzia la riga in corso
/// seguendo la posizione del player e scorre da solo; altrimenti mostra il testo semplice.
class LyricsSheet extends ConsumerStatefulWidget {
  const LyricsSheet({super.key, required this.pathname, required this.player});
  final String pathname;
  final PlayerController player;

  @override
  ConsumerState<LyricsSheet> createState() => _LyricsSheetState();
}

class _LyricsSheetState extends ConsumerState<LyricsSheet> {
  Lyrics? _lyrics;
  bool _loading = true;
  final ScrollController _scroll = ScrollController();
  final Map<int, GlobalKey> _keys = {};
  int _current = -1;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final api = await ref.read(apiProvider.future);
      final lyrics = await api.featuredLyrics(widget.pathname);
      if (mounted) setState(() {
        _lyrics = lyrics;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  int _currentIndex(List<LyricsLine> lines, int ms) {
    var idx = -1;
    for (var i = 0; i < lines.length; i++) {
      final t = lines[i].timeMs;
      if (t == null) continue;
      if (t <= ms) {
        idx = i;
      } else {
        break;
      }
    }
    return idx;
  }

  void _scrollTo(int idx) {
    final context = _keys[idx]?.currentContext;
    if (context != null) {
      Scrollable.ensureVisible(
        context,
        alignment: 0.4,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeInOut,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.of(context).size.height * 0.78;
    final lyrics = _lyrics;
    Widget body;
    if (_loading) {
      body = const Center(child: CircularProgressIndicator());
    } else if (lyrics == null || lyrics.lines.isEmpty) {
      body = const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Testo non disponibile per questo brano.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white54),
          ),
        ),
      );
    } else if (lyrics.synced) {
      body = StreamBuilder<Duration>(
        stream: widget.player.positionStream,
        builder: (context, snapshot) {
          final ms = (snapshot.data ?? Duration.zero).inMilliseconds;
          final idx = _currentIndex(lyrics.lines, ms);
          if (idx != _current) {
            _current = idx;
            if (idx >= 0) {
              WidgetsBinding.instance.addPostFrameCallback((_) => _scrollTo(idx));
            }
          }
          return _list(lyrics, idx);
        },
      );
    } else {
      body = _list(lyrics, -1);
    }

    return SizedBox(
      height: height,
      child: Column(
        children: [
          const SizedBox(height: 12),
          const Text('Testo', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          if (lyrics?.credit != null && lyrics!.credit!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(lyrics.credit!,
                  style: const TextStyle(color: Colors.white38, fontSize: 11)),
            ),
          const SizedBox(height: 8),
          Expanded(child: body),
        ],
      ),
    );
  }

  Widget _list(Lyrics lyrics, int currentIdx) {
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 48),
      itemCount: lyrics.lines.length,
      itemBuilder: (context, i) {
        final key = _keys.putIfAbsent(i, () => GlobalKey());
        final active = i == currentIdx;
        final text = lyrics.lines[i].text;
        return Container(
          key: key,
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text(
            text.isEmpty ? '♪' : text,
            style: TextStyle(
              fontSize: active ? 20 : 17,
              height: 1.35,
              fontWeight: active ? FontWeight.w700 : FontWeight.w400,
              color: active
                  ? kSolcoLime
                  : (currentIdx < 0 ? Colors.white : Colors.white54),
            ),
          ),
        );
      },
    );
  }
}
