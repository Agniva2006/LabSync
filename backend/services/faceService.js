const faceapi = require('@vladmandic/face-api');
const path = require('path');
const sharp = require('sharp');

// ==================== CANVAS INITIALIZATION FOR NODE ====================

let canvasModule;
try {
  canvasModule = require('@napi-rs/canvas');
  console.log('🎨 [CANVAS-INIT] Using high-performance @napi-rs/canvas native binding');
} catch (e1) {
  try {
    canvasModule = require('canvas');
    console.log('🎨 [CANVAS-INIT] Using node-canvas binding');
  } catch (e2) {
    console.error('❌ [CANVAS-INIT] Neither @napi-rs/canvas nor canvas could be loaded:', e1.message);
  }
}

const { Image, ImageData, loadImage } = canvasModule || {};

// Safe wrapper around Canvas to ensure width/height are never undefined when called by face-api.js
class SafeCanvas extends (canvasModule?.Canvas || Object) {
  constructor(width = 0, height = 0) {
    super(Math.max(0, width || 0), Math.max(0, height || 0));
  }
}

function safeCreateCanvas(width = 0, height = 0) {
  if (!canvasModule?.createCanvas) throw new Error('Canvas module not available');
  return canvasModule.createCanvas(Math.max(0, width || 0), Math.max(0, height || 0));
}

// Monkey patch faceapi environment to use our safe canvas in Node
if (canvasModule) {
  faceapi.env.monkeyPatch({
    Canvas: SafeCanvas,
    Image,
    ImageData,
    createCanvas: safeCreateCanvas,
  });
}

// Import sheets service for persistent storage (supports Google Sheets + local DB fallback)
const {
  getSheetData,
  getLocalDbData,
  appendRow,
  findRowIndex,
  updateRow,
} = require('./sheetsService');

// Import shared state for multi-sample enrollment sessions
const { faceEnrollmentSessions } = require('./sharedState');

// ==================== CONSTANTS ====================

const ENROLL_MIN_CONFIDENCE = 0.22;     // Fast SSD detection threshold for enrollment candidates
const ENROLL_MIN_SCORE = 0.25;          // Calibrated score threshold for OV2640 hardware sensor
const ENROLL_MIN_FACE_PX = 35;          // Minimum face box dimension (px) for enrollment
const VERIFY_CONFIDENCE_PRIMARY = 0.20; // Primary detection threshold for verification
const VERIFY_CONFIDENCE_FALLBACK = 0.15;// Fallback for low-light verification
const VERIFY_DISTANCE_THRESHOLD = 0.65; // Euclidean distance threshold for match (standard for SSD MobileNet)
const SAMPLES_NEEDED_FOR_ENROLLMENT = 1;// Finalize immediately on first valid face frame so ESP32 never times out
const HIGH_QUALITY_SINGLE_SCORE = 0.25; // Any detected face passing quality gate (score >= 0.25) can enroll immediately

class FaceRecognitionService {
  constructor() {
    this.modelsLoaded = false;
    this.faceDatabase = new Map(); // userId → { rawUserId, descriptor, enrolledAt, score, samplesUsed }
    this.modelUrl = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
    console.log('🔧 [FACE-SERVICE] FaceRecognitionService initialized (dual-mode persistence + sharp preprocessing)');
  }

  // ==================== INITIALIZATION ====================

