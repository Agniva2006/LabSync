import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';
import '../../widgets/custom_shimmer.dart';

class RequestsScreen extends StatefulWidget {
  const RequestsScreen({super.key});

  @override
  State<RequestsScreen> createState() => _RequestsScreenState();
}

class _RequestsScreenState extends State<RequestsScreen> {
  final ApiService _apiService = ApiService();
  List<dynamic> _requests = [];
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _fetchRequests();
  }

  Future<void> _fetchRequests() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final userId = CurrentUser.userId;
      print('🔍 Fetching requests for user: $userId');

      if (userId == null || userId.isEmpty) {
        setState(() {
          _errorMessage = 'User not logged in. Please login again.';
          _isLoading = false;
        });
        return;
      }

      final response = await _apiService.getUserRequests(userId);
      print('📡 API Response: ${response['success']}');

      if (!mounted) return;

      if (response['success'] == true) {
        final requests = response['data'] ?? [];
        print('✅ Found ${requests.length} requests');

        setState(() {
          _requests = requests;
          _isLoading = false;
        });
      } else {
        setState(() {
          _errorMessage = response['message'] ?? 'Failed to load requests.';
          _isLoading = false;
        });
      }
    } catch (e) {
      print('❌ Error fetching requests: $e');
      if (!mounted) return;
      setState(() {
        _errorMessage = 'Network error. Please check your connection.';
        _isLoading = false;
      });
    }
  }

  int _getCount(String status) {
    return _requests
        .where((r) => r['status']?.toLowerCase() == status.toLowerCase())
        .length;
  }

  String _formatDate(String? dateString) {
    if (dateString == null || dateString.isEmpty) return 'Unknown date';
    try {
      final date = DateTime.parse(dateString);
      final now = DateTime.now();
      final difference = now.difference(date);

      if (difference.inMinutes < 1) return 'Just now';
      if (difference.inMinutes < 60) return '${difference.inMinutes}m ago';
      if (difference.inHours < 24) return '${difference.inHours}h ago';
      if (difference.inDays < 7) return '${difference.inDays}d ago';

      return '${date.day}/${date.month}/${date.year}';
    } catch (e) {
      return dateString;
    }
  }

  @override
  Widget build(BuildContext context) {
    final pendingCount = _getCount('pending');
    final approvedCount = _getCount('approved');
    final rejectedCount = _getCount('rejected');

    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('MY REQUESTS'),
        backgroundColor: AppColors.bgDark,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.neonCyan),
          onPressed: () => Navigator.pop(context),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: AppColors.neonCyan),
            onPressed: _fetchRequests,
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: _isLoading
          ? const CustomShimmer()
          : _errorMessage != null
              ? _buildErrorState()
              : _requests.isEmpty
                  ? _buildEmptyState()
                  : RefreshIndicator(
                      onRefresh: _fetchRequests,
                      color: AppColors.neonCyan,
                      child: ListView(
                        padding: const EdgeInsets.all(20),
                        children: [
                          // Header Stats
                          Row(
                            children: [
                              Expanded(
                                child: _StatCard(
                                    label: 'PENDING',
                                    value: '$pendingCount',
                                    color: AppColors.warning),
                              ),
                              const SizedBox(width: 16),
                              Expanded(
                                child: _StatCard(
                                    label: 'APPROVED',
                                    value: '$approvedCount',
                                    color: AppColors.success),
                              ),
                              const SizedBox(width: 16),
                              Expanded(
                                child: _StatCard(
                                    label: 'REJECTED',
                                    value: '$rejectedCount',
                                    color: AppColors.danger),
                              ),
                            ],
                          )
                              .animate()
                              .fadeIn(duration: 500.ms)
                              .slideY(begin: -0.2),

                          const SizedBox(height: 24),

                          Text(
                            'ACTIVE REQUESTS',
                            style: TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 12,
                              letterSpacing: 2,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 16),

                          // Requests List
                          ..._requests.asMap().entries.map((entry) {
                            final index = entry.key;
                            final req = entry.value;
                            return Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: _RequestCard(
                                request: req,
                                formatDate: _formatDate,
                              )
                                  .animate()
                                  .fadeIn(delay: (index * 100).ms)
                                  .slideX(begin: 0.1),
                            );
                          }),
                        ],
                      ),
                    ),
    );
  }

  Widget _buildErrorState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.error_outline,
              size: 64, color: AppColors.danger.withOpacity(0.7)),
          const SizedBox(height: 16),
          Text(
            _errorMessage!,
            textAlign: TextAlign.center,
            style:
                const TextStyle(color: AppColors.textSecondary, fontSize: 16),
          ),
          const SizedBox(height: 24),
          ElevatedButton.icon(
            onPressed: _fetchRequests,
            icon: const Icon(Icons.refresh),
            label: const Text('RETRY'),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.neonCyan,
              foregroundColor: AppColors.bgDark,
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8)),
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
          Icon(Icons.inventory_2_outlined,
              size: 80, color: AppColors.textMuted.withOpacity(0.5)),
          const SizedBox(height: 16),
          const Text(
            'No requests yet',
            style: TextStyle(
                color: AppColors.textSecondary,
                fontSize: 18,
                fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          Text(
            'Scan a QR code to request equipment',
            style: TextStyle(color: AppColors.textMuted, fontSize: 14),
          ),
        ],
      ),
    );
  }
}

