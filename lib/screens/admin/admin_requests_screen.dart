import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';
import '../../widgets/custom_shimmer.dart';

class AdminRequestsScreen extends StatefulWidget {
  const AdminRequestsScreen({super.key});

  @override
  State<AdminRequestsScreen> createState() => _AdminRequestsScreenState();
}

class _AdminRequestsScreenState extends State<AdminRequestsScreen>
    with SingleTickerProviderStateMixin {
  final ApiService _apiService = ApiService();
  List<dynamic> _allRequests = [];
  List<dynamic> _filteredRequests = [];
  bool _isLoading = true;
  String? _errorMessage;
  String _currentFilter = 'pending';

  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    _tabController.addListener(_handleTabChange);
    _fetchRequests();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  void _handleTabChange() {
    if (_tabController.indexIsChanging) return;

    setState(() {
      switch (_tabController.index) {
        case 0:
          _currentFilter = 'pending';
          break;
        case 1:
          _currentFilter = 'approved';
          break;
        case 2:
          _currentFilter = 'rejected';
          break;
        case 3:
          _currentFilter = 'all';
          break;
      }
      _applyFilter();
    });
  }

  Future<void> _fetchRequests() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final response = await _apiService.getAllRequests();

      if (!mounted) return;

      if (response['success'] == true) {
        setState(() {
          _allRequests = response['data'] ?? [];
          _applyFilter();
          _isLoading = false;
        });
      } else {
        setState(() {
          _errorMessage = response['message'] ?? 'Failed to load requests.';
          _isLoading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = 'Network error. Please check your connection.';
        _isLoading = false;
      });
    }
  }

  void _applyFilter() {
    if (_currentFilter == 'all') {
      _filteredRequests = _allRequests;
    } else {
      _filteredRequests = _allRequests.where((r) {
        final status = r['status'] ?? r['Status'] ?? '';
        return status.toLowerCase() == _currentFilter;
      }).toList();
    }
  }

  int _getCount(String status) {
    return _allRequests.where((r) {
      final s = r['status'] ?? r['Status'] ?? '';
      return s.toLowerCase() == status.toLowerCase();
    }).length;
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

  // ==================== APPROVE/REJECT ACTIONS ====================

  Future<void> _approveRequest(String requestId, String equipmentName) async {
    final adminId = CurrentUser.userId ?? '';

    print('✅ Approving request: $requestId for equipment: $equipmentName');

    // Show confirmation dialog
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: AppColors.success.withOpacity(0.3)),
        ),
        title: Row(
          children: [
            Icon(Icons.check_circle, color: AppColors.success),
            const SizedBox(width: 8),
            const Text('Approve Request?',
                style: TextStyle(color: AppColors.textPrimary)),
          ],
        ),
        content: Text(
          'Approve request for $equipmentName?\n\nThis will reserve the equipment for the user.',
          style: const TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel',
                style: TextStyle(color: AppColors.textSecondary)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.success,
              foregroundColor: AppColors.bgDark,
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Approve',
                style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    // Show loading
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => const Center(
        child: CircularProgressIndicator(color: AppColors.neonCyan),
      ),
    );

    try {
      final result = await _apiService.approveRequest(
        requestId: requestId,
        adminId: adminId,
      );

      if (!mounted) return;
      Navigator.pop(context); // Close loading

      if (result['success'] == true) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('✅ ${result['message'] ?? 'Request approved'}'),
            backgroundColor: AppColors.success,
            behavior: SnackBarBehavior.floating,
          ),
        );
        await _fetchRequests();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(result['message'] ?? 'Failed to approve'),
            backgroundColor: AppColors.danger,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      Navigator.pop(context); // Close loading

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Error: $e'),
          backgroundColor: AppColors.danger,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  Future<void> _rejectRequest(String requestId, String equipmentName) async {
    final reasonController = TextEditingController();

    final reason = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: AppColors.danger.withOpacity(0.3)),
        ),
        title: Row(
          children: [
            Icon(Icons.cancel, color: AppColors.danger),
            const SizedBox(width: 8),
            const Text('Reject Request',
                style: TextStyle(color: AppColors.textPrimary)),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Rejecting request for $equipmentName',
              style:
                  const TextStyle(color: AppColors.textSecondary, fontSize: 12),
            ),
            const SizedBox(height: 16),
            const Text(
              'REASON (Optional)',
              style: TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 11,
                  letterSpacing: 1),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: reasonController,
              style: const TextStyle(color: AppColors.textPrimary),
              maxLines: 3,
              decoration: InputDecoration(
                hintText: 'e.g., Equipment under maintenance',
                hintStyle: TextStyle(color: AppColors.textMuted),
                filled: true,
                fillColor: AppColors.bgDark,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, null),
            child: const Text('Cancel',
                style: TextStyle(color: AppColors.textSecondary)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.danger,
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.pop(context, reasonController.text),
            child: const Text('Reject',
                style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );

    if (reason == null) return; // User cancelled

    // Show loading
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => const Center(
        child: CircularProgressIndicator(color: AppColors.neonCyan),
      ),
    );

    try {
      final result = await _apiService.rejectRequest(
        requestId: requestId,
        adminId: CurrentUser.userId ?? '',
        reason: reason,
      );

      if (!mounted) return;
      Navigator.pop(context); // Close loading

      if (result['success'] == true) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('❌ ${result['message'] ?? 'Request rejected'}'),
            backgroundColor: AppColors.danger,
            behavior: SnackBarBehavior.floating,
          ),
        );
        await _fetchRequests();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(result['message'] ?? 'Failed to reject'),
            backgroundColor: AppColors.danger,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      Navigator.pop(context); // Close loading

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Error: $e'),
          backgroundColor: AppColors.danger,
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  // ==================== UI BUILD ====================

  @override
  Widget build(BuildContext context) {
    final pendingCount = _getCount('pending');
    final approvedCount = _getCount('approved');
    final rejectedCount = _getCount('rejected');

    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('MANAGE REQUESTS'),
        backgroundColor: AppColors.bgDark,
        elevation: 0,
        automaticallyImplyLeading: false,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: AppColors.neonCyan),
            onPressed: _fetchRequests,
            tooltip: 'Refresh',
          ),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: AppColors.neonCyan,
          labelColor: AppColors.neonCyan,
          unselectedLabelColor: AppColors.textSecondary,
          tabs: [
            Tab(text: 'PENDING ($pendingCount)'),
            Tab(text: 'APPROVED ($approvedCount)'),
            Tab(text: 'REJECTED ($rejectedCount)'),
            const Tab(text: 'ALL'),
          ],
        ),
      ),
      body: _isLoading
          ? const CustomShimmer()
          : _errorMessage != null
              ? _buildErrorState()
              : _filteredRequests.isEmpty
                  ? _buildEmptyState()
                  : RefreshIndicator(
                      onRefresh: _fetchRequests,
                      color: AppColors.neonCyan,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _filteredRequests.length,
                        itemBuilder: (context, index) {
                          final req = _filteredRequests[index];

                          // ✅ Safe null handling for all fields
                          final requestId =
                              req['requestid'] ?? req['requestId'] ?? '';
                          final equipmentName = req['equipmentname'] ??
                              req['equipmentName'] ??
                              req['equipment'] ??
                              'Unknown Equipment';

                          return Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: _AdminRequestCard(
                              request: req,
                              formatDate: _formatDate,
                              onApprove: () => _approveRequest(
                                requestId,
                                equipmentName,
                              ),
                              onReject: () => _rejectRequest(
                                requestId,
                                equipmentName,
                              ),
                            )
                                .animate()
                                .fadeIn(delay: (index * 80).ms)
                                .slideX(begin: 0.1),
                          );
                        },
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
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEmptyState() {
    IconData icon;
    String title;
    String subtitle;

    switch (_currentFilter) {
      case 'pending':
        icon = Icons.check_circle_outline;
        title = 'No Pending Requests';
        subtitle = 'All caught up! Great job!';
        break;
      case 'approved':
        icon = Icons.assignment_outlined;
        title = 'No Approved Requests';
        subtitle = 'Approve some requests to see them here';
        break;
      case 'rejected':
        icon = Icons.thumb_up_alt_outlined;
        title = 'No Rejected Requests';
        subtitle = 'No rejections yet';
        break;
      default:
        icon = Icons.inventory_2_outlined;
        title = 'No Requests Yet';
        subtitle = 'Requests will appear here when users submit them';
    }

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
                fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          Text(
            subtitle,
            style: TextStyle(color: AppColors.textMuted, fontSize: 14),
          ),
        ],
      ),
    );
  }
}

