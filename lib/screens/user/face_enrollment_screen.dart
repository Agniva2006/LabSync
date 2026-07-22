import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:camera/camera.dart';
import 'package:go_router/go_router.dart';
import '../../core/constants.dart';
import '../../services/api_service.dart';
import '../../core/current_user.dart';

class FaceEnrollmentScreen extends StatefulWidget {
  final String? targetUserId;
  final String? targetUserName;

  const FaceEnrollmentScreen({
    super.key,
    this.targetUserId,
    this.targetUserName,
  });

  @override
  State<FaceEnrollmentScreen> createState() => _FaceEnrollmentScreenState();
}

class _FaceEnrollmentScreenState extends State<FaceEnrollmentScreen> {
  final ApiService _apiService = ApiService();
  CameraController? _cameraController;
  bool _isProcessing = false;
  bool _isCameraInitialized = false;
  String _status = 'Position your face in the frame';
  bool _isEnrolled = false;
  double _progress = 0.0;

  String get activeUserId =>
      (widget.targetUserId != null && widget.targetUserId!.isNotEmpty)
          ? widget.targetUserId!
          : CurrentUser.userId;

  String get activeUserName =>
      (widget.targetUserName != null && widget.targetUserName!.isNotEmpty)
          ? widget.targetUserName!
          : CurrentUser.name;

  @override
  void initState() {
    super.initState();
    _initializeCamera();
    _checkEnrollmentStatus();
  }

  Future<void> _checkEnrollmentStatus() async {
    try {
      final status = await _apiService.getFaceStatus(activeUserId);
      if (mounted) {
        setState(() {
          _isEnrolled = status['enrolled'] == true;
          if (_isEnrolled) {
            _status = '✅ Face already enrolled for $activeUserName';
          }
        });
      }
    } catch (e) {
      print('❌ Error checking enrollment status: $e');
    }
  }

  Future<void> _initializeCamera() async {
    try {
      final cameras = await availableCameras();

      // Try to find front camera, fallback to any camera
      CameraDescription? frontCamera;
      for (final camera in cameras) {
        if (camera.lensDirection == CameraLensDirection.front) {
          frontCamera = camera;
          break;
        }
      }

      final selectedCamera = frontCamera ?? cameras.first;

      _cameraController = CameraController(
        selectedCamera,
        ResolutionPreset.medium,
        enableAudio: false,
      );

      await _cameraController!.initialize();

      if (!mounted) return;

      setState(() {
        _isCameraInitialized = true;
        _status = 'Camera ready. Position your face in the frame';
      });

      HapticFeedback.lightImpact();
    } catch (e) {
      print('❌ Error initializing camera: $e');
      if (mounted) {
        setState(() {
          _status = '❌ Camera error: $e';
        });
      }
    }
  }

