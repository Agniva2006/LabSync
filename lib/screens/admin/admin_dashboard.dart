import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:go_router/go_router.dart';
import 'package:fl_chart/fl_chart.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';
import 'equipment_list_screen.dart';
import 'users_list_screen.dart';
import 'admin_profile_screen.dart';
import 'room_access_screen.dart';
import 'live_occupancy_screen.dart';
import 'bulk_import_screen.dart';
import 'admin_door_control_screen.dart';
import 'admin_requests_screen.dart';
import '../../widgets/custom_shimmer.dart';

class AdminDashboard extends StatefulWidget {
  const AdminDashboard({super.key});

  @override
  State<AdminDashboard> createState() => _AdminDashboardState();
}

class _AdminDashboardState extends State<AdminDashboard> {
  final ApiService _apiService = ApiService();
  bool _isLoading = true;
  Map<String, dynamic> _stats = {};
  List<dynamic> _allEquipment = [];
  List<dynamic> _users = [];
  List<dynamic> _pendingRequests = [];
  int _selectedIndex = 0;

  @override
  void initState() {
    super.initState();
    _fetchAdminData();
  }

  List<Widget> get _navScreens => [
        _buildDashboardHome(),
        _buildEquipmentList(),
        _buildUsersList(),
        const AdminRequestsScreen(),
        const RoomAccessScreen(),
        const LiveOccupancyScreen(),
        const AdminProfileScreen(),
      ];

  Future<void> _fetchAdminData() async {
    setState(() => _isLoading = true);
    try {
      final statsResponse = await _apiService.getAdminStats();
      final equipmentResponse = await _apiService.getAdminEquipment();
      final usersResponse = await _apiService.getAdminUsers();
      final requestsResponse = await _apiService.getAllRequests();

      if (statsResponse['success'] == true) {
        _stats = statsResponse['data'] ?? {};
      }
      if (equipmentResponse['success'] == true) {
        _allEquipment = equipmentResponse['data'] ?? [];
      }
      if (usersResponse['success'] == true) {
        _users = usersResponse['data'] ?? [];
      }
      if (requestsResponse['success'] == true) {
        _pendingRequests = (requestsResponse['data'] ?? [])
            .where((r) => r['status']?.toLowerCase() == 'pending')
            .toList();
      }
    } catch (e) {
      print('Error fetching admin data: $e');
    }
    setState(() => _isLoading = false);
  }

