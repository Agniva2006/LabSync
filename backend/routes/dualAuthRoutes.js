const express = require('express');
const router = express.Router();
const { getSheetData, logAccessEvent } = require('../services/sheetsService');
const faceService = require('../services/faceService');
const { createNotification } = require('../services/notificationService');
const { pendingCommands } = require('../services/sharedState');

// POST /api/dual-auth/verify - Complete dual biometric authentication
router.post('/verify', async (req, res) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const { userId, roomId, fingerprintVerified, faceImage } = req.body;

    console.log(`\n============================================================`);
    console.log(`🔐 [DUAL-AUTH-START] User ID: ${userId || 'MISSING'} | Room ID: ${roomId || 'MISSING'}`);
    console.log(`   Time: ${timestamp} | Fingerprint Flag: ${fingerprintVerified} | Face Frame: ${!!faceImage}`);

    if (!userId || !roomId) {
      return res.status(400).json({
        success: false,
        message: 'userId and roomId are required for dual authentication',
      });
    }

    // Step 1: Validate Room Details & Policy
    console.log(`⏳ [DUAL-AUTH-STEP 1/6] Retrieving room metadata for ${roomId}...`);
    const rooms = await getSheetData('ROOMS');
    const normRoomId = String(roomId).toLowerCase();
    const room = rooms.find(r => String(r.roomid || r.roomId || '').toLowerCase() === normRoomId);

    if (!room) {
      console.warn(`❌ [DUAL-AUTH-STEP 1/6] Room "${roomId}" not found in database!`);
      return res.status(404).json({
        success: false,
        message: `Room "${roomId}" not found`,
      });
    }

    const securityLevel = (room.securitylevel || room.securityLevel || 'LOW').toUpperCase();
    const roomName = room.roomname || room.roomName || roomId;
    console.log(`✅ [DUAL-AUTH-STEP 1/6] Room Found: "${roomName}" | Security Policy: [${securityLevel}]`);

    // Step 2: Validate User Permissions
    console.log(`⏳ [DUAL-AUTH-STEP 2/6] Verifying access permissions for ${userId}...`);
    const users = await getSheetData('USERS');
    const normUserId = String(userId).toLowerCase();
    const user = users.find(u => String(u.userid || u.userId || '').toLowerCase() === normUserId);

    if (!user) {
      console.warn(`❌ [DUAL-AUTH-STEP 2/6] User "${userId}" not found in database!`);
      return res.status(404).json({
        success: false,
        message: `User "${userId}" not found`,
      });
    }

    const userName = user.username || user.name || userId;
    const authorizedRooms = (user.authorized_rooms || '').split(',').map(r => r.trim().toLowerCase());
    const isAuthorized = authorizedRooms.includes(normRoomId) || authorizedRooms.includes('*') || user.role === 'admin';

    if (!isAuthorized) {
      console.warn(`❌ [DUAL-AUTH-STEP 2/6] User "${userName}" (${userId}) NOT authorized for room "${roomName}" (${roomId})`);
      await logAccessEvent({
        action: 'ENTRY',
        authMethod: 'DUAL',
        status: 'UNAUTHORIZED_ROOM',
        userId: userId,
        roomId: roomId,
        details: `User not on authorized list for ${roomName}`
      });

      return res.status(403).json({
        success: false,
        message: `User is not authorized to access ${roomName}`,
      });
    }
    console.log(`✅ [DUAL-AUTH-STEP 2/6] User "${userName}" (${userId}) authorized for ${roomName} [Role: ${user.role}]`);

    // Step 3: Evaluate Factor 1 (Fingerprint)
    console.log(`⏳ [DUAL-AUTH-STEP 3/6] Evaluating fingerprint factor...`);
    let fingerprintOk = false;
    if (fingerprintVerified === true || fingerprintVerified === 'true') {
      fingerprintOk = true;
      console.log(`✅ [DUAL-AUTH-STEP 3/6] Fingerprint factor: PASSED (Verified by Adafruit DSP Hardware)`);
    } else {
      console.log(`ℹ️ [DUAL-AUTH-STEP 3/6] Fingerprint factor: NOT VERIFIED / ABSENT`);
      if (securityLevel === 'HIGH') {
        console.warn(`❌ [DUAL-AUTH-HIGH-POLICY] High security room requires physical fingerprint match!`);
        return res.status(401).json({
          success: false,
          message: 'Fingerprint verification strictly required for high-security room',
          requiresFingerprint: true,
        });
      }
    }

    // Step 4: Evaluate Factor 2 (Facial Recognition)
    console.log(`⏳ [DUAL-AUTH-STEP 4/6] Evaluating facial biometric factor...`);
    let faceOk = false;
    let faceResult = null;

    if (faceImage && typeof faceImage === 'string') {
      try {
        const cleanBase64 = faceImage.replace(/^data:image\/\w+;base64,/, '').trim();
        const imageBuffer = Buffer.from(cleanBase64, 'base64');
        console.log(`   Ingesting face image: ${imageBuffer.length} bytes for ${userId}...`);

        faceResult = await faceService.verifyFace(userId, imageBuffer);
        faceOk = faceResult.success;
        console.log(`   Face Result: ${faceOk ? '✅ MATCH' : '❌ MISMATCH'} (Distance: ${faceResult.distance?.toFixed(3) || 'N/A'}, Similarity: ${faceResult.similarityPercent || 0}%)`);
      } catch (faceErr) {
        console.error(`❌ [DUAL-AUTH-STEP 4/6] Face verification exception:`, faceErr.message);
      }
    } else {
      console.log(`ℹ️ [DUAL-AUTH-STEP 4/6] Face image not provided in payload`);
      if (securityLevel === 'HIGH') {
        console.warn(`❌ [DUAL-AUTH-HIGH-POLICY] High security room requires facial verification!`);
        return res.status(401).json({
          success: false,
          message: 'Face verification strictly required for high-security room',
          requiresFace: true,
        });
      }
    }

    // Step 5: Multi-Factor Policy Matrix Decision
    console.log(`⏳ [DUAL-AUTH-STEP 5/6] Enforcing security policy matrix for level: [${securityLevel}]...`);
    let accessGranted = false;
    let authMethod = 'UNKNOWN';

    switch (securityLevel) {
      case 'LOW':
        // Any single factor passes (Fingerprint OR Face)
        accessGranted = fingerprintOk || faceOk;
        authMethod = (fingerprintOk && faceOk) ? 'DUAL' : (fingerprintOk ? 'FINGERPRINT' : 'FACE');
        break;

      case 'MEDIUM':
        // Default to either factor, but logs DUAL if both are verified
        accessGranted = fingerprintOk || faceOk;
        authMethod = (fingerprintOk && faceOk) ? 'DUAL' : (fingerprintOk ? 'FINGERPRINT' : 'FACE');
        break;

      case 'HIGH':
        // Both factors MUST pass (Fingerprint AND Face)
        accessGranted = fingerprintOk && faceOk;
        authMethod = 'DUAL';
        break;

      default:
        accessGranted = fingerprintOk || faceOk;
        authMethod = fingerprintOk ? 'FINGERPRINT' : 'FACE';
    }

    console.log(`🎯 [DUAL-AUTH-STEP 5/6] Decision Outcome: ${accessGranted ? '✅ ACCESS GRANTED' : '❌ ACCESS DENIED'}`);
    console.log(`   Method: ${authMethod} | FP: ${fingerprintOk} | Face: ${faceOk} | Policy: ${securityLevel}`);

    // If access granted, queue door unlock command for ESP32 DevKit
    if (accessGranted && roomId) {
      pendingCommands.set(roomId, {
        command: 'face_unlock',
        userName: userName,
        adminId: userId,
        timestamp: new Date().toISOString(),
      });
      console.log(`🔓 [DOOR-UNLOCK-COMMAND] Queued 'face_unlock' for Room ${roomId}`);
    }

    // Step 6: Audit Logging & User Notifications
    console.log(`⏳ [DUAL-AUTH-STEP 6/6] Logging access event to database & alerting user...`);
    await logAccessEvent({
      action: 'ENTRY',
      authMethod: authMethod,
      status: accessGranted ? 'GRANTED' : 'DENIED',
      userId: userId,
      roomId: roomId,
      details: `Fingerprint: ${fingerprintOk} | Face: ${faceOk} (Sim: ${faceResult?.similarityPercent || 0}%) | Level: ${securityLevel} | Elapsed: ${Date.now() - startTime}ms`
    });

    if (accessGranted) {
      await createNotification(
        userId,
        '✅ Access Granted',
        `Access granted to ${roomName} via ${authMethod} authentication.`,
        'ACCESS_GRANTED'
      ).catch(() => {});
    } else {
      await createNotification(
        userId,
        '❌ Access Denied',
        `Access denied for ${roomName}. Security level: ${securityLevel}.`,
        'ACCESS_DENIED'
      ).catch(() => {});
    }

    const elapsed = Date.now() - startTime;
    console.log(`🏁 [DUAL-AUTH-COMPLETE] Completed in ${elapsed}ms\n============================================================\n`);

    res.json({
      success: accessGranted,
      message: accessGranted ? `Access granted to ${roomName}` : `Access denied for ${roomName}`,
      securityLevel,
      authMethod,
      fingerprintVerified: fingerprintOk,
      faceVerified: faceOk,
      faceDetails: faceResult ? {
        similarityPercent: faceResult.similarityPercent,
        confidence: faceResult.confidence,
        distance: faceResult.distance,
        box: faceResult.box || null,
      } : null,
      room: {
        roomId,
        roomName,
      },
      timeMs: elapsed,
    });

  } catch (error) {
    console.error('❌ [DUAL-AUTH-ERROR]:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Dual authentication processing failed',
    });
  }
});

// GET /api/dual-auth/room/:roomId - Get room security level
router.get('/room/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const rooms = await getSheetData('ROOMS');
    const normRoom = String(roomId).toLowerCase();
    const room = rooms.find(r => String(r.roomid || r.roomId || '').toLowerCase() === normRoom);

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
        securityLevel: (room.securitylevel || room.securityLevel || 'LOW').toUpperCase(),
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