const express = require('express');
const router = express.Router();
const { getSheetData, appendRow, findRowIndex, updateRow, logAccessEvent } = require('../services/sheetsService');
const { createNotification } = require('../services/notificationService');
const { checkNightLockout, trackFailedAttempt, clearFailedAttempts } = require('../services/securityService');

const { pendingCommands, deviceStatus, enrollmentStatus, pendingFaceAuth } = require('../services/sharedState');

// ==================== DUAL AUTH — STEP 1: FINGERPRINT VERIFIED ====================
// Called by ESP32 DevKit after fingerSearch() succeeds
router.post('/fingerprint-verified', async (req, res) => {
  try {
    const { roomId, userId, fingerId } = req.body;

    if (!roomId || !userId || fingerId === undefined) {
      return res.status(400).json({ success: false, message: 'roomId, userId, fingerId required' });
    }

    console.log(`\n🟢 FINGERPRINT VERIFIED`);
    console.log(`   Room: ${roomId} | User: ${userId} | Finger: ${fingerId}`);

    // [NIGHT LOCKOUT CHECK]
    const { lockedOut, message } = await checkNightLockout(userId);
    if (lockedOut) {
      await logAccessEvent({
        action: 'ENTRY',
        authMethod: 'FINGERPRINT',
        status: 'NIGHT_LOCKOUT',
        userId: userId,
        roomId: roomId,
        details: message
      });
      return res.json({ success: false, message });
    }

    // Clear failed attempts since fingerprint passed
    clearFailedAttempts(roomId);

    // Store pending face auth (30s timeout)
    pendingFaceAuth.set(roomId, {
      userId,
      fingerId,
      timestamp: Date.now(),
      status: 'PENDING_FACE',
    });

    // Log to ROOM_ACCESS sheet
    await logAccessEvent({
      action: 'ENTRY',
      authMethod: 'FINGERPRINT',
      status: 'PENDING_FACE',
      userId: userId,
      roomId: roomId,
      details: `Fingerprint ID ${fingerId} verified — awaiting face auth`
    });

    res.json({ success: true, message: 'Fingerprint verified — face verification pending' });
  } catch (error) {
    console.error('❌ fingerprint-verified error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== POLL: PENDING FACE AUTH (Flutter + Python poll this) ====================
router.get('/pending-face-auth/:roomId', (req, res) => {
  const { roomId } = req.params;
  const pending = pendingFaceAuth.get(roomId);

  // Expire after 30 seconds
  if (pending && Date.now() - pending.timestamp > 30000) {
    console.log(`⏰ Face auth timeout for room ${roomId}`);
    pendingFaceAuth.delete(roomId);

    appendRow('ROOM_ACCESS', [
      `LOG-${Date.now()}`,
      pending.userId,
      roomId,
      'FACE_AUTH',
      new Date().toISOString(),
      'TIMEOUT',
      'true',
      'false',
      'Face verification timeout (30s)',
    ]).catch(() => {});

    return res.json({ pending: false, timeout: true });
  }

  if (pending && pending.status === 'PENDING_FACE') {
    return res.json({
      pending: true,
      userId: pending.userId,
      fingerId: pending.fingerId,
    });
  }

  res.json({ pending: false });
});

// ==================== CLEAR PENDING ====================
router.post('/clear-pending/:roomId', (req, res) => {
  const { roomId } = req.params;
  pendingFaceAuth.delete(roomId);
  res.json({ success: true, message: 'Pending state cleared' });
});

// ==================== SEND COMMAND (from backend/admin/face-verify result) ====================
router.post('/send-command', async (req, res) => {
  try {
    const { roomId, command, userName, adminId, userId, email, department, role, authorizedRooms } = req.body;

    if (!roomId || !command) {
      return res.status(400).json({ success: false, message: 'roomId and command required' });
    }

    console.log(`\n📡 COMMAND QUEUED: ${command} → Room ${roomId}`);

    // If command is an ENROLL command, ensure user exists in USERS sheet
    if (typeof command === 'string' && command.startsWith('ENROLL:')) {
      const parts = command.split(':');
      const targetUserId = parts[1] || userId;
      const targetUserName = parts[2] || userName || 'New User';

      try {
        const bcrypt = require('bcryptjs');
        const users = await getSheetData('USERS');
        let userIndex = users.findIndex(u => (u.userid || u.userId) === targetUserId || (email && u.email && u.email.toLowerCase() === email.toLowerCase()));

        if (userIndex === -1) {
          // Create new user record in USERS sheet
          const defaultHash = await bcrypt.hash('user123', 10);
          await appendRow('USERS', [
            targetUserId,
            targetUserName,
            email || '',
            defaultHash,
            role || 'user',
            department || '',
            authorizedRooms || roomId,
            '',   // fingerprintId
            '',   // faceDescriptor
            'NOT_ENROLLED'
          ]);
          console.log(`✅ Created user ${targetUserName} (${targetUserId}) in USERS sheet [Role: ${role || 'user'}]`);
        } else {
          // Update existing user details if role/email/department/authorizedRooms changed
          const existingUser = users[userIndex];
          const rowIndex = userIndex + 2; // 1-indexed + header
          await updateRow('USERS', rowIndex, [
            existingUser.userid || existingUser.userId || targetUserId,
            targetUserName,
            email || existingUser.email || '',
            existingUser.password,
            role || existingUser.role || 'user',
            department || existingUser.department || '',
            authorizedRooms || existingUser.authorized_rooms || roomId,
            existingUser.fingerprintid || existingUser.fingerprintId || '',
            existingUser.facedescriptor || existingUser.faceDescriptor || '',
            existingUser.facestatus || existingUser.faceStatus || 'NOT_ENROLLED'
          ]);
          console.log(`🔄 Updated user details for ${targetUserName} (${targetUserId}) in USERS sheet [Role: ${role || existingUser.role}]`);
        }
      } catch (dbErr) {
        console.error('❌ Error syncing user to USERS sheet during enroll:', dbErr.message);
      }
    }

    pendingCommands.set(roomId, {
      command,
      userName: userName || 'System',
      adminId: adminId || userId || 'SYSTEM',
      timestamp: new Date().toISOString(),
    });

    // Update pending face auth status
    const pending = pendingFaceAuth.get(roomId);
    if (pending) {
      pending.status = command === 'face_unlock' ? 'COMPLETED' : 'DENIED';
    }

    // Log command
    try {
      await logAccessEvent({
        action: 'COMMAND',
        authMethod: 'SYSTEM',
        status: command === 'face_unlock' ? 'SUCCESS' : 'DENIED',
        userId: adminId || userId || 'SYSTEM',
        roomId: roomId,
        details: `Command: ${command} by ${userName || 'system'}`
      });
    } catch (logErr) {
      console.warn('⚠️ Log failed:', logErr.message);
    }

    res.json({ success: true, message: `Command '${command}' queued for ${roomId}` });
  } catch (error) {
    console.error('❌ send-command error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== POST /api/esp32/door-closed ====================
// ESP32 reports that the door relay has closed
router.post('/door-closed', async (req, res) => {
  try {
    const { roomId } = req.body;
    if (!roomId) {
      return res.status(400).json({ success: false, message: 'roomId required' });
    }

    console.log(`🚪 Door closed mechanically at room ${roomId}`);
    
    await logAccessEvent({
      action: 'DOOR_CLOSED',
      authMethod: 'SYSTEM',
      status: 'SUCCESS',
      userId: 'SYSTEM',
      roomId: roomId,
      details: 'Relay closed by hardware timer'
    });

    res.json({ success: true, message: 'Door close logged' });
  } catch (error) {
    console.error('❌ POST /door-closed error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET COMMANDS (ESP32 polls this) ====================
// ESP32 DevKit polls every 3 seconds — in-memory (NO Sheets reads = no quota burn)
router.get('/get-commands/:roomId', (req, res) => {
  const { roomId } = req.params;
  const command = pendingCommands.get(roomId);

  if (command) {
    pendingCommands.delete(roomId); // One-time use
    console.log(`📤 Delivering command to ESP32: ${command.command} → ${roomId}`);
    return res.json({
      success: true,
      hasCommand: true,
      command: command.command,
      userName: command.userName,
      adminId: command.adminId,
    });
  }

  res.json({ success: true, hasCommand: false });
});

// ==================== GET USER BY FINGERPRINT ID ====================
// ESP32 calls this after fingerSearch() to get the matching userId
router.get('/user-by-finger/:fingerId', async (req, res) => {
  try {
    const { fingerId } = req.params;
    const users = await getSheetData('USERS');

    const user = users.find(u => {
      const storedId = u.fingerprintid || u.fingerprintId || '';
      return storedId !== '' && parseInt(storedId) === parseInt(fingerId);
    });

    if (!user) {
      console.log(`❌ No user found for fingerprint ID: ${fingerId}`);
      return res.json({ found: false, message: `No user registered with fingerprint ID ${fingerId}` });
    }

    const userId = user.userid || user.userId;
    const userName = user.username || user.name;

    console.log(`✅ Fingerprint ${fingerId} → User: ${userName} (${userId})`);
    res.json({ found: true, userId, userName, role: user.role });
  } catch (error) {
    console.error('❌ user-by-finger error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== ENROLLMENT COMPLETE (ESP32 calls after enroll) ====================
router.post('/enrollment-complete', async (req, res) => {
  try {
    const { fingerId, userId, userName, roomId } = req.body;

    console.log(`\n📝 ENROLLMENT COMPLETE`);
    console.log(`   Finger ID: ${fingerId} | User: ${userName} (${userId})`);

    // Track in-memory for polling
    enrollmentStatus.set(userId, {
      completed: true,
      fingerprintId: fingerId,
      enrolledAt: new Date().toISOString(),
      userName,
    });

    // Update USERS sheet fingerprintId column
    const users = await getSheetData('USERS');
    let rowIndex = await findRowIndex('USERS', 'userid', userId);
    if (rowIndex === -1) rowIndex = await findRowIndex('USERS', 'userId', userId);

    if (rowIndex !== -1) {
      const user = users.find(u => (u.userid || u.userId) === userId);
      await updateRow('USERS', rowIndex, [
        user.userid || user.userId,
        user.username || user.name,
        user.email,
        user.password,
        user.role,
        user.department,
        user.authorized_rooms || '',
        fingerId.toString(),                            // fingerprintId
        user.facedescriptor || user.faceDescriptor || '', // preserve faceDescriptor
        user.facestatus || user.faceStatus || 'NOT_ENROLLED',
      ]);
      console.log(`✅ Updated fingerprintId to ${fingerId} for user ${userId}`);
    }

    // Send notification to user
    await createNotification(
      userId,
      '🖐️ Fingerprint Enrolled',
      `Your fingerprint (ID: ${fingerId}) has been enrolled successfully. You can now use it to access authorized rooms.`,
      'success'
    );

    res.json({ success: true, message: 'Enrollment recorded' });
  } catch (error) {
    console.error('❌ enrollment-complete error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== ENROLLMENT FAILED (ESP32 calls after failed enroll) ====================
router.post('/enrollment-failed', async (req, res) => {
  try {
    const { userId, userName, error, details } = req.body;

    console.log(`\n❌ ENROLLMENT FAILED`);
    console.log(`   User: ${userName} (${userId}) | Error: ${error} | Details: ${details}`);

    enrollmentStatus.set(userId, {
      completed: false,
      failed: true,
      error: error || 'Enrollment failed',
      details: details || '',
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: 'Failure recorded' });
  } catch (err) {
    console.error('❌ enrollment-failed error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== HEARTBEAT (ESP32 posts every 30s) ====================
// Keep track of how many times a device has posted to limit Sheets quota usage
const heartbeatCounters = new Map();

router.post('/heartbeat', async (req, res) => {
  const { roomId, deviceId, rssi, freeHeap, uptime } = req.body;
  if (deviceId) {
    deviceStatus.set(deviceId, {
      roomId, rssi, freeHeap, uptime,
      lastSeen: new Date().toISOString(),
    });

    // Telemetry Logging (Log every 10th heartbeat = roughly every 5 mins)
    let count = heartbeatCounters.get(deviceId) || 0;
    count++;
    if (count >= 10) {
      count = 0;
      try {
        await appendRow('SYSTEM_TELEMETRY', [
          `TEL-${Date.now()}`,
          new Date().toISOString(),
          deviceId,
          roomId,
          rssi,
          freeHeap,
          uptime
        ]);
        console.log(`📊 Telemetry logged for ${deviceId}`);
      } catch (err) {
        // Skip log if sheet doesn't exist yet
      }
    }
    heartbeatCounters.set(deviceId, count);
  }
  res.json({ success: true });
});

// ==================== STATUS (admin/Flutter polls) ====================
router.get('/status', (req, res) => {
  const devices = Object.fromEntries(deviceStatus);
  res.json({
    success: true,
    devices,
    pendingCommandsCount: pendingCommands.size,
    pendingFaceAuthCount: pendingFaceAuth.size,
    enrollmentStatusCount: enrollmentStatus.size,
  });
});

// ==================== ENROLLMENT STATUS POLL ====================
router.get('/enrollment-status/:userId', (req, res) => {
  const { userId } = req.params;
  const status = enrollmentStatus.get(userId);
  if (status) {
    if (status.failed) {
      return res.json({
        success: true,
        enrolled: false,
        failed: true,
        error: status.error,
        details: status.details,
      });
    }
    if (status.completed) {
      return res.json({
        success: true,
        enrolled: true,
        failed: false,
        fingerprintId: status.fingerprintId,
        enrolledAt: status.enrolledAt,
      });
    }
  }
  res.json({ success: true, enrolled: false, failed: false });
});

// ==================== DEBUG (remove in production) ====================
router.get('/debug/pending', (req, res) => {
  res.json({
    pendingCommands: Object.fromEntries(pendingCommands),
    pendingFaceAuth: Object.fromEntries(pendingFaceAuth),
    deviceStatus: Object.fromEntries(deviceStatus),
    enrollmentStatus: Object.fromEntries(enrollmentStatus),
  });
});

router.post('/debug/clear-all', (req, res) => {
  pendingCommands.clear();
  pendingFaceAuth.clear();
  console.log('🗑️ All pending states cleared');
  res.json({ success: true, message: 'Cleared' });
});

module.exports = router;