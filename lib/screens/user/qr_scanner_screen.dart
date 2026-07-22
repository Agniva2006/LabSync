import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:go_router/go_router.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';

class QRScannerScreen extends StatefulWidget {
  final bool isReturn;

  const QRScannerScreen({super.key, this.isReturn = false});

  @override
  State<QRScannerScreen> createState() => _QRScannerScreenState();
}

class _QRScannerScreenState extends State<QRScannerScreen> {
  final MobileScannerController cameraController = MobileScannerController();
  final ApiService _apiService = ApiService();
  bool _isProcessing = false;
  String? _lastScannedCode;
  bool _hasPermission = true;

  @override
  void initState() {
    super.initState();
    _checkCameraPermission();
  }

  Future<void> _checkCameraPermission() async {
    try {
      await cameraController.start();
    } catch (e) {
      setState(() => _hasPermission = false);
      if (mounted) {
        _showErrorDialog(
            'Camera permission denied. Please enable camera access in settings.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: Text(widget.isReturn ? 'RETURN EQUIPMENT' : 'REQUEST EQUIPMENT'),
        backgroundColor: AppColors.bgDark,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.neonCyan),
          onPressed: () => Navigator.pop(context),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.flash_on, color: AppColors.neonCyan),
            onPressed: () => cameraController.toggleTorch(),
            tooltip: 'Toggle Flash',
          ),
          IconButton(
            icon: const Icon(Icons.cameraswitch, color: AppColors.neonCyan),
            onPressed: () => cameraController.switchCamera(),
            tooltip: 'Switch Camera',
          ),
        ],
      ),
      body: Stack(
        children: [
          if (_hasPermission)
            MobileScanner(
              controller: cameraController,
              onDetect: (BarcodeCapture capture) async {
                if (_isProcessing) return;

                final List<Barcode> barcodes = capture.barcodes;
                for (final barcode in barcodes) {
                  if (barcode.rawValue != null &&
                      barcode.rawValue != _lastScannedCode) {
                    HapticFeedback.mediumImpact();

                    setState(() {
                      _lastScannedCode = barcode.rawValue;
                      _isProcessing = true;
                    });

                    await _processQRScan(barcode.rawValue!);

                    if (mounted) {
                      setState(() {
                        _isProcessing = false;
                        _lastScannedCode = null;
                      });
                    }
                  }
                }
              },
            )
          else
            Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  // ✅ FIXED: Changed from camera_alt_off to no_photography
                  Icon(Icons.no_photography,
                      size: 80, color: AppColors.textMuted),
                  const SizedBox(height: 16),
                  const Text(
                    'Camera Access Required',
                    style:
                        TextStyle(color: AppColors.textPrimary, fontSize: 18),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Please enable camera permission in settings',
                    style:
                        TextStyle(color: AppColors.textSecondary, fontSize: 14),
                  ),
                  const SizedBox(height: 24),
                  ElevatedButton(
                    onPressed: _checkCameraPermission,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          Positioned.fill(
            child: CustomPaint(painter: ScannerOverlayPainter()),
          ),
          Positioned(
            top: 80,
            left: 0,
            right: 0,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: GlassCard(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    Text(
                      widget.isReturn ? 'SCAN TO RETURN' : 'SCAN TO REQUEST',
                      style: const TextStyle(
                        color: AppColors.neonCyan,
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 2,
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Align QR code within the frame',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 14,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (_isProcessing)
            Container(
              color: Colors.black.withOpacity(0.8),
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const SizedBox(
                      width: 60,
                      height: 60,
                      child: CircularProgressIndicator(
                        color: AppColors.neonCyan,
                        strokeWidth: 4,
                      ),
                    ),
                    const SizedBox(height: 24),
                    const Text(
                      'PROCESSING...',
                      style: TextStyle(
                        color: AppColors.neonCyan,
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 2,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  String _cleanQRCode(String raw) {
    final trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        final data = jsonDecode(trimmed);
        return data['id'] ?? data['objectId'] ?? data['qrCode'] ?? data['code'] ?? trimmed;
      } catch (_) {}
    }
    if (trimmed.contains('/equipment/')) {
      return trimmed.split('/equipment/').last;
    }
    return trimmed;
  }

  // ==================== MAIN LOGIC ====================
  Future<void> _processQRScan(String rawQrCode) async {
    final qrCode = _cleanQRCode(rawQrCode);
    print('📷 Scanned QR raw="$rawQrCode" -> clean="$qrCode"');

    final userId = CurrentUser.userId ?? '';
    if (userId.isEmpty) {
      _showErrorDialog('User not logged in. Please login again.');
      return;
    }

    // Verify equipment existence from DB via Backend QR scan API
    final verifyResult = await _apiService.scanQR(qrCode, 'verify', userId);
    final eqObj = verifyResult['object'] ?? verifyResult['data'] ?? {};
    final eqStatus = (eqObj['status'] ?? '').toString().toLowerCase();

    // Check if user has active borrows for this equipment
    final activeBorrows = await _apiService.getActiveBorrows();
    final userBorrows = (activeBorrows['data'] ?? [])
        .where((b) =>
            b['userId'] == userId &&
            (b['equipmentId'] == qrCode || b['objectId'] == qrCode))
        .toList();

    print('🔄 User borrows for $qrCode: ${userBorrows.length}, EQ Status: $eqStatus');

    if (widget.isReturn || eqStatus == 'borrowed' || userBorrows.isNotEmpty) {
      // Equipment is borrowed - show RETURN option
      await _showReturnDialog(qrCode, userBorrows.isNotEmpty ? userBorrows.first : {'objectId': qrCode});
    } else {
      // Equipment is available - check approved request or direct borrow
      final userRequests = await _apiService.getUserRequests(userId);
      final approvedRequest = (userRequests['data'] ?? [])
          .where((r) =>
              (r['equipment'] == qrCode || r['equipmentId'] == qrCode) &&
              r['status']?.toLowerCase() == 'approved')
          .toList();

      if (approvedRequest.isNotEmpty || widget.isReturn == false) {
        // Direct Borrow or Approved Request
        await _showBorrowDialog(qrCode);
      } else {
        // Show Request Dialog
        await cameraController.stop();
        final requestData = await _showRequestDialog(qrCode);
        if (mounted) await cameraController.start();

        if (requestData != null) {
          final result = await _apiService.createEquipmentRequest(
            userId: userId,
            userName: CurrentUser.name ?? 'User',
            equipmentId: qrCode,
            equipmentName: requestData['equipmentName'] ?? qrCode,
            roomId: requestData['roomId'] ?? 'Lab',
            purpose: requestData['purpose'] ?? '',
            duration: requestData['duration'] ?? '2 hours',
          );

          if (!mounted) return;

          if (result['success'] == true) {
            HapticFeedback.heavyImpact();
            _showRequestSuccessDialog(result['requestId'] ?? 'REQ-XXX');
          } else {
            _showErrorDialog(result['message'] ?? 'Failed to create request');
          }
        }
      }
    }
  }

  // ==================== RETURN DIALOG ====================
  Future<void> _showReturnDialog(
      String qrCode, Map<String, dynamic> borrow) async {
    final borrowId = borrow['borrowId'] ?? borrow['borrowid'] ?? '';
    final equipmentName =
        borrow['equipmentName'] ?? borrow['equipmentname'] ?? qrCode;
    final borrowDate = borrow['borrowDate'] ?? borrow['borrowdate'] ?? '';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: AppColors.warning.withOpacity(0.3)),
        ),
        title: Row(
          children: [
            // ✅ FIXED: Changed from return_item to replay
            Icon(Icons.replay, color: AppColors.warning),
            const SizedBox(width: 8),
            const Text(
              'Return Equipment?',
              style: TextStyle(color: AppColors.textPrimary, fontSize: 18),
            ),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Text('Equipment: ',
                          style: TextStyle(color: AppColors.textSecondary)),
                      Expanded(
                        child: Text(equipmentName,
                            style: const TextStyle(
                                color: AppColors.neonCyan,
                                fontWeight: FontWeight.bold)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      const Text('Borrowed: ',
                          style: TextStyle(color: AppColors.textSecondary)),
                      Text(_formatDate(borrowDate),
                          style: const TextStyle(color: AppColors.textPrimary)),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Are you sure you want to return this equipment?',
              style: TextStyle(color: AppColors.textSecondary, fontSize: 14),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel',
                style: TextStyle(color: AppColors.textSecondary)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.warning,
              foregroundColor: AppColors.bgDark,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8)),
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Return Now',
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
      final result =
          await _apiService.scanQR(qrCode, 'return', CurrentUser.userId ?? '');

      if (!mounted) return;
      Navigator.pop(context); // Close loading

      if (result['success'] == true) {
        HapticFeedback.heavyImpact();
        _showSuccessDialog(
            result['message'] ?? 'Equipment returned successfully',
            result['object']);
      } else {
        _showErrorDialog(result['message'] ?? 'Failed to return equipment');
      }
    } catch (e) {
      if (!mounted) return;
      Navigator.pop(context);
      _showErrorDialog('Error: $e');
    }
  }

  // ==================== BORROW DIALOG ====================
  Future<void> _showBorrowDialog(String qrCode) async {
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
            const Text(
              'Borrow Equipment?',
              style: TextStyle(color: AppColors.textPrimary, fontSize: 18),
            ),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  const Text('Equipment ID: ',
                      style: TextStyle(color: AppColors.textSecondary)),
                  Text(qrCode,
                      style: const TextStyle(
                          color: AppColors.neonCyan,
                          fontWeight: FontWeight.bold)),
                ],
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Your request has been approved. Do you want to borrow this equipment now?',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.textSecondary, fontSize: 14),
            ),
          ],
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
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8)),
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Borrow Now',
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
      final result =
          await _apiService.scanQR(qrCode, 'borrow', CurrentUser.userId ?? '');

      if (!mounted) return;
      Navigator.pop(context); // Close loading

      if (result['success'] == true) {
        HapticFeedback.heavyImpact();
        _showSuccessDialog(
            result['message'] ?? 'Equipment borrowed successfully',
            result['object']);
      } else {
        _showErrorDialog(result['message'] ?? 'Failed to borrow equipment');
      }
    } catch (e) {
      if (!mounted) return;
      Navigator.pop(context);
      _showErrorDialog('Error: $e');
    }
  }

  // ==================== REQUEST FORM DIALOG ====================
  Future<Map<String, String>?> _showRequestDialog(String equipmentId) async {
    final purposeController = TextEditingController();
    final durationController = TextEditingController(text: '2 hours');

    return await showDialog<Map<String, String>>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: AppColors.neonCyan.withOpacity(0.3)),
        ),
        title: Row(
          children: [
            Icon(Icons.assignment_ind, color: AppColors.neonCyan),
            const SizedBox(width: 8),
            const Text('Request Equipment',
                style: TextStyle(color: AppColors.textPrimary, fontSize: 18)),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  const Text('Equipment ID: ',
                      style: TextStyle(color: AppColors.textSecondary)),
                  Text(equipmentId,
                      style: const TextStyle(
                          color: AppColors.neonCyan,
                          fontWeight: FontWeight.bold)),
                ],
              ),
            ),
            const SizedBox(height: 20),
            const Text('PURPOSE',
                style: TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                    letterSpacing: 1)),
            const SizedBox(height: 8),
            TextField(
              controller: purposeController,
              style: const TextStyle(color: AppColors.textPrimary),
              maxLines: 2,
              decoration: InputDecoration(
                hintText: 'e.g., Digital Logic Lab Project',
                hintStyle: TextStyle(color: AppColors.textMuted),
                filled: true,
                fillColor: AppColors.bgDark,
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide: BorderSide.none),
              ),
            ),
            const SizedBox(height: 16),
            const Text('DURATION',
                style: TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                    letterSpacing: 1)),
            const SizedBox(height: 8),
            TextField(
              controller: durationController,
              style: const TextStyle(color: AppColors.textPrimary),
              decoration: InputDecoration(
                hintText: 'e.g., 2 hours, 1 day',
                hintStyle: TextStyle(color: AppColors.textMuted),
                filled: true,
                fillColor: AppColors.bgDark,
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                    borderSide: BorderSide.none),
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
              backgroundColor: AppColors.neonCyan,
              foregroundColor: AppColors.bgDark,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8)),
            ),
            onPressed: () {
              if (purposeController.text.isEmpty) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Please enter a purpose')),
                );
                return;
              }
              Navigator.pop(context, {
                'equipmentName': equipmentId,
                'roomId': 'Lab',
                'purpose': purposeController.text.trim(),
                'duration': durationController.text.trim(),
              });
            },
            child: const Text('Send Request',
                style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  // ==================== SUCCESS/ERROR DIALOGS ====================
  void _showSuccessDialog(String message, dynamic object) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: AppColors.success.withOpacity(0.3)),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.check_circle, size: 64, color: AppColors.success),
            const SizedBox(height: 16),
            Text(
              'SUCCESS',
              style: TextStyle(
                  color: AppColors.success,
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 2),
            ),
            const SizedBox(height: 8),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(
                    color: AppColors.textPrimary, fontSize: 14)),
            if (object != null) ...[
              const SizedBox(height: 16),
              GlassCard(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    Text(object['name'] ?? object['objectName'] ?? 'Equipment',
                        style: const TextStyle(
                            color: AppColors.neonCyan,
                            fontSize: 16,
                            fontWeight: FontWeight.bold)),
                    const SizedBox(height: 4),
                    Text('Room: ${object['room'] ?? 'Unknown'}',
                        style: TextStyle(
                            color: AppColors.textSecondary, fontSize: 12)),
                  ],
                ),
              ),
            ],
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.of(context).pop();
              Navigator.of(context).pop();
            },
            style: TextButton.styleFrom(
                backgroundColor: AppColors.success,
                foregroundColor: AppColors.bgDark),
            child: const Text('DONE'),
          ),
        ],
      ),
    );
  }

  void _showRequestSuccessDialog(String requestId) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: AppColors.warning.withOpacity(0.3)),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.hourglass_top, size: 64, color: AppColors.warning),
            const SizedBox(height: 16),
            Text('REQUEST SENT',
                style: TextStyle(
                    color: AppColors.warning,
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 2)),
            const SizedBox(height: 8),
            const Text(
                'Your request has been sent to the Admin. You will be notified once it is approved.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.textPrimary, fontSize: 14)),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                  color: AppColors.bgDark,
                  borderRadius: BorderRadius.circular(8)),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Text('Request ID: ',
                      style: TextStyle(color: AppColors.textSecondary)),
                  Text(requestId,
                      style: const TextStyle(
                          color: AppColors.neonCyan,
                          fontWeight: FontWeight.bold)),
                ],
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.of(context).pop();
              context.go('/user/requests');
            },
            style: TextButton.styleFrom(
                backgroundColor: AppColors.warning,
                foregroundColor: AppColors.bgDark),
            child: const Text('VIEW REQUESTS'),
          ),
          TextButton(
            onPressed: () {
              Navigator.of(context).pop();
              Navigator.of(context).pop();
            },
            style: TextButton.styleFrom(
                backgroundColor: AppColors.neonCyan,
                foregroundColor: AppColors.bgDark),
            child: const Text('DASHBOARD'),
          ),
        ],
      ),
    );
  }

  void _showErrorDialog(String message) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: AppColors.danger.withOpacity(0.3)),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error, size: 64, color: AppColors.danger),
            const SizedBox(height: 16),
            Text('ERROR',
                style: TextStyle(
                    color: AppColors.danger,
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 2)),
            const SizedBox(height: 8),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(
                    color: AppColors.textPrimary, fontSize: 14)),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            style: TextButton.styleFrom(
                backgroundColor: AppColors.danger,
                foregroundColor: AppColors.bgDark),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  String _formatDate(String? dateString) {
    if (dateString == null || dateString.isEmpty) return 'Unknown';
    try {
      final date = DateTime.parse(dateString);
      return '${date.day}/${date.month}/${date.year} ${date.hour}:${date.minute.toString().padLeft(2, '0')}';
    } catch (e) {
      return dateString;
    }
  }

  @override
  void dispose() {
    cameraController.dispose();
    super.dispose();
  }
}