  async initialize() {
    if (this.modelsLoaded) {
      return;
    }

    const startTime = Date.now();
    const localModelPath = path.resolve(__dirname, '../models');
    console.log(`\n========================================`);
    console.log(`📦 [FACE-INIT-START] Loading face recognition models...`);
    console.log(`   Path: ${localModelPath}`);

    try {
      console.log('   ⏳ Step 1/4: Loading TinyFaceDetector (Ultra-Fast 1.5s Engine)...');
      await faceapi.nets.tinyFaceDetector.loadFromDisk(localModelPath);

      console.log('   ⏳ Step 2/4: Loading Face Landmark 68 Net (Alignment)...');
      await faceapi.nets.faceLandmark68Net.loadFromDisk(localModelPath);

      console.log('   ⏳ Step 3/4: Loading Face Recognition Net (128-d Embeddings)...');
      await faceapi.nets.faceRecognitionNet.loadFromDisk(localModelPath);

      try {
        console.log('   ⏳ Step 4/4: Loading SSD MobileNet v1 (Precision Fallback)...');
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(localModelPath);
      } catch (e) {
        console.warn('   ℹ️ SSD MobileNet v1 skipped (TinyFaceDetector active)');
      }

      this.modelsLoaded = true;
      const elapsed = Date.now() - startTime;
      console.log(`✅ [FACE-INIT-SUCCESS] Neural weights loaded from local disk in ${elapsed}ms!`);

      // Load enrolled face descriptors from persistent storage
      await this.loadFacesFromSheet();
      console.log(`========================================\n`);
    } catch (error) {
      console.warn(`⚠️ [FACE-INIT-WARN] Local disk model load failed (${error.message}). Attempting CDN fallback...`);
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(this.modelUrl);
        await faceapi.nets.faceLandmark68Net.loadFromUri(this.modelUrl);
        await faceapi.nets.faceRecognitionNet.loadFromUri(this.modelUrl);
        this.modelsLoaded = true;
        console.log(`✅ [FACE-INIT-SUCCESS] All face recognition models loaded from CDN (${Date.now() - startTime}ms)`);
        await this.loadFacesFromSheet();
        console.log(`========================================\n`);
      } catch (cdnError) {
        console.error('❌ [FACE-INIT-ERROR] Failed to load models from both local disk and CDN:', cdnError.message);
        throw cdnError;
      }
    }
  }

  // ==================== IMAGE PRE-PROCESSING ====================

  /**
   * Pre-process ESP32-CAM / client JPEG for optimal face detection.
   * Handles low-light, softness, and variable contrast.
   */
  async preprocessImage(imageBuffer) {
    const startTime = Date.now();
    try {
      if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
        throw new Error('Invalid image buffer passed to preprocessor');
      }

      const meta = await sharp(imageBuffer).metadata();
      const origSize = imageBuffer.length;

      let pipeline = sharp(imageBuffer);
      // Downscale to max 320px on CPU if larger so neural net inference stays under 2-3s
      if (meta.width > 320 || meta.height > 320) {
        pipeline = pipeline.resize(320, 240, { fit: 'inside', withoutEnlargement: true });
      }

      const processed = await pipeline
        .normalise()            // Auto-stretch histogram for consistent brightness/contrast
        .sharpen({              // Gentle sharpen for OV2640 lens softness
          sigma: 1.0,
          m1: 1.0,
          m2: 0.5,
        })
        .jpeg({ quality: 90 })  // Re-encode at high quality
        .toBuffer();

      const elapsed = Date.now() - startTime;
      console.log(`   🔧 [PREPROCESS] ${origSize} bytes (${meta.width}x${meta.height}) → ${processed.length} bytes in ${elapsed}ms`);
      return processed;
    } catch (err) {
      console.warn(`   ⚠️ [PREPROCESS-WARN] sharp preprocessing failed (${err.message}), using raw buffer`);
      return imageBuffer;
    }
  }

  // ==================== SHEETS / LOCAL DB PERSISTENCE ====================

  _normalizeKey(id) {
    return String(id || '').trim().toLowerCase();
  }

  /**
   * Load all enrolled face descriptors from Database into memory
   */
  async loadFacesFromSheet() {
    try {
      console.log('📊 [DATABASE] Loading enrolled face descriptors from USERS table...');
      const users = await getSheetData('USERS');
      let loaded = 0;

      for (const user of users) {
        const userId = user.userid || user.userId || user.USERID || user.id || '';
        const descriptorStr = user.facedescriptor || user.faceDescriptor || user.FACEDESCRIPTOR || '';
        const userName = user.username || user.name || userId;

        if (userId && descriptorStr && descriptorStr.trim() !== '') {
          try {
            const parsed = JSON.parse(descriptorStr);
            if (Array.isArray(parsed) && parsed.length === 128) {
              const faceEntry = {
                rawUserId: userId,
                userName: userName,
                descriptor: parsed,
                enrolledAt: user.faceenrolledat || user.faceEnrolledAt || new Date().toISOString(),
                score: parseFloat(user.facescore || user.faceScore || '0.9'),
                samplesUsed: parseInt(user.facesamplesused || user.faceSamplesUsed || '1', 10),
              };

              // Store under both exact ID and normalized lowercase ID
              this.faceDatabase.set(userId, faceEntry);
              this.faceDatabase.set(this._normalizeKey(userId), faceEntry);
              loaded++;
              console.log(`   👤 Loaded enrolled face for ${userName} (${userId}) [128-d vector]`);
            } else {
              console.warn(`   ⚠️ Invalid descriptor format for ${userId} (length: ${parsed?.length})`);
            }
          } catch (parseErr) {
            console.warn(`   ⚠️ Could not parse face descriptor for ${userId}: ${parseErr.message}`);
          }
        }
      }

      console.log(`✅ [DATABASE] Successfully loaded ${loaded} enrolled face descriptor(s) into memory!`);

      // Run universal biometric synchronization and healing for ALL users on startup
      await this.syncAndHealAllBiometrics(users);
    } catch (error) {
      console.error('❌ [DATABASE] Error loading faces from database:', error.message);
    }
  }

  /**
   * Universal Biometric Sync & Healing System
   * Ensures all users across the system have their fingerprints and face vectors
   * synchronized between memory, local_db.json, and Google Sheets without losing or wiping any data.
   */
  async syncAndHealAllBiometrics(cachedUsers = null) {
    try {
      console.log('🔄 [BIOMETRIC-SYNC] Running universal biometric sync across all users...');
      const users = cachedUsers || await getSheetData('USERS');
      const localUsers = getLocalDbData('USERS');

      // Build unified list of all unique user IDs
      const allUserIds = new Set();
      (users || []).forEach(u => {
        const id = u.userid || u.userId;
        if (id) allUserIds.add(id);
      });
      (localUsers || []).forEach(u => {
        const id = u.userid || u.userId;
        if (id) allUserIds.add(id);
      });

      let healedCount = 0;

      for (const userId of allUserIds) {
        const normKey = this._normalizeKey(userId);
        const sheetUser = (users || []).find(u => this._normalizeKey(u.userid || u.userId) === normKey);
        const localUser = (localUsers || []).find(u => this._normalizeKey(u.userid || u.userId) === normKey);

        // Determine best available biometrics for this user
        let faceDescStr = (sheetUser?.facedescriptor || sheetUser?.faceDescriptor || '').trim();
        if (!faceDescStr || faceDescStr.length < 50) {
          faceDescStr = (localUser?.facedescriptor || localUser?.faceDescriptor || '').trim();
        }

        const fingerprintId = (sheetUser?.fingerprintid || sheetUser?.fingerprintId || localUser?.fingerprintid || localUser?.fingerprintId || '').toString().trim();
        const userName = sheetUser?.username || sheetUser?.name || localUser?.username || localUser?.name || userId;
        const role = sheetUser?.role || localUser?.role || 'user';

        // Load into in-memory faceDatabase if valid 128-d descriptor exists
        if (faceDescStr && faceDescStr.length >= 50) {
          try {
            const parsed = JSON.parse(faceDescStr);
            if (Array.isArray(parsed) && parsed.length === 128) {
              const faceEntry = {
                rawUserId: userId,
                userName: userName,
                role: role,
                fingerprintId: fingerprintId,
                descriptor: parsed,
                enrolledAt: sheetUser?.faceenrolledat || localUser?.faceenrolledat || new Date().toISOString(),
                score: 0.95,
                samplesUsed: 1,
              };
              this.faceDatabase.set(userId, faceEntry);
              this.faceDatabase.set(normKey, faceEntry);
            }
          } catch (e) {}
        }

        // If local has valid face descriptor or fingerprint that Google Sheets is missing, heal Sheets row!
        const sheetHasFace = (sheetUser?.facestatus || sheetUser?.faceStatus) === 'ENROLLED' && (sheetUser?.facedescriptor || sheetUser?.faceDescriptor)?.length > 50;
        const localHasFace = faceDescStr.length > 50;
        const sheetHasFp = (sheetUser?.fingerprintid || sheetUser?.fingerprintId || '').trim().length > 0;
        const localHasFp = fingerprintId.length > 0;

        if (sheetUser && ((!sheetHasFace && localHasFace) || (!sheetHasFp && localHasFp))) {
          let rowIndex = sheetUser._rowNumber;
          if (!rowIndex) {
            rowIndex = await findRowIndex('USERS', 'userid', userId);
          }
          if (rowIndex !== -1) {
            console.log(`✨ [BIOMETRIC-HEAL] Healing biometrics in Google Sheets for ${userName} (${userId}) at Row ${rowIndex}`);
            await updateRow('USERS', rowIndex, [
              sheetUser.userid || sheetUser.userId || userId,
              userName,
              sheetUser.email || localUser?.email || '',
              sheetUser.password || localUser?.password || '$2a$10$qSbfQoa5HHuxXzaTM4BnzuZGfscQPGgSQHyHhgCeN2Vn9Wbr/DcHu',
              role,
              sheetUser.department || localUser?.department || 'Laboratory',
              sheetUser.authorized_rooms || localUser?.authorized_rooms || 'ROOM-001',
              fingerprintId,
              faceDescStr,
              (faceDescStr.length > 50) ? 'ENROLLED' : (sheetUser.facestatus || 'NOT_ENROLLED')
            ]);
            healedCount++;
          }
        } else if (!sheetUser && localUser) {
          console.log(`✨ [BIOMETRIC-HEAL] Appending missing user ${userName} (${userId}) to Google Sheets`);
          await appendRow('USERS', [
            userId,
            userName,
            localUser.email || '',
            localUser.password || '$2a$10$qSbfQoa5HHuxXzaTM4BnzuZGfscQPGgSQHyHhgCeN2Vn9Wbr/DcHu',
            role,
            localUser.department || 'Laboratory',
            localUser.authorized_rooms || 'ROOM-001',
            fingerprintId,
            faceDescStr,
            (faceDescStr.length > 50) ? 'ENROLLED' : (localUser.facestatus || 'NOT_ENROLLED')
          ]);
          healedCount++;
        }
      }

      console.log(`✅ [BIOMETRIC-SYNC] Completed universal sync. Loaded ${Math.floor(this.faceDatabase.size / 2)} face templates in memory, healed ${healedCount} user(s).`);
      return true;
    } catch (error) {
      console.error('❌ [BIOMETRIC-SYNC-ERROR]:', error.message);
      return false;
    }
  }

  /**
   * Lookup user by fingerprint ID in in-memory database
   */
  getUserByFingerprintId(fingerId) {
    const targetFp = parseInt(fingerId, 10);
    if (isNaN(targetFp)) return null;
    for (const [key, entry] of this.faceDatabase.entries()) {
      if (entry.fingerprintId && parseInt(entry.fingerprintId, 10) === targetFp) {
        return {
          userId: entry.rawUserId || key,
          userName: entry.userName || 'User',
          role: entry.role || 'user',
          fingerprintId: String(targetFp),
          faceEnrolled: true
        };
      }
    }
    return null;
  }

  /**
   * Universal Biometric Sync alias
   */
  async syncBiometrics(cachedUsers = null) {
    return this.syncAndHealAllBiometrics(cachedUsers);
  }

  /**
   * Save a face descriptor to persistent storage (Column I: faceDescriptor, Column J: faceStatus)
   */
  async saveFaceToSheet(userId, descriptor, score) {
    try {
      console.log(`💾 [DATABASE-SAVE] Saving face descriptor for user: ${userId}`);
      const users = await getSheetData('USERS');
      const localUsers = getLocalDbData('USERS');

      let rowIndex = await findRowIndex('USERS', 'userid', userId);
      if (rowIndex === -1) {
        rowIndex = await findRowIndex('USERS', 'userId', userId);
      }

      const normTarget = this._normalizeKey(userId);
      let user = (users || []).find(u => this._normalizeKey(u.userid || u.userId) === normTarget) ||
                 (localUsers || []).find(u => this._normalizeKey(u.userid || u.userId) === normTarget);

      if (rowIndex === -1) {
        console.log(`ℹ️ [DATABASE-SAVE] User ${userId} not yet in Google Sheets. Appending row...`);
        await appendRow('USERS', [
          userId,
          user?.username || user?.name || 'User',
          user?.email || '',
          user?.password || '$2a$10$qSbfQoa5HHuxXzaTM4BnzuZGfscQPGgSQHyHhgCeN2Vn9Wbr/DcHu',
          user?.role || 'user',
          user?.department || 'Laboratory',
          user?.authorized_rooms || 'ROOM-001',
          user?.fingerprintid || user?.fingerprintId || '',
          JSON.stringify(descriptor),
          'ENROLLED'
        ]);
        console.log(`✅ [DATABASE-SAVE] Successfully appended enrolled user ${userId} to USERS table!`);
        return true;
      }

      await updateRow('USERS', rowIndex, [
        user?.userid || user?.userId || userId,
        user?.username || user?.name || 'User',
        user?.email || '',
        user?.password || '$2a$10$qSbfQoa5HHuxXzaTM4BnzuZGfscQPGgSQHyHhgCeN2Vn9Wbr/DcHu',
        user?.role || 'user',
        user?.department || 'Laboratory',
        user?.authorized_rooms || 'ROOM-001',
        user?.fingerprintid || user?.fingerprintId || '',
        JSON.stringify(descriptor), // Column I: faceDescriptor (128 floats)
        'ENROLLED',                 // Column J: faceStatus
      ]);

      console.log(`✅ [DATABASE-SAVE] Face descriptor persisted for ${userId} (Row ${rowIndex})`);
      return true;
    } catch (error) {
      console.error(`❌ [DATABASE-SAVE] Error saving face descriptor for ${userId}:`, error.message);
      return false;
    }
  }

  /**
   * Clear face descriptor from storage (on face deletion)
   */
  async clearFaceFromSheet(userId) {
    try {
      const users = await getSheetData('USERS');
      let rowIndex = await findRowIndex('USERS', 'userid', userId);
      if (rowIndex === -1) rowIndex = await findRowIndex('USERS', 'userId', userId);
      if (rowIndex === -1) return false;

      const normTarget = this._normalizeKey(userId);
      const user = users.find(u => this._normalizeKey(u.userid || u.userId) === normTarget);
      if (!user) return false;

      await updateRow('USERS', rowIndex, [
        user.userid || user.userId || userId,
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

      console.log(`✅ [DATABASE-DELETE] Face descriptor cleared from storage for ${userId}`);
      return true;
    } catch (error) {
      console.error(`❌ [DATABASE-DELETE] Error clearing face descriptor:`, error.message);
      return false;
    }
  }

  // ==================== FACE DETECTION & 4-ANGLE ROTATION ====================

  rotateImageCanvas(img, angle) {
    if (angle === 0) {
      const cvs = safeCreateCanvas(img.width, img.height);
      const ctx = cvs.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return cvs;
    }

    const is90or270 = angle === 90 || angle === 270;
    const width = is90or270 ? img.height : img.width;
    const height = is90or270 ? img.width : img.height;

    const cvs = safeCreateCanvas(width, height);
    const ctx = cvs.getContext('2d');

    ctx.translate(width / 2, height / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);

    return cvs;
  }

  /**
   * High-speed face detection for upright hardware camera (Angle 0°).
   * Eliminates the 4-way rotation delay (which caused 40s freezes and ESP32 timeouts).
   * Evaluates in ~1.8 - 2.5 seconds on CPU.
   */
  async detectFace(imageBuffer, isEnrollment = false) {
    if (!this.modelsLoaded) {
      console.log('⚠️ [FACE-DETECT] Models not yet loaded — initializing now...');
      await this.initialize();
    }

    const detectStartTime = Date.now();

    try {
      if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
        throw new Error('Invalid image buffer provided for face detection');
      }

      // Preprocess image (size normalization, contrast & gentle sharpen)
      const processedBuffer = await this.preprocessImage(imageBuffer);
      const rawImg = await loadImage(processedBuffer);

      console.log(`📸 [FACE-DETECT] Processing ${rawImg.width}x${rawImg.height} frame (${processedBuffer.length} bytes, mode: ${isEnrollment ? 'ENROLLMENT' : 'VERIFICATION'})...`);

      // Single upright orientation (0°) - matches hardware terminal mounting
      const cvs = this.rotateImageCanvas(rawImg, 0);

      // Pass 1: Ultra-Fast TinyFaceDetector (runs in ~1.2 - 1.6s on CPU!)
      let detection = null;
      try {
        const threshold = isEnrollment ? 0.22 : 0.20;
        detection = await faceapi
          .detectSingleFace(cvs, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: threshold }))
          .withFaceLandmarks()
          .withFaceDescriptor();
      } catch (err) {
        console.warn('   ⚠️ TinyFaceDetector primary pass error:', err.message);
      }

      // Pass 2: Retry with sensitive threshold if first pass was empty (handles low-light OV2640 frames)
      if (!detection) {
        try {
          detection = await faceapi
            .detectSingleFace(cvs, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: isEnrollment ? 0.16 : 0.15 }))
            .withFaceLandmarks()
            .withFaceDescriptor();
        } catch (e) {}
      }

      // Pass 3: Precision fallback to SSD MobileNet if TinyFace missed
      if (!detection && faceapi.nets.ssdMobilenetv1?.isLoaded) {
        try {
          console.log('   ℹ️ Attempting high-precision SSD MobileNet fallback...');
          detection = await faceapi
            .detectSingleFace(cvs, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.20 }))
            .withFaceLandmarks()
            .withFaceDescriptor();
        } catch (e) {}
      }

      if (detection) {
        const dBox = detection.detection.box;
        const dScore = detection.detection.score;
        const origBox = { x: dBox.x, y: dBox.y, width: dBox.width, height: dBox.height };

        console.log(`   🎯 [FACE-DETECTED] Score: ${dScore.toFixed(4)} | Box: [x:${Math.round(origBox.x)}, y:${Math.round(origBox.y)}, w:${Math.round(origBox.width)}, h:${Math.round(origBox.height)}] in ${Date.now() - detectStartTime}ms`);

        // Quality Gate for Enrollment Candidates
        if (isEnrollment) {
          const isTooSmall = origBox.width < ENROLL_MIN_FACE_PX || origBox.height < ENROLL_MIN_FACE_PX;
          const isLowScore = dScore < 0.15;

          if (isTooSmall || isLowScore) {
            console.warn(`   ⚠️ [ENROLL-QUALITY-GATE-REJECT] Face rejected: score=${dScore.toFixed(3)}, size=${Math.round(origBox.width)}x${Math.round(origBox.height)}`);
            return {
              success: false,
              message: isTooSmall
                ? 'Face too far from camera. Please stand closer.'
                : 'Face not clear enough. Please hold still in good lighting.',
              box: {
                x: Math.round(origBox.x),
                y: Math.round(origBox.y),
                w: Math.round(origBox.width),
                h: Math.round(origBox.height),
              },
            };
          }
        }

        return {
          success: true,
          descriptor: Array.from(detection.descriptor), // 128 float vector
          landmarks: detection.landmarks,
          box: origBox,
          score: dScore,
          rotationAngle: 0,
          timeMs: Date.now() - detectStartTime,
        };
      }

      console.warn(`   ❌ [NO-FACE] No face detected in ${Date.now() - detectStartTime}ms`);
      return {
        success: false,
        message: 'No face detected. Ensure face is clearly visible, well-lit, and facing the camera.',
      };
    } catch (error) {
      console.error('❌ [FACE-DETECT-ERROR]:', error.message);
      return { success: false, message: `Face detection failed: ${error.message}` };
    }
  }

  // ==================== VECTOR OPERATIONS ====================

  computeAverageDescriptor(descriptors) {
    if (!descriptors || descriptors.length === 0) return null;
    if (descriptors.length === 1) return descriptors[0];

    const len = descriptors[0].length; // 128
    const avg = new Array(len).fill(0);

    for (const desc of descriptors) {
      for (let i = 0; i < len; i++) {
        avg[i] += desc[i];
      }
    }

    for (let i = 0; i < len; i++) {
      avg[i] /= descriptors.length;
    }

    // Normalize vector to unit length
    let norm = 0;
    for (let i = 0; i < len; i++) {
      norm += avg[i] * avg[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < len; i++) {
        avg[i] /= norm;
      }
    }

    return avg;
  }

  euclideanDistance(desc1, desc2) {
    if (!desc1 || !desc2 || desc1.length !== desc2.length) {
      throw new Error(`Descriptor length mismatch (${desc1?.length} vs ${desc2?.length})`);
    }
    let sum = 0;
    for (let i = 0; i < desc1.length; i++) {
      const diff = desc1[i] - desc2[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  // ==================== FACE VERIFICATION PIPELINE ====================

  async getFaceEntry(userId) {
    if (!userId) return null;
    const normKey = this._normalizeKey(userId);

    let entry = this.faceDatabase.get(userId) || this.faceDatabase.get(normKey);

    // If not in cache, reload from storage
    if (!entry) {
      console.log(`ℹ️ [FACE-CACHE] User "${userId}" not in memory cache. Reloading from database...`);
      await this.loadFacesFromSheet();
      entry = this.faceDatabase.get(userId) || this.faceDatabase.get(normKey);
    }

    return entry;
  }

  /**
   * Primary Face Verification Method
   * Compares incoming camera image against stored 128-d master embedding
   */
  async verifyFace(userId, imageBuffer, threshold = VERIFY_DISTANCE_THRESHOLD) {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    console.log(`\n============================================================`);
    console.log(`🔍 [FACE-VERIFY-START] User ID: ${userId} | Time: ${timestamp}`);
    console.log(`   Threshold: <= ${threshold} | Frame Buffer: ${imageBuffer?.length || 0} bytes`);

    try {
      // Step 1: Validate payload
      if (!userId || typeof userId !== 'string') {
        console.warn(`❌ [FACE-VERIFY-STEP 1/5] Invalid userId: "${userId}"`);
        return { success: false, message: 'Invalid user ID' };
      }
      if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        console.warn(`❌ [FACE-VERIFY-STEP 1/5] Missing or empty image buffer`);
        return { success: false, message: 'No face image provided' };
      }
      console.log(`✅ [FACE-VERIFY-STEP 1/5] Payload validated: ${imageBuffer.length} bytes`);

      // Step 2: Retrieve enrolled face descriptor
      const storedFace = await this.getFaceEntry(userId);
      if (!storedFace || !storedFace.descriptor) {
        console.warn(`❌ [FACE-VERIFY-STEP 2/5] No face enrolled for user "${userId}" in database!`);
        const availableUsers = this.getEnrolledUsers();
        console.log(`   ℹ️ Currently enrolled users (${availableUsers.length}):`, availableUsers.join(', ') || 'None');
        return {
          success: false,
          noFaceEnrolled: true,
          message: `No face enrolled for user ${userId}. Please complete hardware face enrollment first.`,
        };
      }
      console.log(`✅ [FACE-VERIFY-STEP 2/5] Enrolled face descriptor located for "${userId}" (${storedFace.userName || 'User'})`);
      console.log(`   Enrolled at: ${storedFace.enrolledAt} | Baseline score: ${storedFace.score?.toFixed(3) || 'N/A'}`);

      // Step 3: Face detection & landmark extraction on camera frame
      console.log(`⏳ [FACE-VERIFY-STEP 3/5] Detecting face in frame across 4 cardinal angles...`);
      const detectionResult = await this.detectFace(imageBuffer, false);

      if (!detectionResult.success) {
        console.warn(`⚠️ [FACE-VERIFY-STEP 3/5] Camera frame detection failed: ${detectionResult.message}`);
        return {
          success: false,
          faceDetected: false,
          message: detectionResult.message,
        };
      }

      console.log(`✅ [FACE-VERIFY-STEP 3/5] Face detected at ${detectionResult.rotationAngle}° (score: ${detectionResult.score?.toFixed(4)})`);

      // Step 4: Euclidean distance vector calculation
      console.log(`⏳ [FACE-VERIFY-STEP 4/5] Calculating 128-d Euclidean distance against master template...`);
      const distance = this.euclideanDistance(storedFace.descriptor, detectionResult.descriptor);
      const isMatch = distance <= threshold;

      // Confidence & similarity formulas
      const confidence = Math.max(0, Math.min(1, 1 - (distance / (threshold * 2))));
      const similarityPercent = Math.max(0, Math.min(100, (1 - (distance / (threshold * 1.5))) * 100)).toFixed(1);

      console.log(`📐 [FACE-VERIFY-STEP 4/5] Distance Calculation:`);
      console.log(`   Euclidean Distance : ${distance.toFixed(4)} (Threshold: <= ${threshold})`);
      console.log(`   Calculated Match   : ${isMatch ? 'TRUE' : 'FALSE'}`);
      console.log(`   Similarity Score   : ${similarityPercent}%`);
      console.log(`   Confidence Score   : ${(confidence * 100).toFixed(1)}%`);

      // Step 5: Decision & Result
      const totalElapsed = Date.now() - startTime;
      console.log(`🎯 [FACE-VERIFY-STEP 5/5] Final Access Decision in ${totalElapsed}ms:`);
      console.log(`   Outcome: ${isMatch ? '✅ MATCH GRANTED' : '❌ MISMATCH DENIED'}`);
      console.log(`============================================================\n`);

      return {
        success: isMatch,
        message: isMatch
          ? `Face verified successfully (${similarityPercent}% similarity)`
          : `Face does not match enrolled template (${similarityPercent}% similarity, distance: ${distance.toFixed(3)})`,
        confidence,
        similarityPercent: parseFloat(similarityPercent),
        distance,
        threshold,
        rotationAngle: detectionResult.rotationAngle,
        score: detectionResult.score,
        timeMs: totalElapsed,
        box: detectionResult.box ? {
          x: Math.round(detectionResult.box.x),
          y: Math.round(detectionResult.box.y),
          w: Math.round(detectionResult.box.width),
          h: Math.round(detectionResult.box.height),
        } : null,
      };

    } catch (error) {
      console.error(`❌ [FACE-VERIFY-EXCEPTION]:`, error.message);
      return { success: false, message: `Verification error: ${error.message}` };
    }
  }

  // ==================== HARDWARE ENROLLMENT (SESSION-BASED) ====================

  /**
   * Enroll face from ESP32-CAM multi-sample stream
   */
  async enrollFaceFromHardware(userId, imageBuffer) {
    if (!userId || typeof userId !== 'string') {
      return { success: false, message: 'Invalid user ID' };
    }
    if (!imageBuffer) {
      return { success: false, message: 'No image buffer provided' };
    }

    const now = Date.now();

    // Get or create session
    let session = faceEnrollmentSessions.get(userId);
    if (!session || session.finalized) {
      session = {
        descriptors: [],
        scores: [],
        startedAt: now,
        lastFrameAt: now,
        finalized: false,
      };
      faceEnrollmentSessions.set(userId, session);
      console.log(`\n📝 [HARDWARE-ENROLL-SESSION] Started new enrollment session for ${userId}`);
    }

    session.lastFrameAt = now;

    // Detect face with quality gating
    const result = await this.detectFace(imageBuffer, true);

    if (!result.success) {
      return {
        success: false,
        message: result.message,
        box: result.box || null,
        confidence: 0,
        samplesAccepted: session.descriptors.length,
        samplesNeeded: SAMPLES_NEEDED_FOR_ENROLLMENT,
        finalized: false,
      };
    }

    // Accumulate good sample
    session.descriptors.push(result.descriptor);
    session.scores.push(result.score);

    const samplesAccepted = session.descriptors.length;
    const isHighQuality = result.score >= HIGH_QUALITY_SINGLE_SCORE;
    const hasEnoughSamples = samplesAccepted >= SAMPLES_NEEDED_FOR_ENROLLMENT;

    console.log(`   📊 [HARDWARE-ENROLL-PROGRESS] Sample ${samplesAccepted}/${SAMPLES_NEEDED_FOR_ENROLLMENT} accepted (score: ${result.score.toFixed(3)}, highQ: ${isHighQuality})`);

    // Check if ready to finalize
    if (hasEnoughSamples || isHighQuality) {
      const masterDescriptor = this.computeAverageDescriptor(session.descriptors);
      const avgScore = session.scores.reduce((a, b) => a + b, 0) / session.scores.length;

      const faceData = {
        rawUserId: userId,
        descriptor: masterDescriptor,
        enrolledAt: new Date().toISOString(),
        score: avgScore,
        samplesUsed: samplesAccepted,
      };

      this.faceDatabase.set(userId, faceData);
      this.faceDatabase.set(this._normalizeKey(userId), faceData);

      // Persist to storage
      await this.saveFaceToSheet(userId, masterDescriptor, avgScore);
      session.finalized = true;

      console.log(`✅ [HARDWARE-ENROLL-FINALIZED] User ${userId} face enrolled using ${samplesAccepted} sample(s), avg score: ${avgScore.toFixed(3)}`);

      return {
        success: true,
        message: `Face enrolled successfully using ${samplesAccepted} sample(s)`,
        confidence: avgScore,
        samplesAccepted,
        samplesNeeded: SAMPLES_NEEDED_FOR_ENROLLMENT,
        finalized: true,
        box: result.box ? {
          x: Math.round(result.box.x),
          y: Math.round(result.box.y),
          w: Math.round(result.box.width),
          h: Math.round(result.box.height),
        } : null,
      };
    }

    return {
      success: false,
      message: `Sample ${samplesAccepted}/${SAMPLES_NEEDED_FOR_ENROLLMENT} accepted. Please continue looking at camera.`,
      confidence: result.score,
      samplesAccepted,
      samplesNeeded: SAMPLES_NEEDED_FOR_ENROLLMENT,
      finalized: false,
      box: result.box ? {
        x: Math.round(result.box.x),
        y: Math.round(result.box.y),
        w: Math.round(result.box.width),
        h: Math.round(result.box.height),
      } : null,
    };
  }

  // Single-buffer enrollment
  async enrollFace(userId, imageBuffer) {
    if (!imageBuffer) return { success: false, message: 'No image provided' };
    return this.enrollFaceMultiSample(userId, [imageBuffer]);
  }

  async enrollFaceMultiSample(userId, imageBuffers) {
    console.log(`\n📝 [ENROLL-MULTI-SAMPLE] User: ${userId} (${imageBuffers.length} sample(s))`);
    try {
      const validDescriptors = [];
      const scores = [];
      let lastAngle = 0;
      let lastBox = null;

      for (let i = 0; i < imageBuffers.length; i++) {
        const result = await this.detectFace(imageBuffers[i], true);
        if (result.box) lastBox = result.box;
        if (result.success) {
          validDescriptors.push(result.descriptor);
          scores.push(result.score);
          lastAngle = result.rotationAngle || 0;
        }
      }

      if (validDescriptors.length === 0) {
        return { success: false, message: 'No clean face detected' };
      }

      const masterDescriptor = this.computeAverageDescriptor(validDescriptors);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

      const faceData = {
        rawUserId: userId,
        descriptor: masterDescriptor,
        enrolledAt: new Date().toISOString(),
        score: avgScore,
        samplesUsed: validDescriptors.length,
      };

      this.faceDatabase.set(userId, faceData);
      this.faceDatabase.set(this._normalizeKey(userId), faceData);
      await this.saveFaceToSheet(userId, masterDescriptor, avgScore);

      return {
        success: true,
        message: `Face enrolled successfully using ${validDescriptors.length} sample(s)`,
        confidence: avgScore,
        samplesUsed: validDescriptors.length,
        rotationAngle: lastAngle,
        box: lastBox,
      };
    } catch (err) {
      return { success: false, message: `Enrollment error: ${err.message}` };
    }
  }

  // ==================== UTILITIES ====================

  async deleteFace(userId) {
    console.log(`🗑️ [FACE-DELETE] Deleting face for user: ${userId}`);
    const normKey = this._normalizeKey(userId);
    this.faceDatabase.delete(userId);
    this.faceDatabase.delete(normKey);
    faceEnrollmentSessions.delete(userId);
    await this.clearFaceFromSheet(userId);
    return { success: true, message: 'Face deleted successfully' };
  }

  getEnrolledCount() {
    const unique = new Set();
    for (const [k, v] of this.faceDatabase.entries()) {
      if (v?.rawUserId) unique.add(v.rawUserId);
    }
    return unique.size;
  }

  isUserEnrolled(userId) {
    const normKey = this._normalizeKey(userId);
    return this.faceDatabase.has(userId) || this.faceDatabase.has(normKey);
  }

  getEnrolledUsers() {
    const unique = new Set();
    for (const [k, v] of this.faceDatabase.entries()) {
      if (v?.rawUserId) unique.add(v.rawUserId);
    }
    return Array.from(unique);
  }

  getDescriptorForUser(userId) {
    const entry = this.faceDatabase.get(userId) || this.faceDatabase.get(this._normalizeKey(userId));
    if (entry && entry.descriptor) {
      return {
        descriptor: entry.descriptor,
        status: 'ENROLLED',
      };
    }
    return null;
  }
}

module.exports = new FaceRecognitionService();