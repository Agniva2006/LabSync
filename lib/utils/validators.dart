class Validators {
  // Password validation: Min 8 chars, 1 number, 1 special character
  static bool isValidPassword(String password) {
    if (password.isEmpty) return false;

    // Min 8 characters
    if (password.length < 8) return false;

    // At least 1 number
    final hasNumber = RegExp(r'[0-9]').hasMatch(password);
    if (!hasNumber) return false;

    // At least 1 special character
    final hasSpecial = RegExp(r'[!@#$%^&*(),.?":{}|<>]').hasMatch(password);
    if (!hasSpecial) return false;

    // At least 1 letter
    final hasLetter = RegExp(r'[A-Za-z]').hasMatch(password);
    if (!hasLetter) return false;

    return true;
  }

  // Get password validation error message
  static String? validatePassword(String? value) {
    if (value == null || value.isEmpty) {
      return 'Password is required';
    }
    if (value.length < 8) {
      return 'Password must be at least 8 characters';
    }
    if (!RegExp(r'[0-9]').hasMatch(value)) {
      return 'Password must contain at least 1 number';
    }
    if (!RegExp(r'[!@#$%^&*(),.?":{}|<>]').hasMatch(value)) {
      return 'Password must contain at least 1 special character';
    }
    if (!RegExp(r'[A-Za-z]').hasMatch(value)) {
      return 'Password must contain at least 1 letter';
    }
    return null;
  }

  // Email validation
  static String? validateEmail(String? value) {
    if (value == null || value.isEmpty) {
      return 'Email is required';
    }
    if (!value.contains('@')) {
      return 'Enter a valid email';
    }
    return null;
  }
}