// ==================== SCANNER OVERLAY ====================
class ScannerOverlayPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(
      Rect.fromLTWH(0, 0, size.width, size.height),
      Paint()..color = Colors.black.withOpacity(0.6),
    );

    final scannerSize = size.width * 0.7;
    final scannerLeft = (size.width - scannerSize) / 2;
    final scannerTop = (size.height - scannerSize) / 2;
    final scannerRect =
        Rect.fromLTWH(scannerLeft, scannerTop, scannerSize, scannerSize);

    canvas.drawRect(
      scannerRect,
      Paint()
        ..color = Colors.transparent
        ..blendMode = BlendMode.clear,
    );

    canvas.drawRect(
      scannerRect,
      Paint()
        ..color = AppColors.neonCyan
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3,
    );

    _drawCornerMarkers(canvas, scannerRect);
  }

  void _drawCornerMarkers(Canvas canvas, Rect rect) {
    final markerLength = rect.width * 0.15;
    final paint = Paint()
      ..color = AppColors.neonCyan
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4;

    canvas.drawLine(Offset(rect.left, rect.top + markerLength),
        Offset(rect.left, rect.top), paint);
    canvas.drawLine(Offset(rect.left, rect.top),
        Offset(rect.left + markerLength, rect.top), paint);
    canvas.drawLine(Offset(rect.right - markerLength, rect.top),
        Offset(rect.right, rect.top), paint);
    canvas.drawLine(Offset(rect.right, rect.top),
        Offset(rect.right, rect.top + markerLength), paint);
    canvas.drawLine(Offset(rect.left, rect.bottom - markerLength),
        Offset(rect.left, rect.bottom), paint);
    canvas.drawLine(Offset(rect.left, rect.bottom),
        Offset(rect.left + markerLength, rect.bottom), paint);
    canvas.drawLine(Offset(rect.right - markerLength, rect.bottom),
        Offset(rect.right, rect.bottom), paint);
    canvas.drawLine(Offset(rect.right, rect.bottom),
        Offset(rect.right, rect.bottom - markerLength), paint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
