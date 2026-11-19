import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/solco_api.dart';
import '../state/settings.dart';
import '../theme.dart';

/// «Impostazioni»: preferenze locali del dispositivo, valide per TUTTI (anche ospiti),
/// come sul sito. Oggi: autoplay continuo. In fondo, qualche informazione e i link utili.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  // Versione mostrata all'utente (deve combaciare con pubspec: version).
  static const _appVersion = '0.7.3 (12)';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);
    final controller = ref.read(settingsProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Impostazioni')),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          const _SectionTitle('Riproduzione'),
          SwitchListTile(
            value: settings.autoplay,
            onChanged: controller.setAutoplay,
            activeColor: kSolcoLime,
            secondary: const Icon(Icons.all_inclusive),
            title: const Text('Autoplay continuo'),
            subtitle: const Text(
              'A coda finita, continua da solo con brani popolari su Solco: la musica '
              'non si ferma, anche a schermo bloccato. Non vale per radio e podcast.',
            ),
          ),
          const Divider(height: 24, color: Colors.white12),
          const _SectionTitle('Informazioni'),
          const ListTile(
            leading: Icon(Icons.info_outline),
            title: Text('Versione'),
            trailing: Text(_appVersion, style: TextStyle(color: Colors.white54)),
          ),
          _LinkTile(
            icon: Icons.public,
            title: 'Sito ufficiale',
            url: kSolcoBaseUrl,
          ),
          _LinkTile(
            icon: Icons.help_outline,
            title: 'Guida',
            url: '$kSolcoBaseUrl/guida',
          ),
          _LinkTile(
            icon: Icons.privacy_tip_outlined,
            title: 'Privacy',
            url: '$kSolcoBaseUrl/privacy',
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 16, 16, 24),
            child: Text(
              'Tocca una voce per copiare il link e aprirlo nel browser.',
              style: TextStyle(color: Colors.white38, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Text(
          text.toUpperCase(),
          style: TextStyle(
            color: Colors.white.withOpacity(0.5),
            fontWeight: FontWeight.w700,
            fontSize: 12,
            letterSpacing: 0.8,
          ),
        ),
      );
}

/// Riga che copia un link negli appunti (niente plugin nativi aggiuntivi: coerente con «Premi»).
class _LinkTile extends StatelessWidget {
  const _LinkTile({required this.icon, required this.title, required this.url});
  final IconData icon;
  final String title;
  final String url;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title),
      subtitle: Text(url, style: const TextStyle(color: Colors.white38, fontSize: 12)),
      trailing: const Icon(Icons.copy, size: 18),
      onTap: () async {
        final messenger = ScaffoldMessenger.of(context);
        await Clipboard.setData(ClipboardData(text: url));
        messenger.showSnackBar(
          const SnackBar(content: Text('Link copiato.')),
        );
      },
    );
  }
}
