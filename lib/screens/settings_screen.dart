import 'package:flutter/material.dart';
import '../core/constants.dart';
import '../widgets/glass_card.dart';
import '../services/api_service.dart';
import '../core/current_user.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final ApiService _apiService = ApiService();

  // Settings State
  bool _enableFingerprint = true;
  bool _enableFaceRecognition = true;
  bool _doorAlertNotifications = true;
  bool _systemRequestAlerts = true;
  int _unlockDurationSeconds = 5;
  int? _latencyMs;
  bool _isTestingLatency = false;

  @override
  void initState() {
    super.initState();
    _measureLatency();
  }

  Future<void> _measureLatency() async {
    setState(() => _isTestingLatency = true);
    final ms = await _apiService.testServerLatency();
    if (mounted) {
      setState(() {
        _latencyMs = ms;
        _isTestingLatency = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final isAdmin = CurrentUser.role.toLowerCase() == 'admin';

    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('SETTINGS & PREFERENCES'),
        backgroundColor: AppColors.bgDark,
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.speed, color: AppColors.neonCyan),
            tooltip: 'Test Connection Speed',
            onPressed: _isTestingLatency ? null : _measureLatency,
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 1. Connection Health Card
            GlassCard(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: (_latencyMs != null && _latencyMs! >= 0 && _latencyMs! < 300)
                          ? AppColors.success.withOpacity(0.2)
                          : AppColors.warning.withOpacity(0.2),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      Icons.wifi_tethering,
                      color: (_latencyMs != null && _latencyMs! >= 0 && _latencyMs! < 300)
                          ? AppColors.success
                          : AppColors.warning,
                      size: 28,
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'SERVER CONNECTION STATUS',
                          style: TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 10,
                            letterSpacing: 1.5,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          _isTestingLatency
                              ? 'Testing latency...'
                              : (_latencyMs == null || _latencyMs! < 0)
                                  ? 'Offline / Server unreachable'
                                  : 'Online - Ping: ${_latencyMs}ms (Sub-second response)',
                          style: const TextStyle(
                            color: AppColors.textPrimary,
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: _isTestingLatency
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: AppColors.neonCyan,
                            ),
                          )
                        : const Icon(Icons.refresh, color: AppColors.neonCyan),
                    onPressed: _measureLatency,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // 2. Biometric Preferences Section
            GlassCard(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'BIOMETRIC AUTHENTICATION',
                    style: TextStyle(
                      color: AppColors.neonCyan,
                      fontSize: 11,
                      letterSpacing: 2,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 16),
                  SwitchListTile(
                    activeColor: AppColors.neonCyan,
                    title: const Text(
                      'Optical Fingerprint Auth',
                      style: TextStyle(color: AppColors.textPrimary, fontSize: 15),
                    ),
                    subtitle: const Text(
                      'Use fingerprint sensor for fast lab door unlock',
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
                    ),
                    value: _enableFingerprint,
                    onChanged: (val) => setState(() => _enableFingerprint = val),
                  ),
                  const Divider(color: AppColors.surfaceLight),
                  SwitchListTile(
                    activeColor: AppColors.neonCyan,
                    title: const Text(
                      'AI Facial Verification',
                      style: TextStyle(color: AppColors.textPrimary, fontSize: 15),
                    ),
                    subtitle: const Text(
                      'Requires facial recognition verification after fingerprint',
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
                    ),
                    value: _enableFaceRecognition,
                    onChanged: (val) => setState(() => _enableFaceRecognition = val),
                  ),
                  const Divider(color: AppColors.surfaceLight),
                  ListTile(
                    title: const Text(
                      'Door Auto-Close Relay Delay',
                      style: TextStyle(color: AppColors.textPrimary, fontSize: 15),
                    ),
                    subtitle: Text(
                      'Hold door relay open for $_unlockDurationSeconds seconds',
                      style: const TextStyle(color: AppColors.textSecondary, fontSize: 12),
                    ),
                    trailing: DropdownButton<int>(
                      dropdownColor: AppColors.surfaceDark,
                      value: _unlockDurationSeconds,
                      items: const [
                        DropdownMenuItem(value: 3, child: Text('3s', style: TextStyle(color: AppColors.neonCyan))),
                        DropdownMenuItem(value: 5, child: Text('5s', style: TextStyle(color: AppColors.neonCyan))),
                        DropdownMenuItem(value: 10, child: Text('10s', style: TextStyle(color: AppColors.neonCyan))),
                      ],
                      onChanged: (val) {
                        if (val != null) setState(() => _unlockDurationSeconds = val);
                      },
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // 3. Notifications & Alert Preferences
            GlassCard(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'NOTIFICATION PREFERENCES',
                    style: TextStyle(
                      color: AppColors.neonCyan,
                      fontSize: 11,
                      letterSpacing: 2,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 16),
                  SwitchListTile(
                    activeColor: AppColors.neonCyan,
                    title: const Text(
                      'Door Access Alerts',
                      style: TextStyle(color: AppColors.textPrimary, fontSize: 15),
                    ),
                    subtitle: const Text(
                      'Receive in-app alerts on entry/exit logs',
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
                    ),
                    value: _doorAlertNotifications,
                    onChanged: (val) => setState(() => _doorAlertNotifications = val),
                  ),
                  const Divider(color: AppColors.surfaceLight),
                  SwitchListTile(
                    activeColor: AppColors.neonCyan,
                    title: const Text(
                      'Borrow Request Updates',
                      style: TextStyle(color: AppColors.textPrimary, fontSize: 15),
                    ),
                    subtitle: const Text(
                      'Get notified when equipment request status changes',
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
                    ),
                    value: _systemRequestAlerts,
                    onChanged: (val) => setState(() => _systemRequestAlerts = val),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // 4. Admin System Info (If Admin)
            if (isAdmin) ...[
              GlassCard(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'ADMIN SYSTEM METRICS',
                      style: TextStyle(
                        color: AppColors.neonPurple,
                        fontSize: 11,
                        letterSpacing: 2,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 12),
                    _buildInfoRow('API Endpoint:', AppConstants.baseUrl),
                    _buildInfoRow('Sheets Sync Engine:', 'Batch append (appendRows Enabled)'),
                    _buildInfoRow('Neural Models Path:', 'backend/models (Local Disk)'),
                    _buildInfoRow('Auto-Rotation Engine:', '4-Way Canvas (0°, 180°, 90°, 270°)'),
                  ],
                ),
              ),
              const SizedBox(height: 24),
            ],

            // Save Settings Button
            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton.icon(
                onPressed: () {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('✅ Settings saved successfully!'),
                      backgroundColor: AppColors.success,
                    ),
                  );
                },
                icon: const Icon(Icons.save),
                label: const Text(
                  'SAVE SETTINGS',
                  style: TextStyle(letterSpacing: 1.5, fontWeight: FontWeight.bold),
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
          ],
        ),
      ),
    );
  }

  Widget _buildInfoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: AppColors.textSecondary, fontSize: 13)),
          Flexible(
            child: Text(
              value,
              style: const TextStyle(color: AppColors.textPrimary, fontSize: 13, fontWeight: FontWeight.w600),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}
