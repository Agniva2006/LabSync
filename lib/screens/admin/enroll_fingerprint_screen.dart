import 'package:flutter/material.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';

class EnrollFingerprintScreen extends StatefulWidget {
  final String userId;
  final String userName;
  final String roomId;

  const EnrollFingerprintScreen({
    super.key,
    required this.userId,
    required this.userName,
    this.roomId = 'ROOM-001',
  });

  @override
  State<EnrollFingerprintScreen> createState() =>
      _EnrollFingerprintScreenState();
}

class _EnrollFingerprintScreenState extends State<EnrollFingerprintScreen> {
  final ApiService _apiService = ApiService();
  String _status = 'Ready to enroll';
  bool _isEnrolling = false;
  bool _enrollmentComplete = false;

  Future<void> _startEnrollment() async {
    setState(() {
      _isEnrolling = true;
      _status = 'Sending enrollment command to ESP32...';
    });

    try {
      // Send enrollment command via startEnrollment API
      final result = await _apiService.startEnrollment(
        roomId: widget.roomId,
        userId: widget.userId,
        userName: widget.userName,
      );

      if (result['success'] == true) {
        setState(() {
          _status = '✅ ESP32 is waiting for fingerprint!\n\n'
              'Ask the user to:\n'
              '1. Place finger on sensor (1st scan)\n'
              '2. Remove finger\n'
              '3. Place SAME finger again (2nd scan)\n'
              '4. Wait for green LED blink';
        });

        // Poll for completion
        _pollEnrollmentStatus();
      } else {
        setState(() {
          _status = '❌ Failed: ${result['message']}';
          _isEnrolling = false;
        });
      }
    } catch (e) {
      setState(() {
        _status = '❌ Error: $e';
        _isEnrolling = false;
      });
    }
  }

  Future<void> _pollEnrollmentStatus() async {
    int attempts = 0;
    const maxAttempts = 30; // 30 seconds max

    while (attempts < maxAttempts && mounted) {
      await Future.delayed(const Duration(seconds: 1));
      attempts++;

      try {
        final status = await _apiService.getEnrollmentStatus(widget.userId);

        if (status['success'] == true) {
          if (status['enrolled'] == true) {
            setState(() {
              _enrollmentComplete = true;
              _isEnrolling = false;
              _status = '✅ ✅ ✅ ENROLLMENT SUCCESSFUL!\n\n'
                  'Fingerprint ID: ${status['fingerprintId']}\n'
                  'User can now use the door!';
            });
            return;
          } else if (status['failed'] == true) {
            setState(() {
              _isEnrolling = false;
              _status = '❌ ENROLLMENT FAILED!\n\n'
                  'Error: ${status['error']}\n'
                  'Details: ${status['details']}\n\n'
                  'Please try again.';
            });
            return;
          }
        }
      } catch (e) {
        print('Poll error: $e');
      }

      setState(() {
        _status = '⏳ Waiting for user to place finger... (${attempts}s)';
      });
    }

    if (!_enrollmentComplete && mounted) {
      setState(() {
        _status = '❌ Enrollment timed out. Try again.';
        _isEnrolling = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('ENROLL FINGERPRINT'),
        backgroundColor: AppColors.bgDark,
      ),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            GlassCard(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  Icon(
                    _enrollmentComplete
                        ? Icons.check_circle
                        : _isEnrolling
                            ? Icons.fingerprint
                            : Icons.how_to_reg,
                    size: 80,
                    color: _enrollmentComplete
                        ? AppColors.success
                        : _isEnrolling
                            ? AppColors.warning
                            : AppColors.neonCyan,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    widget.userName,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  Text(
                    widget.userId,
                    style: const TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 14,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            GlassCard(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'STATUS:',
                    style: TextStyle(
                      color: AppColors.neonCyan,
                      fontSize: 12,
                      letterSpacing: 2,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    _status,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 14,
                    ),
                  ),
                ],
              ),
            ),
            const Spacer(),
            if (!_enrollmentComplete)
              SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton.icon(
                  onPressed: _isEnrolling ? null : _startEnrollment,
                  icon: _isEnrolling
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: AppColors.bgDark,
                          ),
                        )
                      : const Icon(Icons.fingerprint, size: 24),
                  label: Text(
                    _isEnrolling ? 'WAITING FOR FINGER...' : 'START ENROLLMENT',
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 2,
                    ),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.neonCyan,
                    foregroundColor: AppColors.bgDark,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ),
            if (_enrollmentComplete)
              SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton.icon(
                  onPressed: () => Navigator.pop(context, true),
                  icon: const Icon(Icons.check, size: 24),
                  label: const Text(
                    'DONE',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 2,
                    ),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.success,
                    foregroundColor: AppColors.bgDark,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
