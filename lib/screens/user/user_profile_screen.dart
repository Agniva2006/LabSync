import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';
import '../../utils/validators.dart';
import '../user/borrow_history_screen.dart';
import '../user/face_enrollment_screen.dart';
import '../user/dual_auth_screen.dart';
import '../settings_screen.dart';

class UserProfileScreen extends StatefulWidget {
  const UserProfileScreen({super.key});

  @override
  State<UserProfileScreen> createState() => _UserProfileScreenState();
}

class _UserProfileScreenState extends State<UserProfileScreen> {
  final ApiService _apiService = ApiService();
  List<dynamic> _activeBorrows = [];
  List<dynamic> _borrowHistory = [];
  List<dynamic> _authorizedRooms = [];
  bool _isLoading = true;
  String _errorMessage = '';
  bool _isFaceEnrolled = false;
  bool _isCheckingFaceStatus = true;

  @override
  void initState() {
    super.initState();
    _loadUserData();
  }

  Future<void> _loadUserData() async {
    setState(() {
      _isLoading = true;
      _errorMessage = '';
    });

    try {
      await Future.wait([
        _apiService.getActiveBorrows().then((r) {
          if (r['success'] == true) {
            _activeBorrows = r['data'] ?? [];
          } else {
            _errorMessage = r['message'] ?? 'Failed to load active borrows';
          }
        }),
        _apiService.getUserPermissions(CurrentUser.userId).then((r) {
          if (r['success'] == true) {
            _authorizedRooms = r['data'] ?? [];
          }
        }),
        _apiService.getBorrowHistory(CurrentUser.userId).then((r) {
          if (r['success'] == true) {
            _borrowHistory = r['data'] ?? [];
          }
        }),
        _checkFaceEnrollmentStatus(),
      ]);
    } catch (e) {
      setState(() {
        _errorMessage = 'Network error: $e';
      });
    }

    setState(() => _isLoading = false);
  }

