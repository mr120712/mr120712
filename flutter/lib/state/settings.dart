import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Le impostazioni dell'app: preferenze SALVATE SUL DISPOSITIVO (shared_preferences).
/// Non richiedono l'accesso: valgono per questo telefono, come sul sito.
class Settings {
  const Settings({this.autoplay = true});

  /// Autoplay continuo: a coda finita, la musica continua da sola con brani
  /// popolari su Solco (non vale per radio e podcast). Predefinito: attivo.
  final bool autoplay;

  Settings copyWith({bool? autoplay}) => Settings(autoplay: autoplay ?? this.autoplay);
}

/// Controller delle impostazioni: legge i valori salvati all'avvio e li riscrive
/// a ogni modifica. Finché il caricamento non è finito, usa i valori predefiniti.
class SettingsController extends StateNotifier<Settings> {
  SettingsController() : super(const Settings()) {
    _load();
  }

  static const _kAutoplay = 'settings.autoplay';
  SharedPreferences? _prefs;

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _prefs = prefs;
      state = Settings(autoplay: prefs.getBool(_kAutoplay) ?? true);
    } catch (_) {
      // Se le preferenze non si caricano, restano i valori predefiniti.
    }
  }

  Future<void> setAutoplay(bool value) async {
    state = state.copyWith(autoplay: value);
    try {
      final prefs = _prefs ??= await SharedPreferences.getInstance();
      await prefs.setBool(_kAutoplay, value);
    } catch (_) {
      // La UI resta aggiornata anche se il salvataggio su disco non riesce.
    }
  }
}

/// Le impostazioni correnti dell'app.
final settingsProvider =
    StateNotifierProvider<SettingsController, Settings>((ref) => SettingsController());
