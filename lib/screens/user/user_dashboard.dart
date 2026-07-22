import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:go_router/go_router.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';
import 'qr_scanner_screen.dart';
import 'active_borrows_screen.dart';
import 'requests_screen.dart';
import 'user_profile_screen.dart';
import '../../widgets/custom_shimmer.dart';

class UserDashboard extends StatefulWidget {
  const UserDashboard({super.key});

  @override
  State<UserDashboard> createState() => _UserDashboardState();
}

class _UserDashboardState extends State<UserDashboard> {
  int _selectedIndex = 0;
  final ApiService _apiService = ApiService();

  List<Widget> get _screens => [
        DashboardHome(onNavigateToTab: _navigateToTab),
        const ActiveBorrowsScreen(),
        const SizedBox(), // Index 2: Placeholder for SCAN
        const RequestsScreen(),
        const UserProfileScreen(),
      ];

  void _navigateToTab(int index) {
    setState(() {
      _selectedIndex = index;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      body: IndexedStack(
        index: _selectedIndex,
        children: _screens,
      ),
      bottomNavigationBar: _buildBottomNav(),
    );
  }

  Widget _buildBottomNav() {
    return Container(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            AppColors.surfaceDark.withOpacity(0.95),
            AppColors.surfaceLight.withOpacity(0.95),
          ],
        ),
        border: Border(
            top: BorderSide(
                color: AppColors.neonCyan.withOpacity(0.2), width: 1)),
        boxShadow: [
          BoxShadow(
              color: AppColors.neonCyan.withOpacity(0.1),
              blurRadius: 20,
              offset: const Offset(0, -5)),
        ],
      ),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              _buildNavItem(
                  0, Icons.dashboard_outlined, Icons.dashboard, 'HOME'),
              _buildNavItem(
                  1, Icons.inventory_2_outlined, Icons.inventory_2, 'BORROWS'),
              _buildNavItem(
                  -1, Icons.qr_code_scanner, Icons.qr_code_scanner, 'SCAN',
                  isFab: true),
              _buildNavItem(
                  3, Icons.assignment_outlined, Icons.assignment, 'REQUESTS'),
              _buildNavItem(4, Icons.person_outline, Icons.person, 'PROFILE'),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildNavItem(
      int index, IconData icon, IconData activeIcon, String label,
      {bool isFab = false}) {
    final isSelected = isFab ? false : _selectedIndex == index;

    if (isFab) {
      return GestureDetector(
        onTap: () => Navigator.push(context,
            MaterialPageRoute(builder: (_) => const QRScannerScreen())),
        child: Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
                colors: [AppColors.neonCyan, AppColors.neonBlue]),
            borderRadius: BorderRadius.circular(20),
            boxShadow: [
              BoxShadow(
                  color: AppColors.neonCyan.withOpacity(0.5),
                  blurRadius: 15,
                  spreadRadius: 2)
            ],
          ),
          child: Icon(icon, color: AppColors.bgDark, size: 32),
        ).animate().scale(duration: 200.ms, curve: Curves.easeOut).shimmer(
            duration: 2000.ms, color: AppColors.neonCyan.withOpacity(0.3)),
      );
    }

    return GestureDetector(
      onTap: () {
        if (index >= 0 && index < _screens.length) {
          setState(() => _selectedIndex = index);
        }
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          color: isSelected
              ? AppColors.neonCyan.withOpacity(0.15)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(12),
          border: isSelected
              ? Border.all(color: AppColors.neonCyan.withOpacity(0.3), width: 1)
              : null,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(isSelected ? activeIcon : icon,
                color:
                    isSelected ? AppColors.neonCyan : AppColors.textSecondary,
                size: 24),
            const SizedBox(height: 4),
            Text(label,
                style: TextStyle(
                    color: isSelected
                        ? AppColors.neonCyan
                        : AppColors.textSecondary,
                    fontSize: 10,
                    fontWeight: isSelected ? FontWeight.w700 : FontWeight.w500,
                    letterSpacing: 1)),
          ],
        ),
      ),
    );
  }
}

