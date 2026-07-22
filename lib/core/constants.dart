import 'package:flutter/material.dart';

// ==================== COLOR PALETTE ====================
class AppColors {
  // Deep space dark backgrounds
  static const Color bgDark = Color(0xFF05070A);
  static const Color surfaceDark = Color(0xFF0F141F);
  static const Color surfaceLight = Color(0xFF1A2232);

  // Light theme backgrounds
  static const Color bgLight = Color(0xFFF5F7FA);
  static const Color surfaceLightTheme = Color(0xFFFFFFFF);
  static const Color surfaceLightSecondary = Color(0xFFE8EAF0);

  // Neon Accents
  static const Color neonCyan = Color(0xFF00F0FF);
  static const Color neonBlue = Color(0xFF0066FF);
  static const Color neonPurple = Color(0xFF9D00FF);

  // Text - Dark Theme
  static const Color textPrimary = Color(0xFFFFFFFF);
  static const Color textSecondary = Color(0xFF8892A6);
  static const Color textMuted = Color(0xFF4B5568);

  // Text - Light Theme
  static const Color textPrimaryLight = Color(0xFF1A1F3A);
  static const Color textSecondaryLight = Color(0xFF5A6478);
  static const Color textMutedLight = Color(0xFF9CA3AF);

  // Status
  static const Color success = Color(0xFF00FF9D);
  static const Color warning = Color(0xFFFFB800);
  static const Color danger = Color(0xFFFF3366);

  // Gradients
  static const LinearGradient primaryGradient = LinearGradient(
    colors: [neonCyan, neonBlue],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );

  static const LinearGradient accentGradient = LinearGradient(
    colors: [neonPurple, neonBlue],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );
}

// ==================== TYPOGRAPHY ====================
class AppTextStyles {
  static const TextStyle heading1Dark = TextStyle(
    fontSize: 32,
    fontWeight: FontWeight.bold,
    color: AppColors.textPrimary,
    letterSpacing: 1.5,
  );

  static const TextStyle heading2Dark = TextStyle(
    fontSize: 24,
    fontWeight: FontWeight.bold,
    color: AppColors.textPrimary,
    letterSpacing: 1.2,
  );

  static const TextStyle heading3Dark = TextStyle(
    fontSize: 20,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimary,
    letterSpacing: 1.0,
  );

  static const TextStyle bodyDark = TextStyle(
    fontSize: 16,
    color: AppColors.textPrimary,
    height: 1.5,
  );

  static const TextStyle bodySecondaryDark = TextStyle(
    fontSize: 14,
    color: AppColors.textSecondary,
    height: 1.4,
  );

  static const TextStyle captionDark = TextStyle(
    fontSize: 12,
    color: AppColors.textSecondary,
    letterSpacing: 0.5,
  );

  static const TextStyle heading1Light = TextStyle(
    fontSize: 32,
    fontWeight: FontWeight.bold,
    color: AppColors.textPrimaryLight,
    letterSpacing: 1.5,
  );

  static const TextStyle heading2Light = TextStyle(
    fontSize: 24,
    fontWeight: FontWeight.bold,
    color: AppColors.textPrimaryLight,
    letterSpacing: 1.2,
  );

  static const TextStyle heading3Light = TextStyle(
    fontSize: 20,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimaryLight,
    letterSpacing: 1.0,
  );

  static const TextStyle bodyLight = TextStyle(
    fontSize: 16,
    color: AppColors.textPrimaryLight,
    height: 1.5,
  );

  static const TextStyle bodySecondaryLight = TextStyle(
    fontSize: 14,
    color: AppColors.textSecondaryLight,
    height: 1.4,
  );

  static const TextStyle captionLight = TextStyle(
    fontSize: 12,
    color: AppColors.textSecondaryLight,
    letterSpacing: 0.5,
  );
}

// ==================== SPACING & SIZING ====================
class AppSpacing {
  static const double xs = 4.0;
  static const double sm = 8.0;
  static const double md = 16.0;
  static const double lg = 24.0;
  static const double xl = 32.0;
  static const double xxl = 48.0;

  static const EdgeInsets paddingSmall = EdgeInsets.all(sm);
  static const EdgeInsets paddingMedium = EdgeInsets.all(md);
  static const EdgeInsets paddingLarge = EdgeInsets.all(lg);

  static const EdgeInsets marginSmall = EdgeInsets.all(sm);
  static const EdgeInsets marginMedium = EdgeInsets.all(md);
  static const EdgeInsets marginLarge = EdgeInsets.all(lg);
}

class AppSizes {
  static const double iconSmall = 20.0;
  static const double iconMedium = 24.0;
  static const double iconLarge = 32.0;
  static const double iconXLarge = 48.0;

  static const double buttonHeight = 50.0;
  static const double inputHeight = 56.0;

  static const double borderRadiusSmall = 8.0;
  static const double borderRadiusMedium = 12.0;
  static const double borderRadiusLarge = 16.0;
  static const double borderRadiusXLarge = 24.0;
}

