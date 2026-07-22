import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:io';
import 'package:image_picker/image_picker.dart';

class UserManagementScreen extends StatefulWidget {
  @override
  _UserManagementScreenState createState() => _UserManagementScreenState();
}

class _UserManagementScreenState extends State<UserManagementScreen> {
  List<dynamic> users = [];
  bool isLoading = true;

  final String backendUrl = "https://labsync-backend-e2o8.onrender.com/api";

  @override
  void initState() {
    super.initState();
    _loadUsers();
  }

  Future<void> _loadUsers() async {
    setState(() => isLoading = true);

    try {
      final response = await http.get(Uri.parse('$backendUrl/users'));

      if (response.statusCode == 200) {
        setState(() {
          users = json.decode(response.body)['users'];
          isLoading = false;
        });
      }
    } catch (e) {
      setState(() => isLoading = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Error loading users: $e')));
    }
  }

  Future<void> _addUser() async {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Add New User'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              decoration: InputDecoration(labelText: 'User ID'),
              onChanged: (value) => _newUserId = value,
            ),
            TextField(
              decoration: InputDecoration(labelText: 'Name'),
              onChanged: (value) => _newUserName = value,
            ),
            TextField(
              decoration: InputDecoration(labelText: 'Email'),
              onChanged: (value) => _newUserEmail = value,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text('Cancel'),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(context);
              await _createUser();
            },
            child: Text('Add'),
          ),
        ],
      ),
    );
  }

  String _newUserId = '';
  String _newUserName = '';
  String _newUserEmail = '';

  Future<void> _createUser() async {
    try {
      final response = await http.post(
        Uri.parse('$backendUrl/users'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'userId': _newUserId,
          'userName': _newUserName,
          'email': _newUserEmail,
          'role': 'user',
          'department': 'CS',
          'authorizedRooms': 'ROOM-001',
        }),
      );

      if (response.statusCode == 200) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('✅ User created!')));
        _loadUsers();
      }
    } catch (e) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Error: $e')));
    }
  }

  Future<void> _triggerFingerprintEnrollment(
      String userId, String userName) async {
    try {
      final response = await http.post(
        Uri.parse('$backendUrl/esp32/send-command'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'roomId': 'ROOM-001',
          'command': 'enroll',
          'userId': userId,
          'userName': userName,
        }),
      );

      if (response.statusCode == 200) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(
                '🔔 ESP32 enrollment triggered! Place finger on sensor.')));
      }
    } catch (e) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Error: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('User Management'),
        actions: [
          IconButton(
            icon: Icon(Icons.refresh),
            onPressed: _loadUsers,
          ),
        ],
      ),
      body: isLoading
          ? Center(child: CircularProgressIndicator())
          : ListView.builder(
              itemCount: users.length,
              itemBuilder: (context, index) {
                final user = users[index];
                return Card(
                  margin: EdgeInsets.all(8),
                  child: ListTile(
                    leading: CircleAvatar(
                      child: Text(user['userName'][0]),
                    ),
                    title: Text(user['userName']),
                    subtitle: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('ID: ${user['userId']}'),
                        Text('Email: ${user['email']}'),
                        Row(
                          children: [
                            Icon(
                              user['fingerprintid'] != null &&
                                      user['fingerprintid']
                                          .toString()
                                          .isNotEmpty
                                  ? Icons.fingerprint
                                  : Icons.fingerprint_outlined,
                              size: 16,
                              color: user['fingerprintid'] != null &&
                                      user['fingerprintid']
                                          .toString()
                                          .isNotEmpty
                                  ? Colors.green
                                  : Colors.grey,
                            ),
                            SizedBox(width: 4),
                            Text(
                              user['fingerprintid'] != null &&
                                      user['fingerprintid']
                                          .toString()
                                          .isNotEmpty
                                  ? 'FP: ${user['fingerprintid']}'
                                  : 'FP: Not enrolled',
                              style: TextStyle(fontSize: 12),
                            ),
                            SizedBox(width: 16),
                            Icon(
                              user['facestatus'] == 'ENROLLED'
                                  ? Icons.face
                                  : Icons.face_outlined,
                              size: 16,
                              color: user['facestatus'] == 'ENROLLED'
                                  ? Colors.green
                                  : Colors.grey,
                            ),
                            SizedBox(width: 4),
                            Text(
                              user['facestatus'] == 'ENROLLED'
                                  ? 'Face: Enrolled'
                                  : 'Face: Not enrolled',
                              style: TextStyle(fontSize: 12),
                            ),
                          ],
                        ),
                      ],
                    ),
                    trailing: PopupMenuButton(
                      itemBuilder: (context) => [
                        PopupMenuItem(
                          child: Text('Enroll Fingerprint'),
                          onTap: () => _triggerFingerprintEnrollment(
                            user['userId'],
                            user['userName'],
                          ),
                        ),
                        PopupMenuItem(
                          child: Text('Enroll Face'),
                          onTap: () {
                            Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (context) => FaceEnrollScreen(
                                  userId: user['userId'],
                                  userName: user['userName'],
                                ),
                              ),
                            );
                          },
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
      floatingActionButton: FloatingActionButton(
        onPressed: _addUser,
        child: Icon(Icons.add),
      ),
    );
  }
}

