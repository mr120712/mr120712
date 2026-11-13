import 'package:flutter/material.dart';

/// Palette Solco — look AGGRESSIVO/VIRALE: nero profondo + accento MAGENTA
/// elettrico e un gradiente brand (come il sito). I nomi delle costanti restano
/// per compatibilità; i valori sono il nuovo tema. Per cambiare accento,
/// sostituisci kSolcoLime.
const Color kSolcoNavy = Color(0xFF08060E); // sfondo nero-violaceo
const Color kSolcoNavyCard = Color(0xFF120E1C); // superfici / card
const Color kSolcoLime = Color(0xFFFF2E88); // accento MAGENTA elettrico
const Color kSolcoChristmasRed = Color(0xFFFF4D5E); // rosso (es. badge "in diretta")
const Color kSolcoGold = Color(0xFFF59E0B); // ambra (avvisi)

/// Gradiente brand (violetto → magenta → ambra): per header e accenti "virali".
const LinearGradient kSolcoGradient = LinearGradient(
  begin: Alignment.centerLeft,
  end: Alignment.centerRight,
  colors: [Color(0xFF8B5CF6), Color(0xFFEC4899), Color(0xFFF59E0B)],
);

const Color _fg = Color(0xFFF4F2F8);
const Color _onAccent = Color(0xFF180314);
const Color _border = Color(0xFF271D38);
const Color _muted = Color(0xFFAA9FBB);

ThemeData solcoTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: kSolcoNavy,
    colorScheme: base.colorScheme.copyWith(
      primary: kSolcoLime,
      onPrimary: _onAccent,
      secondary: kSolcoLime,
      surface: kSolcoNavyCard,
      onSurface: _fg,
      outline: _border,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: kSolcoNavy,
      foregroundColor: _fg,
      elevation: 0,
      centerTitle: false,
    ),
    cardColor: kSolcoNavyCard,
    dividerColor: _border,
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: kSolcoLime,
        foregroundColor: _onAccent,
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: kSolcoNavyCard,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: _border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: _border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: kSolcoLime, width: 1.5),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: const Color(0xFF0F0A18),
      elevation: 0,
      indicatorColor: kSolcoLime.withOpacity(0.20),
      labelTextStyle: WidgetStateProperty.all(
        const TextStyle(fontSize: 12, color: _muted),
      ),
    ),
  );
}
