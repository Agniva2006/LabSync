const express = require('express');
const router = express.Router();
const { getSheetData, logAccessEvent } = require('../services/sheetsService');
const faceService = require('../services/faceService');
const { createNotification } = require('../services/notificationService');

// POST /api/dual-auth/verify - Complete dual authentication
router.post('/verify', async (req, res) => {
  try {
    const { userId, roomId, fingerprintVerified, faceImage } = req.body;

    console.log(`🔐 Dual auth request: User ${userId}, Room ${roomId}`);

    // 1. Get room details
    const rooms = await getSheetData('ROOMS');
    const room = rooms.find(r => r.roomid === roomId || r.roomId === roomId);

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found',
      });
    }

    const securityLevel = (room.securitylevel || room.securityLevel || 'LOW').toUpperCase();
    console.log(`🔒 Room security level: ${securityLevel}`);

    // 2. Check user permissions
    const users = await getSheetData('USERS');
    const user = users.find(u => u.userid === userId || u.userId === userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const authorizedRooms = (user.authorized_rooms || '').split(',').map(r => r.trim());
    if (!authorizedRooms.includes(roomId)) {
      return res.status(403).json({
        success: false,
        message: 'User not authorized for this room',
      });
    }

    // 3. Authentication logic based on security level
    let fingerprintOk = false;
    let faceOk = false;

    // Check fingerprint
    if (fingerprintVerified === true) {
      fingerprintOk = true;
      console.log('✅ Fingerprint verified');
    } else if (securityLevel === 'HIGH') {
      return res.status(401).json({
        success: false,
        message: 'Fingerprint verification required for high-security room',
        requiresFingerprint: true,
      });
    }

    // Check face
    if (faceImage) {
      const faceResult = await faceService.verifyFace(userId, Buffer.from(faceImage, 'base64'));
      faceOk = faceResult.success;
      console.log(` Face verification: ${faceOk ? 'SUCCESS' : 'FAILED'}`);
    } else if (securityLevel === 'HIGH') {
      return res.status(401).json({
        success: false,
        message: 'Face verification required for high-security room',
        requiresFace: true,
      });
    }

    // 4. Final decision
    let accessGranted = false;
    let authMethod = '';

    switch (securityLevel) {
      case 'LOW':
        accessGranted = fingerprintOk || faceOk;
        authMethod = fingerprintOk ? 'FINGERPRINT' : 'FACE';
        break;
      
      case 'MEDIUM':
        accessGranted = fingerprintOk || faceOk;
        authMethod = fingerprintOk && faceOk ? 'DUAL' : (fingerprintOk ? 'FINGERPRINT' : 'FACE');
        break;
      
      case 'HIGH':
        accessGranted = fingerprintOk && faceOk;
        authMethod = 'DUAL';
        break;
      
      default:
        accessGranted = fingerprintOk || faceOk;
        authMethod = 'UNKNOWN';
    }

    // 5. Log access robustly
    await logAccessEvent({
      action: 'ENTRY',
      authMethod: authMethod,
      status: accessGranted ? 'GRANTED' : 'DENIED',
      userId: userId,
      roomId: roomId,
      details: `Fingerprint: ${fingerprintOk}, Face: ${faceOk}, Security Level: ${securityLevel}`
    });

    // 6. Send notification
    if (accessGranted) {
      await createNotification(
        userId,
        '✅ Access Granted',
        `You have been granted access to ${room.roomname || room.roomName}`,
        'ACCESS_GRANTED'
      );
    } else {
      await createNotification(
        userId,
        '❌ Access Denied',
        `Access denied for ${room.roomname || room.roomName}. Security level: ${securityLevel}`,
        'ACCESS_DENIED'
      );
    }

    res.json({
      success: accessGranted,
      message: accessGranted ? 'Access granted' : 'Access denied',
      securityLevel,
      authMethod,
      fingerprintVerified: fingerprintOk,
      faceVerified: faceOk,
      room: {
        roomId,
        roomName: room.roomname || room.roomName,
      },
    });

  } catch (error) {
    console.error('❌ Dual auth error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Authentication failed',
    });
  }
});

// GET /api/dual-auth/room/:roomId - Get room security level
router.get('/room/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const rooms = await getSheetData('ROOMS');
    const room = rooms.find(r => r.roomid === roomId || r.roomId === roomId);

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found',
      });
    }

    res.json({
      success: true,
      room: {
        roomId,
        roomName: room.roomname || room.roomName,
        securityLevel: room.securitylevel || room.securityLevel || 'LOW',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;