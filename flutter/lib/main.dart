import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio_background/just_audio_background.dart';

import 'screens/home_screen.dart';
import 'screens/library_screen.dart';
import 'screens/login_screen.dart';
import 'screens/profile_screen.dart';
import 'screens/search_screen.dart';
import 'state/app_state.dart';
import 'theme.dart';
import 'widgets/mini_player.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Abilita i comandi dalla schermata di blocco e la riproduzione in background.
  await JustAudioBackground.init(
    androidNotificationChannelId: 'app.solco.audio',
    androidNotificationChannelName: 'Solco',
    androidNotificationOngoing: true,
  );
  runApp(const ProviderScope(child: SolcoApp()));
}

class SolcoApp extends StatelessWidget {
  const SolcoApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Solco',
      debugShowCheckedModeBanner: false,
      theme: solcoTheme(),
      home: const _AuthGate(),
    );
  }
}

/// Mostra il login finché non c'è una sessione; poi l'app con la navigazione.
class _AuthGate extends ConsumerWidget {
  const _AuthGate();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    return session.when(
      loading: () => const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (_, __) => const LoginScreen(),
      data: (user) => user == null ? const LoginScreen() : const _MainShell(),
    );
  }
}

class _MainShell extends StatefulWidget {
  const _MainShell();
  @override
  State<_MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<_MainShell> {
  int _index = 0;
  static const _titles = ['Home', 'Cerca', 'Libreria', 'Profilo'];

  @override
  Widget build(BuildContext context) {
    final pages = const [HomeScreen(), SearchScreen(), LibraryScreen(), ProfileScreen()];
    return Scaffold(
      appBar: AppBar(title: Text(_titles[_index])),
      body: SafeArea(child: pages[_index]),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const MiniPlayer(),
          NavigationBar(
            selectedIndex: _index,
            onDestinationSelected: (i) => setState(() => _index = i),
            destinations: const [
              NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
              NavigationDestination(icon: Icon(Icons.search), label: 'Cerca'),
              NavigationDestination(icon: Icon(Icons.library_music_outlined), selectedIcon: Icon(Icons.library_music), label: 'Libreria'),
              NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profilo'),
            ],
          ),
        ],
      ),
    );
  }
}
