import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:go_router/go_router.dart';
import '../core/constants.dart';
import '../core/globals.dart';

class ApiService {
  final String baseUrl = AppConstants.baseUrl;

  // ==================== TIMEOUT CONFIGURATION ====================
  static const Duration _defaultTimeout = Duration(seconds: 15);
  static const Duration _faceOperationTimeout = Duration(seconds: 60);
  static const Duration _backendWakeUpTimeout = Duration(seconds: 30);

  // ==================== TOKEN MANAGEMENT ====================

  Future<void> saveToken(String token) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(AppConstants.tokenKey, token);
      print('✅ Token saved successfully');
    } catch (e) {
      print('❌ Error saving token: $e');
    }
  }

  Future<String?> getToken() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(AppConstants.tokenKey);
    } catch (e) {
      print('❌ Error getting token: $e');
      return null;
    }
  }

  Future<void> clearToken() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.clear();
      print('✅ Token cleared successfully');
    } catch (e) {
      print('❌ Error clearing token: $e');
    }
  }

  Future<Map<String, String>> _getAuthHeaders() async {
    final token = await getToken();
    return {
      'Content-Type': 'application/json',
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
    };
  }

  // ==================== BACKEND WAKE-UP ====================

  Future<void> wakeUpBackend() async {
    try {
      print('🔔 Waking up backend...');
      final url = Uri.parse('${baseUrl.replaceAll('/api', '')}/api/wake');
      final response = await http.get(url).timeout(_backendWakeUpTimeout);
      print('✅ Backend awake: ${response.statusCode}');
    } catch (e) {
      print('⚠️ Backend wake-up: $e');
    }
  }

  // ==================== ERROR HANDLING ====================

  void _checkUnauthorized(http.Response response) {
    if (response.statusCode == 401) {
      print('⚠️ 401 Unauthorized detected. Clearing token and redirecting to login.');
      clearToken();
      final context = rootNavigatorKey.currentContext;
      if (context != null && context.mounted) {
        context.go('/login');
      }
    }
  }

  // ==================== AUTHENTICATION ====================

  Future<Map<String, dynamic>> login(String email, String password) async {
    final url = Uri.parse('$baseUrl/auth/login');
    print('📡 Attempting login for: $email');

    try {
      final response = await http
          .post(
            url,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'email': email, 'password': password}),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        await saveToken(data['token']);
        print('✅ Login successful for: $email');
        return {
          'success': true,
          'token': data['token'],
          'user': data['user'],
        };
      } else {
        print('❌ Login failed: ${data['message']}');
        return {
          'success': false,
          'message': data['message'] ?? 'Login failed',
        };
      }
    } on TimeoutException {
      print('❌ Login timeout');
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      print('❌ Login error: $e');
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> register(
    String name,
    String email,
    String password,
    String department, {
    String role = 'user',
  }) async {
    final url = Uri.parse('$baseUrl/auth/register');
    print('📡 Registering user: $email [Role: $role]');

    try {
      final response = await http
          .post(
            url,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'name': name,
              'email': email,
              'password': password,
              'department': department,
              'role': role,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 201 && data['success'] == true) {
        await saveToken(data['token']);
        print('✅ Registration successful for: $email');
        return {
          'success': true,
          'token': data['token'],
          'user': data['user'],
        };
      } else {
        print('❌ Registration failed: ${data['message']}');
        return {
          'success': false,
          'message': data['message'] ?? 'Registration failed',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> changePassword(
    String userId,
    String oldPassword,
    String newPassword,
  ) async {
    final url = Uri.parse('$baseUrl/auth/change-password');
    print('📡 Changing password for user: $userId');

    try {
      final response = await http
          .put(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'userId': userId,
              'oldPassword': oldPassword,
              'newPassword': newPassword,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Password changed successfully');
        return {
          'success': true,
          'message': data['message'] ?? 'Password changed successfully',
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to change password',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== EMAIL OTP AUTHENTICATION ====================

  Future<Map<String, dynamic>> sendOTP(String email) async {
    final url = Uri.parse('$baseUrl/auth/send-otp');
    print('📡 Requesting OTP for email: $email');

    try {
      final response = await http
          .post(
            url,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'email': email}),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);
      return data;
    } on TimeoutException {
      return {'success': false, 'message': 'Connection timeout while sending OTP.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  Future<Map<String, dynamic>> verifyOTP({
    required String email,
    required String otp,
  }) async {
    final url = Uri.parse('$baseUrl/auth/verify-otp');
    print('📡 Verifying OTP for $email...');

    try {
      final response = await http
          .post(
            url,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'email': email, 'otp': otp}),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        if (data['token'] != null) {
          await saveToken(data['token']);
        }
        return data;
      } else {
        return {'success': false, 'message': data['message'] ?? 'Invalid OTP'};
      }
    } on TimeoutException {
      return {'success': false, 'message': 'Connection timeout while verifying OTP.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  // ==================== LATENCY BENCHMARK ====================

  Future<int> testServerLatency() async {
    final stopwatch = Stopwatch()..start();
    try {
      final url = Uri.parse('$baseUrl/status');
      await http.get(url).timeout(const Duration(seconds: 5));
      stopwatch.stop();
      return stopwatch.elapsedMilliseconds;
    } catch (e) {
      stopwatch.stop();
      return -1; // Offline / error
    }
  }

  // ==================== GET CURRENT USER (Token Validation) ====================

  Future<Map<String, dynamic>> getMe() async {
    final url = Uri.parse('$baseUrl/auth/me');
    print('📡 Validating token with /api/auth/me...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);
          
      _checkUnauthorized(response);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Token valid — user: ${data['user']?['name']}');
        return {
          'success': true,
          'user': data['user'],
        };
      } else {
        print('❌ Token invalid: ${data['message']}');
        return {
          'success': false,
          'message': data['message'] ?? 'Token validation failed',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout.',
      };
    } catch (e) {
      print('❌ getMe error: $e');
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== INVENTORY & EQUIPMENT ====================

  Future<Map<String, dynamic>> getInventory() async {
    final url = Uri.parse('$baseUrl/inventory');
    print('📡 Fetching inventory...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Inventory fetched: ${data['data']?.length ?? 0} items');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch inventory',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> getActiveBorrows() async {
    final url = Uri.parse('$baseUrl/inventory/active-borrows');
    print('📡 Fetching active borrows...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Active borrows fetched: ${data['data']?.length ?? 0}');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch active borrows',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> getBorrowHistory(String userId) async {
    if (userId.isEmpty) {
      return {
        'success': false,
        'message': 'User ID is empty. Please login again.',
      };
    }

    final url = Uri.parse('$baseUrl/inventory/borrow-history/$userId');
    print('📡 Fetching borrow history for user: $userId');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Borrow history fetched: ${data['data']?.length ?? 0} records');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to fetch history',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== QR CODE ====================

  Future<Map<String, dynamic>> scanQR(
    String qrCode,
    String action,
    String userId,
  ) async {
    final url = Uri.parse('$baseUrl/qr/scan');
    print('📡 Scanning QR: $qrCode, Action: $action');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'qrCode': qrCode,
              'action': action,
              'userId': userId,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ QR scan successful');
        return {
          'success': true,
          'message': data['message'],
          'object': data['object'],
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Scan failed',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== ADMIN OPERATIONS ====================

  Future<Map<String, dynamic>> getAdminStats() async {
    final url = Uri.parse('$baseUrl/admin/stats');
    print('📡 Fetching admin stats...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);
          
      _checkUnauthorized(response);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Admin stats fetched');
        return {
          'success': true,
          'data': data['data'] ?? {},
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch stats',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> getAdminEquipment() async {
    final url = Uri.parse('$baseUrl/admin/equipment');
    print('📡 Fetching admin equipment...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Admin equipment fetched: ${data['data']?.length ?? 0} items');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch equipment',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> getAdminUsers() async {
    final url = Uri.parse('$baseUrl/admin/users');
    print('📡 Fetching admin users...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Admin users fetched: ${data['data']?.length ?? 0} users');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch users',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> getAdminLogs() async {
    final url = Uri.parse('$baseUrl/admin/logs');
    print('📡 Fetching admin logs...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Admin logs fetched: ${data['data']?.length ?? 0} logs');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch logs',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== ESP32 COMMANDS & ENROLLMENT ====================

  Future<Map<String, dynamic>> sendESP32Command({
    required String roomId,
    required String command,
    required String userName,
    required String adminId,
    String data = '',
  }) async {
    final url = Uri.parse('$baseUrl/esp32/send-command');
    print('📡 Sending ESP32 command: $command to $roomId');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'roomId': roomId,
              'command': command,
              'userName': userName,
              'adminId': adminId,
              'data': data,
            }),
          )
          .timeout(_defaultTimeout);

      final dataJson = jsonDecode(response.body);

      if (response.statusCode == 200 && dataJson['success'] == true) {
        return {'success': true, 'message': dataJson['message']};
      } else {
        return {'success': false, 'message': dataJson['message'] ?? 'Failed'};
      }
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  Future<Map<String, dynamic>> getEnrollmentStatus(String userId) async {
    final url = Uri.parse('$baseUrl/esp32/enrollment-status/$userId');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);
      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        return {
          'success': true,
          'enrolled': data['enrolled'] ?? false,
          'failed': data['failed'] ?? false,
          'error': data['error'] ?? '',
          'details': data['details'] ?? '',
          'fingerprintId': data['fingerprintId'] ?? 0,
        };
      } else {
        return {'success': false, 'enrolled': false, 'failed': false};
      }
    } catch (e) {
      return {
        'success': false,
        'enrolled': false,
        'failed': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ✅ START ENROLLMENT METHOD - ADDED HERE
  Future<Map<String, dynamic>> startEnrollment({
    required String roomId,
    required String userId,
    required String userName,
    required String adminId,
    String? email,
    String? department,
    String? role,
    String? authorizedRooms,
  }) async {
    final url = Uri.parse('$baseUrl/esp32/send-command');
    print(
        '📡 Starting fingerprint enrollment for user: $userName ($userId) [Role: ${role ?? 'user'}] in room: $roomId');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'roomId': roomId,
              'command': 'ENROLL:$userId:$userName',
              'userId': userId,
              'userName': userName,
              'adminId': adminId,
              'email': email ?? '',
              'department': department ?? '',
              'role': role ?? 'user',
              'authorizedRooms': authorizedRooms ?? roomId,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Enrollment command sent to ESP32');
        return {
          'success': true,
          'message': data['message'] ?? 'Enrollment started',
        };
      } else {
        print('❌ Start enrollment failed: ${data['message']}');
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to start enrollment',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      print('❌ Start enrollment error: $e');
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== USER MANAGEMENT ====================

  Future<Map<String, dynamic>> bulkImportUsers(
    List<Map<String, dynamic>> users,
  ) async {
    final url = Uri.parse('$baseUrl/admin/users/bulk-import');
    print('📡 Bulk importing ${users.length} users...');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({'users': users}),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Users imported successfully');
        return {
          'success': true,
          'message': data['message'] ?? 'Users imported successfully',
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Import failed',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<String?> exportUsers() async {
    final url = Uri.parse('$baseUrl/admin/users/export');
    print('📡 Exporting users...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      if (response.statusCode == 200) {
        print('✅ Users exported successfully');
        return response.body;
      } else {
        return null;
      }
    } on TimeoutException {
      return null;
    } catch (e) {
      return null;
    }
  }

  Future<Map<String, dynamic>> deleteUsers(List<String> userIds) async {
    final url = Uri.parse('$baseUrl/admin/users/delete');
    print('📡 Deleting ${userIds.length} users...');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({'userIds': userIds}),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Users deleted successfully');
        return {
          'success': true,
          'message': data['message'] ?? 'Users deleted successfully',
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Delete failed',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== EQUIPMENT REQUESTS ====================

  Future<Map<String, dynamic>> createEquipmentRequest({
    required String userId,
    required String userName,
    required String equipmentId,
    required String equipmentName,
    required String roomId,
    required String purpose,
    required String duration,
  }) async {
    final url = Uri.parse('$baseUrl/requests/create');
    print('📡 Creating equipment request for: $equipmentId');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'userId': userId,
              'userName': userName,
              'equipmentId': equipmentId,
              'equipmentName': equipmentName,
              'roomId': roomId,
              'purpose': purpose,
              'duration': duration,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);
      if (response.statusCode == 201 && data['success'] == true) {
        return {
          'success': true,
          'message': data['message'],
          'requestId': data['requestId'],
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to create request',
        };
      }
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  Future<Map<String, dynamic>> getUserRequests(String userId) async {
    final url = Uri.parse('$baseUrl/requests/user/$userId');
    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);
      final data = jsonDecode(response.body);
      if (response.statusCode == 200 && data['success'] == true) {
        return {'success': true, 'data': data['data'] ?? []};
      } else {
        return {'success': false, 'message': 'Failed to fetch requests'};
      }
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  Future<Map<String, dynamic>> getAllRequests() async {
    final url = Uri.parse('$baseUrl/requests/all');
    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);
      final data = jsonDecode(response.body);
      if (response.statusCode == 200 && data['success'] == true) {
        return {
          'success': true,
          'data': data['data'] ?? [],
          'pending': data['pending'] ?? 0,
        };
      } else {
        return {'success': false, 'message': 'Failed to fetch requests'};
      }
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  Future<Map<String, dynamic>> approveRequest({
    required String requestId,
    required String adminId,
  }) async {
    final url = Uri.parse('$baseUrl/requests/$requestId/approve');
    print('📡 Approving request: $requestId');

    try {
      final response = await http
          .put(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({'adminId': adminId}),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);
      if (response.statusCode == 200 && data['success'] == true) {
        return {
          'success': true,
          'message': data['message'] ?? 'Request approved',
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to approve',
        };
      }
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  Future<Map<String, dynamic>> rejectRequest({
    required String requestId,
    required String adminId,
    String reason = '',
  }) async {
    final url = Uri.parse('$baseUrl/requests/$requestId/reject');
    print('📡 Rejecting request: $requestId');

    try {
      final response = await http
          .put(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'adminId': adminId,
              'reason': reason,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);
      if (response.statusCode == 200 && data['success'] == true) {
        return {
          'success': true,
          'message': data['message'] ?? 'Request rejected',
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to reject',
        };
      }
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  // ==================== ROOM ACCESS ====================

  Future<Map<String, dynamic>> getRooms() async {
    final url = Uri.parse('$baseUrl/room-access/rooms');
    print('📡 Fetching rooms...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Rooms fetched: ${data['data']?.length ?? 0} rooms');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch rooms',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> logRoomEntry(
    String userId,
    String userName,
    String roomId,
    String roomName,
  ) async {
    final url = Uri.parse('$baseUrl/room-access/log-entry');
    print('📡 Logging room entry: $userName -> $roomName');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'userId': userId,
              'userName': userName,
              'roomId': roomId,
              'roomName': roomName,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Room entry logged successfully');
        return {
          'success': true,
          'data': data,
        };
      } else {
        print('❌ Log entry failed: ${data['message']}');
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to log entry',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      print('❌ Log entry error: $e');
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> addRoom(
    String roomName,
    String building,
    String floor,
  ) async {
    final url = Uri.parse('$baseUrl/room-access/add-room');
    print('📡 Adding room: $roomName');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'roomName': roomName,
              'building': building,
              'floor': floor,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Room added successfully');
        return {
          'success': true,
          'data': data,
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to add room',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> assignRoomPermission(
    String userId,
    String roomId,
  ) async {
    final url = Uri.parse('$baseUrl/room-access/assign-permission');
    print('📡 Assigning room permission: $userId -> $roomId');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'userId': userId,
              'roomId': roomId,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Room permission assigned');
        return {
          'success': true,
          'data': data,
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to assign permission',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> getRoomAccessLogs() async {
    final url = Uri.parse('$baseUrl/room-access/logs');
    print('📡 Fetching room access logs...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Access logs fetched: ${data['data']?.length ?? 0} logs');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch access logs',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> getUserPermissions(String userId) async {
    if (userId.isEmpty) {
      return {
        'success': false,
        'message': 'User ID is empty. Please login again.',
      };
    }

    final url = Uri.parse('$baseUrl/room-access/user-permissions/$userId');
    print('📡 Fetching user permissions for: $userId');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ User permissions fetched: ${data['data']?.length ?? 0} rooms');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to fetch permissions',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> getCurrentlyInside(String roomId) async {
    final url = Uri.parse('$baseUrl/room-access/currently-inside/$roomId');
    print('📡 Fetching current occupancy for room: $roomId');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print(
            '✅ Current occupancy fetched: ${data['data']?.length ?? 0} people');
        return {
          'success': true,
          'data': data['data'] ?? [],
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch current occupancy',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== NOTIFICATIONS ====================

  Future<Map<String, dynamic>> getNotifications() async {
    final url = Uri.parse('$baseUrl/notifications');
    print('📡 Fetching notifications...');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Notifications fetched: ${data['data']?.length ?? 0}');
        return {
          'success': true,
          'data': data['data'] ?? [],
          'unreadCount': data['unreadCount'] ?? 0,
          'count': data['count'] ?? 0,
        };
      } else {
        return {
          'success': false,
          'message': 'Failed to fetch notifications',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> markNotificationAsRead(String notifId) async {
    final url = Uri.parse('$baseUrl/notifications/$notifId/read');
    print('📡 Marking notification as read: $notifId');

    try {
      final response = await http
          .put(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Notification marked as read');
        return {
          'success': true,
          'message': data['message'] ?? 'Marked as read',
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to mark as read',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> markAllNotificationsAsRead() async {
    final url = Uri.parse('$baseUrl/notifications/read-all');
    print('📡 Marking all notifications as read...');

    try {
      final response = await http
          .put(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ All notifications marked as read');
        return {
          'success': true,
          'message': data['message'] ?? 'All marked as read',
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to mark all as read',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  Future<Map<String, dynamic>> deleteNotification(String notifId) async {
    final url = Uri.parse('$baseUrl/notifications/$notifId');
    print('📡 Deleting notification: $notifId');

    try {
      final response = await http
          .delete(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Notification deleted');
        return {
          'success': true,
          'message': data['message'] ?? 'Deleted successfully',
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to delete notification',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== DUAL AUTHENTICATION ====================

  Future<Map<String, dynamic>> dualAuthVerify({
    required String userId,
    required String roomId,
    required bool fingerprintVerified,
    String? faceImage,
  }) async {
    final url = Uri.parse('$baseUrl/dual-auth/verify');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'userId': userId,
              'roomId': roomId,
              'fingerprintVerified': fingerprintVerified,
              'faceImage': faceImage,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        return {
          'success': true,
          'message': data['message'],
          'securityLevel': data['securityLevel'],
          'authMethod': data['authMethod'],
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Authentication failed',
        };
      }
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  Future<Map<String, dynamic>> getRoomSecurityLevel(String roomId) async {
    final url = Uri.parse('$baseUrl/dual-auth/room/$roomId');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);
      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        return {
          'success': true,
          'securityLevel': data['room']['securityLevel'],
          'roomName': data['room']['roomName'],
        };
      } else {
        return {'success': false, 'message': 'Failed to get room info'};
      }
    } catch (e) {
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  // ==================== DOOR CONTROL ====================

  Future<Map<String, dynamic>> remoteUnlock(
    String roomId,
    String adminId,
  ) async {
    final url = Uri.parse('$baseUrl/door-control/remote-unlock');
    print('📡 Remote unlock requested for room: $roomId by admin: $adminId');

    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'roomId': roomId,
              'adminId': adminId,
            }),
          )
          .timeout(_defaultTimeout);

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        print('✅ Remote unlock successful');
        return {
          'success': true,
          'message': data['message'] ?? 'Door unlocked',
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to unlock',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Connection timeout. Please check your internet.',
      };
    } catch (e) {
      return {
        'success': false,
        'message': 'Network error: $e',
      };
    }
  }

  // ==================== FACE RECOGNITION (60-SECOND TIMEOUT) ====================

  Future<Map<String, dynamic>> enrollFace({
    required String userId,
    required String userName,
    required Uint8List imageBytes,
  }) async {
    final url = Uri.parse('$baseUrl/face/enroll');
    print('📡 Enrolling face for user: $userId');

    try {
      final request = http.MultipartRequest('POST', url);

      final token = await getToken();
      if (token != null) {
        request.headers['Authorization'] = 'Bearer $token';
      }

      request.fields['userId'] = userId;
      request.fields['userName'] = userName;

      request.files.add(
        http.MultipartFile.fromBytes(
          'faceImage',
          imageBytes,
          filename: 'face_${DateTime.now().millisecondsSinceEpoch}.jpg',
          contentType: MediaType('image', 'jpeg'),
        ),
      );

      final streamedResponse = await request.send().timeout(
        _faceOperationTimeout,
        onTimeout: () {
          print('❌ Face enrollment timed out after 60 seconds');
          throw TimeoutException(
              'Backend is taking too long to process face. Please try again.');
        },
      );

      final response = await http.Response.fromStream(streamedResponse);
      final data = jsonDecode(response.body);

      print('📥 Enroll response: ${response.statusCode} - ${data['success']}');

      if (response.statusCode == 200 && data['success'] == true) {
        return {'success': true, 'message': data['message'] ?? 'Face enrolled'};
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to enroll face',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message':
            'Backend timeout. Face processing is taking too long. Please try again.',
      };
    } catch (e) {
      print('❌ Enroll error: $e');
      return {'success': false, 'message': 'Network error: $e'};
    }
  }
  // ==================== FACE RECOGNITION (EXTENDED TIMEOUT - 120 SECONDS) ====================

  Future<Map<String, dynamic>> enrollFaceWithExtendedTimeout({
    required String userId,
    required String userName,
    required Uint8List imageBytes,
  }) async {
    final url = Uri.parse('$baseUrl/face/enroll');
    print('📡 Enrolling face for user: $userId (Extended timeout: 120s)');

    try {
      final request = http.MultipartRequest('POST', url);

      final token = await getToken();
      if (token != null) {
        request.headers['Authorization'] = 'Bearer $token';
      }

      request.fields['userId'] = userId;
      request.fields['userName'] = userName;

      request.files.add(
        http.MultipartFile.fromBytes(
          'faceImage',
          imageBytes,
          filename: 'face_${DateTime.now().millisecondsSinceEpoch}.jpg',
          contentType: MediaType('image', 'jpeg'),
        ),
      );

      // ✅ 120-SECOND TIMEOUT (2 minutes)
      final streamedResponse = await request.send().timeout(
        const Duration(seconds: 120),
        onTimeout: () {
          print('❌ Face enrollment timed out after 120 seconds');
          throw TimeoutException(
              'Backend is taking too long. Please try again.');
        },
      );

      final response = await http.Response.fromStream(streamedResponse);
      final data = jsonDecode(response.body);

      print('📥 Enroll response: ${response.statusCode} - ${data['success']}');

      if (response.statusCode == 200 && data['success'] == true) {
        return {'success': true, 'message': data['message'] ?? 'Face enrolled'};
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Failed to enroll face',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message':
            'Backend timeout after 2 minutes. Please check your internet or try again later.',
      };
    } catch (e) {
      print('❌ Enroll error: $e');
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  Future<Map<String, dynamic>> verifyFace({
    required String userId,
    required Uint8List imageBytes,
    String? roomId, // Pass roomId so backend sends face_unlock command to ESP32
  }) async {
    final url = Uri.parse('$baseUrl/face/verify');
    print('📡 Verifying face for user: $userId (room: ${roomId ?? "none"})');

    try {
      final request = http.MultipartRequest('POST', url);

      final token = await getToken();
      if (token != null) {
        request.headers['Authorization'] = 'Bearer $token';
      }

      request.fields['userId'] = userId;
      if (roomId != null && roomId.isNotEmpty) {
        request.fields['roomId'] = roomId;
      }

      request.files.add(
        http.MultipartFile.fromBytes(
          'faceImage',
          imageBytes,
          filename: 'verify_${DateTime.now().millisecondsSinceEpoch}.jpg',
          contentType: MediaType('image', 'jpeg'),
        ),
      );

      final streamedResponse = await request.send().timeout(
        _faceOperationTimeout,
        onTimeout: () {
          print('❌ Face verification timed out after 60 seconds');
          throw TimeoutException(
              'Backend is taking too long to verify face. Please try again.');
        },
      );

      final response = await http.Response.fromStream(streamedResponse);
      final data = jsonDecode(response.body);

      print('📥 Verify response: ${response.statusCode} - ${data['success']}');

      if (response.statusCode == 200 && data['success'] == true) {
        return {
          'success': true,
          'message': data['message'] ?? 'Face verified',
          'confidence': data['confidence'] ?? 0.0,
        };
      } else {
        return {
          'success': false,
          'message': data['message'] ?? 'Face does not match',
        };
      }
    } on TimeoutException {
      return {
        'success': false,
        'message':
            'Backend timeout. Face verification is taking too long. Please try again.',
      };
    } catch (e) {
      print('❌ Verify error: $e');
      return {'success': false, 'message': 'Network error: $e'};
    }
  }

  Future<Map<String, dynamic>> getFaceStatus(String userId) async {
    final url = Uri.parse('$baseUrl/face/status/$userId');

    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);
      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        return {'success': true, 'enrolled': data['enrolled'] ?? false};
      } else {
        return {'success': false, 'enrolled': false};
      }
    } catch (e) {
      print('❌ Face status error: $e');
      return {
        'success': false,
        'enrolled': false,
        'message': 'Network error: $e',
      };
    }
  }
  // ==================== ESP32 / HARDWARE INTEGRATION ====================

  /// Poll backend to check if ESP32 hardware has verified a fingerprint for this room
  Future<Map<String, dynamic>> checkFingerprintPending(String roomId) async {
    final url = Uri.parse('$baseUrl/esp32/pending-face-auth/$roomId');
    try {
      final response = await http.get(url).timeout(_defaultTimeout);
      final data = jsonDecode(response.body);
      return {
        'pending': data['pending'] ?? false,
        'userId': data['userId'] ?? '',
        'fingerId': data['fingerId'] ?? 0,
        'timeout': data['timeout'] ?? false,
      };
    } catch (e) {
      return {'pending': false, 'userId': '', 'timeout': false};
    }
  }

  /// Log room access after successful auth
  Future<Map<String, dynamic>> logRoomAccess({
    required String userId,
    required String roomId,
    required bool fingerprintVerified,
    required bool faceVerified,
  }) async {
    final url = Uri.parse('$baseUrl/dual-auth/verify');
    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({
              'userId': userId,
              'roomId': roomId,
              'fingerprintVerified': fingerprintVerified,
              'faceImage': null,
            }),
          )
          .timeout(_defaultTimeout);
      final data = jsonDecode(response.body);
      return {'success': data['success'] ?? true};
    } catch (e) {
      return {'success': false, 'message': 'Logging error: $e'};
    }
  }

  /// Get ESP32 device status (for admin dashboard)
  Future<Map<String, dynamic>> getDeviceStatus() async {
    final url = Uri.parse('$baseUrl/esp32/status');
    try {
      final response = await http
          .get(url, headers: await _getAuthHeaders())
          .timeout(_defaultTimeout);
      final data = jsonDecode(response.body);
      return {'success': true, 'data': data};
    } catch (e) {
      return {'success': false, 'message': 'Device status error: $e'};
    }
  }

  /// Admin: remote unlock a door
  Future<Map<String, dynamic>> sendDoorCommand(String roomId, String command) async {
    final url = Uri.parse('$baseUrl/esp32/send-command');
    try {
      final response = await http
          .post(
            url,
            headers: await _getAuthHeaders(),
            body: jsonEncode({'roomId': roomId, 'command': command}),
          )
          .timeout(_defaultTimeout);
      final data = jsonDecode(response.body);
      return {'success': data['success'] ?? false, 'message': data['message']};
    } catch (e) {
      return {'success': false, 'message': 'Command error: $e'};
    }
  }
}
