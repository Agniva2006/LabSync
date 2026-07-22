import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';
import '../../utils/validators.dart';
import 'users_list_screen.dart';
import 'equipment_list_screen.dart';
import 'bulk_import_screen.dart';
import '../settings_screen.dart';

class AdminProfileScreen extends StatefulWidget {
  const AdminProfileScreen({super.key});

  @override
  State<AdminProfileScreen> createState() => _AdminProfileScreenState();
}

class _AdminProfileScreenState extends State<AdminProfileScreen> {
  final ApiService _apiService = ApiService();
  Map<String, dynamic> _stats = {};
  List<dynamic> _allEquipment = [];
  List<dynamic> _users = [];
  List<dynamic> _rooms = [];
  List<dynamic> _logs = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _isLoading = true);

    await Future.wait([
      _apiService.getAdminStats().then((r) {
        if (r['success'] == true) _stats = r['data'] ?? {};
      }),
      _apiService.getAdminEquipment().then((r) {
        if (r['success'] == true) _allEquipment = r['data'] ?? [];
      }),
      _apiService.getAdminUsers().then((r) {
        if (r['success'] == true) _users = r['data'] ?? [];
      }),
      _apiService.getRooms().then((r) {
        if (r['success'] == true) _rooms = r['data'] ?? [];
      }),
      _apiService.getAdminLogs().then((r) {
        if (r['success'] == true) _logs = r['data'] ?? [];
      }),
    ]);

    setState(() => _isLoading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('ADMIN PROFILE'),
        backgroundColor: AppColors.neonPurple.withOpacity(0.2),
        elevation: 0,
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _loadData),
        ],
      ),
      body: _isLoading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.neonCyan))
          : SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  // 1. Profile Header
                  GlassCard(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      children: [
                        CircleAvatar(
                          radius: 50,
                          backgroundColor:
                              AppColors.neonPurple.withOpacity(0.2),
                          child: const Icon(Icons.admin_panel_settings,
                              size: 60, color: AppColors.neonPurple),
                        ),
                        const SizedBox(height: 16),
                        Text(
                          CurrentUser.name.isEmpty
                              ? 'Administrator'
                              : CurrentUser.name,
                          style: const TextStyle(
                              fontSize: 24,
                              fontWeight: FontWeight.bold,
                              color: AppColors.textPrimary),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '${CurrentUser.role.toUpperCase()} - ${CurrentUser.department.isEmpty ? "Administration" : CurrentUser.department}',
                          style: TextStyle(
                              color: AppColors.textSecondary, fontSize: 14),
                        ),
                        const SizedBox(height: 16),
                        Text(
                          CurrentUser.email.isEmpty
                              ? 'admin@iit.edu'
                              : CurrentUser.email,
                          style: TextStyle(
                              color: AppColors.neonCyan, fontSize: 14),
                        ),
                        const SizedBox(height: 16),
                        OutlinedButton.icon(
                          onPressed: _showEditProfileSheet,
                          icon: const Icon(Icons.edit, size: 16),
                          label: const Text('Change Password'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.neonCyan,
                            side: BorderSide(
                                color: AppColors.neonCyan.withOpacity(0.5)),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),

                  // 2. Admin Controls (Navigation)
                  GlassCard(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('ADMIN CONTROLS',
                            style: TextStyle(
                                color: AppColors.textSecondary,
                                fontSize: 12,
                                letterSpacing: 2,
                                fontWeight: FontWeight.bold)),
                        const SizedBox(height: 16),

                        // ✅ NEW: Bulk Import Users Button
                        _buildControlRow(Icons.people_outline,
                            'Bulk Import Users', AppColors.neonBlue, () {
                          Navigator.push(
                              context,
                              MaterialPageRoute(
                                  builder: (_) => const BulkImportScreen()));
                        }),
                        const Divider(
                            color: AppColors.surfaceLight, height: 24),

                        _buildControlRow(
                            Icons.people, 'Manage Users', AppColors.neonBlue,
                            () {
                          Navigator.push(
                              context,
                              MaterialPageRoute(
                                  builder: (_) =>
                                      UsersListScreen(users: _users)));
                        }),
                        const Divider(
                            color: AppColors.surfaceLight, height: 24),
                        _buildControlRow(Icons.inventory_2, 'Manage Equipment',
                            AppColors.neonCyan, () {
                          Navigator.push(
                              context,
                              MaterialPageRoute(
                                  builder: (_) => EquipmentListScreen(
                                      equipment: _allEquipment,
                                      title: 'Manage Equipment',
                                      headerColor: AppColors.neonCyan)));
                        }),
                        const Divider(
                            color: AppColors.surfaceLight, height: 24),
                        _buildControlRow(Icons.analytics, 'View Reports',
                            AppColors.success, _showReportsDialog),
                        const Divider(
                            color: AppColors.surfaceLight, height: 24),
                        _buildControlRow(Icons.history, 'Activity Logs',
                            AppColors.warning, _showLogsDialog),
                        const Divider(
                            color: AppColors.surfaceLight, height: 24),
                        _buildControlRow(Icons.settings, 'Settings & Preferences',
                            AppColors.neonCyan, () {
                          Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (_) => const SettingsScreen(),
                            ),
                          );
                        }),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),

                  // 3. Logout Button
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton.icon(
                      onPressed: () async {
                        await _apiService.clearToken();
                        CurrentUser.clear();
                        if (context.mounted) context.go('/');
                      },
                      icon: const Icon(Icons.logout),
                      label: const Text('LOGOUT FROM ADMIN PANEL',
                          style: TextStyle(
                              letterSpacing: 1, fontWeight: FontWeight.bold)),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.danger.withOpacity(0.2),
                        foregroundColor: AppColors.danger,
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12)),
                        side: BorderSide(
                            color: AppColors.danger.withOpacity(0.5)),
                      ),
                    ),
                  ),
                ],
              ),
            ),
    );
  }

  // --- HELPER WIDGETS & DIALOGS ---

  Widget _buildControlRow(
      IconData icon, String label, Color color, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Row(
        children: [
          Icon(icon, color: color, size: 24),
          const SizedBox(width: 16),
          Expanded(
              child: Text(label,
                  style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w500))),
          Icon(Icons.chevron_right, color: AppColors.textMuted),
        ],
      ),
    );
  }

  void _showReportsDialog() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        title: const Text('System Reports',
            style: TextStyle(color: AppColors.textPrimary)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _reportItem('Total Users', _users.length.toString()),
            _reportItem('Total Equipment', _allEquipment.length.toString()),
            _reportItem('Available Equipment',
                _stats['availableEquipment']?.toString() ?? '0'),
            _reportItem('Borrowed Equipment',
                _stats['borrowedEquipment']?.toString() ?? '0'),
            _reportItem('Total Rooms', _rooms.length.toString()),
            _reportItem(
                'Active Borrows', _stats['activeBorrows']?.toString() ?? '0'),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close',
                  style: TextStyle(color: AppColors.textSecondary)))
        ],
      ),
    );
  }

  void _showLogsDialog() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        title: const Text('Activity Logs',
            style: TextStyle(color: AppColors.textPrimary)),
        content: SizedBox(
          width: double.maxFinite,
          height: 400,
          child: _logs.isEmpty
              ? const Center(
                  child: Text('No logs found',
                      style: TextStyle(color: AppColors.textSecondary)))
              : ListView.builder(
                  itemCount: _logs.length,
                  itemBuilder: (context, index) {
                    final log = _logs[index];
                    return ListTile(
                      leading: Icon(Icons.history,
                          color: AppColors.warning, size: 20),
                      title: Text(log['details'] ?? log['action'] ?? 'Action',
                          style: const TextStyle(
                              color: AppColors.textPrimary, fontSize: 14)),
                      subtitle: Text(log['timestamp'] ?? '',
                          style: TextStyle(
                              color: AppColors.textMuted, fontSize: 12)),
                      dense: true,
                    );
                  },
                ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close',
                  style: TextStyle(color: AppColors.textSecondary)))
        ],
      ),
    );
  }

  void _showEditProfileSheet() {
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
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) => Padding(
          padding: EdgeInsets.fromLTRB(
              20, 20, 20, MediaQuery.of(context).viewInsets.bottom + 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Change Password',
                  style: TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 20,
                      fontWeight: FontWeight.bold)),
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
                      color: AppColors.textMuted,
                    ),
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
                      color: AppColors.textMuted,
                    ),
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
                      obscureConfirm ? Icons.visibility_off : Icons.visibility,
                      color: AppColors.textMuted,
                    ),
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
                        // ✅ Validate password before submitting
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

                        // ✅ Check if passwords match
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
                            newPassController.text);
                        setModalState(() => isUpdating = false);

                        if (result['success'] == true) {
                          Navigator.pop(context);
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                              content: Text(result['message']),
                              backgroundColor: AppColors.success));
                        } else {
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                              content: Text(result['message']),
                              backgroundColor: AppColors.danger));
                        }
                      },
                style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.neonCyan,
                    foregroundColor: AppColors.bgDark,
                    padding: const EdgeInsets.symmetric(vertical: 16)),
                child: isUpdating
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Update Password',
                        style: TextStyle(fontWeight: FontWeight.bold)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _reportItem(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: AppColors.textSecondary)),
          Text(value,
              style: const TextStyle(
                  color: AppColors.neonCyan,
                  fontWeight: FontWeight.bold,
                  fontSize: 16)),
        ],
      ),
    );
  }
}
