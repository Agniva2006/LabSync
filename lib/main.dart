import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'core/constants.dart';
import 'core/current_user.dart';
import 'core/globals.dart';
import 'services/api_service.dart';
import 'screens/splash_screen.dart';
import 'screens/onboarding_screen.dart';
import 'screens/auth/login_screen.dart';
import 'screens/auth/register_screen.dart';
import 'screens/user/user_dashboard.dart';
import 'screens/admin/admin_dashboard.dart';

final ApiService _apiService = ApiService();

// ==================== THEME PROVIDER ====================
final themeProvider = StateNotifierProvider<ThemeNotifier, ThemeState>(
  (ref) => ThemeNotifier(),
);

class ThemeState {
  final bool isDarkMode;

  ThemeState({this.isDarkMode = true});

  ThemeState copyWith({bool? isDarkMode}) {
    return ThemeState(isDarkMode: isDarkMode ?? this.isDarkMode);
  }
}

class ThemeNotifier extends StateNotifier<ThemeState> {
  ThemeNotifier() : super(ThemeState()) {
    _loadThemePreference();
  }

  Future<void> _loadThemePreference() async {
    final prefs = await SharedPreferences.getInstance();
    final isDark = prefs.getBool(AppConstants.themeKey) ?? true;
    state = ThemeState(isDarkMode: isDark);
  }

  Future<void> toggleTheme(bool isDark) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(AppConstants.themeKey, isDark);
    state = ThemeState(isDarkMode: isDark);
  }
}

// ==================== ROUTER CONFIGURATION ====================
final GoRouter _router = GoRouter(
  navigatorKey: rootNavigatorKey,
  initialLocation: '/',
  redirect: (context, state) async {
    final prefs = await SharedPreferences.getInstance();
    final onboardingCompleted =
        prefs.getBool(AppConstants.onboardingKey) ?? false;
    final token = await _apiService.getToken();
    final isLoggedIn = token != null && token.isNotEmpty;

    final currentPath = state.matchedLocation;

    // Public routes that don't need authentication
    final publicRoutes = ['/', '/onboarding', '/login', '/register'];
    final isPublicRoute = publicRoutes.contains(currentPath);

    // If onboarding not completed and not on onboarding page, redirect to onboarding
    if (!onboardingCompleted &&
        currentPath != '/onboarding' &&
        currentPath != '/') {
      return '/onboarding';
    }

    // If not logged in and trying to access protected route, redirect to login
    if (!isLoggedIn && !isPublicRoute) {
      return '/login';
    }

    // If logged in and on login/register/onboarding page, redirect based on role
    if (isLoggedIn &&
        (currentPath == '/login' ||
            currentPath == '/register' ||
            currentPath == '/onboarding')) {
      final role = CurrentUser.role;
      if (role == 'admin') {
        return '/admin';
      } else {
        return '/user';
      }
    }

    return null;
  },
  routes: [
    GoRoute(
      path: '/',
      name: 'splash',
      builder: (context, state) => const SplashScreen(),
    ),
    GoRoute(
      path: '/onboarding',
      name: 'onboarding',
      builder: (context, state) => const OnboardingScreen(),
    ),
    GoRoute(
      path: '/login',
      name: 'login',
      builder: (context, state) => const LoginScreen(),
    ),
    GoRoute(
      path: '/register',
      name: 'register',
      builder: (context, state) => const RegisterScreen(),
    ),
    GoRoute(
      path: '/user',
      name: 'user',
      builder: (context, state) => const UserDashboard(),
    ),
    GoRoute(
      path: '/admin',
      name: 'admin',
      builder: (context, state) => const AdminDashboard(),
    ),
  ],
);

// ==================== MAIN FUNCTION ====================
void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Lock to portrait mode
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  // Check for existing token and auto-login
  final token = await _apiService.getToken();
  if (token != null && token.isNotEmpty) {
    print('✅ Auto-login: Token found');
  }

  runApp(
    const ProviderScope(
      child: LabSyncApp(),
    ),
  );
}

// ==================== APP WIDGET ====================
class LabSyncApp extends ConsumerWidget {
  const LabSyncApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeState = ref.watch(themeProvider);

    return MaterialApp.router(
      title: AppConstants.appName,
      debugShowCheckedModeBanner: false,
      theme: themeState.isDarkMode ? AppTheme.darkTheme : AppTheme.lightTheme,
      routerConfig: _router,
    );
  }
}