// ==================== ADMIN REQUEST CARD ====================
class _AdminRequestCard extends StatelessWidget {
  final Map<String, dynamic> request;
  final String Function(String?) formatDate;
  final VoidCallback onApprove;
  final VoidCallback onReject;

  const _AdminRequestCard({
    required this.request,
    required this.formatDate,
    required this.onApprove,
    required this.onReject,
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

  @override
  Widget build(BuildContext context) {
    // ✅ Safe null handling for all fields
    final status = request['status'] ?? 'pending';
    final statusColor = _getStatusColor(status);
    final isPending = status.toLowerCase() == 'pending';

    final equipmentName = request['equipmentname'] ??
        request['equipmentName'] ??
        request['equipment'] ??
        'Unknown Equipment';
    final userName =
        request['username'] ?? request['userName'] ?? 'Unknown User';
    final roomId = request['roomid'] ?? request['roomId'] ?? 'Unknown';
    final duration = request['duration'] ?? 'N/A';
    final purpose = request['purpose'] ?? 'No purpose specified';
    final requestedAt =
        formatDate(request['requestedat'] ?? request['requestedAt']);
    final approvedAt =
        formatDate(request['approvedat'] ?? request['approvedAt']);
    final adminComment =
        request['admincomment'] ?? request['adminComment'] ?? '';

    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header Row
          Row(
            children: [
              Container(
                width: 4,
                height: 50,
                decoration: BoxDecoration(
                  color: statusColor,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      equipmentName,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Requested by $userName',
                      style: TextStyle(color: AppColors.neonCyan, fontSize: 12),
                    ),
                  ],
                ),
              ),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
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

          const SizedBox(height: 16),

          // Details Grid
          Row(
            children: [
              Expanded(
                child: _DetailItem(
                  icon: Icons.meeting_room_outlined,
                  label: 'Room',
                  value: roomId,
                ),
              ),
              Expanded(
                child: _DetailItem(
                  icon: Icons.access_time,
                  label: 'Duration',
                  value: duration,
                ),
              ),
            ],
          ),

          const SizedBox(height: 8),

          _DetailItem(
            icon: Icons.description_outlined,
            label: 'Purpose',
            value: purpose,
            fullWidth: true,
          ),

          const SizedBox(height: 8),

          Row(
            children: [
              Icon(Icons.calendar_today, size: 12, color: AppColors.textMuted),
              const SizedBox(width: 4),
              Text(
                requestedAt,
                style: TextStyle(color: AppColors.textMuted, fontSize: 11),
              ),
            ],
          ),

          // Action Buttons (only for pending)
          if (isPending) ...[
            const SizedBox(height: 16),
            const Divider(color: AppColors.textMuted, height: 1),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: onReject,
                    icon: const Icon(Icons.cancel_outlined, size: 18),
                    label: const Text('REJECT'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: AppColors.danger,
                      side:
                          BorderSide(color: AppColors.danger.withOpacity(0.5)),
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: onApprove,
                    icon: const Icon(Icons.check, size: 18),
                    label: const Text('APPROVE'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.success.withOpacity(0.8),
                      foregroundColor: Colors.black87,
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                      elevation: 2,
                      shadowColor: AppColors.success.withOpacity(0.3),
                    ),
                  ),
                ),
              ],
            ),
          ] else if (status.toLowerCase() == 'approved') ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: AppColors.success.withOpacity(0.1),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.success.withOpacity(0.3)),
              ),
              child: Row(
                children: [
                  Icon(Icons.check_circle, color: AppColors.success, size: 16),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Approved on $approvedAt',
                      style: TextStyle(color: AppColors.success, fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
          ] else if (status.toLowerCase() == 'rejected') ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: AppColors.danger.withOpacity(0.1),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.danger.withOpacity(0.3)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(Icons.cancel, color: AppColors.danger, size: 16),
                      const SizedBox(width: 8),
                      Text(
                        'Rejected on $approvedAt',
                        style: TextStyle(color: AppColors.danger, fontSize: 12),
                      ),
                    ],
                  ),
                  if (adminComment.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      'Reason: $adminComment',
                      style: TextStyle(
                          color: AppColors.textSecondary, fontSize: 11),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ==================== DETAIL ITEM WIDGET ====================
class _DetailItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final bool fullWidth;

  const _DetailItem({
    required this.icon,
    required this.label,
    required this.value,
    this.fullWidth = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: fullWidth ? null : const EdgeInsets.only(right: 8),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: AppColors.bgDark,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(icon, size: 14, color: AppColors.neonCyan),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label.toUpperCase(),
                  style: TextStyle(
                    color: AppColors.textMuted,
                    fontSize: 9,
                    letterSpacing: 1,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  value.isEmpty ? 'N/A' : value,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
