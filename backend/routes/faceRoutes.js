const express = require('express');
const router = express.Router();
const multer = require('multer');
const faceService = require('../services/faceService');
const { getSheetData, findRowIndex, updateRow, appendRow, logAccessEvent } = require('../services/sheetsService');
const { verifyToken } = require('../middleware/authMiddleware');
const { checkNightLockout, trackFailedAttempt, clearFailedAttempts } = require('../services/securityService');
const { enrollmentStatus, pendingCommands } = require('../services/sharedState');

// ==================== MULTER CONFIGURATION ====================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    console.log(`📁 [UPLOAD] Received file: ${file.originalname}, Type: ${file.mimetype}`);
    
    // Accept standard image types
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'application/octet-stream'];
    if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error(`Only JPEG and PNG images are allowed (received: ${file.mimetype})`), false);
    }
  },
});

// ==================== HELPER FUNCTIONS ====================

const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 10MB.',
      });
    }
    return res.status(400).json({
      success: false,
      message: `Upload error: ${err.message}`,
    });
  }
  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }
  next();
};

// Helper to extract buffer from either multipart (req.file) or json base64 (req.body.faceImage)
function extractImageBuffer(req) {
  if (req.file && req.file.buffer && req.file.buffer.length > 0) {
    return { buffer: req.file.buffer, source: 'MULTIPART_FILE' };
  }

  const base64Candidate = req.body?.faceImage || req.body?.image || req.body?.photo;
  if (base64Candidate && typeof base64Candidate === 'string') {
    const cleanBase64 = base64Candidate.replace(/^data:image\/\w+;base64,/, '').trim();
    const buffer = Buffer.from(cleanBase64, 'base64');
    return { buffer, source: 'BASE64_BODY' };
  }

  return { buffer: null, source: 'NONE' };
}

// ==================== UNIVERSAL REMOTE / APP / WEB FACE ENROLLMENT ====================
router.post('/enroll', upload.single('faceImage'), handleMulterError, async (req, res) => {
  try {
    const { userId } = req.body;
    const { buffer: imageBuffer, source } = extractImageBuffer(req);

    console.log(`\n============================================================`);
    console.log(`🌐 [REMOTE-FACE-ENROLL] Enrollment request for User ID: ${userId || 'N/A'}`);
    console.log(`   Source: ${source} | Buffer: ${imageBuffer?.length || 0} bytes`);

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }

    if (!imageBuffer || imageBuffer.length === 0) {
      return res.status(400).json({ success: false, message: 'No face image provided (must provide multipart file or base64 faceImage).' });
    }

    await faceService.initialize();
    const result = await faceService.enrollFace(userId, imageBuffer);

    if (result.success) {
      const existingStatus = enrollmentStatus.get(userId);
      if (existingStatus) {
        existingStatus.faceEnrolled = true;
        existingStatus.faceEnrolledAt = new Date().toISOString();
      } else {
        enrollmentStatus.set(userId, {
          completed: true,
          faceEnrolled: true,
          faceEnrolledAt: new Date().toISOString(),
        });
      }

      console.log(`🎉 [REMOTE-FACE-ENROLL] Successfully enrolled face for ${userId}`);
      console.log(`============================================================\n`);

      return res.json({
        success: true,
        message: 'Face enrolled successfully',
        userId,
        confidence: result.confidence,
        box: result.box || null,
      });
    } else {
      console.warn(`❌ [REMOTE-FACE-ENROLL-FAILED] ${result.message}`);
      console.log(`============================================================\n`);
      return res.status(400).json({
        success: false,
        message: result.message || 'Face enrollment failed',
      });
    }
  } catch (error) {
    console.error(`❌ [REMOTE-FACE-ENROLL-ERROR]:`, error);
    res.status(500).json({
      success: false,
      message: 'Server error during remote face enrollment',
      error: error.message,
    });
  }
});

