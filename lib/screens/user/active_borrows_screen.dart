import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../widgets/custom_shimmer.dart';
import '../../services/api_service.dart';

class ActiveBorrowsScreen extends StatefulWidget {
  const ActiveBorrowsScreen({super.key});

  @override
  State<ActiveBorrowsScreen> createState() => _ActiveBorrowsScreenState();
}

class _ActiveBorrowsScreenState extends State<ActiveBorrowsScreen> {
  final ApiService _apiService = ApiService();
  bool _isLoading = true;
  List<dynamic> _borrows = [];

  @override
  void initState() {
    super.initState();
    _fetchBorrows();
  }

  Future<void> _fetchBorrows() async {
    setState(() => _isLoading = true);

    final result = await _apiService.getActiveBorrows();

    if (result['success'] == true) {
      setState(() {
        _borrows = result['data'] ?? [];
      });
    }

    setState(() => _isLoading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('ACTIVE BORROWS'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: AppColors.neonCyan),
            onPressed: _fetchBorrows,
          ),
        ],
      ),
      body: _isLoading
          ? const CustomShimmer()
          : _borrows.isEmpty
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
                        'NO ACTIVE BORROWS',
                        style: TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 16,
                          letterSpacing: 2,
                        ),
                      ),
                    ],
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.all(20),
                  itemCount: _borrows.length,
                  itemBuilder: (context, index) {
                    final borrow = _borrows[index];
                    return _BorrowCard(borrow: borrow)
                        .animate()
                        .fade(
                            duration: 400.ms,
                            delay: Duration(milliseconds: index * 100))
                        .slideY(begin: 0.1);
                  },
                ),
    );
  }
}

class _BorrowCard extends StatelessWidget {
  final dynamic borrow;

  const _BorrowCard({required this.borrow});

  @override
  Widget build(BuildContext context) {
    // Mock object data since our API doesn't join tables yet
    final objectId = borrow['objectId'] ?? '';
    final objectName =
        objectId == 'OBJ-001' ? 'Digital Oscilloscope' : 'Equipment #$objectId';

    return GlassCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 4,
                height: 60,
                decoration: BoxDecoration(
                  color: AppColors.neonCyan,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      objectName,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Borrowed: ${borrow['borrowTime']?.substring(0, 10) ?? 'Unknown'}',
                      style: TextStyle(
                          color: AppColors.textSecondary, fontSize: 12),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          LinearProgressIndicator(
            value: 0.6,
            backgroundColor: AppColors.surfaceLight,
            valueColor: const AlwaysStoppedAnimation<Color>(AppColors.neonCyan),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Time Remaining:',
                  style: TextStyle(color: AppColors.textSecondary)),
              Text(
                borrow['deadline'] ?? '24h 00m',
                style: const TextStyle(
                    color: AppColors.warning, fontWeight: FontWeight.bold),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