// ================= FACE ENROLLMENT SCREEN =================

class FaceEnrollScreen extends StatefulWidget {
  final String userId;
  final String userName;

  const FaceEnrollScreen({
    Key? key,
    required this.userId,
    required this.userName,
  }) : super(key: key);

  @override
  _FaceEnrollScreenState createState() => _FaceEnrollScreenState();
}

class _FaceEnrollScreenState extends State<FaceEnrollScreen> {
  File? _image;
  bool _isLoading = false;
  final ImagePicker _picker = ImagePicker();

  final String faceApiUrl = "https://labsync-face-api.onrender.com";
  final String mainBackendUrl = "https://labsync-backend-e2o8.onrender.com/api";

  Future<void> _captureAndEnroll() async {
    final XFile? photo = await _picker.pickImage(source: ImageSource.camera);

    if (photo != null) {
      setState(() {
        _image = File(photo.path);
        _isLoading = true;
      });

      try {
        var request =
            http.MultipartRequest('POST', Uri.parse('$faceApiUrl/enroll'));
        request.fields['userId'] = widget.userId;
        request.fields['userName'] = widget.userName;
        request.files
            .add(await http.MultipartFile.fromPath('faceImage', _image!.path));

        var response = await request.send();
        var resBody = await http.Response.fromStream(response);

        if (response.statusCode == 200) {
          await http.post(
            Uri.parse('$mainBackendUrl/users/update-face-status'),
            headers: {'Content-Type': 'application/json'},
            body: json.encode({
              'userId': widget.userId,
              'faceStatus': 'ENROLLED',
            }),
          );

          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('✅ Face enrolled successfully!')),
          );
          Navigator.pop(context);
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('❌ Failed: ${resBody.body}')),
          );
        }
      } catch (e) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('❌ Error: $e')),
        );
      } finally {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Enroll Face: ${widget.userName}')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _image == null
                ? const Icon(Icons.face, size: 100, color: Colors.grey)
                : Image.file(_image!, height: 200),
            const SizedBox(height: 20),
            const Text(
              "Tap the button to capture your face",
              style: TextStyle(fontSize: 16),
            ),
            const SizedBox(height: 20),
            ElevatedButton.icon(
              icon: const Icon(Icons.camera_alt),
              label:
                  Text(_isLoading ? 'Enrolling...' : 'Capture & Enroll Face'),
              onPressed: _isLoading ? null : _captureAndEnroll,
              style: ElevatedButton.styleFrom(
                padding:
                    const EdgeInsets.symmetric(horizontal: 30, vertical: 15),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
