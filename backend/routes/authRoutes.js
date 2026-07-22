const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/authMiddleware');
const { validateRequest, schemas } = require('../middleware/validationMiddleware');
const { getSheetData, appendRow, findRowIndex, updateRow } = require('../services/sheetsService');
const { createNotification } = require('../services/notificationService');
const rateLimit = require('express-rate-limit');

// ==================== RATE LIMITER ====================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 auth requests per window
  message: { success: false, message: 'Too many authentication attempts from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ==================== HELPER ====================
function generateUserId() {
  return `USR-${Date.now().toString().slice(-6)}`;
}

// ==================== POST /api/auth/register ====================
router.post('/register', authLimiter, validateRequest(schemas.register), async (req, res) => {
  try {
    const { name, email, password, department, role } = req.body;
    
    // Check duplicate email
    const users = await getSheetData('USERS');
    const existing = users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    // Auto-calculate next available fingerprint slot ID (1, 2, 3...)
    let maxFpId = 0;
    users.forEach(u => {
      const idNum = parseInt(u.fingerprintId || u.fingerprintid || '0');
      if (!isNaN(idNum) && idNum > maxFpId) maxFpId = idNum;
    });
    const nextFpId = String(maxFpId + 1);

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = generateUserId();
    const assignedRole = (role || 'user').toLowerCase() === 'admin' ? 'admin' : 'user';

    // Save to USERS sheet
    // Columns: userId | username | email | password | role | department | authorized_rooms | fingerprintId | faceDescriptor | faceStatus
    await appendRow('USERS', [
      userId,
      name,
      email,
      hashedPassword,
      assignedRole,
      department,
      'ROOM-001',   // default authorized_rooms
      nextFpId,     // fingerprintId
      '',           // faceDescriptor
      'NOT_ENROLLED', // faceStatus
    ]);

    // Issue JWT with assignedRole
    const token = jwt.sign(
      { userId, role: assignedRole, email, name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Welcome notification
    await createNotification(userId, '👋 Welcome to LabSync!', `Your account has been created as ${assignedRole.toUpperCase()}. Fingerprint slot #${nextFpId} reserved.`, 'info');

    console.log(`✅ User registered: ${name} (${userId}) [role: ${assignedRole}, fpSlot: #${nextFpId}]`);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        userId,
        name,
        email,
        role: assignedRole,
        department,
        fingerprintId: nextFpId,
        faceStatus: 'NOT_ENROLLED',
      },
    });
  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({ success: false, message: error.message || 'Registration failed' });
  }
});

