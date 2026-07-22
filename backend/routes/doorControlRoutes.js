const express = require('express');
const router = express.Router();
const { getSheetData, appendRow, findRowIndex, updateRow, logAccessEvent } = require('../services/sheetsService');
const { createNotification } = require('../services/notificationService');
const { verifyToken, verifyAdmin } = require('../middleware/authMiddleware');
const { validateRequest, schemas } = require('../middleware/validationMiddleware');

const { pendingCommands, enrollmentStatus } = require('../services/sharedState');

// ==================== POST /api/door-control/remote-unlock ====================
// Admin unlocks door remotely from the Flutter app
router.post('/remote-unlock', verifyToken, verifyAdmin, validateRequest(schemas.remoteUnlock), async (req, res) => {
  try {
    const { roomId } = req.body;
    const adminId = req.user.userId;

    // Queue command in shared in-memory store (ESP32 will poll get-commands)
    pendingCommands.set(roomId, {
      command: 'unlock',
      userName: req.user.name || 'Admin',
      adminId,
      timestamp: new Date().toISOString(),
    });

    // Log to ROOM_ACCESS sheet
    await logAccessEvent({
      action: 'REMOTE_UNLOCK',
      authMethod: 'ADMIN',
      status: 'GRANTED',
      userId: adminId,
      roomId: roomId,
      details: `Remote unlock by admin`
    });

    console.log(`🔓 Remote unlock queued for room ${roomId} by admin ${adminId}`);
    res.json({ success: true, message: 'Unlock command sent to door controller' });
  } catch (error) {
    console.error('❌ Remote unlock error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== POST /api/door-control/start-enrollment ====================
// Admin triggers fingerprint enrollment for a user via ESP32
router.post('/start-enrollment', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { roomId, userId, userName } = req.body;
    const adminId = req.user.userId;

    if (!roomId || !userId || !userName) {
      return res.status(400).json({ success: false, message: 'roomId, userId, userName required' });
    }

    // Verify user exists
    const users = await getSheetData('USERS');
    const user = users.find(u => (u.userid || u.userId) === userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Clear any previous enrollment status for this user
    enrollmentStatus.delete(userId);

    // Queue ENROLL command for ESP32 to pick up (uses shared pendingCommands)
    pendingCommands.set(roomId, {
      command: `ENROLL:${userId}:${userName}`,
      userName,
      adminId,
      timestamp: new Date().toISOString(),
    });

    console.log(`📝 Enrollment command queued for ${userName} (${userId}) → Room ${roomId}`);

    // Notify the user
    await createNotification(
      userId,
      '🖐️ Fingerprint Enrollment Started',
      `An admin has initiated fingerprint enrollment for you. Please go to room ${roomId} and place your finger on the sensor.`,
      'info'
    );

    res.json({
      success: true,
      message: `Enrollment command sent. Ask ${userName} to place finger on sensor in room ${roomId}.`,
    });
  } catch (error) {
    console.error('❌ Start enrollment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/door-control/status/:roomId ====================
router.get('/status/:roomId', verifyToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const logs = await getSheetData('ROOM_ACCESS');
    const roomLogs = logs
      .filter(l => l.roomId === roomId || l.roomid === roomId)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 20);

    res.json({ success: true, data: roomLogs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;