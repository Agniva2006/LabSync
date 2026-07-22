import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../core/constants.dart';
import '../core/current_user.dart';
import '../services/api_service.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  final ApiService _apiService = ApiService();

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    );

    _controller.forward();

    // Restore user session and navigate
    _initializeAndNavigate();
  }

  Future<void> _initializeAndNavigate() async {
    // Let animation play for at least 2 seconds
    await Future.delayed(const Duration(milliseconds: 2000));

    if (!mounted) return;

    try {
      final prefs = await SharedPreferences.getInstance();
      final token = await _apiService.getToken();
      final onboardingDone = prefs.getBool(AppConstants.onboardingKey) ?? false;

      if (!onboardingDone) {
        if (mounted) context.go('/onboarding');
        return;
      }

      if (token == null || token.isEmpty) {
        if (mounted) context.go('/login');
        return;
      }

      // Token exists — restore user data from SharedPreferences first (fast)
      final savedUserId = prefs.getString(AppConstants.userIdKey) ?? '';
      final savedName = prefs.getString(AppConstants.userNameKey) ?? '';
      final savedEmail = prefs.getString(AppConstants.userEmailKey) ?? '';
      final savedRole = prefs.getString(AppConstants.userRoleKey) ?? 'user';

      if (savedUserId.isNotEmpty) {
        CurrentUser.setUser({
          'userId': savedUserId,
          'name': savedName,
          'email': savedEmail,
          'role': savedRole,
        });
        print('✅ Restored CurrentUser from SharedPreferences: $savedName ($savedRole)');
      }

      // Validate token with backend and get fresh data
      try {
        final meResult = await _apiService.getMe();
        if (meResult['success'] == true && meResult['user'] != null) {
          final user = meResult['user'];
          CurrentUser.setUser(user);

          // Persist refreshed data
          await prefs.setString(AppConstants.userIdKey, user['userId'] ?? '');
          await prefs.setString(AppConstants.userNameKey, user['name'] ?? '');
          await prefs.setString(AppConstants.userEmailKey, user['email'] ?? '');
          await prefs.setString(AppConstants.userRoleKey, user['role'] ?? 'user');

          print('✅ CurrentUser refreshed from /api/auth/me: ${user['name']} (${user['role']})');
        }
      } catch (e) {
        print('⚠️ Could not refresh user from API (using cached data): $e');
        // Continue with cached data — don't block the user
      }

      if (!mounted) return;

      // Navigate based on role
      if (CurrentUser.role == 'admin') {
        context.go('/admin');
      } else {
        context.go('/user');
      }
    } catch (e) {
      print('❌ Splash init error: $e');
      if (mounted) context.go('/login');
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // Logo
            Container(
              width: 150,
              height: 150,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [AppColors.neonCyan, AppColors.neonPurple],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(30),
                boxShadow: [
                  BoxShadow(
                    color: AppColors.neonCyan.withOpacity(0.5),
                    blurRadius: 30,
                    spreadRadius: 5,
                  ),
                ],
              ),
              child: Icon(
                Icons.science_rounded,
                size: 80,
                color: Colors.white,
              ),
            )
                .animate(controller: _controller)
                .scale(duration: 800.ms, curve: Curves.elasticOut)
                .then()
                .shimmer(duration: 1500.ms),

            const SizedBox(height: 30),

            ShaderMask(
              shaderCallback: (bounds) => const LinearGradient(
                colors: [AppColors.neonCyan, AppColors.neonPurple],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ).createShader(bounds),
              child: const Text(
                'LABSYNC',
                style: TextStyle(
                  fontSize: 42,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 4,
                  color: Colors.white,
                ),
              ),
            )
                .animate(controller: _controller)
                .fadeIn(delay: 400.ms, duration: 600.ms)
                .slideY(begin: 0.3, end: 0),

            const SizedBox(height: 10),

            // Tagline
            Text(
              'Smart Laboratory Management',
              style: TextStyle(
                fontSize: 16,
                color: AppColors.textSecondary,
                letterSpacing: 2,
              ),
            )
                .animate(controller: _controller)
                .fadeIn(delay: 800.ms, duration: 600.ms),

            const SizedBox(height: 50),

            // Loading indicator
            CircularProgressIndicator(
              valueColor: AlwaysStoppedAnimation<Color>(AppColors.neonCyan),
            ).animate(controller: _controller).fadeIn(delay: 1200.ms),
          ],
        ),
      ),
    );
  }
}