// ==================== POST /api/auth/login ====================
router.post('/login', authLimiter, validateRequest(schemas.login), async (req, res) => {
  try {
    const { email, password } = req.body;

    const users = await getSheetData('USERS');
    const user = users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Support both bcrypt hashed and legacy plaintext (migration period)
    let isMatch = false;
    const storedPassword = user.password || '';
    
    if (storedPassword.startsWith('$2')) {
      // Bcrypt hash
      isMatch = await bcrypt.compare(password, storedPassword);
    } else {
      // Legacy plaintext — compare directly, then migrate to hash
      isMatch = storedPassword === password;
      if (isMatch) {
        // Migrate to bcrypt
        const hashed = await bcrypt.hash(password, 10);
        const rowIndex = await findRowIndex('USERS', 'email', email);
        if (rowIndex !== -1) {
          await updateRow('USERS', rowIndex, [
            user.userid || user.userId,
            user.username || user.name,
            user.email,
            hashed,
            user.role,
            user.department,
            user.authorized_rooms || '',
            user.fingerprintid || user.fingerprintId || '',
            user.facedescriptor || user.faceDescriptor || '',
            user.facestatus || user.faceStatus || 'NOT_ENROLLED',
          ]);
          console.log(`🔄 Migrated password to bcrypt for: ${email}`);
        }
      }
    }

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const userId = user.userid || user.userId;
    const userName = user.username || user.name;
    const role = user.role || 'user';

    // Issue JWT
    const token = jwt.sign(
      { userId, role, email: user.email, name: userName },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ User logged in: ${userName} (${userId}) [role: ${role}]`);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        userId,
        name: userName,
        email: user.email,
        role,
        department: user.department || '',
        faceStatus: user.facestatus || user.faceStatus || 'NOT_ENROLLED',
        fingerprintId: user.fingerprintid || user.fingerprintId || '',
      },
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ success: false, message: error.message || 'Login failed' });
  }
});

// ==================== PUT /api/auth/change-password ====================
router.put('/change-password', async (req, res) => {
  try {
    const { userId, oldPassword, newPassword } = req.body;

    if (!userId || !oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }

    const users = await getSheetData('USERS');
    const user = users.find(u => (u.userid || u.userId) === userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Verify old password
    let isMatch = false;
    if ((user.password || '').startsWith('$2')) {
      isMatch = await bcrypt.compare(oldPassword, user.password);
    } else {
      isMatch = user.password === oldPassword;
    }

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const hashedNew = await bcrypt.hash(newPassword, 10);
    const rowIndex = await findRowIndex('USERS', 'userid', userId);

    if (rowIndex !== -1) {
      await updateRow('USERS', rowIndex, [
        user.userid || user.userId,
        user.username || user.name,
        user.email,
        hashedNew,
        user.role,
        user.department,
        user.authorized_rooms || '',
        user.fingerprintid || user.fingerprintId || '',
        user.facedescriptor || user.faceDescriptor || '',
        user.facestatus || user.faceStatus || 'NOT_ENROLLED',
      ]);
    }

    await createNotification(userId, '🔐 Password Changed', 'Your password was updated successfully.', 'info');

    console.log(`✅ Password changed for user: ${userId}`);
    res.status(200).json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('❌ Password change error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to change password' });
  }
});

// ==================== GET /api/auth/me ====================
// Verify token and return current user info
router.get('/me', async (req, res) => {
  try {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token' });
    }
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const users = await getSheetData('USERS');
    const user = users.find(u => (u.userid || u.userId) === decoded.userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        userId: user.userid || user.userId,
        name: user.username || user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        faceStatus: user.facestatus || user.faceStatus || 'NOT_ENROLLED',
        fingerprintId: user.fingerprintid || user.fingerprintId || '',
        authorizedRooms: user.authorized_rooms || '',
      },
    });
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
});

// In-memory OTP Store (email -> { otp, expiresAt })
const otpStore = new Map();

// ==================== POST /api/auth/send-otp ====================
router.post('/send-otp', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const users = await getSheetData('USERS');
    const user = users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
    if (!user) {
      return res.status(404).json({ success: false, message: 'No registered account found with this email' });
    }

    // Generate random 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity

    otpStore.set(email.toLowerCase(), { otp, expiresAt });

    console.log(`\n📧 OTP GENERATED for ${email}: ${otp} (Expires in 5 minutes)`);

    res.json({
      success: true,
      message: `OTP sent to ${email}`,
      otpDebug: otp, // Returned for UI convenience/testing
    });
  } catch (error) {
    console.error('❌ Error sending OTP:', error);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

// ==================== POST /api/auth/verify-otp ====================
router.post('/verify-otp', authLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const record = otpStore.get(email.toLowerCase());
    if (!record) {
      return res.status(400).json({ success: false, message: 'No OTP requested for this email. Please request a new OTP.' });
    }

    if (Date.now() > record.expiresAt) {
      otpStore.delete(email.toLowerCase());
      return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
    }

    if (record.otp !== otp.toString().trim()) {
      return res.status(400).json({ success: false, message: 'Invalid OTP code. Please check and try again.' });
    }

    // OTP matched! Delete from store
    otpStore.delete(email.toLowerCase());

    // Fetch user details
    const users = await getSheetData('USERS');
    const user = users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userId = user.userid || user.userId;
    const userName = user.username || user.name;
    const role = user.role || 'user';

    // Issue JWT Token
    const token = jwt.sign(
      { userId, role, email: user.email, name: userName },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ Email OTP login successful for: ${userName} (${userId})`);

    res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      token,
      user: {
        userId,
        name: userName,
        email: user.email,
        role,
        department: user.department || '',
        faceStatus: user.facestatus || user.faceStatus || 'NOT_ENROLLED',
        fingerprintId: user.fingerprintid || user.fingerprintId || '',
      },
    });
  } catch (error) {
    console.error('❌ Error verifying OTP:', error);
    res.status(500).json({ success: false, message: 'Failed to verify OTP' });
  }
});

module.exports = router;