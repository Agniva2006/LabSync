import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../widgets/neon_button.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _otpController = TextEditingController();
  final ApiService _apiService = ApiService();

  bool _isLoading = false;
  bool _isObscure = true;
  bool _rememberMe = false;
  bool _isOtpMode = false;
  bool _otpSent = false;
  String? _otpDebugCode;

  void _handleLogin() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    setState(() => _isLoading = true);

    try {
      print('🔐 Attempting login for: ${_emailController.text}');

      final result = await _apiService.login(
        _emailController.text.trim(),
        _passwordController.text.trim(),
      );

      setState(() => _isLoading = false);

      if (result['success'] == true) {
        final user = result['user'];

        // 🔍 DEBUG: Print user data received from backend
        print('✅ Login successful!');
        print('🔍 User data received: $user');
        print('🔍 User ID from backend: ${user['userId']}');
        print('🔍 User name: ${user['name']}');
        print('🔍 User role: ${user['role']}');

        // Set user data
        CurrentUser.setUser(user);

        // 🔍 DEBUG: Verify CurrentUser is set
        print('🔍 CurrentUser.userId after setUser: "${CurrentUser.userId}"');
        print('🔍 CurrentUser.name after setUser: "${CurrentUser.name}"');
        print('🔍 CurrentUser.role after setUser: "${CurrentUser.role}"');

        // Always save token and user data to SharedPreferences
        await _apiService.saveToken(result['token']);
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(AppConstants.userIdKey, user['userId'] ?? '');
        await prefs.setString(AppConstants.userNameKey, user['name'] ?? '');
        await prefs.setString(AppConstants.userEmailKey, user['email'] ?? '');
        await prefs.setString(AppConstants.userRoleKey, user['role'] ?? 'user');
        print('💾 User data persisted to SharedPreferences');

        if (!mounted) return;

        // Show success message
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Welcome back, ${user['name']}!'),
            backgroundColor: AppColors.success,
            behavior: SnackBarBehavior.floating,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
        );

        // Auto-redirect based on role
        final role = user['role'] ?? 'user';
        print('🚀 Redirecting to: ${role == 'admin' ? '/admin' : '/user'}');

        if (role == 'admin') {
          context.go('/admin');
        } else {
          context.go('/user');
        }
      } else {
        print('❌ Login failed: ${result['message']}');

        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(result['message'] ?? 'Login failed'),
            backgroundColor: AppColors.danger,
            behavior: SnackBarBehavior.floating,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
        );
      }
    } catch (e) {
      setState(() => _isLoading = false);
      print('❌ Login error: $e');

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Connection error: $e'),
          backgroundColor: AppColors.danger,
          behavior: SnackBarBehavior.floating,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      );
    }
  }

  void _handleSendOtp() async {
    final email = _emailController.text.trim();
    if (email.isEmpty || !email.contains('@')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Please enter a valid email address first'),
          backgroundColor: AppColors.warning,
        ),
      );
      return;
    }

    setState(() => _isLoading = true);
    final result = await _apiService.sendOTP(email);
    setState(() => _isLoading = false);

    if (result['success'] == true) {
      setState(() {
        _otpSent = true;
        _otpDebugCode = result['otpDebug'];
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(result['message'] ?? 'OTP sent to $email'),
          backgroundColor: AppColors.success,
        ),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(result['message'] ?? 'Failed to send OTP'),
          backgroundColor: AppColors.danger,
        ),
      );
    }
  }

  void _handleVerifyOtp() async {
    final email = _emailController.text.trim();
    final otp = _otpController.text.trim();

    if (otp.length < 6) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Please enter the 6-digit OTP code'),
          backgroundColor: AppColors.warning,
        ),
      );
      return;
    }

    setState(() => _isLoading = true);
    final result = await _apiService.verifyOTP(email: email, otp: otp);
    setState(() => _isLoading = false);

    if (result['success'] == true) {
      final user = result['user'];
      CurrentUser.setUser(user);
      await _apiService.saveToken(result['token']);

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(AppConstants.userIdKey, user['userId'] ?? '');
      await prefs.setString(AppConstants.userNameKey, user['name'] ?? '');
      await prefs.setString(AppConstants.userEmailKey, user['email'] ?? '');
      await prefs.setString(AppConstants.userRoleKey, user['role'] ?? 'user');

      if (!mounted) return;

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Welcome, ${user['name']}! OTP verified successfully.'),
          backgroundColor: AppColors.success,
        ),
      );

      final role = user['role'] ?? 'user';
      if (role == 'admin') {
        context.go('/admin');
      } else {
        context.go('/user');
      }
    } else {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(result['message'] ?? 'Invalid OTP'),
          backgroundColor: AppColors.danger,
        ),
      );
    }
  }

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _otpController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(color: AppColors.bgDark),
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 450),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Logo & Title
                  Column(
                    children: [
                      Image.asset(
                        'assets/images/iit_kgp_profile.png',
                        width: 100,
                        height: 100,
                        errorBuilder: (context, error, stackTrace) {
                          return const Icon(Icons.hexagon_outlined,
                              size: 64, color: AppColors.neonCyan);
                        },
                      )
                          .animate()
                          .scale(duration: 600.ms, curve: Curves.easeOutBack),
                      const SizedBox(height: 16),
                      Text(
                        'INDIAN INSTITUTE OF TECHNOLOGY KHARAGPUR',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: AppColors.neonCyan,
                          fontSize: 12,
                          letterSpacing: 2,
                          fontWeight: FontWeight.bold,
                        ),
                      ).animate().fade(delay: 400.ms, duration: 800.ms),
                      const SizedBox(height: 16),
                      Text(
                        'LABSYNC',
                        style: TextStyle(
                          fontFamily: 'Rajdhani',
                          fontSize: 36,
                          fontWeight: FontWeight.w800,
                          color: AppColors.textPrimary,
                          letterSpacing: 4,
                        ),
                      ).animate().fade(duration: 800.ms).slideY(begin: 0.2),
                      const SizedBox(height: 8),
                      Text(
                        'Smart Laboratory Access & Asset Tracking',
                        style: TextStyle(
                          color: AppColors.neonCyan,
                          fontSize: 14,
                          letterSpacing: 2,
                          fontWeight: FontWeight.w600,
                        ),
                      ).animate().fade(delay: 400.ms, duration: 800.ms),
                    ],
                  ),
                  const SizedBox(height: 40),

                  // Login Form
                  GlassCard(
                    padding: const EdgeInsets.all(32),
                    child: Form(
                      key: _formKey,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Text(
                            'SIGN IN TO YOUR ACCOUNT',
                            style: TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 12,
                              letterSpacing: 2,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 24),

                          Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              ChoiceChip(
                                label: const Text('PASSWORD'),
                                selected: !_isOtpMode,
                                selectedColor: AppColors.neonCyan.withOpacity(0.2),
                                labelStyle: TextStyle(
                                  color: !_isOtpMode ? AppColors.neonCyan : AppColors.textSecondary,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 11,
                                ),
                                onSelected: (sel) => setState(() => _isOtpMode = !sel),
                              ),
                              const SizedBox(width: 12),
                              ChoiceChip(
                                label: const Text('EMAIL OTP'),
                                selected: _isOtpMode,
                                selectedColor: AppColors.neonPurple.withOpacity(0.2),
                                labelStyle: TextStyle(
                                  color: _isOtpMode ? AppColors.neonPurple : AppColors.textSecondary,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 11,
                                ),
                                onSelected: (sel) => setState(() => _isOtpMode = sel),
                              ),
                            ],
                          ),
                          const SizedBox(height: 20),

                          // Email Field
                          TextFormField(
                            controller: _emailController,
                            style:
                                const TextStyle(color: AppColors.textPrimary),
                            keyboardType: TextInputType.emailAddress,
                            decoration: const InputDecoration(
                              labelText: 'EMAIL',
                              prefixIcon: Icon(Icons.email_outlined,
                                  color: AppColors.neonCyan),
                            ),
                            validator: (value) {
                              if (value == null || value.isEmpty) {
                                return 'Email is required';
                              }
                              if (!value.contains('@')) {
                                return 'Enter a valid email';
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 16),

                          // Password Mode Field
                          if (!_isOtpMode) ...[
                            TextFormField(
                              controller: _passwordController,
                              style:
                                  const TextStyle(color: AppColors.textPrimary),
                              obscureText: _isObscure,
                              decoration: InputDecoration(
                                labelText: 'PASSWORD',
                                prefixIcon: const Icon(Icons.lock_outline,
                                    color: AppColors.neonCyan),
                                suffixIcon: IconButton(
                                  icon: Icon(
                                    _isObscure
                                        ? Icons.visibility_off
                                        : Icons.visibility,
                                    color: AppColors.textMuted,
                                  ),
                                  onPressed: () =>
                                      setState(() => _isObscure = !_isObscure),
                                ),
                              ),
                              validator: (value) {
                                if (value == null || value.isEmpty) {
                                  return 'Password is required';
                                }
                                if (value.length < 6) {
                                  return 'Password must be at least 6 characters';
                                }
                                return null;
                              },
                            ),
                            const SizedBox(height: 16),
                          ],

                          // OTP Mode Fields
                          if (_isOtpMode) ...[
                            if (_otpSent) ...[
                              TextFormField(
                                controller: _otpController,
                                style: const TextStyle(color: AppColors.textPrimary, letterSpacing: 4, fontWeight: FontWeight.bold),
                                keyboardType: TextInputType.number,
                                maxLength: 6,
                                decoration: InputDecoration(
                                  labelText: '6-DIGIT OTP CODE',
                                  prefixIcon: const Icon(Icons.pin, color: AppColors.neonPurple),
                                  helperText: _otpDebugCode != null ? 'Demo OTP Code: $_otpDebugCode' : 'Check your inbox for 6-digit code',
                                  helperStyle: const TextStyle(color: AppColors.neonCyan, fontWeight: FontWeight.bold),
                                ),
                              ),
                              const SizedBox(height: 16),
                            ],
                          ],

                          // Remember Me Checkbox
                          Row(
                            children: [
                              SizedBox(
                                height: 24,
                                width: 24,
                                child: Checkbox(
                                  value: _rememberMe,
                                  onChanged: (value) {
                                    setState(() => _rememberMe = value!);
                                  },
                                  activeColor: AppColors.neonCyan,
                                  side: BorderSide(
                                      color:
                                          AppColors.neonCyan.withOpacity(0.5)),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Text(
                                'Remember me',
                                style: TextStyle(
                                    color: AppColors.textSecondary,
                                    fontSize: 12),
                              ),
                            ],
                          ),
                          const SizedBox(height: 24),

                          // Login Button
                          if (!_isOtpMode)
                            NeonButton(
                              text: 'LOGIN',
                              onPressed: _handleLogin,
                              isLoading: _isLoading,
                            ),
                          if (_isOtpMode && !_otpSent)
                            NeonButton(
                              text: 'SEND 6-DIGIT OTP',
                              onPressed: _handleSendOtp,
                              isLoading: _isLoading,
                            ),
                          if (_isOtpMode && _otpSent)
                            NeonButton(
                              text: 'VERIFY OTP & LOGIN',
                              onPressed: _handleVerifyOtp,
                              isLoading: _isLoading,
                            ),
                          const SizedBox(height: 24),

                          // Register Link
                          Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(
                                "Don't have an account? ",
                                style: TextStyle(
                                    color: AppColors.textMuted, fontSize: 12),
                              ),
                              GestureDetector(
                                onTap: () => context.go('/register'),
                                child: const Text(
                                  'REGISTER',
                                  style: TextStyle(
                                    color: AppColors.neonCyan,
                                    fontSize: 12,
                                    fontWeight: FontWeight.bold,
                                    letterSpacing: 1,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  )
                      .animate()
                      .fade(duration: 1000.ms, delay: 200.ms)
                      .slideY(begin: 0.1),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