// ==================== REQUEST CARD WIDGET ====================
class _RequestCard extends StatelessWidget {
  final Map<String, dynamic> request;
  final String Function(String?) formatDate;

  const _RequestCard({
    required this.request,
    required this.formatDate,
  });

  Color _getStatusColor(String? status) {
    switch (status?.toLowerCase()) {
      case 'pending':
        return AppColors.warning;
      case 'approved':
        return AppColors.success;
      case 'rejected':
        return AppColors.danger;
      default:
        return AppColors.textSecondary;
    }
  }

  IconData _getStatusIcon(String? status) {
    switch (status?.toLowerCase()) {
      case 'pending':
        return Icons.hourglass_empty;
      case 'approved':
        return Icons.check_circle_outline;
      case 'rejected':
        return Icons.cancel_outlined;
      default:
        return Icons.info_outline;
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = request['status'] ?? 'pending';
    final statusColor = _getStatusColor(status);
    final statusIcon = _getStatusIcon(status);

    final equipmentName = request['equipmentName'] ?? 'Unknown Equipment';
    final roomId = request['roomId'] ?? 'Unknown Room';
    final requestedAt = formatDate(request['requestedAt']);
    final duration = request['duration'] ?? 'N/A';
    final purpose = request['purpose'] ?? '';

    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 4,
            height: 70,
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
                Row(
                  children: [
                    Icon(statusIcon, color: statusColor, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        equipmentName,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                          color: AppColors.textPrimary,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Icon(Icons.meeting_room_outlined,
                        size: 14, color: AppColors.textMuted),
                    const SizedBox(width: 4),
                    Text(
                      'Room: $roomId',
                      style: TextStyle(
                          color: AppColors.textSecondary, fontSize: 12),
                    ),
                    const SizedBox(width: 16),
                    Icon(Icons.access_time,
                        size: 14, color: AppColors.textMuted),
                    const SizedBox(width: 4),
                    Text(
                      duration,
                      style: TextStyle(
                          color: AppColors.textSecondary, fontSize: 12),
                    ),
                  ],
                ),
                if (purpose.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    'Purpose: $purpose',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 11),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                const SizedBox(height: 8),
                Text(
                  requestedAt,
                  style: TextStyle(color: AppColors.textMuted, fontSize: 11),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
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

// ==================== STATS CARD WIDGET ====================
class _StatCard extends StatelessWidget {
  final String label;
  final String value;
  final Color color;

  const _StatCard({
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withOpacity(0.3)),
      ),
      child: Column(
        children: [
          Text(
            value,
            style: TextStyle(
              color: color,
              fontSize: 24,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            label,
            style: TextStyle(
              color: AppColors.textSecondary,
              fontSize: 10,
              letterSpacing: 1,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }
}
