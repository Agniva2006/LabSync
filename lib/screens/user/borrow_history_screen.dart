import 'package:flutter/material.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';

class BorrowHistoryScreen extends StatefulWidget {
  final List<dynamic> borrows;
  final String title;

  const BorrowHistoryScreen({
    super.key,
    required this.borrows,
    required this.title,
  });

  @override
  State<BorrowHistoryScreen> createState() => _BorrowHistoryScreenState();
}

class _BorrowHistoryScreenState extends State<BorrowHistoryScreen> {
  late List<dynamic> _currentBorrows;
  final ApiService _apiService = ApiService();

  @override
  void initState() {
    super.initState();
    _currentBorrows = widget.borrows;
  }

  Future<void> _refreshData() async {
    final response = await _apiService.getBorrowHistory(CurrentUser.userId);
    if (response['success'] == true && mounted) {
      setState(() {
        _currentBorrows = response['data'] ?? [];
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: Text(widget.title),
        backgroundColor: AppColors.neonCyan.withOpacity(0.2),
        elevation: 0,
      ),
      body: _currentBorrows.isEmpty
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.inventory_2_outlined,
                    size: 80,
                    color: AppColors.textMuted,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'No ${widget.title} found',
                    style: TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 18,
                    ),
                  ),
                ],
              ),
            )
          : RefreshIndicator(
              onRefresh: _refreshData,
              color: AppColors.neonCyan,
              child: ListView.builder(
                padding: const EdgeInsets.all(20),
                itemCount: _currentBorrows.length,
                itemBuilder: (context, index) {
                  final borrow = _currentBorrows[index];
                  return _BorrowItemCard(borrow: borrow);
                },
              ),
            ),
    );
  }
}

class _BorrowItemCard extends StatelessWidget {
  final dynamic borrow;

  const _BorrowItemCard({required this.borrow});

  @override
  Widget build(BuildContext context) {
    final borrowTime = DateTime.tryParse(borrow['borrowTime'] ?? '');
    final deadline = DateTime.tryParse(borrow['deadline'] ?? '');
    final returnTime = DateTime.tryParse(borrow['returnTime'] ?? '');
    final status = borrow['status'] ?? 'Unknown';

    // ✅ Get equipment name - try multiple field names
    final objectName = borrow['objectName'] ??
        borrow['name'] ??
        borrow['equipmentName'] ??
        'Equipment';
    final objectId = borrow['objectId'] ?? '';

    final isOverdue = deadline != null &&
        DateTime.now().isAfter(deadline) &&
        status != 'Returned';

    final isReturned = status == 'Returned';
    final isActive = status == 'Active' || status == 'Borrowed';

    Color statusColor;
    IconData statusIcon;
    String statusText;

    if (isReturned) {
      statusColor = AppColors.success;
      statusIcon = Icons.check_circle;
      statusText = 'RETURNED';
    } else if (isOverdue) {
      statusColor = AppColors.danger;
      statusIcon = Icons.warning;
      statusText = 'OVERDUE';
    } else {
      statusColor = AppColors.warning;
      statusIcon = Icons.inventory_2;
      statusText = 'ACTIVE';
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      child: GlassCard(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header with status badge
            Row(
              children: [
                Icon(statusIcon, color: statusColor, size: 28),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        objectName,
                        style: const TextStyle(
                          color: AppColors.textPrimary,
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      if (objectId.isNotEmpty)
                        Text(
                          'ID: $objectId',
                          style: TextStyle(
                            color: AppColors.textMuted,
                            fontSize: 11,
                          ),
                        ),
                    ],
                  ),
                ),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: statusColor.withOpacity(0.2),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: statusColor.withOpacity(0.5)),
                  ),
                  child: Text(
                    statusText,
                    style: TextStyle(
                      color: statusColor,
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.5,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            const Divider(color: AppColors.surfaceLight),
            const SizedBox(height: 16),

            // Details
            _buildDetailRow(
              icon: Icons.calendar_today,
              label: 'Borrowed On',
              value: borrowTime != null
                  ? '${borrowTime.day}/${borrowTime.month}/${borrowTime.year} at ${borrowTime.hour}:${borrowTime.minute.toString().padLeft(2, '0')}'
                  : 'N/A',
              color: AppColors.neonCyan,
            ),
            const SizedBox(height: 12),

            if (deadline != null)
              _buildDetailRow(
                icon: Icons.access_time,
                label: 'Due Date',
                value: '${deadline.day}/${deadline.month}/${deadline.year}',
                color: isOverdue ? AppColors.danger : AppColors.warning,
              ),
            const SizedBox(height: 12),

            if (returnTime != null)
              _buildDetailRow(
                icon: Icons.assignment_return,
                label: 'Returned On',
                value:
                    '${returnTime.day}/${returnTime.month}/${returnTime.year} at ${returnTime.hour}:${returnTime.minute.toString().padLeft(2, '0')}',
                color: AppColors.success,
              ),

            if (isOverdue) ...[
              const SizedBox(height: 16),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.danger.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.danger.withOpacity(0.3)),
                ),
                child: Row(
                  children: [
                    Icon(Icons.error_outline,
                        color: AppColors.danger, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'This item is overdue. Please return it immediately.',
                        style: TextStyle(
                          color: AppColors.danger,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],

            if (isActive && deadline != null) ...[
              const SizedBox(height: 16),
              _buildCountdownTimer(deadline),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildDetailRow({
    required IconData icon,
    required String label,
    required String value,
    required Color color,
  }) {
    return Row(
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 8),
        Text(
          '$label: ',
          style: TextStyle(
            color: AppColors.textSecondary,
            fontSize: 13,
            fontWeight: FontWeight.w500,
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: TextStyle(
              color: color,
              fontSize: 13,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildCountdownTimer(DateTime deadline) {
    final now = DateTime.now();
    final difference = deadline.difference(now);

    String timeLeft;
    if (difference.inDays > 0) {
      timeLeft =
          '${difference.inDays} day${difference.inDays > 1 ? 's' : ''} left';
    } else if (difference.inHours > 0) {
      timeLeft =
          '${difference.inHours} hour${difference.inHours > 1 ? 's' : ''} left';
    } else if (difference.inMinutes > 0) {
      timeLeft =
          '${difference.inMinutes} minute${difference.inMinutes > 1 ? 's' : ''} left';
    } else {
      timeLeft = 'Due now!';
    }

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.warning.withOpacity(0.1),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppColors.warning.withOpacity(0.3)),
      ),
      child: Row(
        children: [
          // ✅ FIXED: Removed the accidental file path string
          const Icon(Icons.timer, color: AppColors.warning, size: 20),
          const SizedBox(width: 8),
          Text(
            timeLeft,
            style: const TextStyle(
              color: AppColors.warning,
              fontSize: 13,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }
}
