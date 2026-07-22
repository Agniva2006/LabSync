import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import '../../core/constants.dart';
import '../../core/current_user.dart';
import '../../widgets/custom_shimmer.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen>
    with SingleTickerProviderStateMixin {
  final ApiService _apiService = ApiService();
  List<dynamic> _notifications = [];
  bool _isLoading = true;
  bool _isRefreshing = false;
  int _unreadCount = 0;
  String _errorMessage = '';

  // Filter state
  String _currentFilter = 'all'; // 'all', 'unread', 'read'

  @override
  void initState() {
    super.initState();
    _fetchNotifications();
  }

  Future<void> _fetchNotifications() async {
    setState(() {
      _isLoading = true;
      _errorMessage = '';
    });

    try {
      final response = await _apiService.getNotifications();

      if (response['success'] == true) {
        setState(() {
          _notifications = response['data'] ?? [];
          _unreadCount = response['unreadCount'] ?? 0;
        });
        print('✅ Notifications loaded: ${_notifications.length}');
      } else {
        setState(() {
          _errorMessage = response['message'] ?? 'Failed to load notifications';
        });
      }
    } catch (e) {
      print('❌ Error fetching notifications: $e');
      setState(() {
        _errorMessage = 'Network error. Please check your connection.';
      });
    } finally {
      setState(() => _isLoading = false);
    }
  }

  Future<void> _refreshNotifications() async {
    setState(() => _isRefreshing = true);
    await _fetchNotifications();
    setState(() => _isRefreshing = false);
  }

  Future<void> _markAsRead(String notifId) async {
    try {
      await _apiService.markNotificationAsRead(notifId);
      await _fetchNotifications();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text('Marked as read'),
            backgroundColor: AppColors.success,
            behavior: SnackBarBehavior.floating,
            duration: const Duration(seconds: 1),
          ),
        );
      }
    } catch (e) {
      print('❌ Error marking as read: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Error: $e'),
            backgroundColor: AppColors.danger,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  Future<void> _markAllAsRead() async {
    try {
      await _apiService.markAllNotificationsAsRead();
      await _fetchNotifications();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text('All notifications marked as read'),
            backgroundColor: AppColors.success,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      print('❌ Error marking all as read: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Error: $e'),
            backgroundColor: AppColors.danger,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  Future<void> _deleteNotification(String notifId, int index) async {
    try {
      await _apiService.deleteNotification(notifId);
      await _fetchNotifications();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text('Notification deleted'),
            backgroundColor: AppColors.success,
            behavior: SnackBarBehavior.floating,
            duration: const Duration(seconds: 1),
          ),
        );
      }
    } catch (e) {
      print('❌ Error deleting notification: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Error: $e'),
            backgroundColor: AppColors.danger,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  Color _getPriorityColor(String? priority) {
    switch (priority?.toLowerCase()) {
      case 'high':
        return AppColors.danger;
      case 'medium':
        return AppColors.warning;
      case 'low':
        return AppColors.success;
      default:
        return AppColors.neonCyan;
    }
  }

  IconData _getNotificationIcon(String? type) {
    switch (type?.toUpperCase()) {
      case 'WELCOME':
        return Icons.waving_hand;
      case 'REQUEST':
        return Icons.pending_actions;
      case 'APPROVED':
        return Icons.check_circle;
      case 'REJECTED':
        return Icons.cancel;
      case 'REMINDER':
        return Icons.access_time;
      case 'OVERDUE':
        return Icons.warning;
      case 'ADMIN':
        return Icons.admin_panel_settings;
      case 'ACCESS_GRANTED':
        return Icons.check;
      case 'ACCESS_DENIED':
        return Icons.block;
      case 'SUCCESS':
        return Icons.celebration;
      case 'WARNING':
        return Icons.error_outline;
      case 'ERROR':
        return Icons.dangerous;
      case 'INFO':
        return Icons.info_outline;
      default:
        return Icons.notifications;
    }
  }

  Color _getNotificationColor(String? type) {
    switch (type?.toUpperCase()) {
      case 'SUCCESS':
      case 'APPROVED':
      case 'ACCESS_GRANTED':
        return AppColors.success;
      case 'WARNING':
      case 'OVERDUE':
      case 'REMINDER':
        return AppColors.warning;
      case 'ERROR':
      case 'REJECTED':
      case 'ACCESS_DENIED':
        return AppColors.danger;
      case 'ADMIN':
        return AppColors.neonPurple;
      default:
        return AppColors.neonCyan;
    }
  }

  String _formatTime(String? timestamp) {
    if (timestamp == null || timestamp.isEmpty) return '';

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

  List<dynamic> _getFilteredNotifications() {
    switch (_currentFilter) {
      case 'unread':
        return _notifications.where((n) => n['read'] != 'TRUE').toList();
      case 'read':
        return _notifications.where((n) => n['read'] == 'TRUE').toList();
      default:
        return _notifications;
    }
  }

  @override
  Widget build(BuildContext context) {
    final filteredNotifications = _getFilteredNotifications();

    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        backgroundColor: AppColors.bgDark,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.neonCyan),
          onPressed: () => Navigator.pop(context),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'NOTIFICATIONS',
              style: TextStyle(
                fontSize: 12,
                color: AppColors.textSecondary,
                letterSpacing: 2,
              ),
            ),
            Row(
              children: [
                const Text(
                  'INBOX',
                  style: TextStyle(
                    fontSize: 20,
                    color: AppColors.neonCyan,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 2,
                  ),
                ),
                if (_unreadCount > 0) ...[
                  const SizedBox(width: 8),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [AppColors.neonPurple, AppColors.neonCyan],
                      ),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      '$_unreadCount',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ).animate().scale(duration: 300.ms, curve: Curves.elasticOut),
                ],
              ],
            ),
          ],
        ),
        actions: [
          if (_unreadCount > 0)
            IconButton(
              icon: const Icon(Icons.done_all, color: AppColors.neonCyan),
              onPressed: _markAllAsRead,
              tooltip: 'Mark all as read',
            ).animate().fadeIn(delay: 200.ms),
          IconButton(
            icon: const Icon(Icons.refresh, color: AppColors.neonCyan),
            onPressed: _refreshNotifications,
            tooltip: 'Refresh',
          ).animate().fadeIn(delay: 400.ms),
        ],
      ),
      body: Column(
        children: [
          // Filter Tabs
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                _buildFilterChip('all', 'All', _notifications.length),
                const SizedBox(width: 8),
                _buildFilterChip('unread', 'Unread', _unreadCount),
                const SizedBox(width: 8),
                _buildFilterChip(
                    'read', 'Read', _notifications.length - _unreadCount),
              ],
            ),
          ),

          // Content
          Expanded(
            child: _isLoading
                ? _buildLoadingState()
                : _errorMessage.isNotEmpty
                    ? _buildErrorState()
                    : filteredNotifications.isEmpty
                        ? _buildEmptyState()
                        : _buildNotificationList(filteredNotifications),
          ),
        ],
      ),
    );
  }

  Widget _buildFilterChip(String filter, String label, int count) {
    final isSelected = _currentFilter == filter;

    return Expanded(
      child: GestureDetector(
        onTap: () {
          setState(() => _currentFilter = filter);
        },
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            gradient: isSelected
                ? const LinearGradient(
                    colors: [AppColors.neonCyan, AppColors.neonPurple],
                  )
                : null,
            color: isSelected ? null : AppColors.surfaceDark,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: isSelected
                  ? Colors.transparent
                  : AppColors.neonCyan.withOpacity(0.3),
            ),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                label,
                style: TextStyle(
                  color: isSelected ? Colors.white : AppColors.textSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1,
                ),
              ),
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: isSelected
                      ? Colors.white.withOpacity(0.2)
                      : AppColors.neonCyan.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  '$count',
                  style: TextStyle(
                    color: isSelected ? Colors.white : AppColors.neonCyan,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildLoadingState() {
    return const CustomShimmer();
  }

  Widget _buildErrorState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.error_outline,
            size: 80,
            color: AppColors.danger.withOpacity(0.5),
          ),
          const SizedBox(height: 16),
          Text(
            _errorMessage,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 14,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          ElevatedButton.icon(
            onPressed: _fetchNotifications,
            icon: const Icon(Icons.refresh),
            label: const Text('RETRY'),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.neonCyan,
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 12),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.notifications_none,
            size: 100,
            color: AppColors.textSecondary.withOpacity(0.3),
          )
              .animate()
              .scale(duration: 600.ms, curve: Curves.elasticOut)
              .then()
              .shimmer(duration: 2000.ms, color: AppColors.neonCyan),
          const SizedBox(height: 24),
          Text(
            _currentFilter == 'unread'
                ? 'No unread notifications'
                : _currentFilter == 'read'
                    ? 'No read notifications'
                    : 'No notifications yet',
            style: TextStyle(
              color: AppColors.textSecondary,
              fontSize: 18,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'You\'re all caught up!',
            style: TextStyle(
              color: AppColors.textMuted,
              fontSize: 14,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildNotificationList(List<dynamic> notifications) {
    return RefreshIndicator(
      onRefresh: _refreshNotifications,
      color: AppColors.neonCyan,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: notifications.length,
        itemBuilder: (context, index) {
          final notif = notifications[index];
          final isRead = notif['read'] == 'TRUE';
          final type = notif['type'] ?? 'info';
          final notifColor = _getNotificationColor(type);

          return _buildNotificationCard(notif, isRead, type, notifColor, index);
        },
      ),
    );
  }

  Widget _buildNotificationCard(
    dynamic notif,
    bool isRead,
    String type,
    Color notifColor,
    int index,
  ) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: GlassCard(
        padding: EdgeInsets.zero,
        child: Dismissible(
          key: Key(notif['notifId'] ?? index.toString()),
          direction: DismissDirection.endToStart,
          background: Container(
            alignment: Alignment.centerRight,
            padding: const EdgeInsets.only(right: 20),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Colors.transparent, AppColors.danger],
              ),
              borderRadius: BorderRadius.circular(16),
            ),
            child: const Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.delete, color: Colors.white, size: 28),
                SizedBox(height: 4),
                Text(
                  'DELETE',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 1,
                  ),
                ),
              ],
            ),
          ),
          onDismissed: (direction) {
            _deleteNotification(notif['notifId'], index);
          },
          child: InkWell(
            onTap: () {
              if (!isRead) {
                _markAsRead(notif['notifId']);
              }
            },
            borderRadius: BorderRadius.circular(16),
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                border: isRead
                    ? null
                    : Border.all(
                        color: notifColor.withOpacity(0.3),
                        width: 1.5,
                      ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Priority indicator
                  Container(
                    width: 4,
                    height: 60,
                    decoration: BoxDecoration(
                      color: _getPriorityColor(notif['priority']),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  const SizedBox(width: 16),

                  // Icon
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      color: notifColor.withOpacity(0.15),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: notifColor.withOpacity(0.3),
                      ),
                    ),
                    child: Icon(
                      _getNotificationIcon(type),
                      color: isRead ? AppColors.textSecondary : notifColor,
                      size: 24,
                    ),
                  ),
                  const SizedBox(width: 12),

                  // Content
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          notif['message'] ?? 'Notification',
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight:
                                isRead ? FontWeight.w500 : FontWeight.bold,
                            color: isRead
                                ? AppColors.textSecondary
                                : AppColors.textPrimary,
                            height: 1.4,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Icon(
                              Icons.access_time,
                              size: 12,
                              color: AppColors.textSecondary.withOpacity(0.7),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              _formatTime(notif['createdAt']),
                              style: TextStyle(
                                fontSize: 11,
                                color: AppColors.textSecondary.withOpacity(0.7),
                              ),
                            ),
                            const Spacer(),
                            if (!isRead)
                              Container(
                                width: 8,
                                height: 8,
                                decoration: BoxDecoration(
                                  color: notifColor,
                                  shape: BoxShape.circle,
                                  boxShadow: [
                                    BoxShadow(
                                      color: notifColor.withOpacity(0.5),
                                      blurRadius: 4,
                                      spreadRadius: 1,
                                    ),
                                  ],
                                ),
                              )
                                  .animate(
                                      onPlay: (controller) =>
                                          controller.repeat())
                                  .scale(
                                    duration: 600.ms,
                                    curve: Curves.easeInOut,
                                    end: const Offset(1.2, 1.2),
                                  )
                                  .then()
                                  .scale(
                                    duration: 600.ms,
                                    curve: Curves.easeInOut,
                                    end: const Offset(1.0, 1.0),
                                  ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    )
        .animate()
        .fade(duration: 400.ms, delay: (index * 50).ms)
        .slideX(begin: -0.1, end: 0);
  }
}
