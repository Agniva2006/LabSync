import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'constants.dart';

class LabSyncTheme {
  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: AppColors.bgDark,
      colorScheme: const ColorScheme.dark(
        primary: AppColors.neonCyan,
        secondary: AppColors.neonBlue,
        surface: AppColors.surfaceDark,
        error: AppColors.danger,
      ),
      textTheme:
          GoogleFonts.spaceGroteskTextTheme(ThemeData.dark().textTheme).apply(
        bodyColor: AppColors.textPrimary,
        displayColor: AppColors.textPrimary,
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: GoogleFonts.rajdhani(
          color: AppColors.neonCyan,
          fontSize: 24,
          fontWeight: FontWeight.w700,
          letterSpacing: 2.0,
        ),
        iconTheme: const IconThemeData(color: AppColors.neonCyan),
      ),
      cardTheme: CardThemeData(
        // ← FIXED: Changed from CardTheme to CardThemeData
        color: AppColors.surfaceDark,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(
              color: AppColors.neonCyan.withValues(alpha: 0.15), width: 1),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surfaceLight,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide:
              BorderSide(color: AppColors.neonCyan.withValues(alpha: 0.3)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide:
              BorderSide(color: AppColors.textMuted.withValues(alpha: 0.5)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.neonCyan, width: 2),
        ),
        hintStyle: GoogleFonts.spaceGrotesk(color: AppColors.textMuted),
      ),
    );
  }
}