// ==================== HARDWARE FACE ENROLLMENT (ESP32-CAM MULTI-SAMPLE) ====================

router.post('/enroll-hardware', upload.single('faceImage'), handleMulterError, async (req, res) => {
  try {
    const { userId } = req.body;
    const { buffer: imageBuffer, source } = extractImageBuffer(req);

    console.log(`\n============================================================`);
    console.log(`🤖 [HARDWARE-FACE-ENROLL] Request from User ID: ${userId || 'N/A'}`);
    console.log(`   Source: ${source} | Buffer: ${imageBuffer?.length || 0} bytes`);

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }

    if (!imageBuffer || imageBuffer.length === 0) {
      return res.status(400).json({ success: false, message: 'No image file or base64 faceImage provided.' });
    }

    // Process hardware face sample
    const result = await faceService.enrollFaceFromHardware(userId, imageBuffer);

    if (result.finalized) {
      console.log(`🎉 [HARDWARE-FACE-ENROLL] Enrollment successfully FINALIZED for ${userId}`);

      // Update shared state so UI / ESP32 polls detect completion
      const existingStatus = enrollmentStatus.get(userId);
      if (existingStatus) {
        existingStatus.faceEnrolled = true;
        existingStatus.faceEnrolledAt = new Date().toISOString();
        existingStatus.faceSamplesUsed = result.samplesAccepted;
      } else {
        enrollmentStatus.set(userId, {
          completed: true,
          faceEnrolled: true,
          faceEnrolledAt: new Date().toISOString(),
          faceSamplesUsed: result.samplesAccepted,
        });
      }
    } else {
      console.log(`⏳ [HARDWARE-FACE-ENROLL] Progress for ${userId}: ${result.message}`);
    }

    console.log(`============================================================\n`);

    res.json({
      success: result.finalized || false,
      message: result.message || 'Processing sample...',
      box: result.box || null,
      confidence: result.confidence || 0,
      samplesAccepted: result.samplesAccepted || 0,
      samplesNeeded: result.samplesNeeded || 1,
      finalized: result.finalized || false,
    });

  } catch (error) {
    console.error(`❌ [HARDWARE-FACE-ENROLL-ERROR]:`, error);
    res.status(500).json({
      success: false,
      message: 'Server error during hardware face enrollment',
      error: error.message,
    });
  }
});

// ==================== FACE VERIFICATION ====================

