import 'package:flutter/material.dart';

/// Colori del marchio Solco (come il tema scuro del sito).
const Color kSolcoNavy = Color(0xFF08151F);
const Color kSolcoNavyCard = Color(0xFF0D1D15);
const Color kSolcoLime = Color(0xFFC5ED72);
const Color kSolcoChristmasRed = Color(0xFFE5484D);
const Color kSolcoGold = Color(0xFFF2C14E);

ThemeData solcoTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: kSolcoNavy,
    colorScheme: base.colorScheme.copyWith(
      primary: kSolcoLime,
      secondary: kSolcoChristmasRed,
      surface: kSolcoNavyCard,
      onPrimary: kSolcoNavy,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: kSolcoNavy,
      foregroundColor: Colors.white,
      elevation: 0,
      centerTitle: false,
    ),
    cardColor: kSolcoNavyCard,
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: kSolcoLime,
        foregroundColor: kSolcoNavy,
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: kSolcoNavyCard,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide.none,
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: kSolcoNavyCard,
      indicatorColor: kSolcoLime.withOpacity(0.18),
      labelTextStyle: WidgetStateProperty.all(
        const TextStyle(fontSize: 12, color: Colors.white70),
      ),
    ),
  );
}
