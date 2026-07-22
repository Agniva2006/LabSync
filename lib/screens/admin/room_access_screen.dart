import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../widgets/custom_shimmer.dart';

class RoomAccessScreen extends StatefulWidget {
  const RoomAccessScreen({super.key});

  @override
  State<RoomAccessScreen> createState() => _RoomAccessScreenState();
}

class _RoomAccessScreenState extends State<RoomAccessScreen>
    with SingleTickerProviderStateMixin {
  final ApiService _apiService = ApiService();

  // ==================== STATE VARIABLES ====================
  bool _isLoading = true;
  String? _errorMessage;
  List<dynamic> _rooms = [];
  List<dynamic> _users = [];
  List<dynamic> _logs = [];

  late TabController _tabController;
  final List<String> _tabTitles = ['LOGS', 'ROOMS', 'PERMISSIONS'];
  final List<IconData> _tabIcons = [
    Icons.history,
    Icons.meeting_room,
    Icons.security,
  ];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _loadData();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  // ==================== DATA LOADING ====================

  Future<void> _loadData() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final results = await Future.wait([
        _apiService.getRoomAccessLogs(),
        _apiService.getRooms(),
        _apiService.getAdminUsers(),
      ]);

      if (!mounted) return;

      setState(() {
        _logs = results[0]['success'] == true ? results[0]['data'] ?? [] : [];
        _rooms = results[1]['success'] == true ? results[1]['data'] ?? [] : [];
        _users = results[2]['success'] == true ? results[2]['data'] ?? [] : [];
        _isLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = 'Failed to load data: $e';
        _isLoading = false;
      });
    }
  }

  // ==================== MAIN BUILD ====================

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('BIOMETRIC ROOM ACCESS'),
        backgroundColor: AppColors.neonPurple.withOpacity(0.2),
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.fingerprint,
                color: AppColors.neonPurple, size: 28),
            tooltip: 'Simulate Hardware Scan',
            onPressed: _showSimulateScanSheet,
          ),
          IconButton(
            icon: const Icon(Icons.refresh, color: AppColors.neonCyan),
            tooltip: 'Refresh',
            onPressed: _loadData,
          ),
        ],
      ),
      body: Column(
        children: [
          // Tab Selector
          _buildTabSelector(),

          // Content Area
          Expanded(
            child: _isLoading
                ? _buildLoadingState()
                : _errorMessage != null
                    ? _buildErrorState()
                    : TabBarView(
                        controller: _tabController,
                        children: [
                          _buildLogsTab(),
                          _buildRoomsTab(),
                          _buildPermissionsTab(),
                        ],
                      ),
          ),
        ],
      ),
    );
  }

  // ==================== TAB SELECTOR ====================

  Widget _buildTabSelector() {
    return Container(
      padding: const EdgeInsets.all(12),
      child: TabBar(
        controller: _tabController,
        indicator: BoxDecoration(
          color: AppColors.neonPurple.withOpacity(0.2),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppColors.neonPurple),
        ),
        indicatorSize: TabBarIndicatorSize.tab,
        labelColor: AppColors.neonPurple,
        unselectedLabelColor: AppColors.textSecondary,
        tabs: List.generate(3, (index) {
          return Tab(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(_tabIcons[index], size: 24),
                const SizedBox(height: 4),
                Text(
                  _tabTitles[index],
                  style: const TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 1,
                  ),
                ),
              ],
            ),
          );
        }),
      ),
    );
  }

  // ==================== STATE WIDGETS ====================

  Widget _buildLoadingState() {
    return const CustomShimmer();
  }

  Widget _buildErrorState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, size: 64, color: AppColors.danger),
            const SizedBox(height: 16),
            Text(
              _errorMessage!,
              textAlign: TextAlign.center,
              style:
                  const TextStyle(color: AppColors.textSecondary, fontSize: 14),
            ),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              onPressed: _loadData,
              icon: const Icon(Icons.refresh),
              label: const Text('RETRY'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.neonCyan,
                foregroundColor: AppColors.bgDark,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ==================== LOGS TAB ====================

  Widget _buildLogsTab() {
    if (_logs.isEmpty) {
      return _buildEmptyState(
        icon: Icons.history,
        title: 'No Access Logs',
        subtitle: 'Access logs will appear here when users enter/exit rooms',
      );
    }

    return RefreshIndicator(
      onRefresh: _loadData,
      color: AppColors.neonCyan,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _logs.length,
        itemBuilder: (context, index) {
          final log = _logs[index];
          return _buildLogCard(log);
        },
      ),
    );
  }

  Widget _buildLogCard(dynamic log) {
    final action = log['action']?.toString().toUpperCase() ?? 'GRANTED';
    final isEntry = action == 'ENTRY' || action == 'GRANTED' || action == 'VERIFIED' || action == 'REMOTE_UNLOCK';

    final userId = log['userId'] ?? log['userid'] ?? '';
    String userName = log['userName'] ?? log['user_name'] ?? '';
    if (userName.isEmpty || userName == 'Unknown User' || userName.startsWith('ROOM-')) {
      for (var u in _users) {
        if ((u['userId'] ?? u['userid']) == userId) {
          userName = u['username'] ?? u['name'] ?? '';
          break;
        }
      }
    }
    if (userName.isEmpty) userName = userId.isNotEmpty ? 'User ($userId)' : 'System Access';

    final roomId = log['roomId'] ?? log['room_id'] ?? '';
    String roomName = log['roomName'] ?? log['room_name'] ?? '';
    if (roomName.isEmpty || roomName.startsWith('ROOM-')) {
      for (var r in _rooms) {
        if ((r['roomId'] ?? r['room_id']) == roomId) {
          roomName = r['roomName'] ?? r['room_name'] ?? roomId;
          break;
        }
      }
    }
    if (roomName.isEmpty) roomName = roomId.isNotEmpty ? roomId : 'Main Lab';

    final timestamp = log['timestamp'] ?? '';
    final rawDuration = log['durationMinutes'] ?? log['duration_minutes'] ?? log['duration'];
    int? parsedDuration;
    if (rawDuration != null && rawDuration.toString() != 'false' && rawDuration.toString() != 'null') {
      parsedDuration = int.tryParse(rawDuration.toString());
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      child: GlassCard(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: (isEntry ? AppColors.success : AppColors.warning)
                    .withOpacity(0.15),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                isEntry ? Icons.login : Icons.logout,
                color: isEntry ? AppColors.success : AppColors.warning,
                size: 28,
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    userName,
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      color: AppColors.textPrimary,
                      fontSize: 16,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Icon(Icons.meeting_room,
                          size: 14, color: AppColors.textSecondary),
                      const SizedBox(width: 4),
                      Text(
                        roomName,
                        style: const TextStyle(
                            color: AppColors.textSecondary, fontSize: 12),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Icon(Icons.access_time,
                          size: 14, color: AppColors.textMuted),
                      const SizedBox(width: 4),
                      Text(
                        _formatTimestamp(timestamp),
                        style: const TextStyle(
                            color: AppColors.textMuted, fontSize: 11),
                      ),
                    ],
                  ),
                  if (parsedDuration != null && parsedDuration > 0) ...[
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        const Icon(Icons.timer, size: 14, color: AppColors.neonCyan),
                        const SizedBox(width: 4),
                        Text(
                          'Duration: $parsedDuration min',
                          style: const TextStyle(
                            color: AppColors.neonCyan,
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: (isEntry ? AppColors.success : AppColors.warning)
                    .withOpacity(0.15),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: (isEntry ? AppColors.success : AppColors.warning)
                      .withOpacity(0.5),
                ),
              ),
              child: Text(
                action,
                style: TextStyle(
                  color: isEntry ? AppColors.success : AppColors.warning,
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ==================== ROOMS TAB ====================

  Widget _buildRoomsTab() {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: _showAddRoomDialog,
              icon: const Icon(Icons.add),
              label: const Text(
                'ADD NEW ROOM',
                style: TextStyle(fontWeight: FontWeight.bold, letterSpacing: 1),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.neonPurple,
                foregroundColor: AppColors.bgDark,
                padding: const EdgeInsets.symmetric(vertical: 16),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
          ),
        ),
        Expanded(
          child: _rooms.isEmpty
              ? _buildEmptyState(
                  icon: Icons.meeting_room,
                  title: 'No Rooms',
                  subtitle: 'Add rooms to manage access permissions',
                )
              : RefreshIndicator(
                  onRefresh: _loadData,
                  color: AppColors.neonCyan,
                  child: ListView.builder(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    itemCount: _rooms.length,
                    itemBuilder: (context, index) {
                      final room = _rooms[index];
                      return _buildRoomCard(room);
                    },
                  ),
                ),
        ),
      ],
    );
  }

  int _calculateRoomHoursByRole(String roomId, String targetRole) {
    int totalMins = 0;
    for (var log in _logs) {
      final rId = log['roomId'] ?? log['roomid'] ?? '';
      if (rId == roomId) {
        final uId = log['userId'] ?? log['userid'] ?? '';
        dynamic userObj;
        for (var u in _users) {
          if ((u['userId'] ?? u['userid']) == uId) {
            userObj = u;
            break;
          }
        }
        final role = (userObj?['role'] ?? 'user').toString().toLowerCase();

        if (role == targetRole.toLowerCase()) {
          final dur = int.tryParse(log['durationMinutes']?.toString() ?? '0') ?? 0;
          totalMins += dur;
        }
      }
    }
    return totalMins;
  }

  String _formatMins(int minutes) {
    if (minutes <= 0) return '0m';
    final hours = minutes ~/ 60;
    final mins = minutes % 60;
    if (hours > 0) return '${hours}h ${mins}m';
    return '${mins}m';
  }

  Widget _buildRoomCard(dynamic room) {
    final roomName = room['roomName'] ?? room['room_name'] ?? 'Unknown';
    final building = room['building'] ?? 'N/A';
    final floor = room['floor'] ?? 'N/A';
    final roomId = room['roomId'] ?? room['room_id'] ?? '';
    final adminMins = _calculateRoomHoursByRole(roomId, 'admin');
    final userMins = _calculateRoomHoursByRole(roomId, 'user');

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      child: GlassCard(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.neonPurple.withOpacity(0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(
                    Icons.meeting_room,
                    color: AppColors.neonPurple,
                    size: 32,
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        roomName,
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          color: AppColors.textPrimary,
                          fontSize: 16,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Icon(Icons.location_on,
                              size: 14, color: AppColors.textSecondary),
                          const SizedBox(width: 4),
                          Text(
                            '$building - Floor $floor',
                            style: const TextStyle(
                                color: AppColors.textSecondary, fontSize: 12),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'ID: $roomId',
                        style: const TextStyle(
                            color: AppColors.textMuted, fontSize: 11),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            const Divider(color: AppColors.surfaceLight),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    const Icon(Icons.admin_panel_settings, size: 14, color: AppColors.neonPurple),
                    const SizedBox(width: 4),
                    Text(
                      'Admin: ${_formatMins(adminMins)}',
                      style: const TextStyle(
                        color: AppColors.neonPurple,
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
                Row(
                  children: [
                    const Icon(Icons.people, size: 14, color: AppColors.neonCyan),
                    const SizedBox(width: 4),
                    Text(
                      'Users: ${_formatMins(userMins)}',
                      style: const TextStyle(
                        color: AppColors.neonCyan,
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  // ==================== PERMISSIONS TAB ====================

  Widget _buildPermissionsTab() {
    if (_users.isEmpty) {
      return _buildEmptyState(
        icon: Icons.security,
        title: 'No Users',
        subtitle: 'Users will appear here for permission management',
      );
    }

    return RefreshIndicator(
      onRefresh: _loadData,
      color: AppColors.neonCyan,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _users.length,
        itemBuilder: (context, index) {
          final user = _users[index];
          return _buildPermissionCard(user);
        },
      ),
    );
  }

  Widget _buildPermissionCard(dynamic user) {
    final userName = user['name'] ?? user['userName'] ?? 'Unknown';
    final userEmail = user['email'] ?? '';
    final userId = user['userId'] ?? user['user_id'] ?? '';
    final authorizedRoomsStr = user['authorized_rooms']?.toString() ?? '';
    final authorizedRoomIds = authorizedRoomsStr
        .split(',')
        .where((id) => id.trim().isNotEmpty)
        .map((id) => id.trim())
        .toList();

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      child: GlassCard(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  backgroundColor: AppColors.neonCyan.withOpacity(0.2),
                  child: const Icon(Icons.person, color: AppColors.neonCyan),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        userName,
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          color: AppColors.textPrimary,
                          fontSize: 16,
                        ),
                      ),
                      if (userEmail.isNotEmpty)
                        Text(
                          userEmail,
                          style: const TextStyle(
                              color: AppColors.textSecondary, fontSize: 12),
                        ),
                    ],
                  ),
                ),
                ElevatedButton.icon(
                  onPressed: () => _showAssignPermissionDialog(user),
                  icon: const Icon(Icons.add, size: 16),
                  label: const Text(
                    'ASSIGN',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.neonPurple,
                    foregroundColor: AppColors.bgDark,
                    padding:
                        const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                ),
              ],
            ),
            if (authorizedRoomIds.isNotEmpty) ...[
              const SizedBox(height: 12),
              const Divider(color: AppColors.surfaceLight, height: 1),
              const SizedBox(height: 12),
              const Text(
                'AUTHORIZED ROOMS:',
                style: TextStyle(
                  color: AppColors.textMuted,
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1,
                ),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: authorizedRoomIds.map((roomId) {
                  final room = _rooms.firstWhere(
                    (r) => (r['roomId'] ?? r['room_id']) == roomId,
                    orElse: () => {'roomName': roomId, 'roomId': roomId},
                  );
                  return _buildRoomChip(room);
                }).toList(),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildRoomChip(dynamic room) {
    final roomName =
        room['roomName'] ?? room['room_name'] ?? room['roomId'] ?? 'Unknown';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: AppColors.success.withOpacity(0.15),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppColors.success.withOpacity(0.5)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.meeting_room, size: 14, color: AppColors.success),
          const SizedBox(width: 4),
          Text(
            roomName,
            style: const TextStyle(
              color: AppColors.success,
              fontSize: 11,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }

  // ==================== EMPTY STATE ====================

  Widget _buildEmptyState({
    required IconData icon,
    required String title,
    required String subtitle,
  }) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 80, color: AppColors.textMuted.withOpacity(0.5)),
          const SizedBox(height: 16),
          Text(
            title,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 18,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            subtitle,
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColors.textMuted, fontSize: 14),
          ),
        ],
      ),
    );
  }

  // ==================== SIMULATE SCAN SHEET ====================

  void _showSimulateScanSheet() {
    String? selectedUserId;
    String? selectedUserName;
    String? selectedRoomId;
    String? selectedRoomName;
    bool isSimulating = false;

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
            20,
            20,
            20,
            MediaQuery.of(context).viewInsets.bottom + 20,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.neonPurple.withOpacity(0.2),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Icon(Icons.fingerprint,
                        color: AppColors.neonPurple, size: 32),
                  ),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Text(
                      'Simulate Biometric Scan',
                      style: TextStyle(
                        color: AppColors.textPrimary,
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              const Text(
                'Select a user and room to simulate a hardware scan. This will log the entry exactly as the ESP32 would.',
                style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
              ),
              const SizedBox(height: 24),

              // User Dropdown
              DropdownButtonFormField<String>(
                value: selectedUserId,
                decoration: InputDecoration(
                  labelText: 'Select User',
                  labelStyle: const TextStyle(color: AppColors.textSecondary),
                  prefixIcon:
                      const Icon(Icons.person, color: AppColors.neonCyan),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide: BorderSide(color: AppColors.surfaceLight),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide: BorderSide(color: AppColors.surfaceLight),
                  ),
                  filled: true,
                  fillColor: AppColors.bgDark,
                ),
                dropdownColor: AppColors.surfaceDark,
                style: const TextStyle(color: AppColors.textPrimary),
                items: _users.map((user) {
                  final userId = user['userId'] ?? user['user_id'];
                  final userName =
                      user['name'] ?? user['userName'] ?? 'Unknown';
                  return DropdownMenuItem<String>(
                    value: userId,
                    child: Text(userName),
                  );
                }).toList(),
                onChanged: (value) {
                  setModalState(() {
                    selectedUserId = value;
                    final user = _users.firstWhere(
                      (u) => (u['userId'] ?? u['user_id']) == value,
                      orElse: () => {},
                    );
                    selectedUserName = user['name'] ?? user['userName'];
                  });
                },
              ),
              const SizedBox(height: 16),

              // Room Dropdown
              DropdownButtonFormField<String>(
                value: selectedRoomId,
                decoration: InputDecoration(
                  labelText: 'Select Room',
                  labelStyle: const TextStyle(color: AppColors.textSecondary),
                  prefixIcon: const Icon(Icons.meeting_room,
                      color: AppColors.neonPurple),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide: BorderSide(color: AppColors.surfaceLight),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide: BorderSide(color: AppColors.surfaceLight),
                  ),
                  filled: true,
                  fillColor: AppColors.bgDark,
                ),
                dropdownColor: AppColors.surfaceDark,
                style: const TextStyle(color: AppColors.textPrimary),
                items: _rooms.map((room) {
                  final roomId = room['roomId'] ?? room['room_id'];
                  final roomName =
                      room['roomName'] ?? room['room_name'] ?? 'Unknown';
                  return DropdownMenuItem<String>(
                    value: roomId,
                    child: Text(roomName),
                  );
                }).toList(),
                onChanged: (value) {
                  setModalState(() {
                    selectedRoomId = value;
                    final room = _rooms.firstWhere(
                      (r) => (r['roomId'] ?? r['room_id']) == value,
                      orElse: () => {},
                    );
                    selectedRoomName = room['roomName'] ?? room['room_name'];
                  });
                },
              ),
              const SizedBox(height: 24),

              // Simulate Button
              ElevatedButton.icon(
                onPressed: (selectedUserId != null &&
                        selectedRoomId != null &&
                        !isSimulating)
                    ? () async {
                        setModalState(() => isSimulating = true);
                        HapticFeedback.mediumImpact();

                        // Simulate hardware scanning delay
                        await Future.delayed(const Duration(seconds: 1));

                        final result = await _apiService.logRoomEntry(
                          selectedUserId!,
                          selectedUserName!,
                          selectedRoomId!,
                          selectedRoomName!,
                        );

                        setModalState(() => isSimulating = false);

                        if (result['success'] == true) {
                          Navigator.pop(context);
                          _loadData();
                          HapticFeedback.heavyImpact();
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text(
                                  '✅ Access Granted! Door Unlocked & Logged.'),
                              backgroundColor: AppColors.success,
                              behavior: SnackBarBehavior.floating,
                            ),
                          );
                        } else {
                          HapticFeedback.lightImpact();
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content:
                                  Text(result['message'] ?? 'Access Denied'),
                              backgroundColor: AppColors.danger,
                              behavior: SnackBarBehavior.floating,
                            ),
                          );
                        }
                      }
                    : null,
                icon: isSimulating
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: AppColors.bgDark,
                        ),
                      )
                    : const Icon(Icons.fingerprint),
                label: Text(
                  isSimulating ? 'SCANNING...' : 'SIMULATE SCAN',
                  style: const TextStyle(
                      fontWeight: FontWeight.bold, letterSpacing: 1),
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.neonPurple,
                  foregroundColor: AppColors.bgDark,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ==================== ADD ROOM DIALOG ====================

  void _showAddRoomDialog() {
    final roomNameController = TextEditingController();
    final buildingController = TextEditingController();
    final floorController = TextEditingController();

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: AppColors.neonPurple.withOpacity(0.3)),
        ),
        title: Row(
          children: [
            Icon(Icons.add_circle, color: AppColors.neonPurple),
            const SizedBox(width: 8),
            const Text(
              'Add New Room',
              style: TextStyle(color: AppColors.textPrimary),
            ),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: roomNameController,
              decoration: InputDecoration(
                labelText: 'Room Name',
                labelStyle: const TextStyle(color: AppColors.textSecondary),
                prefixIcon:
                    const Icon(Icons.meeting_room, color: AppColors.neonCyan),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: AppColors.surfaceLight),
                ),
                filled: true,
                fillColor: AppColors.bgDark,
              ),
              style: const TextStyle(color: AppColors.textPrimary),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: buildingController,
              decoration: InputDecoration(
                labelText: 'Building',
                labelStyle: const TextStyle(color: AppColors.textSecondary),
                prefixIcon:
                    const Icon(Icons.business, color: AppColors.neonCyan),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: AppColors.surfaceLight),
                ),
                filled: true,
                fillColor: AppColors.bgDark,
              ),
              style: const TextStyle(color: AppColors.textPrimary),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: floorController,
              decoration: InputDecoration(
                labelText: 'Floor',
                labelStyle: const TextStyle(color: AppColors.textSecondary),
                prefixIcon: const Icon(Icons.layers, color: AppColors.neonCyan),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: AppColors.surfaceLight),
                ),
                filled: true,
                fillColor: AppColors.bgDark,
              ),
              style: const TextStyle(color: AppColors.textPrimary),
              keyboardType: TextInputType.number,
            ),
          ],
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
              if (roomNameController.text.isEmpty ||
                  buildingController.text.isEmpty ||
                  floorController.text.isEmpty) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('Please fill all fields'),
                    backgroundColor: AppColors.danger,
                  ),
                );
                return;
              }

              final result = await _apiService.addRoom(
                roomNameController.text,
                buildingController.text,
                floorController.text,
              );

              if (result['success'] == true) {
                Navigator.pop(context);
                _loadData();
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('✅ Room added successfully'),
                    backgroundColor: AppColors.success,
                  ),
                );
              } else {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(result['message'] ?? 'Failed to add room'),
                    backgroundColor: AppColors.danger,
                  ),
                );
              }
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.neonPurple,
              foregroundColor: AppColors.bgDark,
            ),
            child: const Text('Add'),
          ),
        ],
      ),
    );
  }

  // ==================== ASSIGN PERMISSION DIALOG ====================

  void _showAssignPermissionDialog(dynamic user) {
    String? selectedRoomId;
    final userName = user['name'] ?? user['userName'] ?? 'Unknown';

    showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          backgroundColor: AppColors.surfaceDark,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: BorderSide(color: AppColors.neonPurple.withOpacity(0.3)),
          ),
          title: Row(
            children: [
              Icon(Icons.security, color: AppColors.neonPurple),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Assign Room to $userName',
                  style: const TextStyle(
                      color: AppColors.textPrimary, fontSize: 16),
                ),
              ),
            ],
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: _rooms.isEmpty
                ? [
                    const Text(
                      'No rooms available',
                      style: TextStyle(color: AppColors.textSecondary),
                    ),
                  ]
                : _rooms.map((room) {
                    final roomId = room['roomId'] ?? room['room_id'];
                    final roomName =
                        room['roomName'] ?? room['room_name'] ?? 'Unknown';
                    final building = room['building'] ?? '';
                    final floor = room['floor'] ?? '';

                    return RadioListTile<String>(
                      title: Text(
                        roomName,
                        style: const TextStyle(color: AppColors.textPrimary),
                      ),
                      subtitle: Text(
                        '$building - Floor $floor',
                        style: const TextStyle(
                            color: AppColors.textSecondary, fontSize: 11),
                      ),
                      value: roomId,
                      groupValue: selectedRoomId,
                      activeColor: AppColors.neonPurple,
                      onChanged: (value) =>
                          setDialogState(() => selectedRoomId = value),
                    );
                  }).toList(),
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
              onPressed: selectedRoomId != null
                  ? () async {
                      final userId = user['userId'] ?? user['user_id'];
                      final result = await _apiService.assignRoomPermission(
                        userId,
                        selectedRoomId!,
                      );

                      if (result['success'] == true) {
                        Navigator.pop(context);
                        _loadData();
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('✅ Permission assigned successfully'),
                            backgroundColor: AppColors.success,
                          ),
                        );
                      } else {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text(result['message'] ??
                                'Failed to assign permission'),
                            backgroundColor: AppColors.danger,
                          ),
                        );
                      }
                    }
                  : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.neonPurple,
                foregroundColor: AppColors.bgDark,
              ),
              child: const Text('Assign'),
            ),
          ],
        ),
      ),
    );
  }

  // ==================== HELPER FUNCTIONS ====================

  String _formatTimestamp(String timestamp) {
    if (timestamp.isEmpty) return 'Unknown';
    try {
      final date = DateTime.parse(timestamp);
      final now = DateTime.now();
      final difference = now.difference(date);

      if (difference.inMinutes < 1) return 'Just now';
      if (difference.inMinutes < 60) return '${difference.inMinutes}m ago';
      if (difference.inHours < 24) return '${difference.inHours}h ago';
      if (difference.inDays < 7) return '${difference.inDays}d ago';

      return '${date.day}/${date.month}/${date.year}';
    } catch (e) {
      return timestamp;
    }
  }
}