// ==================== ANIMATIONS ====================
class AppAnimations {
  static const Duration fast = Duration(milliseconds: 200);
  static const Duration medium = Duration(milliseconds: 300);
  static const Duration slow = Duration(milliseconds: 500);

  static const Curve defaultCurve = Curves.easeInOut;
  static const Curve bounceCurve = Curves.elasticOut;
}

// ==================== THEMES ====================
class AppTheme {
  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: AppColors.bgDark,
      primaryColor: AppColors.neonCyan,
      colorScheme: const ColorScheme.dark(
        primary: AppColors.neonCyan,
        secondary: AppColors.neonPurple,
        surface: AppColors.surfaceDark,
        error: AppColors.danger,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.bgDark,
        elevation: 0,
        centerTitle: true,
        iconTheme: IconThemeData(color: AppColors.neonCyan),
        titleTextStyle: TextStyle(
          color: AppColors.textPrimary,
          fontSize: 20,
          fontWeight: FontWeight.bold,
          letterSpacing: 2,
        ),
      ),
      cardTheme: CardThemeData(
        color: AppColors.surfaceDark,
        elevation: 5,
        shadowColor: AppColors.neonCyan.withOpacity(0.1),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusLarge),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.neonCyan,
          foregroundColor: Colors.white,
          elevation: 5,
          shadowColor: AppColors.neonCyan.withOpacity(0.3),
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          ),
          textStyle: const TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.bold,
            letterSpacing: 1,
          ),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surfaceLight,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          borderSide: BorderSide(color: AppColors.neonCyan.withOpacity(0.2)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          borderSide: const BorderSide(color: AppColors.neonCyan, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          borderSide: const BorderSide(color: AppColors.danger, width: 2),
        ),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        hintStyle: const TextStyle(color: AppColors.textMuted),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.surfaceDark,
        contentTextStyle: const TextStyle(color: AppColors.textPrimary),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
        ),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  static ThemeData get lightTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: AppColors.bgLight,
      primaryColor: AppColors.neonCyan,
      colorScheme: const ColorScheme.light(
        primary: AppColors.neonCyan,
        secondary: AppColors.neonPurple,
        surface: AppColors.surfaceLightTheme,
        error: AppColors.danger,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.surfaceLightTheme,
        elevation: 0,
        centerTitle: true,
        iconTheme: IconThemeData(color: AppColors.neonCyan),
        titleTextStyle: TextStyle(
          color: AppColors.textPrimaryLight,
          fontSize: 20,
          fontWeight: FontWeight.bold,
          letterSpacing: 2,
        ),
      ),
      cardTheme: CardThemeData(
        color: AppColors.surfaceLightTheme,
        elevation: 3,
        shadowColor: Colors.black.withOpacity(0.08),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusLarge),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.neonCyan,
          foregroundColor: Colors.white,
          elevation: 3,
          shadowColor: AppColors.neonCyan.withOpacity(0.2),
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          ),
          textStyle: const TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.bold,
            letterSpacing: 1,
          ),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.bgLight,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          borderSide: BorderSide(color: AppColors.neonCyan.withOpacity(0.3)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          borderSide: const BorderSide(color: AppColors.neonCyan, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
          borderSide: const BorderSide(color: AppColors.danger, width: 2),
        ),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        hintStyle: const TextStyle(color: AppColors.textMutedLight),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.surfaceLightTheme,
        contentTextStyle: const TextStyle(color: AppColors.textPrimaryLight),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppSizes.borderRadiusMedium),
        ),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

// ==================== VALIDATION ====================
bool isValidPassword(String password) {
  final regex =
      RegExp(r'^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$');
  return regex.hasMatch(password);
}

bool isValidEmail(String email) {
  final regex = RegExp(r'^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$');
  return regex.hasMatch(email);
}

bool isValidPhone(String phone) {
  final regex = RegExp(r'^\+?[\d\s-]{10,}$');
  return regex.hasMatch(phone);
}

// ==================== APP CONSTANTS ====================
class AppConstants {
  // Backend URL
  static const String baseUrl = 'http://192.168.154.100:5000/api';

  // App Info
  static const String appName = 'LABSYNC';
  static const String appTagline = 'SMART ASSET TRACKING';
  static const String appVersion = '1.0.0';

  // Storage Keys
  static const String tokenKey = 'auth_token';
  static const String userIdKey = 'user_id';
  static const String userNameKey = 'user_name';
  static const String userEmailKey = 'user_email';
  static const String userRoleKey = 'user_role';
  static const String themeKey = 'is_dark_mode';
  static const String onboardingKey = 'onboarding_completed';

  // Limits
  static const int maxBorrowItems = 3;
  static const int maxFingerprints = 127;
  static const int passwordMinLength = 8;

  // Timeouts
  static const Duration apiTimeout = Duration(seconds: 10);
  static const Duration unlockDuration = Duration(seconds: 5);
  static const Duration commandCheckInterval = Duration(seconds: 3);

  // Routes
  static const String splashRoute = '/';
  static const String onboardingRoute = '/onboarding';
  static const String loginRoute = '/login';
  static const String registerRoute = '/register';
  static const String adminRoute = '/admin';
  static const String userRoute = '/user';
}
