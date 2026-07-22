class CurrentUser {
  static String userId = '';
  static String name = '';
  static String email = '';
  static String role = '';
  static String department = '';
  static String faceStatus = 'NOT_ENROLLED';
  static String fingerprintId = '';

  // Backward-compatible getter
  static String get id => userId;

  static void setUser(Map<String, dynamic> user) {
    userId     = user['userId'] ?? user['id'] ?? '';
    name       = user['name'] ?? '';
    email      = user['email'] ?? '';
    role       = user['role'] ?? 'user';
    department = user['department'] ?? '';
    faceStatus = user['faceStatus'] ?? 'NOT_ENROLLED';
    fingerprintId = user['fingerprintId'] ?? '';
  }

  static void clear() {
    userId = '';
    name = '';
    email = '';
    role = '';
    department = '';
    faceStatus = 'NOT_ENROLLED';
    fingerprintId = '';
  }

  static bool get isAdmin => role == 'admin';
  static bool get isLoggedIn => userId.isNotEmpty;
  static bool get hasFaceEnrolled => faceStatus == 'ENROLLED';
  static bool get hasFingerEnrolled => fingerprintId.isNotEmpty;
}
