import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:camera/camera.dart';
import 'package:go_router/go_router.dart';
import '../../core/constants.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';
import '../../widgets/glass_card.dart';

class DualAuthScreen extends StatefulWidget {
  final String roomId;
  final String roomName;

  const DualAuthScreen({
    super.key,
    required this.roomId,
    required this.roomName,
  });

  @override
  State<DualAuthScreen> createState() => _DualAuthScreenState();
}

class _DualAuthScreenState extends State<DualAuthScreen>
    with SingleTickerProviderStateMixin {
  final ApiService _apiService = ApiService();

  // Camera
  CameraController? _cameraController;

  // State
  bool _isProcessing = false;
  String _currentStep = 'fingerprint'; // 'fingerprint' | 'face'
  String _status = 'Waiting for fingerprint on the sensor...';
  String _securityLevel = 'LOW';
  bool _fingerprintDone = false;
  bool _faceDone = false;
  String _pendingUserId = '';

  // Polling
  Timer? _pollTimer;
  int _pollCount = 0;
  static const int _maxPollCount = 150; // 5 min max (2s × 150)

  // Pulse animation
  late AnimationController _pulseController;
  late Animation<double> _pulseAnim;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat(reverse: true);
    _pulseAnim = Tween<double>(begin: 0.7, end: 1.0).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    _loadRoomInfo();
  }

  Future<void> _loadRoomInfo() async {
    final response = await _apiService.getRoomSecurityLevel(widget.roomId);
    if (mounted && response['success'] == true) {
      setState(() {
        _securityLevel = response['securityLevel'] ?? 'LOW';
      });
    }
    _startFingerprintPolling();
  }

  // ==================== HARDWARE POLLING ====================
  // Polls backend every 2 seconds for hardware fingerprint result
  void _startFingerprintPolling() {
    _pollTimer?.cancel();
    _pollCount = 0;

    setState(() {
      _status = '👆 Place your finger on the sensor...';
    });

    _pollTimer = Timer.periodic(const Duration(seconds: 2), (timer) async {
      if (!mounted) { timer.cancel(); return; }

      _pollCount++;
      if (_pollCount > _maxPollCount) {
        timer.cancel();
        setState(() => _status = '⏰ Session timed out. Please try again.');
        return;
      }

      final response = await _apiService.checkFingerprintPending(widget.roomId);

      if (response['pending'] == true) {
        timer.cancel();
        final userId = response['userId'] as String? ?? CurrentUser.userId;
        _onFingerprintVerifiedByHardware(userId);
      }
    });
  }

  void _onFingerprintVerifiedByHardware(String userId) {
    setState(() {
      _fingerprintDone = true;
      _pendingUserId = userId;
      _status = '✅ Fingerprint verified by sensor!';
    });

    if (_securityLevel == 'HIGH') {
      // High security: also need face verification via phone camera
      Future.delayed(const Duration(milliseconds: 800), () {
        if (mounted) _initializeCamera();
      });
    } else {
      // LOW/MEDIUM: fingerprint alone is sufficient
      Future.delayed(const Duration(milliseconds: 800), () {
        if (mounted) _completeAccess(fingerprintOk: true, faceOk: false);
      });
    }
  }

  // ==================== FACE CAMERA ====================
  Future<void> _initializeCamera() async {
    try {
      final cameras = await availableCameras();
      final front = cameras.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cameras.first,
      );

      _cameraController = CameraController(front, ResolutionPreset.medium, enableAudio: false);
      await _cameraController!.initialize();

      if (mounted) {
        setState(() {
          _currentStep = 'face';
          _status = '📷 Look directly at the camera and tap Verify Face';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _status = '❌ Camera error: $e');
    }
  }

  Future<void> _verifyFace() async {
    if (_cameraController == null || !_cameraController!.value.isInitialized) return;

    setState(() {
      _isProcessing = true;
      _status = '📸 Capturing face...';
    });

    try {
      final XFile image = await _cameraController!.takePicture();
      final Uint8List imageBytes = await image.readAsBytes();

      setState(() => _status = '🔍 Verifying face with AI...');

      final result = await _apiService.verifyFace(
        userId: _pendingUserId.isNotEmpty ? _pendingUserId : CurrentUser.userId,
        imageBytes: imageBytes,
        roomId: widget.roomId, // Pass roomId so backend sends face_unlock command
      );

      if (!mounted) return;

      if (result['success'] == true) {
        setState(() {
          _faceDone = true;
          _status = '✅ Face verified!';
        });
        await Future.delayed(const Duration(milliseconds: 800));
        _completeAccess(fingerprintOk: true, faceOk: true);
      } else {
        setState(() => _status = '❌ ${result['message'] ?? 'Face not matched'}');
      }
    } catch (e) {
      if (mounted) setState(() => _status = '❌ Error: $e');
    } finally {
      if (mounted) setState(() => _isProcessing = false);
    }
  }

  // ==================== COMPLETE ACCESS ====================
  Future<void> _completeAccess({required bool fingerprintOk, required bool faceOk}) async {
    setState(() => _status = '🔓 Logging access...');

    try {
      await _apiService.logRoomAccess(
        userId: _pendingUserId.isNotEmpty ? _pendingUserId : CurrentUser.userId,
        roomId: widget.roomId,
        fingerprintVerified: fingerprintOk,
        faceVerified: faceOk,
      );
    } catch (_) {}

    if (!mounted) return;

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: const Text('✅ Access granted! Door is opening...'),
        backgroundColor: AppColors.success,
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 4),
      ),
    );

    await Future.delayed(const Duration(seconds: 2));
    if (mounted) context.go('/user');
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _pulseController.dispose();
    _cameraController?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: Text('ACCESS: ${widget.roomName}',
            style: const TextStyle(fontSize: 16, letterSpacing: 1.5)),
        backgroundColor: AppColors.bgDark,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.neonCyan),
          onPressed: () {
            _pollTimer?.cancel();
            context.go('/user');
          },
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            // Security badge
            _SecurityBadge(level: _securityLevel),
            const SizedBox(height: 20),

            // Step indicators (HIGH security only)
            if (_securityLevel == 'HIGH') ...[
              Row(children: [
                Expanded(child: _StepIndicator(step: 1, label: 'Fingerprint',
                    completed: _fingerprintDone, active: !_fingerprintDone)),
                const SizedBox(width: 12),
                Expanded(child: _StepIndicator(step: 2, label: 'Face',
                    completed: _faceDone, active: _fingerprintDone && !_faceDone)),
              ]),
              const SizedBox(height: 20),
            ],

            // Status card
            GlassCard(
              padding: const EdgeInsets.all(24),
              child: Column(
                children: [
                  // Animated fingerprint icon while waiting
                  if (!_fingerprintDone && _currentStep == 'fingerprint')
                    AnimatedBuilder(
                      animation: _pulseAnim,
                      builder: (_, __) => Transform.scale(
                        scale: _pulseAnim.value,
                        child: Icon(Icons.fingerprint,
                            color: AppColors.neonCyan, size: 72),
                      ),
                    )
                  else
                    Icon(
                      _status.contains('✅') ? Icons.check_circle
                          : _status.contains('❌') ? Icons.cancel
                          : _currentStep == 'face' ? Icons.face
                          : Icons.fingerprint,
                      color: _status.contains('✅') ? AppColors.success
                          : _status.contains('❌') ? AppColors.danger
                          : AppColors.neonCyan,
                      size: 64,
                    ),
                  const SizedBox(height: 16),
                  Text(_status,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  if (!_fingerprintDone) ...[
                    const SizedBox(height: 12),
                    const Text(
                      'The door sensor is waiting for your fingerprint.\nThis happens automatically — no button to press.',
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ],
              ),
            ),

            const SizedBox(height: 20),

            // Camera preview (face step)
            if (_currentStep == 'face' && _cameraController != null &&
                _cameraController!.value.isInitialized) ...[
              Container(
                height: 280,
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.neonPurple, width: 3),
                  borderRadius: BorderRadius.circular(20),
                ),
                clipBehavior: Clip.antiAlias,
                child: Stack(
                  children: [
                    CameraPreview(_cameraController!),
                    // Face outline
                    Center(
                      child: Container(
                        width: 180,
                        height: 230,
                        decoration: BoxDecoration(
                          border: Border.all(color: AppColors.neonPurple.withOpacity(0.8), width: 2),
                          borderRadius: BorderRadius.circular(120),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton.icon(
                  onPressed: _isProcessing ? null : _verifyFace,
                  icon: _isProcessing
                      ? const SizedBox(width: 20, height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Icon(Icons.face, size: 24),
                  label: Text(_isProcessing ? 'VERIFYING...' : 'VERIFY FACE',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, letterSpacing: 2)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.neonPurple,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
            ],

            const SizedBox(height: 20),

            // Instructions card
            GlassCard(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('HOW THIS WORKS', style: TextStyle(
                    color: AppColors.neonCyan, fontWeight: FontWeight.bold,
                    fontSize: 11, letterSpacing: 2)),
                  const SizedBox(height: 10),
                  if (_securityLevel == 'HIGH') ...[
                    _infoRow(Icons.looks_one, 'Place finger on physical sensor', AppColors.danger),
                    _infoRow(Icons.looks_two, 'Face is captured by wall camera', AppColors.warning),
                    _infoRow(Icons.looks_3, 'App verifies face + unlocks door', AppColors.success),
                  ] else ...[
                    _infoRow(Icons.fingerprint, 'Place finger on physical sensor', AppColors.neonCyan),
                    _infoRow(Icons.door_front_door, 'Door opens automatically', AppColors.success),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _infoRow(IconData icon, String text, Color color) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 10),
          Expanded(child: Text(text,
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 13))),
        ],
      ),
    );
  }
}

// ==================== SUPPORTING WIDGETS ====================

class _SecurityBadge extends StatelessWidget {
  final String level;
  const _SecurityBadge({required this.level});

  @override
  Widget build(BuildContext context) {
    final color = level == 'HIGH' ? AppColors.danger
        : level == 'MEDIUM' ? AppColors.warning
        : AppColors.success;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
      decoration: BoxDecoration(
        color: color.withOpacity(0.15),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(level == 'HIGH' ? Icons.security : Icons.shield, color: color, size: 16),
          const SizedBox(width: 8),
          Text('$level SECURITY',
            style: TextStyle(color: color, fontWeight: FontWeight.bold, letterSpacing: 2, fontSize: 13)),
        ],
      ),
    );
  }
}

class _StepIndicator extends StatelessWidget {
  final int step;
  final String label;
  final bool completed;
  final bool active;

  const _StepIndicator({
    required this.step, required this.label,
    required this.completed, required this.active,
  });

  @override
  Widget build(BuildContext context) {
    final color = completed ? AppColors.success
        : active ? AppColors.neonCyan
        : AppColors.textMuted;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color, width: completed || active ? 2 : 1),
      ),
      child: Column(
        children: [
          Icon(completed ? Icons.check_circle : Icons.circle_outlined, color: color, size: 28),
          const SizedBox(height: 6),
          Text('Step $step', style: TextStyle(color: AppColors.textSecondary, fontSize: 10)),
          Text(label, style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 12)),
        ],
      ),
    );
  }
}