router.post('/verify', upload.single('faceImage'), handleMulterError, async (req, res) => {
  const reqStart = Date.now();
  try {
    const { userId, roomId } = req.body;
    const { buffer: imageBuffer, source } = extractImageBuffer(req);

    console.log(`\n============================================================`);
    console.log(`🔍 [FACE-VERIFY-ROUTE] Received verification request`);
    console.log(`   User ID: ${userId || 'MISSING'} | Room ID: ${roomId || 'N/A'}`);
    console.log(`   Payload Source: ${source} | Payload Size: ${imageBuffer?.length || 0} bytes`);

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }
    if (!imageBuffer || imageBuffer.length === 0) {
      return res.status(400).json({ success: false, message: 'No face image provided (must provide multipart file or base64 faceImage).' });
    }

    await faceService.initialize();

    // Call face verification engine
    const result = await faceService.verifyFace(userId, imageBuffer);

    // [NIGHT LOCKOUT ENFORCEMENT]
    if (result.success) {
      const { lockedOut, message } = await checkNightLockout(userId);
      if (lockedOut) {
        console.warn(`🌙 [NIGHT-LOCKOUT] Access blocked for ${userId}: ${message}`);
        result.success = false;
        result.message = message;
      }
    }

    // [INTRUSION DETECTION SYSTEM TRACKING]
    if (!result.success && roomId) {
      await trackFailedAttempt(roomId, 'FACE');
    } else if (result.success && roomId) {
      clearFailedAttempts(roomId);
    }

    // Audit log to ROOM_ACCESS table
    await logAccessEvent({
      action: 'ENTRY',
      authMethod: 'FACE',
      status: result.success ? 'GRANTED' : 'DENIED',
      userId: userId,
      roomId: roomId || 'ROOM-001',
      details: `Distance: ${result.distance?.toFixed(4) || 'N/A'} | Similarity: ${result.similarityPercent || 0}% | Time: ${Date.now() - reqStart}ms`
    });

    if (!result.success) {
      console.log(`❌ [FACE-VERIFY-ROUTE] Verification FAILED for ${userId}: ${result.message} (${Date.now() - reqStart}ms)\n`);
      return res.status(401).json(result);
    }

    console.log(`✅ [FACE-VERIFY-ROUTE] Verification SUCCEEDED for ${userId} in ${Date.now() - reqStart}ms\n`);

    // Look up user name for richer response
    let userName = userId;
    try {
      const users = await getSheetData('USERS');
      const normUser = String(userId).toLowerCase();
      const user = users.find(u => String(u.userid || u.userId || '').toLowerCase() === normUser);
      if (user) {
        userName = user.username || user.name || userId;
      }
    } catch (e) { /* non-critical */ }

    // If roomId is provided and match is valid, queue door unlock command for ESP32
    if (roomId) {
      pendingCommands.set(roomId, {
        command: 'face_unlock',
        userName: userName,
        adminId: userId,
        timestamp: new Date().toISOString(),
      });
      console.log(`🔓 [DOOR-UNLOCK-QUEUED] Command 'face_unlock' queued for Room ${roomId}`);
    }

    res.json({
      success: true,
      message: result.message || 'Face verified successfully',
      confidence: result.confidence,
      similarityPercent: result.similarityPercent,
      distance: result.distance,
      userId,
      userName,
      box: result.box || null, // {x, y, w, h} for TFT bounding box overlay
      timeMs: Date.now() - reqStart,
    });

  } catch (error) {
    console.error(`❌ [FACE-VERIFY-ROUTE-ERROR]:`, error.message);
    res.status(500).json({ success: false, message: 'Failed to verify face: ' + error.message });
  }
});

// ==================== FACE STATUS ====================

router.get('/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }

    const isEnrolled = faceService.isUserEnrolled(userId);
    console.log(`🔍 [FACE-STATUS] Check for ${userId} → ${isEnrolled ? 'ENROLLED' : 'NOT ENROLLED'}`);

    res.json({
      success: true,
      enrolled: isEnrolled,
      userId: userId,
    });
  } catch (error) {
    console.error('❌ [FACE-STATUS-ERROR]:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== DELETE FACE ====================

router.delete('/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }

    console.log(`🗑️ [FACE-DELETE-ROUTE] Deleting face for user: ${userId}`);
    const result = await faceService.deleteFace(userId);
    res.json(result);
  } catch (error) {
    console.error('❌ [FACE-DELETE-ROUTE-ERROR]:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== FACE STATS ====================

router.get('/stats', async (req, res) => {
  try {
    const enrolledCount = faceService.getEnrolledCount();
    const modelsLoaded = faceService.modelsLoaded;

    console.log(`📊 [FACE-STATS] Models loaded: ${modelsLoaded} | Enrolled count: ${enrolledCount}`);

    res.json({
      success: true,
      enrolledFaces: enrolledCount,
      modelsLoaded: modelsLoaded,
    });
  } catch (error) {
    console.error('❌ [FACE-STATS-ERROR]:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== LIST ENROLLED USERS ====================

router.get('/enrolled-users', async (req, res) => {
  try {
    const enrolledUsers = faceService.getEnrolledUsers();
    console.log(`📋 [FACE-ENROLLED-USERS] Total: ${enrolledUsers.length}`);

    res.json({
      success: true,
      count: enrolledUsers.length,
      users: enrolledUsers,
    });
  } catch (error) {
    console.error('❌ [FACE-ENROLLED-USERS-ERROR]:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;