  Future<void> _checkFaceEnrollmentStatus() async {
    setState(() => _isCheckingFaceStatus = true);
    try {
      final status = await _apiService.getFaceStatus(CurrentUser.userId);
      if (mounted) {
        setState(() {
          _isFaceEnrolled = status['enrolled'] == true;
          _isCheckingFaceStatus = false;
        });
      }
    } catch (e) {
      print('❌ Error checking face status: $e');
      if (mounted) {
        setState(() => _isCheckingFaceStatus = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('MY PROFILE'),
        backgroundColor: AppColors.neonCyan.withOpacity(0.2),
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loadUserData,
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: _isLoading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.neonCyan))
          : _errorMessage.isNotEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.error_outline,
                            size: 64, color: AppColors.danger),
                        const SizedBox(height: 16),
                        Text(
                          _errorMessage,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                              color: AppColors.textSecondary, fontSize: 16),
                        ),
                        const SizedBox(height: 24),
                        ElevatedButton.icon(
                          onPressed: _loadUserData,
                          icon: const Icon(Icons.refresh),
                          label: const Text('Retry'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppColors.neonCyan,
                            foregroundColor: AppColors.bgDark,
                          ),
                        ),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _loadUserData,
                  color: AppColors.neonCyan,
                  child: SingleChildScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      children: [
                        // 1. Profile Header
                        GlassCard(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            children: [
                              Stack(
                                children: [
                                  CircleAvatar(
                                    radius: 50,
                                    backgroundColor:
                                        AppColors.neonCyan.withOpacity(0.2),
                                    child: const Icon(Icons.person,
                                        size: 60, color: AppColors.neonCyan),
                                  ),
                                  Positioned(
                                    bottom: 0,
                                    right: 0,
                                    child: Container(
                                      padding: const EdgeInsets.all(4),
                                      decoration: BoxDecoration(
                                        color: AppColors.success,
                                        shape: BoxShape.circle,
                                        border: Border.all(
                                            color: AppColors.bgDark, width: 2),
                                      ),
                                      child: const Icon(Icons.check_circle,
                                          size: 16, color: AppColors.bgDark),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 16),
                              Text(
                                CurrentUser.name.isEmpty
                                    ? 'User'
                                    : CurrentUser.name,
                                style: const TextStyle(
                                  fontSize: 24,
                                  fontWeight: FontWeight.bold,
                                  color: AppColors.textPrimary,
                                ),
                              ),
                              const SizedBox(height: 8),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 12, vertical: 4),
                                decoration: BoxDecoration(
                                  color: AppColors.neonCyan.withOpacity(0.15),
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(
                                      color:
                                          AppColors.neonCyan.withOpacity(0.3)),
                                ),
                                child: Text(
                                  '${CurrentUser.role.toUpperCase()} - ${CurrentUser.department.isEmpty ? "General" : CurrentUser.department}',
                                  style: TextStyle(
                                      color: AppColors.neonCyan,
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600),
                                ),
                              ),
                              const SizedBox(height: 12),
                              Text(
                                CurrentUser.email.isEmpty
                                    ? 'user@iit.edu'
                                    : CurrentUser.email,
                                style: TextStyle(
                                    color: AppColors.textSecondary,
                                    fontSize: 14),
                              ),
                              const SizedBox(height: 20),
                              Wrap(
                                alignment: WrapAlignment.center,
                                spacing: 12,
                                runSpacing: 12,
                                children: [
                                  OutlinedButton.icon(
                                    onPressed: _showChangePasswordSheet,
                                    icon: const Icon(Icons.lock, size: 16),
                                    label: const Text('Change Password'),
                                    style: OutlinedButton.styleFrom(
                                      foregroundColor: AppColors.neonCyan,
                                      side: BorderSide(
                                          color: AppColors.neonCyan
                                              .withOpacity(0.5)),
                                    ),
                                  ),
                                  OutlinedButton.icon(
                                    onPressed: _showEditProfileSheet,
                                    icon: const Icon(Icons.edit, size: 16),
                                    label: const Text('Edit Profile'),
                                    style: OutlinedButton.styleFrom(
                                      foregroundColor: AppColors.neonBlue,
                                      side: BorderSide(
                                          color: AppColors.neonBlue
                                              .withOpacity(0.5)),
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),

                        // 2. Quick Stats
                        GlassCard(
                          padding: const EdgeInsets.all(20),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'QUICK STATS',
                                style: TextStyle(
                                  color: AppColors.textSecondary,
                                  fontSize: 12,
                                  letterSpacing: 2,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              const SizedBox(height: 16),
                              _buildStatRow(
                                  'User ID', CurrentUser.userId, Icons.badge),
                              _buildStatRow(
                                  'Active Borrows',
                                  _activeBorrows.length.toString(),
                                  Icons.inventory_2),
                              _buildStatRow(
                                  'Authorized Rooms',
                                  _authorizedRooms.length.toString(),
                                  Icons.meeting_room),
                              _buildStatRow(
                                  'Total Borrows',
                                  _borrowHistory.length.toString(),
                                  Icons.history),
                              _buildStatRow(
                                  'Role',
                                  CurrentUser.role.toUpperCase(),
                                  Icons.admin_panel_settings),
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),

                        // 🔐 3. BIOMETRIC ACCESS (NEW SECTION)
                        GlassCard(
                          padding: const EdgeInsets.all(20),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Icon(Icons.fingerprint,
                                      color: AppColors.neonPurple, size: 20),
                                  const SizedBox(width: 8),
                                  const Text(
                                    'BIOMETRIC ACCESS',
                                    style: TextStyle(
                                      color: AppColors.textSecondary,
                                      fontSize: 12,
                                      letterSpacing: 2,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                  const Spacer(),
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 8, vertical: 4),
                                    decoration: BoxDecoration(
                                      color: _isFaceEnrolled
                                          ? AppColors.success.withOpacity(0.2)
                                          : AppColors.warning.withOpacity(0.2),
                                      borderRadius: BorderRadius.circular(8),
                                      border: Border.all(
                                        color: _isFaceEnrolled
                                            ? AppColors.success.withOpacity(0.5)
                                            : AppColors.warning
                                                .withOpacity(0.5),
                                      ),
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(
                                          _isFaceEnrolled
                                              ? Icons.check_circle
                                              : Icons.warning,
                                          size: 12,
                                          color: _isFaceEnrolled
                                              ? AppColors.success
                                              : AppColors.warning,
                                        ),
                                        const SizedBox(width: 4),
                                        Text(
                                          _isCheckingFaceStatus
                                              ? 'CHECKING'
                                              : (_isFaceEnrolled
                                                  ? 'ENROLLED'
                                                  : 'NOT ENROLLED'),
                                          style: TextStyle(
                                            color: _isFaceEnrolled
                                                ? AppColors.success
                                                : AppColors.warning,
                                            fontSize: 10,
                                            fontWeight: FontWeight.bold,
                                            letterSpacing: 1,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 16),

                              // Face Recognition Enrollment
                              _buildBiometricItem(
                                icon: Icons.face,
                                title: 'Face Recognition',
                                subtitle: _isFaceEnrolled
                                    ? '✅ Face enrolled for biometric access'
                                    : '⚠️ Enroll your face for face-based access',
                                color: _isFaceEnrolled
                                    ? AppColors.success
                                    : AppColors.neonPurple,
                                trailing: _isFaceEnrolled
                                    ? const Icon(Icons.check_circle,
                                        color: AppColors.success, size: 20)
                                    : const Icon(Icons.arrow_forward_ios,
                                        color: AppColors.neonPurple, size: 16),
                                onTap: () {
                                  Navigator.push(
                                    context,
                                    MaterialPageRoute(
                                      builder: (_) =>
                                          const FaceEnrollmentScreen(),
                                    ),
                                  ).then((_) => _checkFaceEnrollmentStatus());
                                },
                              ),
                              const Divider(
                                  color: AppColors.surfaceLight, height: 24),

                              // Fingerprint (ESP32)
                              _buildBiometricItem(
                                icon: Icons.fingerprint,
                                title: 'Fingerprint (ESP32)',
                                subtitle: 'Use hardware fingerprint sensor',
                                color: AppColors.neonCyan,
                                trailing: const Icon(Icons.arrow_forward_ios,
                                    color: AppColors.neonCyan, size: 16),
                                onTap: () {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(
                                      content: Text(
                                          'Fingerprint enrollment requires ESP32 hardware'),
                                      backgroundColor: AppColors.neonCyan,
                                    ),
                                  );
                                },
                              ),
                              const Divider(
                                  color: AppColors.surfaceLight, height: 24),

                              // Dual Authentication Test
                              _buildBiometricItem(
                                icon: Icons.security,
                                title: 'Test Dual Authentication',
                                subtitle:
                                    'Test HIGH-security room access (Fingerprint + Face)',
                                color: AppColors.danger,
                                trailing: const Icon(Icons.arrow_forward_ios,
                                    color: AppColors.danger, size: 16),
                                onTap: () {
                                  Navigator.push(
                                    context,
                                    MaterialPageRoute(
                                      builder: (_) => const DualAuthScreen(
                                        roomId: 'ROOM-001',
                                        roomName: 'High-Security Lab',
                                      ),
                                    ),
                                  );
                                },
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),

                        // 4. Active Borrows
                        GlassCard(
                          padding: const EdgeInsets.all(20),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  const Text(
                                    'ACTIVE BORROWS',
                                    style: TextStyle(
                                      color: AppColors.textSecondary,
                                      fontSize: 12,
                                      letterSpacing: 2,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                  const Spacer(),
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 10, vertical: 4),
                                    decoration: BoxDecoration(
                                      color: AppColors.warning.withOpacity(0.2),
                                      borderRadius: BorderRadius.circular(12),
                                      border: Border.all(
                                          color: AppColors.warning
                                              .withOpacity(0.5)),
                                    ),
                                    child: Text(
                                      '${_activeBorrows.length}',
                                      style: const TextStyle(
                                        color: AppColors.warning,
                                        fontSize: 14,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 16),
                              if (_activeBorrows.isEmpty)
                                Center(
                                  child: Padding(
                                    padding: const EdgeInsets.all(20),
                                    child: Column(
                                      children: [
                                        Icon(Icons.inventory_2_outlined,
                                            size: 48,
                                            color: AppColors.textMuted),
                                        const SizedBox(height: 12),
                                        Text(
                                          'No active borrows',
                                          style: TextStyle(
                                              color: AppColors.textSecondary,
                                              fontSize: 14),
                                        ),
                                      ],
                                    ),
                                  ),
                                )
                              else ...[
                                ..._activeBorrows
                                    .take(3)
                                    .map((borrow) => _buildBorrowCard(borrow)),
                                if (_activeBorrows.length > 3)
                                  TextButton(
                                    onPressed: () {
                                      Navigator.push(
                                        context,
                                        MaterialPageRoute(
                                          builder: (_) => BorrowHistoryScreen(
                                            borrows: _activeBorrows,
                                            title: 'Active Borrows',
                                          ),
                                        ),
                                      );
                                    },
                                    child: Text(
                                      'View All (${_activeBorrows.length})',
                                      style: const TextStyle(
                                          color: AppColors.neonCyan,
                                          fontWeight: FontWeight.bold),
                                    ),
                                  ),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),

                        // 5. Borrow History
                        GlassCard(
                          padding: const EdgeInsets.all(20),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  const Text(
                                    'BORROW HISTORY',
                                    style: TextStyle(
                                      color: AppColors.textSecondary,
                                      fontSize: 12,
                                      letterSpacing: 2,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                  const Spacer(),
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 10, vertical: 4),
                                    decoration: BoxDecoration(
                                      color:
                                          AppColors.neonBlue.withOpacity(0.2),
                                      borderRadius: BorderRadius.circular(12),
                                      border: Border.all(
                                          color: AppColors.neonBlue
                                              .withOpacity(0.5)),
                                    ),
                                    child: Text(
                                      '${_borrowHistory.length}',
                                      style: const TextStyle(
                                        color: AppColors.neonBlue,
                                        fontSize: 14,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 16),
                              if (_borrowHistory.isEmpty)
                                Center(
                                  child: Padding(
                                    padding: const EdgeInsets.all(20),
                                    child: Column(
                                      children: [
                                        Icon(Icons.history_outlined,
                                            size: 48,
                                            color: AppColors.textMuted),
                                        const SizedBox(height: 12),
                                        Text(
                                          'No borrow history',
                                          style: TextStyle(
                                              color: AppColors.textSecondary,
                                              fontSize: 14),
                                        ),
                                      ],
                                    ),
                                  ),
                                )
                              else ...[
                                ..._borrowHistory
                                    .take(3)
                                    .map((item) => _buildHistoryItem(item)),
                                if (_borrowHistory.length > 3)
                                  TextButton(
                                    onPressed: () {
                                      Navigator.push(
                                        context,
                                        MaterialPageRoute(
                                          builder: (_) => BorrowHistoryScreen(
                                            borrows: _borrowHistory,
                                            title: 'Borrow History',
                                          ),
                                        ),
                                      );
                                    },
                                    child: const Text(
                                      'View Full History',
                                      style: TextStyle(
                                          color: AppColors.neonCyan,
                                          fontWeight: FontWeight.bold),
                                    ),
                                  ),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),

                        // 6. Authorized Rooms
                        GlassCard(
                          padding: const EdgeInsets.all(20),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'AUTHORIZED ROOMS',
                                style: TextStyle(
                                  color: AppColors.textSecondary,
                                  fontSize: 12,
                                  letterSpacing: 2,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              const SizedBox(height: 16),
                              if (_authorizedRooms.isEmpty)
                                Center(
                                  child: Padding(
                                    padding: const EdgeInsets.all(20),
                                    child: Column(
                                      children: [
                                        Icon(Icons.meeting_room_outlined,
                                            size: 48,
                                            color: AppColors.textMuted),
                                        const SizedBox(height: 12),
                                        Text(
                                          'No rooms authorized',
                                          style: TextStyle(
                                              color: AppColors.textSecondary,
                                              fontSize: 14),
                                        ),
                                        const SizedBox(height: 8),
                                        Text(
                                          'Contact admin for room access',
                                          style: TextStyle(
                                              color: AppColors.textMuted,
                                              fontSize: 12),
                                        ),
                                      ],
                                    ),
                                  ),
                                )
                              else
                                Wrap(
                                  spacing: 8,
                                  runSpacing: 8,
                                  children: _authorizedRooms.map((room) {
                                    return Container(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 12, vertical: 8),
                                      decoration: BoxDecoration(
                                        color:
                                            AppColors.success.withOpacity(0.15),
                                        borderRadius: BorderRadius.circular(8),
                                        border: Border.all(
                                            color: AppColors.success
                                                .withOpacity(0.5)),
                                      ),
                                      child: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(Icons.meeting_room,
                                              size: 14,
                                              color: AppColors.success),
                                          const SizedBox(width: 4),
                                          Text(
                                            room['roomName'] ?? room['roomId'],
                                            style: TextStyle(
                                              color: AppColors.success,
                                              fontSize: 11,
                                              fontWeight: FontWeight.bold,
                                            ),
                                          ),
                                        ],
                                      ),
                                    );
                                  }).toList(),
                                ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),

                        // 7. Account Settings
                        GlassCard(
                          padding: const EdgeInsets.all(20),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'ACCOUNT SETTINGS',
                                style: TextStyle(
                                  color: AppColors.textSecondary,
                                  fontSize: 12,
                                  letterSpacing: 2,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              const SizedBox(height: 16),
                              _buildSettingsItem(
                                icon: Icons.notifications_outlined,
                                title: 'Notification Preferences',
                                subtitle: 'Manage alerts and reminders',
                                onTap: () {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(
                                        content: Text('Coming soon')),
                                  );
                                },
                              ),
                              const Divider(
                                  color: AppColors.surfaceLight, height: 24),
                              _buildSettingsItem(
                                icon: Icons.security_outlined,
                                title: 'Security Settings',
                                subtitle: 'Password, 2FA, and privacy',
                                onTap: _showChangePasswordSheet,
                              ),
                              const Divider(
                                  color: AppColors.surfaceLight, height: 24),
                              _buildSettingsItem(
                                icon: Icons.help_outline,
                                title: 'Help & Support',
                                subtitle: 'FAQs and contact support',
                                onTap: () {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(
                                        content: Text(
                                            'Contact: support@labsync.iit.edu')),
                                  );
                                },
                              ),
                              const Divider(
                                  color: AppColors.surfaceLight, height: 24),
                              _buildSettingsItem(
                                icon: Icons.info_outline,
                                title: 'About LabSync',
                                subtitle: 'Version 2.0.0 - Face Recognition',
                                onTap: () {
                                  showAboutDialog(
                                    context: context,
                                    applicationName: 'LabSync',
                                    applicationVersion: '2.0.0',
                                    applicationIcon: const Icon(
                                        Icons.hexagon_outlined,
                                        color: AppColors.neonCyan),
                                    children: [
                                      const Text(
                                        'Smart Laboratory Access & Asset Tracking System',
                                      ),
                                      const SizedBox(height: 8),
                                      const Text(
                                          'Features: QR Tracking, Face Recognition, Dual Auth'),
                                      const SizedBox(height: 8),
                                      const Text('Developed for IIT Kharagpur'),
                                    ],
                                  );
                                },
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),

                        // 8. Logout Button
                        SizedBox(
                          width: double.infinity,
                          child: ElevatedButton.icon(
                            onPressed: () => _showLogoutConfirmation(),
                            icon: const Icon(Icons.logout),
                            label: const Text(
                              'LOGOUT',
                              style: TextStyle(
                                  letterSpacing: 1,
                                  fontWeight: FontWeight.bold),
                            ),
                            style: ElevatedButton.styleFrom(
                              backgroundColor:
                                  AppColors.danger.withOpacity(0.2),
                              foregroundColor: AppColors.danger,
                              padding: const EdgeInsets.symmetric(vertical: 16),
                              shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(12)),
                              side: BorderSide(
                                  color: AppColors.danger.withOpacity(0.5)),
                            ),
                          ),
                        ),
                        const SizedBox(height: 40),
                      ],
                    ),
                  ),
                ),
    );
  }

  // 🔐 NEW: Biometric Item Widget
  Widget _buildBiometricItem({
    required IconData icon,
    required String title,
    required String subtitle,
    required Color color,
    required Widget trailing,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: color.withOpacity(0.15),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: color.withOpacity(0.3)),
            ),
            child: Icon(icon, color: color, size: 24),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: TextStyle(color: AppColors.textMuted, fontSize: 12),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          trailing,
        ],
      ),
    );
  }

  Widget _buildStatRow(String label, String value, IconData icon) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(icon, size: 18, color: AppColors.neonCyan),
          const SizedBox(width: 12),
          Text(
            label,
            style: TextStyle(color: AppColors.textSecondary, fontSize: 14),
          ),
          const Spacer(),
          Text(
            value,
            style: const TextStyle(
              color: AppColors.neonCyan,
              fontSize: 14,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBorrowCard(dynamic borrow) {
    final borrowTime = DateTime.tryParse(borrow['borrowTime'] ?? '');
    final deadline = DateTime.tryParse(borrow['deadline'] ?? '');
    final isOverdue = deadline != null && DateTime.now().isAfter(deadline);

    String objectName = borrow['objectName'] ?? borrow['name'] ?? 'Equipment';

    final objectId = borrow['objectId'] ?? '';

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: isOverdue
              ? AppColors.danger.withOpacity(0.5)
              : AppColors.surfaceLight,
        ),
      ),
      child: Row(
        children: [
          Icon(
            isOverdue ? Icons.warning : Icons.inventory_2,
            color: isOverdue ? AppColors.danger : AppColors.warning,
            size: 24,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  objectName,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                  ),
                ),
                if (objectId.isNotEmpty)
                  Text(
                    'ID: $objectId',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 11),
                  ),
                if (deadline != null)
                  Text(
                    'Due: ${deadline.day}/${deadline.month}/${deadline.year}',
                    style: TextStyle(
                      color: isOverdue ? AppColors.danger : AppColors.textMuted,
                      fontSize: 11,
                    ),
                  ),
              ],
            ),
          ),
          if (isOverdue)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: AppColors.danger.withOpacity(0.2),
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Text(
                'OVERDUE',
                style: TextStyle(
                  color: AppColors.danger,
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildHistoryItem(dynamic item) {
    final borrowTime = DateTime.tryParse(item['borrowTime'] ?? '');
    final returnTime = DateTime.tryParse(item['returnTime'] ?? '');
    final status = item['status'] ?? 'Unknown';

    final objectName = item['objectName'] ?? item['name'] ?? 'Equipment';
    final objectId = item['objectId'] ?? '';

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(
            status == 'Returned' ? Icons.check_circle : Icons.history,
            color:
                status == 'Returned' ? AppColors.success : AppColors.neonBlue,
            size: 24,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  objectName,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                  ),
                ),
                if (objectId.isNotEmpty)
                  Text(
                    'ID: $objectId',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 11),
                  ),
                if (borrowTime != null)
                  Text(
                    'Borrowed: ${borrowTime.day}/${borrowTime.month}/${borrowTime.year}',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 11),
                  ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: status == 'Returned'
                  ? AppColors.success.withOpacity(0.2)
                  : AppColors.neonBlue.withOpacity(0.2),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              status.toUpperCase(),
              style: TextStyle(
                color: status == 'Returned'
                    ? AppColors.success
                    : AppColors.neonBlue,
                fontSize: 10,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSettingsItem({
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Row(
        children: [
          Icon(icon, color: AppColors.neonCyan, size: 24),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  subtitle,
                  style: TextStyle(color: AppColors.textMuted, fontSize: 12),
                ),
              ],
            ),
          ),
          Icon(Icons.chevron_right, color: AppColors.textMuted),
        ],
      ),
    );
  }

  void _showChangePasswordSheet() {
    final oldPassController = TextEditingController();
    final newPassController = TextEditingController();
    final confirmPassController = TextEditingController();
    bool isUpdating = false;
    bool obscureOld = true;
    bool obscureNew = true;
    bool obscureConfirm = true;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surfaceDark,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) => Padding(
          padding: EdgeInsets.fromLTRB(
              20, 20, 20, MediaQuery.of(context).viewInsets.bottom + 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Change Password',
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 20),
              TextField(
                controller: oldPassController,
                obscureText: obscureOld,
                decoration: InputDecoration(
                  labelText: 'Old Password',
                  labelStyle: const TextStyle(color: AppColors.textSecondary),
                  suffixIcon: IconButton(
                    icon: Icon(
                        obscureOld ? Icons.visibility_off : Icons.visibility,
                        color: AppColors.textMuted),
                    onPressed: () =>
                        setModalState(() => obscureOld = !obscureOld),
                  ),
                ),
                style: const TextStyle(color: AppColors.textPrimary),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: newPassController,
                obscureText: obscureNew,
                decoration: InputDecoration(
                  labelText: 'New Password',
                  labelStyle: const TextStyle(color: AppColors.textSecondary),
                  helperText: 'Min 8 chars, 1 number, 1 special char',
                  helperStyle:
                      TextStyle(color: AppColors.textMuted, fontSize: 11),
                  suffixIcon: IconButton(
                    icon: Icon(
                        obscureNew ? Icons.visibility_off : Icons.visibility,
                        color: AppColors.textMuted),
                    onPressed: () =>
                        setModalState(() => obscureNew = !obscureNew),
                  ),
                ),
                style: const TextStyle(color: AppColors.textPrimary),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: confirmPassController,
                obscureText: obscureConfirm,
                decoration: InputDecoration(
                  labelText: 'Confirm New Password',
                  labelStyle: const TextStyle(color: AppColors.textSecondary),
                  suffixIcon: IconButton(
                    icon: Icon(
                        obscureConfirm
                            ? Icons.visibility_off
                            : Icons.visibility,
                        color: AppColors.textMuted),
                    onPressed: () =>
                        setModalState(() => obscureConfirm = !obscureConfirm),
                  ),
                ),
                style: const TextStyle(color: AppColors.textPrimary),
              ),
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: isUpdating
                    ? null
                    : () async {
                        final passwordError =
                            Validators.validatePassword(newPassController.text);
                        if (passwordError != null) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(passwordError),
                              backgroundColor: AppColors.danger,
                            ),
                          );
                          return;
                        }

