const express = require('express');
const router = express.Router();
const multer = require('multer');
const faceService = require('../services/faceService');
const { getSheetData, findRowIndex, updateRow, appendRow, logAccessEvent } = require('../services/sheetsService');
const { verifyToken } = require('../middleware/authMiddleware');
const { checkNightLockout, trackFailedAttempt, clearFailedAttempts } = require('../services/securityService');

const { pendingCommands } = require('../services/sharedState');

// ==================== MULTER CONFIGURATION ====================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    console.log(`📁 Received file: ${file.originalname}, Type: ${file.mimetype}, Size: ${file.size} bytes`);
    
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, PNG) are allowed'), false);
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

// ==================== FACE ENROLLMENT ====================

router.post('/enroll', verifyToken, upload.single('faceImage'), handleMulterError, async (req, res) => {
  try {
    const { userId, userName } = req.body;

    console.log(`\n========================================`);
    console.log(`📝 FACE ENROLLMENT REQUEST`);
    console.log(`User ID: ${userId}`);
    console.log(`User Name: ${userName}`);
    console.log(`========================================\n`);

    // Validate input
    if (!userId || !userName) {
      console.log('❌ Missing userId or userName');
      return res.status(400).json({
        success: false,
        message: 'userId and userName are required',
      });
    }

    if (!req.file) {
      console.log('❌ No image file provided');
      return res.status(400).json({
        success: false,
        message: 'No image file provided. Please upload a face image.',
      });
    }

    console.log(`📦 Image received: ${req.file.size} bytes`);

    // Initialize face service
    await faceService.initialize();

    // Enroll face
    console.log('⏳ Processing face enrollment...');
    const result = await faceService.enrollFace(userId, req.file.buffer);

    if (!result.success) {
      console.log(`❌ Enrollment failed: ${result.message}`);
      return res.status(400).json(result);
    }

    console.log(`✅ Enrollment successful for ${userId}\n`);
    
    res.json({
      success: true,
      message: result.message || 'Face enrolled successfully',
      confidence: result.confidence,
      samplesUsed: result.samplesUsed || 1,
      rotationAngle: result.rotationAngle || 0,
      userId: userId,
    });

  } catch (error) {
    console.error(`\n❌ ENROLLMENT ERROR:`);
    console.error(error);
    console.error(`Stack:`, error.stack);
    console.log(`========================================\n`);
    
    res.status(500).json({
      success: false,
      message: 'Failed to enroll face: ' + error.message,
    });
  }
});

// ==================== HARDWARE FACE ENROLLMENT ====================

// Endpoint for ESP32 to directly enroll a face after fingerprint enrollment
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

    // Pass false for isInitialization (assuming it doesn't need to block if already loaded)
    
    console.log('⏳ Processing hardware face enrollment...');
    const result = await faceService.enrollFace(userId, req.file.buffer);

    if (!result.success) {
      console.log(`❌ Hardware Enrollment failed: ${result.message}`);
      return res.status(400).json(result);
    }

    console.log(`✅ Hardware enrollment successful for ${userId}\n`);
    
    res.json({
      success: true,
      message: result.message || 'Face enrolled successfully via hardware',
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

// Face verify accepts optional roomId — if provided, automatically sends face_unlock / face_deny command to ESP32
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

    // If roomId provided → send door command to ESP32
    if (roomId && pendingCommands) {
      const cmd = result.success ? 'face_unlock' : 'face_deny';
      pendingCommands.set(roomId, {
        command: cmd,
        userName: userId,
        adminId: 'FACE_AUTH_SYSTEM',
        timestamp: new Date().toISOString(),
      });
      console.log(`📡 Door command queued: ${cmd} → Room ${roomId}`);
    }

    // Log to ROOM_ACCESS sheet robustly
    await logAccessEvent({
      action: 'ENTRY',
      authMethod: 'FACE',
      status: result.success ? 'GRANTED' : 'DENIED',
      userId: userId,
      roomId: roomId,
      details: `Distance: ${result.distance?.toFixed(4) || 'N/A'} | Confidence: ${result.confidence?.toFixed(4) || 'N/A'}`
    });

    if (!result.success) {
      console.log(`❌ Verification failed: ${result.message}\n`);
      return res.status(401).json(result);
    }

    console.log(`✅ Verification successful for ${userId} | distance: ${result.distance?.toFixed(4)}\n`);

    res.json({
      success: true,
      message: result.message || 'Face verified successfully',
      confidence: result.confidence,
      distance: result.distance,
      userId,
      doorCommand: roomId ? 'face_unlock' : null,
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
        const userIndex = await findRowIndex('USERS', 'userid', userId);
        
        if (userIndex !== -1) {
          const user = users[userIndex];
          await updateRow('USERS', userIndex, [
            user.userid,
            user.username,
            user.email,
            user.password,
            user.role,
            user.department,
            user.authorized_rooms || '',
            user.fingerprint || '',
            'NOT_ENROLLED', // face_status
          ]);
          console.log('✅ User record updated in database');
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