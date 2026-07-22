import 'package:flutter/material.dart';
import '../../core/constants.dart';
import '../../services/api_service.dart';
import '../user/face_enrollment_screen.dart';

class AdminDoorControlScreen extends StatefulWidget {
  final String userId;
  final String roomId;

  const AdminDoorControlScreen({
    super.key,
    required this.userId,
    required this.roomId,
  });

  @override
  State<AdminDoorControlScreen> createState() => _AdminDoorControlScreenState();
}

class _AdminDoorControlScreenState extends State<AdminDoorControlScreen> {
  final ApiService _apiService = ApiService();
  bool _isLoading = false;
  String _statusMessage = '';

  Future<void> _remoteUnlock() async {
    setState(() {
      _isLoading = true;
      _statusMessage = 'Sending unlock command...';
    });

    try {
      final response =
          await _apiService.remoteUnlock(widget.roomId, widget.userId);

      if (response['success'] == true) {
        setState(() {
          _statusMessage = '✅ Door unlocked successfully!';
        });

        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('🔓 Door unlocked remotely!'),
            backgroundColor: Colors.green,
            duration: Duration(seconds: 3),
          ),
        );
      } else {
        setState(() {
          _statusMessage = '❌ ${response['message'] ?? 'Failed to unlock'}';
        });

        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(response['message'] ?? 'Failed to unlock'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } catch (e) {
      setState(() {
        _statusMessage = '❌ Error: $e';
      });

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Error: $e'),
          backgroundColor: Colors.red,
        ),
      );
    }

    setState(() => _isLoading = false);
  }

  Future<void> _startEnrollment() async {
    setState(() => _isLoading = true);
    List<dynamic> users = [];
    try {
      final response = await _apiService.getAdminUsers();
      if (response['success'] == true) {
        users = response['data'] ?? [];
      }
    } catch (e) {
      print('Error fetching users for enrollment: $e');
    }
    setState(() => _isLoading = false);

    bool isNewUserMode = false;
    Map<String, dynamic>? selectedUser;

    final TextEditingController userIdController = TextEditingController(
        text: 'USR-${DateTime.now().millisecondsSinceEpoch}');
    final TextEditingController nameController = TextEditingController();
    final TextEditingController emailController = TextEditingController();
    final TextEditingController departmentController =
        TextEditingController(text: 'Computer Science');
    final TextEditingController roomsController =
        TextEditingController(text: widget.roomId);
    String selectedRole = 'user';

    await showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) {
          return AlertDialog(
            backgroundColor: AppColors.surfaceDark,
            title: Row(
              children: [
                const Icon(Icons.person_add_alt_1, color: AppColors.neonCyan),
                const SizedBox(width: 8),
                const Text(
                  'Biometric Enrollment',
                  style: TextStyle(color: AppColors.textPrimary, fontSize: 18),
                ),
              ],
            ),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Mode Toggle
                  Row(
                    children: [
                      Expanded(
                        child: ChoiceChip(
                          label: const Text('Existing User'),
                          selected: !isNewUserMode,
                          selectedColor: AppColors.neonCyan.withOpacity(0.2),
                          labelStyle: TextStyle(
                            color: !isNewUserMode
                                ? AppColors.neonCyan
                                : AppColors.textSecondary,
                            fontWeight: FontWeight.bold,
                            fontSize: 11,
                          ),
                          onSelected: (val) {
                            setModalState(() {
                              isNewUserMode = !val;
                            });
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: ChoiceChip(
                          label: const Text('+ New User'),
                          selected: isNewUserMode,
                          selectedColor: AppColors.neonPurple.withOpacity(0.2),
                          labelStyle: TextStyle(
                            color: isNewUserMode
                                ? AppColors.neonPurple
                                : AppColors.textSecondary,
                            fontWeight: FontWeight.bold,
                            fontSize: 11,
                          ),
                          onSelected: (val) {
                            setModalState(() {
                              isNewUserMode = val;
                            });
                          },
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),

                  if (!isNewUserMode) ...[
                    const Text(
                      'SELECT USER FROM DATABASE',
                      style: TextStyle(
                        color: AppColors.neonCyan,
                        fontSize: 10,
                        letterSpacing: 1.5,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 8),
                    DropdownButtonFormField<Map<String, dynamic>>(
                      dropdownColor: AppColors.surfaceDark,
                      value: selectedUser,
                      decoration: const InputDecoration(
                        labelText: 'Select Registered User',
                        prefixIcon: Icon(Icons.people, color: AppColors.neonCyan),
                      ),
                      style: const TextStyle(color: AppColors.textPrimary),
                      items: users.map((u) {
                        final uId = u['userId'] ?? u['userid'] ?? u['id'] ?? '';
                        final uName = u['username'] ?? u['name'] ?? 'User';
                        final uRole = (u['role'] ?? 'user').toString().toUpperCase();
                        return DropdownMenuItem<Map<String, dynamic>>(
                          value: u,
                          child: Text('$uName ($uId) [$uRole]',
                              style: const TextStyle(color: AppColors.textPrimary, fontSize: 13)),
                        );
                      }).toList(),
                      onChanged: (val) {
                        setModalState(() {
                          selectedUser = val;
                          if (val != null) {
                            userIdController.text = val['userId'] ?? val['userid'] ?? '';
                            nameController.text = val['username'] ?? val['name'] ?? '';
                            emailController.text = val['email'] ?? '';
                            departmentController.text = val['department'] ?? '';
                            roomsController.text = val['authorized_rooms'] ?? widget.roomId;
                            selectedRole = (val['role'] ?? 'user').toString().toLowerCase();
                          }
                        });
                      },
                    ),
                    const SizedBox(height: 12),
                  ],

                  // Common Fields: User ID, Name, Email, Role, Department, Authorized Rooms
                  TextField(
                    controller: userIdController,
                    readOnly: !isNewUserMode && selectedUser != null,
                    decoration: const InputDecoration(
                      labelText: 'USER ID',
                      prefixIcon: Icon(Icons.fingerprint, color: AppColors.neonCyan),
                    ),
                    style: const TextStyle(color: AppColors.textPrimary),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: nameController,
                    decoration: const InputDecoration(
                      labelText: 'FULL NAME',
                      prefixIcon: Icon(Icons.person, color: AppColors.neonCyan),
                    ),
                    style: const TextStyle(color: AppColors.textPrimary),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: emailController,
                    decoration: const InputDecoration(
                      labelText: 'EMAIL ADDRESS',
                      prefixIcon: Icon(Icons.email, color: AppColors.neonCyan),
                    ),
                    keyboardType: TextInputType.emailAddress,
                    style: const TextStyle(color: AppColors.textPrimary),
                  ),
                  const SizedBox(height: 12),

                  // Role Selection (USER vs ADMIN)
                  const Text(
                    'ACCESS ROLE',
                    style: TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 10,
                      letterSpacing: 1.5,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Expanded(
                        child: ChoiceChip(
                          label: const Text('USER'),
                          selected: selectedRole == 'user',
                          selectedColor: AppColors.neonCyan.withOpacity(0.2),
                          labelStyle: TextStyle(
                            color: selectedRole == 'user'
                                ? AppColors.neonCyan
                                : AppColors.textSecondary,
                            fontWeight: FontWeight.bold,
                          ),
                          onSelected: (val) {
                            if (val) setModalState(() => selectedRole = 'user');
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: ChoiceChip(
                          label: const Text('ADMIN'),
                          selected: selectedRole == 'admin',
                          selectedColor: AppColors.neonPurple.withOpacity(0.2),
                          labelStyle: TextStyle(
                            color: selectedRole == 'admin'
                                ? AppColors.neonPurple
                                : AppColors.textSecondary,
                            fontWeight: FontWeight.bold,
                          ),
                          onSelected: (val) {
                            if (val) setModalState(() => selectedRole = 'admin');
                          },
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),

                  TextField(
                    controller: departmentController,
                    decoration: const InputDecoration(
                      labelText: 'DEPARTMENT',
                      prefixIcon: Icon(Icons.business, color: AppColors.neonCyan),
                    ),
                    style: const TextStyle(color: AppColors.textPrimary),
                  ),
                  const SizedBox(height: 12),

                  TextField(
                    controller: roomsController,
                    decoration: const InputDecoration(
                      labelText: 'AUTHORIZED ROOMS',
                      prefixIcon: Icon(Icons.meeting_room, color: AppColors.neonCyan),
                      hintText: 'e.g. ROOM 001, ROOM 002',
                    ),
                    style: const TextStyle(color: AppColors.textPrimary),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Cancel', style: TextStyle(color: AppColors.textSecondary)),
              ),
              OutlinedButton.icon(
                onPressed: () async {
                  final userId = userIdController.text.trim();
                  final name = nameController.text.trim();

                  if (userId.isEmpty || name.isEmpty) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('User ID and Name are required'),
                        backgroundColor: AppColors.warning,
                      ),
                    );
                    return;
                  }

                  Navigator.pop(context);
                  Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => FaceEnrollmentScreen(
                        targetUserId: userId,
                        targetUserName: name,
                      ),
                    ),
                  );
                },
                icon: const Icon(Icons.face, size: 18),
                label: const Text('Enroll Face'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.neonCyan,
                  side: BorderSide(color: AppColors.neonCyan.withOpacity(0.5)),
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                ),
              ),
              ElevatedButton.icon(
                onPressed: () async {
                  final userId = userIdController.text.trim();
                  final name = nameController.text.trim();
                  final email = emailController.text.trim();
                  final department = departmentController.text.trim();
                  final rooms = roomsController.text.trim();

                  if (userId.isEmpty || name.isEmpty || email.isEmpty) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('User ID, Name, and Email are required'),
                        backgroundColor: AppColors.warning,
                      ),
                    );
                    return;
                  }

                  Navigator.pop(context);
                  await _enrollUser(
                    userId: userId,
                    name: name,
                    email: email,
                    role: selectedRole,
                    department: department,
                    authorizedRooms: rooms,
                  );
                },
                icon: const Icon(Icons.fingerprint, size: 18),
                label: const Text('Enroll Fingerprint', style: TextStyle(fontWeight: FontWeight.bold)),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.neonPurple,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _enrollUser({
    required String userId,
    required String name,
    required String email,
    required String role,
    required String department,
    required String authorizedRooms,
  }) async {
    setState(() {
      _isLoading = true;
      _statusMessage = 'Syncing database user and activating ESP32 enrollment...';
    });

    try {
      final response = await _apiService.startEnrollment(
        roomId: widget.roomId,
        userId: userId,
        userName: name,
        adminId: widget.userId,
        email: email,
        department: department,
        role: role,
        authorizedRooms: authorizedRooms,
      );

      if (response['success'] == true) {
        setState(() {
          _statusMessage = '✅ Enrollment mode activated for $name ($userId) [Role: ${role.toUpperCase()}]!';
        });

        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '📝 Enrollment mode activated!\nUser: $name ($userId) [Role: ${role.toUpperCase()}]\nAsk user to scan finger on ESP32 sensor.',
            ),
            backgroundColor: AppColors.success,
            duration: const Duration(seconds: 10),
          ),
        );
      } else {
        setState(() {
          _statusMessage =
              '❌ ${response['message'] ?? 'Failed to start enrollment'}';
        });

        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(response['message'] ?? 'Failed to start enrollment'),
            backgroundColor: AppColors.danger,
          ),
        );
      }
    } catch (e) {
      setState(() {
        _statusMessage = '❌ Error: $e';
      });

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Error: $e'),
          backgroundColor: AppColors.danger,
        ),
      );
    }

    setState(() => _isLoading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('Door Control'),
        backgroundColor: AppColors.bgDark,
        foregroundColor: AppColors.textPrimary,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Status Message Card (if any)
            if (_statusMessage.isNotEmpty)
              Card(
                color: _statusMessage.contains('✅')
                    ? Colors.green.withOpacity(0.2)
                    : _statusMessage.contains('❌')
                        ? Colors.red.withOpacity(0.2)
                        : Colors.blue.withOpacity(0.2),
                margin: const EdgeInsets.only(bottom: 16),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    children: [
                      Icon(
                        _statusMessage.contains('✅')
                            ? Icons.check_circle
                            : _statusMessage.contains('❌')
                                ? Icons.error
                                : Icons.info,
                        color: _statusMessage.contains('✅')
                            ? Colors.green
                            : _statusMessage.contains('❌')
                                ? Colors.red
                                : Colors.blue,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          _statusMessage,
                          style: const TextStyle(
                            color: AppColors.textPrimary,
                            fontSize: 14,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),

            // Remote Unlock Button
            Card(
              color: AppColors.surfaceDark,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    const Icon(
                      Icons.lock_open,
                      size: 64,
                      color: AppColors.neonCyan,
                    ),
                    const SizedBox(height: 16),
                    const Text(
                      'Remote Unlock',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Unlock door remotely via app',
                      style: TextStyle(color: AppColors.textSecondary),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        onPressed: _isLoading ? null : _remoteUnlock,
                        icon: _isLoading
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Icon(Icons.lock_open),
                        label: const Text('UNLOCK DOOR'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppColors.neonCyan,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 32,
                            vertical: 16,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Enroll New User Button
            Card(
              color: AppColors.surfaceDark,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    const Icon(
                      Icons.fingerprint,
                      size: 64,
                      color: AppColors.neonPurple,
                    ),
                    const SizedBox(height: 16),
                    const Text(
                      'Enroll New User',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Add new fingerprint to system',
                      style: TextStyle(color: AppColors.textSecondary),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        onPressed: _isLoading ? null : _startEnrollment,
                        icon: const Icon(Icons.person_add),
                        label: const Text('ENROLL USER'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppColors.neonPurple,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 32,
                            vertical: 16,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Info Card
            Card(
              color: AppColors.surfaceDark,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.info_outline,
                            color: AppColors.neonCyan, size: 20),
                        const SizedBox(width: 8),
                        const Text(
                          'How it works',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: AppColors.textPrimary,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    _buildInfoItem('1. Tap "UNLOCK DOOR" to remotely unlock'),
                    _buildInfoItem(
                        '2. Tap "ENROLL USER" to add new fingerprint'),
                    _buildInfoItem(
                        '3. ESP32 checks for commands every 3 seconds'),
                    _buildInfoItem(
                        '4. User must scan finger on sensor within 30 seconds'),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInfoItem(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '• ',
            style: TextStyle(color: AppColors.neonCyan, fontSize: 16),
          ),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 14,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
