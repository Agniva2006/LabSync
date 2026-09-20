const express = require('express');
const router = express.Router();
const multer = require('multer');
const faceService = require('../services/faceService');
const { getSheetData, findRowIndex, updateRow, appendRow, logAccessEvent } = require('../services/sheetsService');
const { verifyToken } = require('../middleware/authMiddleware');
const { checkNightLockout, trackFailedAttempt, clearFailedAttempts } = require('../services/securityService');
const { enrollmentStatus } = require('../services/sharedState');

// ==================== MULTER CONFIGURATION ====================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    console.log(`📁 Received file: ${file.originalname}, Type: ${file.mimetype}, Size: ${file.size} bytes`);
    
    // Accept only JPEG and PNG image types
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png'];
    if (allowedMimes.includes(file.mimetype)) {
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

// ==================== APP/WEB FACE ENROLLMENT (DECOMMISSIONED) ====================
// Face enrollment via Flutter App / Web is disabled.
// All biometric enrollments (fingerprint & face) are performed strictly via the ESP32 + ESP32-CAM terminal.
router.post('/enroll', (req, res) => {
  console.warn('⚠️ Rejected attempt to enroll face via App/Web. Biometrics are hardware-only.');
  return res.status(403).json({
    success: false,
    message: 'App/Web face enrollment is disabled. All biometric enrollments must be conducted at the physical ESP32 door terminal.',
  });
});

// ==================== HARDWARE FACE ENROLLMENT (MULTI-SAMPLE SESSION) ====================

// Endpoint for ESP32 to enroll a face during the enrollment window.
// ESP32 sends multiple JPEG frames asynchronously via FreeRTOS.
// Each call accumulates a good descriptor into a session.
// Once enough samples are collected, the averaged descriptor is saved.
router.post('/enroll-hardware', upload.single('faceImage'), handleMulterError, async (req, res) => {
  try {
    const { userId } = req.body;

    console.log(`\n========================================`);
    console.log(`🤖 HARDWARE FACE ENROLLMENT REQUEST`);
    console.log(`User ID: ${userId}`);
    console.log(`========================================\n`);

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided.' });
    }

    console.log(`📦 Image received: ${req.file.size} bytes (${req.file.mimetype})`);
    console.log('⏳ Processing hardware face enrollment (session-based multi-sample)...');

    // Use the session-based enrollment that accumulates descriptors
    const result = await faceService.enrollFaceFromHardware(userId, req.file.buffer);

    if (result.finalized) {
      console.log(`✅ Hardware enrollment FINALIZED for ${userId}`);

      // Update enrollment status so Flutter can see face completion
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
    } else if (!result.success) {
      console.log(`⏳ Enrollment in progress for ${userId}: ${result.message}`);
    }

    // Always return the result — ESP32 checks `success` field
    res.json({
      success: result.finalized || false, // ESP32 expects `success: true` only when fully enrolled
      message: result.message || 'Processing...',
      box: result.box || null,
      confidence: result.confidence || 0,
      samplesAccepted: result.samplesAccepted || 0,
      samplesNeeded: result.samplesNeeded || 3,
      finalized: result.finalized || false,
    });

  } catch (error) {
    console.error(`\n❌ HARDWARE ENROLLMENT ERROR:`);
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Server error during hardware enrollment',
      error: error.message,
    });
  }
});

// ==================== FACE VERIFICATION ====================