  Future<void> _enrollFace() async {
    if (_cameraController == null || !_cameraController!.value.isInitialized) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Camera not ready. Please wait...'),
          backgroundColor: AppColors.warning,
        ),
      );
      return;
    }

    setState(() {
      _isProcessing = true;
      _progress = 0.0;
      _status = '🔔 Waking up backend (this may take 30s)...';
    });

    try {
      // ✅ STEP 1: Wake up backend first
      await _apiService.wakeUpBackend();

      if (!mounted) return;
      setState(() {
        _progress = 0.2;
        _status = '✅ Backend awake. Capturing image...';
      });

      HapticFeedback.mediumImpact();

      // ✅ STEP 2: Capture image
      final XFile image = await _cameraController!.takePicture();
      Uint8List imageBytes = await image.readAsBytes();

      if (!mounted) return;
      setState(() {
        _progress = 0.4;
        _status = '📸 Image captured. Compressing...';
      });

      // ✅ STEP 3: Compress image if too large (reduce upload time)
      if (imageBytes.length > 1000000) {
        // If larger than 1MB
        print(
            '⚠️ Image size: ${(imageBytes.length / 1024 / 1024).toStringAsFixed(2)} MB - Compressing...');
        // Note: For better compression, use image package
        // For now, we'll send as-is but the backend should handle it
      }

      if (!mounted) return;
      setState(() {
        _progress = 0.5;
        _status = '📤 Uploading to backend (please wait up to 2 minutes)...';
      });

      // ✅ STEP 4: Enroll face with extended timeout
      final result = await _apiService.enrollFaceWithExtendedTimeout(
        userId: activeUserId,
        userName: activeUserName,
        imageBytes: imageBytes,
      );

      if (!mounted) return;

      if (result['success'] == true) {
        setState(() {
          _progress = 1.0;
          _status = '✅ Face enrolled successfully!';
          _isEnrolled = true;
        });

        HapticFeedback.heavyImpact();

        await Future.delayed(const Duration(seconds: 2));
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('✅ Face enrolled successfully!'),
              backgroundColor: AppColors.success,
              behavior: SnackBarBehavior.floating,
            ),
          );
          if (Navigator.canPop(context)) {
            Navigator.pop(context);
          } else {
            context.go('/user');
          }
        }
      } else {
        setState(() {
          _status = '❌ ${result['message']}';
        });
        HapticFeedback.lightImpact();
      }
    } catch (e) {
      print('❌ Enroll error: $e');
      if (mounted) {
        setState(() {
          _status =
              '❌ Error: ${e.toString().substring(0, e.toString().length > 100 ? 100 : e.toString().length)}';
        });
        HapticFeedback.lightImpact();
      }
    } finally {
      if (mounted) {
        setState(() {
          _isProcessing = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _cameraController?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: Text(widget.targetUserId != null ? 'ENROLL USER FACE' : 'ENROLL YOUR FACE'),
        backgroundColor: AppColors.bgDark,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.neonCyan),
          onPressed: () {
            if (Navigator.canPop(context)) {
              Navigator.pop(context);
            } else {
              context.go('/user');
            }
          },
        ),
      ),
      body: SingleChildScrollView(
        child: Column(
          children: [
            const SizedBox(height: 20),

            // Camera Preview
            Container(
              height: 300,
              margin: const EdgeInsets.symmetric(horizontal: 20),
              decoration: BoxDecoration(
                border: Border.all(color: AppColors.neonCyan, width: 3),
                borderRadius: BorderRadius.circular(20),
              ),
              clipBehavior: Clip.antiAlias,
              child: _isCameraInitialized
                  ? Stack(
                      children: [
                        CameraPreview(_cameraController!),
                        // Face outline overlay
                        Center(
                          child: Container(
                            width: 200,
                            height: 250,
                            decoration: BoxDecoration(
                              border: Border.all(
                                color: _isProcessing
                                    ? AppColors.warning
                                    : AppColors.neonCyan,
                                width: 2,
                              ),
                              borderRadius: BorderRadius.circular(100),
                            ),
                          ),
                        ),
                      ],
                    )
                  : const Center(
                      child:
                          CircularProgressIndicator(color: AppColors.neonCyan),
                    ),
            ),

            const SizedBox(height: 20),

            // Progress Bar (only shown during processing)
            if (_isProcessing)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Column(
                  children: [
                    LinearProgressIndicator(
                      value: _progress,
                      backgroundColor: AppColors.surfaceDark,
                      valueColor: const AlwaysStoppedAnimation<Color>(
                          AppColors.neonCyan),
                      minHeight: 8,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '${(_progress * 100).toInt()}%',
                      style: const TextStyle(
                        color: AppColors.neonCyan,
                        fontSize: 14,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),

            const SizedBox(height: 20),

            // Status
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Text(
                _status,
                style: TextStyle(
                  color: _status.contains('✅')
                      ? AppColors.success
                      : _status.contains('❌')
                          ? AppColors.danger
                          : AppColors.textPrimary,
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                ),
                textAlign: TextAlign.center,
              ),
            ),

            const SizedBox(height: 20),

            // Instructions
            Container(
              padding: const EdgeInsets.all(16),
              margin: const EdgeInsets.symmetric(horizontal: 20),
              decoration: BoxDecoration(
                color: AppColors.surfaceDark,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.neonCyan.withOpacity(0.3)),
              ),
              child: Column(
                children: [
                  const Icon(Icons.info_outline,
                      color: AppColors.neonCyan, size: 32),
                  const SizedBox(height: 8),
                  const Text(
                    'Instructions:',
                    style: TextStyle(
                      color: AppColors.textPrimary,
                      fontWeight: FontWeight.bold,
                      fontSize: 14,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    '• Look directly at the camera\n'
                    '• Ensure good lighting\n'
                    '• Remove glasses/mask if possible\n'
                    '• Keep a neutral expression\n'
                    '• Processing may take up to 2 minutes',
                    style: TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 12,
                      height: 1.5,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),

            const SizedBox(height: 20),

            // Enroll / Re-enroll Button
            Padding(
              padding: const EdgeInsets.all(20),
              child: SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton.icon(
                  onPressed: _isProcessing ? null : _enrollFace,
                  icon: _isProcessing
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: AppColors.bgDark,
                          ),
                        )
                      : Icon(
                          _isEnrolled ? Icons.published_with_changes : Icons.face,
                          size: 24,
                        ),
                  label: Text(
                    _isProcessing
                        ? 'ENROLLING...'
                        : (_isEnrolled ? 'UPDATE FACE ENROLLMENT' : 'ENROLL FACE'),
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 2,
                    ),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor:
                        _isEnrolled ? AppColors.neonPurple : AppColors.neonCyan,
                    foregroundColor: AppColors.bgDark,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                    elevation: _isProcessing ? 0 : 4,
                  ),
                ),
              ),
            ),

            const SizedBox(height: 20),
          ],
        ),
      ),
    );
  }
}