  void _navigateToList(String filterType) {
    switch (filterType) {
      case 'ALL':
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => EquipmentListScreen(
              equipment: _allEquipment,
              title: 'All Equipment',
              headerColor: AppColors.neonCyan,
            ),
          ),
        );
        break;
      case 'AVAILABLE':
        final available = _allEquipment
            .where((e) => (e['status'] ?? '').toLowerCase() == 'available')
            .toList();
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => EquipmentListScreen(
              equipment: available,
              title: 'Available Equipment',
              headerColor: AppColors.success,
            ),
          ),
        );
        break;
      case 'BORROWED':
        final borrowed = _allEquipment
            .where((e) => (e['status'] ?? '').toLowerCase() == 'borrowed')
            .toList();
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => EquipmentListScreen(
              equipment: borrowed,
              title: 'Borrowed Equipment',
              headerColor: AppColors.warning,
            ),
          ),
        );
        break;
      case 'USERS':
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => UsersListScreen(users: _users),
          ),
        );
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      body: IndexedStack(
        index: _selectedIndex,
        children: _navScreens,
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
            color: AppColors.neonCyan.withOpacity(0.2),
            width: 1,
          ),
        ),
      ),
      child: SafeArea(
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          physics: const BouncingScrollPhysics(),
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.start,
            children: [
              _buildNavItem(
                  0, Icons.dashboard_outlined, Icons.dashboard, 'DASHBOARD'),
              const SizedBox(width: 2),
              _buildNavItem(1, Icons.inventory_2_outlined, Icons.inventory_2,
                  'EQUIPMENT'),
              const SizedBox(width: 2),
              _buildNavItem(2, Icons.people_outline, Icons.people, 'USERS'),
              const SizedBox(width: 2),
              _buildNavItemWithBadge(3, Icons.assignment_ind_outlined,
                  Icons.assignment_ind, 'REQUESTS', _pendingRequests.length),
              const SizedBox(width: 2),
              _buildNavItem(
                  4, Icons.door_sliding_outlined, Icons.door_sliding, 'ROOMS'),
              const SizedBox(width: 2),
              _buildNavItem(
                  5, Icons.analytics_outlined, Icons.analytics, 'LIVE'),
              const SizedBox(width: 2),
              _buildNavItem(6, Icons.person_outline, Icons.person, 'PROFILE'),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildNavItem(
      int index, IconData icon, IconData activeIcon, String label) {
    final isSelected = _selectedIndex == index;
    return GestureDetector(
      onTap: () => setState(() => _selectedIndex = index),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
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
            Icon(
              isSelected ? activeIcon : icon,
              color: isSelected ? AppColors.neonCyan : AppColors.textSecondary,
              size: 22,
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: TextStyle(
                color:
                    isSelected ? AppColors.neonCyan : AppColors.textSecondary,
                fontSize: 9,
                fontWeight: isSelected ? FontWeight.w700 : FontWeight.w500,
                letterSpacing: 0.5,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildNavItemWithBadge(int index, IconData icon, IconData activeIcon,
      String label, int badgeCount) {
    final isSelected = _selectedIndex == index;
    return GestureDetector(
      onTap: () => setState(() => _selectedIndex = index),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
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
            Stack(
              clipBehavior: Clip.none,
              children: [
                Icon(
                  isSelected ? activeIcon : icon,
                  color:
                      isSelected ? AppColors.neonCyan : AppColors.textSecondary,
                  size: 22,
                ),
                if (badgeCount > 0)
                  Positioned(
                    right: -8,
                    top: -4,
                    child: Container(
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(
                        color: AppColors.danger,
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: AppColors.bgDark,
                          width: 1.5,
                        ),
                      ),
                      constraints: const BoxConstraints(
                        minWidth: 16,
                        minHeight: 16,
                      ),
                      child: Text(
                        badgeCount > 99 ? '99+' : badgeCount.toString(),
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 9,
                          fontWeight: FontWeight.bold,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: TextStyle(
                color:
                    isSelected ? AppColors.neonCyan : AppColors.textSecondary,
                fontSize: 9,
                fontWeight: isSelected ? FontWeight.w700 : FontWeight.w500,
                letterSpacing: 0.5,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // --- DASHBOARD HOME TAB ---
  Widget _buildDashboardHome() {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'ADMIN PANEL',
              style: TextStyle(
                fontSize: 14,
                color: AppColors.textSecondary,
                letterSpacing: 2,
                fontWeight: FontWeight.w600,
              ),
            ),
            Text(
              'LABSYNC CONTROL',
              style: TextStyle(
                fontSize: 20,
                color: AppColors.neonCyan,
                letterSpacing: 2,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: AppColors.neonCyan),
            tooltip: 'Refresh Data',
            onPressed: _fetchAdminData,
          ),
          IconButton(
            icon: const Icon(Icons.account_circle_outlined, color: AppColors.neonPurple),
            tooltip: 'Admin Profile',
            onPressed: () => setState(() => _selectedIndex = 6),
          ),
        ],
      ),
      body: _isLoading
          ? const CustomShimmer()
          : RefreshIndicator(
              onRefresh: _fetchAdminData,
              color: AppColors.neonCyan,
              child: SingleChildScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // ✅ 1. QUICK ACTIONS ROW (WITH REQUESTS & DOOR CONTROL)
                    GlassCard(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'QUICK ACTIONS',
                            style: TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 10,
                              letterSpacing: 1,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              Expanded(
                                child: _QuickActionBtn(
                                  icon: Icons.assignment_ind,
                                  label: 'REQUESTS',
                                  color: AppColors.warning,
                                  badge: _pendingRequests.length,
                                  onTap: () =>
                                      setState(() => _selectedIndex = 3),
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: _QuickActionBtn(
                                  icon: Icons.people_alt,
                                  label: 'BULK IMPORT',
                                  color: AppColors.neonPurple,
                                  onTap: () {
                                    Navigator.push(
                                      context,
                                      MaterialPageRoute(
                                          builder: (_) =>
                                              const BulkImportScreen()),
                                    );
                                  },
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              Expanded(
                                child: _QuickActionBtn(
                                  icon: Icons.door_front_door,
                                  label: 'DOOR CONTROL',
                                  color: AppColors.neonCyan,
                                  onTap: () {
                                    Navigator.push(
                                      context,
                                      MaterialPageRoute(
                                        builder: (context) =>
                                            AdminDoorControlScreen(
                                          userId: CurrentUser.userId,
                                          roomId: 'ROOM-001',
                                        ),
                                      ),
                                    );
                                  },
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: _QuickActionBtn(
                                  icon: Icons.analytics,
                                  label: 'LIVE OCCUPANCY',
                                  color: AppColors.success,
                                  onTap: () =>
                                      setState(() => _selectedIndex = 5),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),

                    // 2. STATS GRID
                    GridView.count(
                      crossAxisCount: 2,
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      childAspectRatio: 1.25,
                      crossAxisSpacing: 12,
                      mainAxisSpacing: 12,
                      children: [
                        GestureDetector(
                          onTap: () => _navigateToList('ALL'),
                          child: _AdminStatCard(
                            label: 'TOTAL EQUIPMENT',
                            value: _stats['totalEquipment']?.toString() ?? '0',
                            icon: Icons.devices,
                            color: AppColors.neonCyan,
                          ),
                        ),
                        GestureDetector(
                          onTap: () => _navigateToList('AVAILABLE'),
                          child: _AdminStatCard(
                            label: 'AVAILABLE',
                            value:
                                _stats['availableEquipment']?.toString() ?? '0',
                            icon: Icons.check_circle,
                            color: AppColors.success,
                          ),
                        ),
                        GestureDetector(
                          onTap: () => _navigateToList('BORROWED'),
                          child: _AdminStatCard(
                            label: 'BORROWED',
                            value:
                                _stats['borrowedEquipment']?.toString() ?? '0',
                            icon: Icons.inventory_2,
                            color: AppColors.warning,
                          ),
                        ),
                        GestureDetector(
                          onTap: () => _navigateToList('USERS'),
                          child: _AdminStatCard(
                            label: 'TOTAL USERS',
                            value: _stats['totalUsers']?.toString() ?? '0',
                            icon: Icons.people,
                            color: AppColors.neonBlue,
                          ),
                        ),
                      ],
                    ).animate().fade(duration: 600.ms),
                    const SizedBox(height: 32),

                    // ✅ 3. PENDING REQUESTS ALERT (if any)
                    if (_pendingRequests.isNotEmpty) ...[
                      GlassCard(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(Icons.warning_amber,
                                    color: AppColors.warning, size: 24),
                                const SizedBox(width: 8),
                                const Text(
                                  'PENDING REQUESTS',
                                  style: TextStyle(
                                    color: AppColors.warning,
                                    fontSize: 14,
                                    letterSpacing: 2,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                                const Spacer(),
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 8, vertical: 4),
                                  decoration: BoxDecoration(
                                    color: AppColors.warning.withOpacity(0.2),
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                  child: Text(
                                    '${_pendingRequests.length}',
                                    style: const TextStyle(
                                      color: AppColors.warning,
                                      fontSize: 12,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            ..._pendingRequests.take(3).map((req) {
                              return Container(
                                margin: const EdgeInsets.only(bottom: 8),
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(
                                  color: AppColors.bgDark,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            req['equipmentName'] ?? 'Equipment',
                                            style: const TextStyle(
                                              color: AppColors.textPrimary,
                                              fontSize: 14,
                                              fontWeight: FontWeight.bold,
                                            ),
                                          ),
                                          Text(
                                            'by ${req['userName'] ?? 'User'}',
                                            style: TextStyle(
                                              color: AppColors.textSecondary,
                                              fontSize: 11,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    Icon(Icons.arrow_forward_ios,
                                        color: AppColors.textMuted, size: 14),
                                  ],
                                ),
                              );
                            }),
                            if (_pendingRequests.length > 3)
                              TextButton(
                                onPressed: () =>
                                    setState(() => _selectedIndex = 3),
                                child: Text(
                                  'View All ${_pendingRequests.length} Requests',
                                  style: TextStyle(color: AppColors.warning),
                                ),
                              ),
                          ],
                        ),
                      ).animate().fadeIn(duration: 600.ms).slideX(begin: -0.1),
                      const SizedBox(height: 24),
                    ],

                    // ✅ 4. VISUAL ANALYTICS (PIE CHART)
                    GlassCard(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'EQUIPMENT STATUS ANALYTICS',
                            style: TextStyle(
                              color: AppColors.neonCyan,
                              fontSize: 14,
                              letterSpacing: 2,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 20),
                          SizedBox(
                            height: 220,
                            child: _buildEquipmentPieChart(),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 32),

                    // 5. SYSTEM OVERVIEW TEXT LIST
                    GlassCard(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'SYSTEM OVERVIEW',
                            style: TextStyle(
                              color: AppColors.neonCyan,
                              fontSize: 14,
                              letterSpacing: 2,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 16),
                          _buildInfoRow(
                              'Total Equipment',
                              _stats['totalEquipment']?.toString() ?? '0',
                              AppColors.neonCyan),
                          _buildInfoRow(
                              'Available',
                              _stats['availableEquipment']?.toString() ?? '0',
                              AppColors.success),
                          _buildInfoRow(
                              'Borrowed',
                              _stats['borrowedEquipment']?.toString() ?? '0',
                              AppColors.warning),
                          _buildInfoRow(
                              'Total Users',
                              _stats['totalUsers']?.toString() ?? '0',
                              AppColors.neonBlue),
                          _buildInfoRow(
                              'Pending Requests',
                              _pendingRequests.length.toString(),
                              AppColors.warning),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }

  // ✅ PIE CHART WIDGET
  Widget _buildEquipmentPieChart() {
    final available =
        int.tryParse(_stats['availableEquipment']?.toString() ?? '0') ?? 0;
    final borrowed =
        int.tryParse(_stats['borrowedEquipment']?.toString() ?? '0') ?? 0;

    final safeAvailable = available > 0 ? available.toDouble() : 0.0;
    final safeBorrowed = borrowed > 0 ? borrowed.toDouble() : 0.0;

    if (safeAvailable == 0 && safeBorrowed == 0) {
      return const Center(
        child: Text('No equipment data to display',
            style: TextStyle(color: AppColors.textSecondary)),
      );
    }

    return Row(
      children: [
        Expanded(
          flex: 2,
          child: PieChart(
            PieChartData(
              sections: [
                PieChartSectionData(
                  value: safeAvailable,
                  title:
                      '${((safeAvailable / (safeAvailable + safeBorrowed)) * 100).toStringAsFixed(0)}%',
                  color: AppColors.success,
                  radius: 60,
                  titleStyle: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 14),
                ),
                PieChartSectionData(
                  value: safeBorrowed,
                  title:
                      '${((safeBorrowed / (safeAvailable + safeBorrowed)) * 100).toStringAsFixed(0)}%',
                  color: AppColors.warning,
                  radius: 60,
                  titleStyle: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 14),
                ),
              ],
              sectionsSpace: 2,
              centerSpaceRadius: 40,
            ),
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          flex: 1,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildLegend(
                  AppColors.success, 'Available', available.toString()),
              const SizedBox(height: 12),
              _buildLegend(AppColors.warning, 'Borrowed', borrowed.toString()),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildLegend(Color color, String label, String value) {
    return Row(
      children: [
        Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 8),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
            Text(value,
                style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.bold)),
          ],
        ),
      ],
    );
  }

  // --- EQUIPMENT TAB ---
  Widget _buildEquipmentList() {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('ALL EQUIPMENT'),
        backgroundColor: AppColors.neonCyan.withOpacity(0.2),
      ),
      body: _allEquipment.isEmpty
          ? const Center(
              child: Text(
                'No equipment found',
                style: TextStyle(color: AppColors.textSecondary),
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(20),
              itemCount: _allEquipment.length,
              itemBuilder: (context, index) {
                final item = _allEquipment[index];
                return Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  child: _EquipmentCard(equipment: item),
                );
              },
            ),
    );
  }

  // --- USERS TAB ---
  Widget _buildUsersList() {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('ALL USERS'),
        backgroundColor: AppColors.neonBlue.withOpacity(0.2),
      ),
      body: _users.isEmpty
          ? const Center(
              child: Text(
                'No users found',
                style: TextStyle(color: AppColors.textSecondary),
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(20),
              itemCount: _users.length,
              itemBuilder: (context, index) {
                final user = _users[index];
                return Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  child: _UserCard(user: user),
                );
              },
            ),
    );
  }

  Widget _buildInfoRow(String label, String value, Color color) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: TextStyle(color: AppColors.textSecondary, fontSize: 14),
          ),
          Text(
            value,
            style: TextStyle(
              color: color,
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }
}

// --- HELPER WIDGETS ---
class _AdminStatCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;

  const _AdminStatCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(12),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, color: color, size: 26),
          const SizedBox(height: 6),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              value,
              style: TextStyle(
                color: color,
                fontSize: 24,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              label,
              style: TextStyle(
                color: AppColors.textSecondary,
                fontSize: 9,
                letterSpacing: 0.5,
                fontWeight: FontWeight.bold,
              ),
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ),
    );
  }
}

class _EquipmentCard extends StatelessWidget {
  final dynamic equipment;

  const _EquipmentCard({required this.equipment});

  @override
  Widget build(BuildContext context) {
    final name = equipment['name'] ?? equipment['objectName'] ?? 'Unknown';
    final room = equipment['room'] ?? 'Unknown';
    final status = equipment['status'] ?? 'Unknown';
    final statusColor = status.toLowerCase() == 'available'
        ? AppColors.success
        : (status.toLowerCase() == 'borrowed'
            ? AppColors.warning
            : AppColors.neonPurple);

    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Container(
            width: 4,
            height: 60,
            decoration: BoxDecoration(
              color: statusColor,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Room: $room',
                  style: TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: statusColor.withOpacity(0.15),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: statusColor.withOpacity(0.5)),
            ),
            child: Text(
              status.toUpperCase(),
              style: TextStyle(
                color: statusColor,
                fontSize: 10,
                fontWeight: FontWeight.bold,
                letterSpacing: 1,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _UserCard extends StatelessWidget {
  final dynamic user;

  const _UserCard({required this.user});

  @override
  Widget build(BuildContext context) {
    final name = user['name'] ?? 'Unknown User';
    final email = user['email'] ?? 'No email';
    final role = user['role'] ?? 'user';
    final roleColor =
        role == 'admin' ? AppColors.neonPurple : AppColors.neonCyan;

    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          CircleAvatar(
            radius: 24,
            backgroundColor: roleColor.withOpacity(0.2),
            child: Icon(Icons.person, color: roleColor, size: 28),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  email,
                  style: TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: roleColor.withOpacity(0.15),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: roleColor.withOpacity(0.5)),
            ),
            child: Text(
              role.toUpperCase(),
              style: TextStyle(
                color: roleColor,
                fontSize: 10,
                fontWeight: FontWeight.bold,
                letterSpacing: 1,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ✅ UPDATED: QUICK ACTION BUTTON WIDGET WITH BADGE SUPPORT
class _QuickActionBtn extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;
  final int? badge;

  const _QuickActionBtn({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
    this.badge,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 16),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [color.withOpacity(0.2), color.withOpacity(0.05)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: color.withOpacity(0.4)),
        ),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Column(
              children: [
                Icon(icon, color: color, size: 28),
                const SizedBox(height: 8),
                Text(
                  label,
                  style: TextStyle(
                    color: color,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 1,
                  ),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
            if (badge != null && badge! > 0)
              Positioned(
                right: -4,
                top: -4,
                child: Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: AppColors.danger,
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: AppColors.bgDark,
                      width: 1.5,
                    ),
                  ),
                  constraints: const BoxConstraints(
                    minWidth: 18,
                    minHeight: 18,
                  ),
                  child: Text(
                    badge! > 99 ? '99+' : badge.toString(),
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