// Face verify accepts optional roomId.
// ESP32 reads the HTTP response directly — it does NOT poll get-commands for face results.
// Therefore we do NOT set pendingCommands here (that was causing a memory leak).
router.post('/verify', upload.single('faceImage'), handleMulterError, async (req, res) => {
  try {
    const { userId, roomId } = req.body;

    console.log(`\n========================================`);
    console.log(`🔍 FACE VERIFICATION REQUEST`);
    console.log(`User ID: ${userId} | Room: ${roomId || 'N/A'}`);
    console.log(`========================================\n`);

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided.' });
    }

    console.log(`📦 Image received: ${req.file.size} bytes`);

    await faceService.initialize();

    console.log('⏳ Processing face verification (SSD MobileNet → FaceLandmark68 → FaceRecognitionNet)...');
    const result = await faceService.verifyFace(userId, req.file.buffer);

    // [NIGHT LOCKOUT CHECK]
    if (result.success) {
      const { lockedOut, message } = await checkNightLockout(userId);
      if (lockedOut) {
        result.success = false;
        result.message = message;
      }
    }

    // [IDS TRACKING]
    if (!result.success && roomId) {
      await trackFailedAttempt(roomId, 'FACE');
    } else if (result.success && roomId) {
      clearFailedAttempts(roomId);
    }

    // Log to ROOM_ACCESS sheet robustly
    await logAccessEvent({
      action: 'ENTRY',
      authMethod: 'FACE',
      status: result.success ? 'GRANTED' : 'DENIED',
      userId: userId,
      roomId: roomId,
      details: `Distance: ${result.distance?.toFixed(4) || 'N/A'} | Confidence: ${result.confidence?.toFixed(4) || 'N/A'} | Similarity: ${result.similarityPercent || 'N/A'}%`
    });

    if (!result.success) {
      console.log(`❌ Verification failed: ${result.message}\n`);
      return res.status(401).json(result);
    }

    console.log(`✅ Verification successful for ${userId} | distance: ${result.distance?.toFixed(4)}\n`);

    // Look up userName from Sheets for richer response
    let userName = userId;
    try {
      const users = await getSheetData('USERS');
      const user = users.find(u => (u.userid || u.userId) === userId);
      if (user) {
        userName = user.username || user.name || userId;
      }
    } catch (e) { /* non-critical */ }

    res.json({
      success: true,
      message: result.message || 'Face verified successfully',
      confidence: result.confidence,
      similarityPercent: result.similarityPercent,
      distance: result.distance,
      userId,
      userName,
      box: result.box || null,  // {x,y,w,h} for TFT bounding box overlay
    });

  } catch (error) {
    console.error(`\n❌ VERIFICATION ERROR:`, error.message);
    res.status(500).json({ success: false, message: 'Failed to verify face: ' + error.message });
  }
});

// ==================== FACE STATUS ====================

router.get('/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    console.log(`🔍 Checking face status for user: ${userId}`);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required',
      });
    }

    const isEnrolled = faceService.isUserEnrolled(userId);

    console.log(`✅ Status: ${isEnrolled ? 'ENROLLED' : 'NOT ENROLLED'}`);

    res.json({
      success: true,
      enrolled: isEnrolled,
      userId: userId,
    });
  } catch (error) {
    console.error('❌ Error checking face status:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ==================== DELETE FACE ====================

router.delete('/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;

    console.log(`\n========================================`);
    console.log(`🗑️ DELETE FACE REQUEST`);
    console.log(`User ID: ${userId}`);
    console.log(`========================================\n`);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required',
      });
    }

    const result = await faceService.deleteFace(userId);

    if (result.success) {
      // Update user's face status in database
      try {
        const users = await getSheetData('USERS');
        // Try both header casings for robust lookup
        let userIndex = await findRowIndex('USERS', 'userid', userId);
        if (userIndex === -1) {
          userIndex = await findRowIndex('USERS', 'userId', userId);
        }
        
        if (userIndex !== -1) {
          // Find user from data array (findRowIndex returns Sheets row, not array index)
          const user = users.find(u => (u.userid || u.userId) === userId);
          if (user) {
            await updateRow('USERS', userIndex, [
              user.userid || user.userId,
              user.username || user.name || '',
              user.email || '',
              user.password || '',
              user.role || 'user',
              user.department || '',
              user.authorized_rooms || '',
              user.fingerprintid || user.fingerprintId || '',
              '',             // Clear faceDescriptor
              'NOT_ENROLLED', // Reset faceStatus
            ]);
            console.log('✅ User record updated in database');
          }
        }
      } catch (dbError) {
        console.error('⚠️ Database update failed:', dbError.message);
      }
    }

    console.log(`✅ Delete result: ${result.success ? 'SUCCESS' : 'FAILED'}\n`);
    
    res.json(result);
  } catch (error) {
    console.error('❌ Error deleting face:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ==================== FACE STATS ====================

router.get('/stats', async (req, res) => {
  try {
    const enrolledCount = faceService.getEnrolledCount();
    const modelsLoaded = faceService.modelsLoaded;

    console.log(`📊 Face recognition stats requested`);
    console.log(`   Models loaded: ${modelsLoaded}`);
    console.log(`   Enrolled faces: ${enrolledCount}`);

    res.json({
      success: true,
      enrolledFaces: enrolledCount,
      modelsLoaded: modelsLoaded,
    });
  } catch (error) {
    console.error('❌ Error getting stats:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ==================== LIST ENROLLED USERS ====================

router.get('/enrolled-users', async (req, res) => {
  try {
    const enrolledUsers = faceService.getEnrolledUsers();

    console.log(`📋 Listing enrolled users: ${enrolledUsers.length} users`);

    res.json({
      success: true,
      count: enrolledUsers.length,
      users: enrolledUsers,
    });
  } catch (error) {
    console.error('❌ Error listing enrolled users:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;