import 'package:flutter/material.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';

class EquipmentListScreen extends StatelessWidget {
  final List<dynamic> equipment;
  final String title;
  final Color headerColor;

  const EquipmentListScreen({
    super.key,
    required this.equipment,
    required this.title,
    required this.headerColor,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: Text(title.toUpperCase()),
        backgroundColor: headerColor.withOpacity(0.2),
        elevation: 0,
      ),
      body: equipment.isEmpty
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.inventory_2_outlined,
                      size: 80, color: AppColors.textMuted),
                  const SizedBox(height: 16),
                  Text(
                    'No equipment found',
                    style: TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 18,
                    ),
                  ),
                ],
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(20),
              itemCount: equipment.length,
              itemBuilder: (context, index) {
                final item = equipment[index];
                return Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: _EquipmentListItem(equipment: item),
                );
              },
            ),
    );
  }
}

class _EquipmentListItem extends StatelessWidget {
  final dynamic equipment;

  const _EquipmentListItem({required this.equipment});

  @override
  Widget build(BuildContext context) {
    final name = equipment['name'] ?? equipment['objectName'] ?? 'Unknown';
    final room = equipment['room'] ?? 'Unknown';
    final objectId = equipment['objectId'] ?? 'N/A';
    final status = equipment['status'] ?? 'Unknown';
    final qrCode = equipment['qrCode'] ?? 'N/A';

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
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Icon(Icons.room, size: 16, color: AppColors.textSecondary),
                    const SizedBox(width: 4),
                    Text(
                      'Room: $room',
                      style: TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Icon(Icons.qr_code, size: 16, color: AppColors.textMuted),
                    const SizedBox(width: 4),
                    Text(
                      'ID: $objectId',
                      style:
                          TextStyle(color: AppColors.textMuted, fontSize: 11),
                    ),
                    const SizedBox(width: 16),
                    Text(
                      'QR: $qrCode',
                      style:
                          TextStyle(color: AppColors.textMuted, fontSize: 11),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
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