// ==========================================
// DASHBOARD HOME
// ==========================================
class DashboardHome extends StatefulWidget {
  final Function(int) onNavigateToTab;

  const DashboardHome({super.key, required this.onNavigateToTab});

  @override
  State<DashboardHome> createState() => _DashboardHomeState();
}

class _DashboardHomeState extends State<DashboardHome> {
  final ApiService _apiService = ApiService();
  bool _isLoading = true;
  List<dynamic> _inventory = [];
  List<dynamic> _activeBorrows = [];

  @override
  void initState() {
    super.initState();
    _fetchDashboardData();
  }

  Future<void> _fetchDashboardData() async {
    setState(() => _isLoading = true);

    final inventoryResult = await _apiService.getInventory();
    final borrowsResult = await _apiService.getActiveBorrows();

    if (inventoryResult['success'] == true) {
      _inventory = inventoryResult['data'] ?? [];
    }

    if (borrowsResult['success'] == true) {
      _activeBorrows = borrowsResult['data'] ?? [];
    }

    setState(() => _isLoading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
                'WELCOME, ${CurrentUser.name.isEmpty ? 'RESEARCHER' : CurrentUser.name.toUpperCase()}',
                style: TextStyle(
                    fontSize: 14,
                    color: AppColors.textSecondary,
                    letterSpacing: 2,
                    fontWeight: FontWeight.w600)),
            Text('LABSYNC SYSTEM',
                style: TextStyle(
                    fontSize: 20,
                    color: AppColors.neonCyan,
                    letterSpacing: 2,
                    fontWeight: FontWeight.w800)),
          ],
        ),
        actions: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: AppColors.success.withOpacity(0.2),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: AppColors.success.withOpacity(0.5)),
            ),
            child: Row(
              children: [
                Container(
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(
                        color: AppColors.success, shape: BoxShape.circle)),
                const SizedBox(width: 8),
                const Text('ONLINE',
                    style: TextStyle(
                        color: AppColors.success,
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 1)),
              ],
            ),
          ),
          const SizedBox(width: 16),
        ],
      ),
      body: _isLoading
          ? const CustomShimmer()
          : RefreshIndicator(
              onRefresh: _fetchDashboardData,
              color: AppColors.neonCyan,
              child: SingleChildScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Stats Row
                    Row(
                      children: [
                        Expanded(
                          child: _StatCard(
                              label: 'TOTAL EQUIPMENT',
                              value: _inventory.length.toString(),
                              icon: Icons.devices,
                              color: AppColors.neonCyan),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: GestureDetector(
                            onTap: () => widget.onNavigateToTab(1),
                            child: _StatCard(
                                label: 'ACTIVE BORROWS',
                                value: _activeBorrows.length.toString(),
                                icon: Icons.inventory_2,
                                color: AppColors.warning),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _StatCard(
                              label: 'AVAILABLE',
                              value: _inventory
                                  .where((e) => e['status'] == 'Available')
                                  .length
                                  .toString(),
                              icon: Icons.check_circle,
                              color: AppColors.success),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Text('QUICK ACTIONS',
                        style: TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 12,
                            letterSpacing: 2,
                            fontWeight: FontWeight.bold)),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: _QuickActionCard(
                            icon: Icons.qr_code_scanner,
                            label: 'BORROW',
                            color: AppColors.neonCyan,
                            onTap: () => Navigator.push(
                                context,
                                MaterialPageRoute(
                                    builder: (_) => const QRScannerScreen())),
                          ),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: _QuickActionCard(
                            icon: Icons.assignment_return,
                            label: 'RETURN',
                            color: AppColors.neonBlue,
                            onTap: () => Navigator.push(
                                context,
                                MaterialPageRoute(
                                    builder: (_) =>
                                        const QRScannerScreen(isReturn: true))),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text('ACTIVE BORROWS',
                            style: TextStyle(
                                color: AppColors.textSecondary,
                                fontSize: 12,
                                letterSpacing: 2,
                                fontWeight: FontWeight.bold)),
                        TextButton(
                          onPressed: () => widget.onNavigateToTab(1),
                          child: const Text('VIEW ALL',
                              style: TextStyle(
                                  color: AppColors.neonCyan, fontSize: 12)),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    if (_activeBorrows.isEmpty)
                      GlassCard(
                        padding: const EdgeInsets.all(16),
                        child: Center(
                          child: Column(
                            children: [
                              Icon(Icons.inventory_2_outlined,
                                  size: 48, color: AppColors.textMuted),
                              const SizedBox(height: 12),
                              Text('No active borrows',
                                  style: TextStyle(
                                      color: AppColors.textSecondary,
                                      fontSize: 14)),
                            ],
                          ),
                        ),
                      )
                    else
                      ..._activeBorrows.map((borrow) {
                        // ✅ Use enriched data directly from backend
                        final objectName =
                            borrow['objectName'] ?? 'Unknown Equipment';
                        final room = borrow['room'] ?? 'Unknown';
                        final deadline =
                            DateTime.tryParse(borrow['deadline'] ?? '');
                        final isOverdue = deadline != null &&
                            DateTime.now().isAfter(deadline);

                        return GlassCard(
                          padding: const EdgeInsets.all(16),
                          child: Row(
                            children: [
                              Container(
                                  width: 4,
                                  height: 80,
                                  decoration: BoxDecoration(
                                      color: isOverdue
                                          ? AppColors.danger
                                          : AppColors.neonCyan,
                                      borderRadius: BorderRadius.circular(2))),
                              const SizedBox(width: 16),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(objectName,
                                        style: const TextStyle(
                                            fontSize: 18,
                                            fontWeight: FontWeight.bold,
                                            color: AppColors.textPrimary)),
                                    const SizedBox(height: 8),
                                    Row(
                                      children: [
                                        Icon(Icons.room,
                                            size: 16,
                                            color: AppColors.textSecondary),
                                        const SizedBox(width: 4),
                                        Text('Room: $room',
                                            style: TextStyle(
                                                color: AppColors.textSecondary,
                                                fontSize: 12)),
                                        const SizedBox(width: 16),
                                        Icon(Icons.access_time,
                                            size: 16,
                                            color: isOverdue
                                                ? AppColors.danger
                                                : AppColors.warning),
                                        const SizedBox(width: 4),
                                        Text(
                                            'Due: ${deadline != null ? '${deadline.day}/${deadline.month}/${deadline.year}' : 'N/A'}',
                                            style: TextStyle(
                                                color: isOverdue
                                                    ? AppColors.danger
                                                    : AppColors.warning,
                                                fontSize: 12)),
                                      ],
                                    ),
                                  ],
                                ),
                              ),
                              Icon(Icons.chevron_right,
                                  color: AppColors.neonCyan, size: 28),
                            ],
                          ),
                        );
                      }).toList(),
                  ],
                ),
              ),
            ),
    );
  }
}

// ==========================================
// HELPER WIDGETS
// ==========================================
class _StatCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;

  const _StatCard(
      {required this.label,
      required this.value,
      required this.icon,
      required this.color});

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Icon(icon, color: color, size: 32),
          const SizedBox(height: 8),
          Text(value,
              style: TextStyle(
                  color: color, fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          Text(label,
              style: TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 10,
                  letterSpacing: 1,
                  fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }
}

class _QuickActionCard extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  const _QuickActionCard(
      {required this.icon,
      required this.label,
      required this.color,
      required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [color.withOpacity(0.2), color.withOpacity(0.05)]),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: color.withOpacity(0.3), width: 1.5),
          boxShadow: [
            BoxShadow(
                color: color.withOpacity(0.2),
                blurRadius: 15,
                offset: const Offset(0, 5))
          ],
        ),
        child: Column(
          children: [
            Icon(icon, size: 40, color: color),
            const SizedBox(height: 12),
            Text(label,
                style: TextStyle(
                    color: color,
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                    letterSpacing: 1.5)),
          ],
        ),
      ),
    );
  }
}