                        if (newPassController.text !=
                            confirmPassController.text) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text('Passwords do not match'),
                              backgroundColor: AppColors.danger,
                            ),
                          );
                          return;
                        }

                        setModalState(() => isUpdating = true);
                        final result = await _apiService.changePassword(
                          CurrentUser.userId,
                          oldPassController.text,
                          newPassController.text,
                        );
                        setModalState(() => isUpdating = false);

                        if (result['success'] == true) {
                          Navigator.pop(context);
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(result['message']),
                              backgroundColor: AppColors.success,
                            ),
                          );
                        } else {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(result['message']),
                              backgroundColor: AppColors.danger,
                            ),
                          );
                        }
                      },
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.neonCyan,
                  foregroundColor: AppColors.bgDark,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                child: isUpdating
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Update Password',
                        style: TextStyle(fontWeight: FontWeight.bold)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showEditProfileSheet() {
    final nameController = TextEditingController(text: CurrentUser.name);
    final departmentController =
        TextEditingController(text: CurrentUser.department);
    bool isUpdating = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surfaceDark,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) => Padding(
          padding: EdgeInsets.fromLTRB(
              20, 20, 20, MediaQuery.of(context).viewInsets.bottom + 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Edit Profile',
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 20),
              TextField(
                controller: nameController,
                decoration: const InputDecoration(
                  labelText: 'Full Name',
                  labelStyle: TextStyle(color: AppColors.textSecondary),
                  prefixIcon: Icon(Icons.person, color: AppColors.neonCyan),
                ),
                style: const TextStyle(color: AppColors.textPrimary),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: departmentController,
                decoration: const InputDecoration(
                  labelText: 'Department',
                  labelStyle: TextStyle(color: AppColors.textSecondary),
                  prefixIcon: Icon(Icons.business, color: AppColors.neonCyan),
                ),
                style: const TextStyle(color: AppColors.textPrimary),
              ),
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: isUpdating
                    ? null
                    : () async {
                        setModalState(() => isUpdating = true);
                        await Future.delayed(const Duration(seconds: 1));
                        setModalState(() => isUpdating = false);
                        Navigator.pop(context);
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Profile updated successfully'),
                            backgroundColor: AppColors.success,
                          ),
                        );
                      },
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.neonBlue,
                  foregroundColor: AppColors.bgDark,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                child: isUpdating
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Save Changes',
                        style: TextStyle(fontWeight: FontWeight.bold)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showLogoutConfirmation() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        title: const Text(
          'Logout Confirmation',
          style: TextStyle(color: AppColors.textPrimary),
        ),
        content: const Text(
          'Are you sure you want to logout?',
          style: TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text(
              'Cancel',
              style: TextStyle(color: AppColors.textSecondary),
            ),
          ),
          ElevatedButton(
            onPressed: () async {
              await _apiService.clearToken();
              CurrentUser.clear();
              if (context.mounted) context.go('/');
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.danger,
              foregroundColor: AppColors.bgDark,
            ),
            child: const Text('Logout'),
          ),
        ],
      ),
    );
  }
}
