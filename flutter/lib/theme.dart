import 'package:flutter/material.dart';

/// Palette Solco — monocromatico FUTURISTICO: nero profondo + un unico accento
/// NEON ciano (come il sito). I nomi delle costanti restano per compatibilità;
/// i valori sono il nuovo tema. Per cambiare accento, sostituisci kSolcoLime.
const Color kSolcoNavy = Color(0xFF05070A); // sfondo nero
const Color kSolcoNavyCard = Color(0xFF0A0E14); // superfici / card
const Color kSolcoLime = Color(0xFF22D3EE); // accento NEON ciano
const Color kSolcoChristmasRed = Color(0xFFFF5D6C); // rosso (es. badge "in diretta")
const Color kSolcoGold = Color(0xFFE0B24E);

const Color _fg = Color(0xFFE9EDF2);
const Color _onAccent = Color(0xFF04161B);
const Color _border = Color(0xFF1B2430);
const Color _muted = Color(0xFFB3C0CC);

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
      backgroundColor: const Color(0xFF080B10),
      elevation: 0,
      indicatorColor: kSolcoLime.withOpacity(0.18),
      labelTextStyle: WidgetStateProperty.all(
        const TextStyle(fontSize: 12, color: _muted),
      ),
    ),
  );
}
