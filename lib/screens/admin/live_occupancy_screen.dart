import 'package:flutter/material.dart';
import 'dart:async';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';

class LiveOccupancyScreen extends StatefulWidget {
  const LiveOccupancyScreen({super.key});

  @override
  State<LiveOccupancyScreen> createState() => _LiveOccupancyScreenState();
}

class _LiveOccupancyScreenState extends State<LiveOccupancyScreen> {
  final ApiService _apiService = ApiService();
  List<dynamic> _rooms = [];
  List<dynamic> _logs = [];
  List<dynamic> _users = [];
  Map<String, List<dynamic>> _occupancy = {}; // roomId -> list of users inside
  Timer? _refreshTimer;
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadData();
    _refreshTimer =
        Timer.periodic(const Duration(seconds: 15), (_) => _updateOccupancy());
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadData() async {
    setState(() => _isLoading = true);
    try {
      final results = await Future.wait([
        _apiService.getRooms(),
        _apiService.getRoomAccessLogs(),
        _apiService.getAdminUsers(),
      ]);

      if (mounted) {
        setState(() {
          _rooms = results[0]['success'] == true ? results[0]['data'] ?? [] : [];
          _logs = results[1]['success'] == true ? results[1]['data'] ?? [] : [];
          _users = results[2]['success'] == true ? results[2]['data'] ?? [] : [];
        });
        await _updateOccupancy();
      }
    } catch (e) {
      print('Error loading live occupancy data: $e');
    }
    setState(() => _isLoading = false);
  }

  Future<void> _updateOccupancy() async {
    for (var room in _rooms) {
      final rId = room['roomId'] ?? room['room_id'] ?? '';
      final result = await _apiService.getCurrentlyInside(rId);
      if (result['success'] == true && mounted) {
        setState(() {
          _occupancy[rId] = result['data'] ?? [];
        });
      }
    }
  }

  String _formatDuration(int minutes) {
    if (minutes <= 0) return '0m';
    final hours = minutes ~/ 60;
    final mins = minutes % 60;
    if (hours > 0) {
      return '${hours}h ${mins}m';
    }
    return '${mins}m';
  }

  // Calculate usage hours spent in a specific room by role ('admin' or 'user')
  int _calculateRoomHoursByRole(String roomId, String targetRole) {
    int totalMins = 0;
    for (var log in _logs) {
      final rId = log['roomId'] ?? log['roomid'] ?? '';
      if (rId == roomId) {
        final uId = log['userId'] ?? log['userid'] ?? '';
        final userObj = _users.findFirst((u) => (u['userId'] ?? u['userid']) == uId);
        final role = (userObj?['role'] ?? 'user').toString().toLowerCase();

        if (role == targetRole.toLowerCase()) {
          final dur = int.tryParse(log['durationMinutes']?.toString() ?? '0') ?? 0;
          totalMins += dur;
        }
      }
    }
    return totalMins;
  }

  int _calculateTotalHoursByRole(String targetRole) {
    int totalMins = 0;
    for (var log in _logs) {
      final uId = log['userId'] ?? log['userid'] ?? '';
      final userObj = _users.findFirst((u) => (u['userId'] ?? u['userid']) == uId);
      final role = (userObj?['role'] ?? 'user').toString().toLowerCase();

      if (role == targetRole.toLowerCase()) {
        final dur = int.tryParse(log['durationMinutes']?.toString() ?? '0') ?? 0;
        totalMins += dur;
      }
    }
    return totalMins;
  }

