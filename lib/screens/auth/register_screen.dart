import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../widgets/neon_button.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmPasswordController = TextEditingController();
  final _departmentController = TextEditingController();
  final ApiService _apiService = ApiService();

  bool _isLoading = false;
  bool _isObscure = true;
  bool _isConfirmObscure = true;
  String _selectedRole = 'user';

  void _handleRegister() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    setState(() => _isLoading = true);

    try {
      print('📝 Attempting registration for: ${_emailController.text}');

      final result = await _apiService.register(
        _nameController.text.trim(),
        _emailController.text.trim(),
        _passwordController.text, // Don't trim password
        _departmentController.text.trim(),
        role: _selectedRole,
      );

      setState(() => _isLoading = false);

      if (result['success'] == true) {
        final user = result['user'];

        // 🔍 DEBUG: Print user data received from backend
        print('✅ Registration successful!');
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

        // ✅ Save token and user data for session persistence
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
            content: Text('Welcome to LabSync, ${user['name']}!'),
            backgroundColor: AppColors.success,
            behavior: SnackBarBehavior.floating,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
        );

        // Navigate to user dashboard
        print('🚀 Redirecting to: /user');
        context.go('/user');
      } else {
        print('❌ Registration failed: ${result['message']}');

        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(result['message'] ?? 'Registration failed'),
            backgroundColor: AppColors.danger,
            behavior: SnackBarBehavior.floating,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
        );
      }
    } catch (e) {
      setState(() => _isLoading = false);
      print('❌ Registration error: $e');

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

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    _confirmPasswordController.dispose();
    _departmentController.dispose();
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
                  Column(
                    children: [
                      const Icon(Icons.hexagon_outlined,
                              size: 64, color: AppColors.neonCyan)
                          .animate()
                          .scale(duration: 600.ms, curve: Curves.easeOutBack)
                          .then()
                          .shimmer(
                              duration: 2000.ms, color: AppColors.neonCyan),
                      const SizedBox(height: 16),
                      Text(
                        'CREATE ACCOUNT',
                        style: TextStyle(
                          fontFamily: 'Rajdhani',
                          fontSize: 32,
                          fontWeight: FontWeight.w800,
                          color: AppColors.textPrimary,
                          letterSpacing: 4,
                        ),
                      ).animate().fade(duration: 800.ms).slideY(begin: 0.2),
                      const SizedBox(height: 8),
                      Text(
                        'Join LabSync System',
                        style: TextStyle(
                          color: AppColors.neonCyan,
                          fontSize: 14,
                          letterSpacing: 2,
                          fontWeight: FontWeight.w600,
                        ),
                      ).animate().fade(delay: 400.ms, duration: 800.ms),
                    ],
                  ),
                  const SizedBox(height: 32),
                  GlassCard(
                    padding: const EdgeInsets.all(32),
                    child: Form(
                      key: _formKey,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Text(
                            'USER REGISTRATION',
                            style: TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 12,
                              letterSpacing: 2,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 24),

                          // Full Name Field
                          TextFormField(
                            controller: _nameController,
                            style:
                                const TextStyle(color: AppColors.textPrimary),
                            decoration: const InputDecoration(
                              labelText: 'FULL NAME',
                              prefixIcon: Icon(Icons.person_outline,
                                  color: AppColors.neonCyan),
                            ),
                            validator: (value) {
                              if (value == null || value.isEmpty) {
                                return 'Full name is required';
                              }
                              if (value.trim().length < 2) {
                                return 'Name must be at least 2 characters';
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 16),

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
                              if (!isValidEmail(value)) {
                                return 'Enter a valid email address';
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 16),

                          // Department Field
                          TextFormField(
                            controller: _departmentController,
                            style:
                                const TextStyle(color: AppColors.textPrimary),
                            decoration: const InputDecoration(
                              labelText: 'DEPARTMENT',
                              prefixIcon: Icon(Icons.business_outlined,
                                  color: AppColors.neonCyan),
                              hintText: 'e.g., Computer Science',
                            ),
                            validator: (value) {
                              if (value == null || value.isEmpty) {
                                return 'Department is required';
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 16),

                          // Account Role Selection
                          const Text(
                            'ACCOUNT ROLE',
                            style: TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 10,
                              letterSpacing: 1.5,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Row(
                            children: [
                              Expanded(
                                child: ChoiceChip(
                                  label: const Text('USER'),
                                  selected: _selectedRole == 'user',
                                  selectedColor: AppColors.neonCyan.withOpacity(0.2),
                                  labelStyle: TextStyle(
                                    color: _selectedRole == 'user'
                                        ? AppColors.neonCyan
                                        : AppColors.textSecondary,
                                    fontWeight: FontWeight.bold,
                                  ),
                                  onSelected: (val) {
                                    if (val) setState(() => _selectedRole = 'user');
                                  },
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: ChoiceChip(
                                  label: const Text('ADMIN'),
                                  selected: _selectedRole == 'admin',
                                  selectedColor: AppColors.neonPurple.withOpacity(0.2),
                                  labelStyle: TextStyle(
                                    color: _selectedRole == 'admin'
                                        ? AppColors.neonPurple
                                        : AppColors.textSecondary,
                                    fontWeight: FontWeight.bold,
                                  ),
                                  onSelected: (val) {
                                    if (val) setState(() => _selectedRole = 'admin');
                                  },
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 16),

                          // Password Field
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
                              helperText:
                                  'Min 8 chars, 1 letter, 1 number, 1 special char',
                              helperStyle: const TextStyle(
                                color: AppColors.textMuted,
                                fontSize: 11,
                              ),
                            ),
                            validator: (value) {
                              if (value == null || value.isEmpty) {
                                return 'Password is required';
                              }
                              if (value.length < 8) {
                                return 'Password must be at least 8 characters';
                              }
                              if (!isValidPassword(value)) {
                                return 'Password must contain letters, numbers, and special characters';
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 16),

                          // Confirm Password Field
                          TextFormField(
                            controller: _confirmPasswordController,
                            style:
                                const TextStyle(color: AppColors.textPrimary),
                            obscureText: _isConfirmObscure,
                            decoration: InputDecoration(
                              labelText: 'CONFIRM PASSWORD',
                              prefixIcon: const Icon(Icons.lock_outline,
                                  color: AppColors.neonCyan),
                              suffixIcon: IconButton(
                                icon: Icon(
                                  _isConfirmObscure
                                      ? Icons.visibility_off
                                      : Icons.visibility,
                                  color: AppColors.textMuted,
                                ),
                                onPressed: () => setState(() =>
                                    _isConfirmObscure = !_isConfirmObscure),
                              ),
                            ),
                            validator: (value) {
                              if (value == null || value.isEmpty) {
                                return 'Please confirm your password';
                              }
                              if (value != _passwordController.text) {
                                return 'Passwords do not match';
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 32),

                          // Register Button
                          NeonButton(
                            text: 'CREATE ACCOUNT',
                            icon: Icons.person_add,
                            isLoading: _isLoading,
                            onPressed: _handleRegister,
                          ),
                          const SizedBox(height: 24),

                          // Login Link
                          Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(
                                'Already have an account? ',
                                style: TextStyle(
                                    color: AppColors.textMuted, fontSize: 12),
                              ),
                              GestureDetector(
                                onTap: () => context.go('/'),
                                child: const Text(
                                  'LOGIN',
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