  @override
  Widget build(BuildContext context) {
    final totalAdminMins = _calculateTotalHoursByRole('admin');
    final totalUserMins = _calculateTotalHoursByRole('user');

    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('LIVE LAB & USAGE METRICS'),
        backgroundColor: AppColors.neonCyan.withOpacity(0.2),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: AppColors.neonCyan),
            onPressed: _loadData,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.neonCyan))
          : _rooms.isEmpty
              ? const Center(
                  child: Text('No rooms configured',
                      style: TextStyle(color: AppColors.textSecondary)))
              : RefreshIndicator(
                  onRefresh: _loadData,
                  color: AppColors.neonCyan,
                  child: SingleChildScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // SUMMARY CARDS (USAGE HOURS BY ROLE)
                        GlassCard(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'TOTAL LAB USAGE HOURS BY ROLE',
                                style: TextStyle(
                                  color: AppColors.neonCyan,
                                  fontSize: 10,
                                  letterSpacing: 1.5,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              const SizedBox(height: 12),
                              Row(
                                children: [
                                  Expanded(
                                    child: _MetricTile(
                                      title: 'ADMIN USAGE',
                                      value: _formatDuration(totalAdminMins),
                                      icon: Icons.admin_panel_settings,
                                      color: AppColors.neonPurple,
                                    ),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: _MetricTile(
                                      title: 'USER USAGE',
                                      value: _formatDuration(totalUserMins),
                                      icon: Icons.people,
                                      color: AppColors.neonCyan,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 20),

                        const Text(
                          'ROOM OCCUPANCY & LIVE LOCATIONS',
                          style: TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 11,
                            letterSpacing: 2,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 12),

                        ListView.builder(
                          shrinkWrap: true,
                          physics: const NeverScrollableScrollPhysics(),
                          itemCount: _rooms.length,
                          itemBuilder: (context, index) {
                            final room = _rooms[index];
                            final rId = room['roomId'] ?? room['room_id'] ?? '';
                            final usersInside = _occupancy[rId] ?? [];
                            final totalInside = usersInside.length;
                            final adminRoomMins = _calculateRoomHoursByRole(rId, 'admin');
                            final userRoomMins = _calculateRoomHoursByRole(rId, 'user');

                            return Container(
                              margin: const EdgeInsets.only(bottom: 16),
                              child: GlassCard(
                                padding: const EdgeInsets.all(20),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        Icon(Icons.meeting_room,
                                            color: AppColors.neonCyan, size: 32),
                                        const SizedBox(width: 12),
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                room['roomName'] ?? room['room_name'] ?? 'Unknown Room',
                                                style: const TextStyle(
                                                    fontSize: 18,
                                                    fontWeight: FontWeight.bold,
                                                    color: AppColors.textPrimary),
                                              ),
                                              Text(
                                                '${room['building'] ?? 'Main'} - Floor ${room['floor'] ?? '1'} (ID: $rId)',
                                                style: TextStyle(
                                                    color: AppColors.textSecondary,
                                                    fontSize: 12),
                                              ),
                                            ],
                                          ),
                                        ),
                                        Container(
                                          padding: const EdgeInsets.symmetric(
                                              horizontal: 14, vertical: 6),
                                          decoration: BoxDecoration(
                                            color: totalInside > 0
                                                ? AppColors.success.withOpacity(0.2)
                                                : AppColors.textMuted.withOpacity(0.2),
                                            borderRadius: BorderRadius.circular(20),
                                            border: Border.all(
                                                color: totalInside > 0
                                                    ? AppColors.success
                                                    : AppColors.textMuted),
                                          ),
                                          child: Text(
                                            '$totalInside LIVE INSIDE',
                                            style: TextStyle(
                                              color: totalInside > 0
                                                  ? AppColors.success
                                                  : AppColors.textMuted,
                                              fontWeight: FontWeight.bold,
                                              fontSize: 11,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 12),

                                    // Room Hours breakdown by Admin vs User
                                    Row(
                                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                      children: [
                                        Text(
                                          '👑 Admin Hours: ${_formatDuration(adminRoomMins)}',
                                          style: const TextStyle(
                                            color: AppColors.neonPurple,
                                            fontSize: 12,
                                            fontWeight: FontWeight.bold,
                                          ),
                                        ),
                                        Text(
                                          '👤 User Hours: ${_formatDuration(userRoomMins)}',
                                          style: const TextStyle(
                                            color: AppColors.neonCyan,
                                            fontSize: 12,
                                            fontWeight: FontWeight.bold,
                                          ),
                                        ),
                                      ],
                                    ),

                                    if (usersInside.isNotEmpty) ...[
                                      const SizedBox(height: 12),
                                      const Divider(color: AppColors.surfaceLight),
                                      const SizedBox(height: 8),
                                      ...usersInside.map((u) => _UserTimeCard(
                                          user: u,
                                          usersList: _users,
                                          roomName: room['roomName'] ?? rId,
                                          formatDuration: _formatDuration)),
                                    ],
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                      ],
                    ),
                  ),
                ),
    );
  }
}

extension _IterableExt<T> on Iterable<T> {
  T? findFirst(bool Function(T element) test) {
    for (var element in this) {
      if (test(element)) return element;
    }
    return null;
  }
}

class _MetricTile extends StatelessWidget {
  final String title;
  final String value;
  final IconData icon;
  final Color color;

  const _MetricTile({
    required this.title,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withOpacity(0.3)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 24),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: TextStyle(color: AppColors.textSecondary, fontSize: 9, letterSpacing: 1),
              ),
              const SizedBox(height: 2),
              Text(
                value,
                style: TextStyle(color: color, fontSize: 16, fontWeight: FontWeight.bold),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _UserTimeCard extends StatelessWidget {
  final dynamic user;
  final List<dynamic> usersList;
  final String roomName;
  final String Function(int) formatDuration;

  const _UserTimeCard({
    required this.user,
    required this.usersList,
    required this.roomName,
    required this.formatDuration,
  });

  @override
  Widget build(BuildContext context) {
    final uId = user['userId'] ?? user['userid'] ?? '';
    final userObj = usersList.findFirst((u) => (u['userId'] ?? u['userid']) == uId);
    final role = (userObj?['role'] ?? 'user').toString().toUpperCase();
    final isAdmin = role == 'ADMIN';

    DateTime? entryTime;
    try {
      if (user['entryTime'] != null) {
        entryTime = DateTime.parse(user['entryTime']);
      }
    } catch (_) {}

    final duration = user['durationSoFar'] ?? 0;

    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: (isAdmin ? AppColors.neonPurple : AppColors.neonCyan).withOpacity(0.3),
        ),
      ),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: (isAdmin ? AppColors.neonPurple : AppColors.neonCyan).withOpacity(0.2),
            child: Icon(
              isAdmin ? Icons.admin_panel_settings : Icons.person,
              color: isAdmin ? AppColors.neonPurple : AppColors.neonCyan,
              size: 20,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      user['userName'] ?? 'Unknown User',
                      style: const TextStyle(
                        fontWeight: FontWeight.bold,
                        color: AppColors.textPrimary,
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: (isAdmin ? AppColors.neonPurple : AppColors.neonCyan).withOpacity(0.2),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        role,
                        style: TextStyle(
                          color: isAdmin ? AppColors.neonPurple : AppColors.neonCyan,
                          fontSize: 9,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    const Icon(Icons.location_on, size: 12, color: AppColors.success),
                    const SizedBox(width: 4),
                    Text(
                      'Live at $roomName',
                      style: const TextStyle(
                        color: AppColors.success,
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (entryTime != null) ...[
                      Text(
                        ' • In: ${entryTime.hour.toString().padLeft(2, '0')}:${entryTime.minute.toString().padLeft(2, '0')}',
                        style: const TextStyle(color: AppColors.textSecondary, fontSize: 11),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: AppColors.warning.withOpacity(0.2),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: AppColors.warning.withOpacity(0.5)),
            ),
            child: Text(
              formatDuration(duration),
              style: const TextStyle(
                color: AppColors.warning,
                fontWeight: FontWeight.bold,
                fontSize: 12,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
