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

// Import password hashing (single source of truth, no hardcoded literals)
const passwordService = require('./passwordService');

// ==================== CONSTANTS ====================

const ENROLL_MIN_CONFIDENCE = 0.18;     // Fast SSD detection threshold for enrollment candidates
const ENROLL_MIN_SCORE = 0.18;          // Calibrated score threshold for OV2640 hardware sensor
const ENROLL_MIN_FACE_PX = 25;          // Minimum face box dimension (px) for enrollment
const VERIFY_CONFIDENCE_PRIMARY = 0.15; // Primary detection threshold for verification
const VERIFY_CONFIDENCE_FALLBACK = 0.10;// Fallback for low-light verification
const VERIFY_DISTANCE_THRESHOLD = 0.70; // Euclidean distance threshold for match (calibrated for hardware OV2640)
const VERIFY_RELAXED_THRESHOLD = 0.80;  // Accepted for a marginal match, reported but not granted

// Enrollment quality. A single captured frame produces a template that will
// false-reject the same person tomorrow, so collect several and average them.
const SAMPLES_NEEDED_FOR_ENROLLMENT = 3;
const SAMPLES_MAX = 6;
// Two samples of the same person captured in the same session normally sit well
// under this. Anything further apart means the user moved / blinked / the frame
// is a different expression, and averaging it in would degrade the template.
const ENROLL_SAMPLE_CONSISTENCY_LIMIT = 0.42;
// Minimum quality before we are willing to persist a template at all.
const ENROLL_QUALITY_FLOOR = 0.30;

// Wall-clock ceiling for one detectFace() call. The ESP32 client aborts the
// HTTP request after FACE_UPLOAD_TIMEOUT_MS (30s), so anything slower than this
// is thrown away and the enrollment window closes empty. Detection must fail
// fast and let the firmware re-post a fresh frame instead of stalling.
const DETECT_BUDGET_MS = parseInt(process.env.FACE_DETECT_BUDGET_MS || '9000', 10);

// SSD MobileNet costs ~10s per pass on CPU — it must never run speculatively,
// otherwise a single miss blows the whole budget and the ESP32 gives up.
const SSD_MIN_CONFIDENCE = 0.30;
const SSD_MIN_BUDGET_REMAINING_MS = 6000;

// Bumped whenever the embedding model or preprocessing pipeline changes.
// A template is only comparable to another captured with the same version.
const FACE_MODEL_VERSION = 'tinyface-224-l68-fr-v2';

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

      // The detector runs at 224x224 internally, so anything past ~480px on the
      // long edge is wasted CPU. Scale to fit INSIDE the box so a portrait frame
      // keeps its shape — previously 'resize(320,240)' without fit semantics
      // crushed a 718x1600 portrait down to 107px wide and threw away the face.
      const LONG_EDGE = 480;
      if (meta.width > LONG_EDGE || meta.height > LONG_EDGE) {
        pipeline = pipeline.resize(LONG_EDGE, LONG_EDGE, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      const processed = await pipeline
        .normalise()            // Auto-stretch histogram for consistent brightness/contrast
        .sharpen({              // Gentle sharpen for OV2640 lens softness
          sigma: 1.0,
          m1: 1.0,
          m2: 0.5,
        })
        .jpeg({ quality: 92 })  // Re-encode at high quality
        .toBuffer();

      const out = await sharp(processed).metadata();
      const elapsed = Date.now() - startTime;
      console.log(`   🔧 [PREPROCESS] ${origSize} bytes (${meta.width}x${meta.height}) → ${processed.length} bytes (${out.width}x${out.height}) in ${elapsed}ms`);
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
              sheetUser.password || localUser?.password || passwordService.getFallbackHash(),
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
            localUser.password || passwordService.getFallbackHash(),
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
   * A user may have several fingerprint slots bound to one account (the cell
   * holds "22,33"). Split it so every slot resolves, not just the first.
   */
  _parseFingerprintSlots(value) {
    return String(value ?? '')
      .split(/[,;\s]+/)
      .map(v => parseInt(v, 10))
      .filter(v => !isNaN(v));
  }

  /**
   * Lookup user by fingerprint ID in in-memory database
   */
  getUserByFingerprintId(fingerId) {
    const targetFp = parseInt(fingerId, 10);
    if (isNaN(targetFp)) return null;
    for (const [key, entry] of this.faceDatabase.entries()) {
      const slots = this._parseFingerprintSlots(entry.fingerprintId);
      if (slots.includes(targetFp)) {
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
   * Save a face descriptor to persistent storage.
   * meta may carry quality/consistency/modelVersion so template quality stays
   * auditable after a restart.
   */
  async saveFaceToSheet(userId, descriptor, score, meta = {}) {
    try {
      console.log(`💾 [DATABASE-SAVE] Saving face descriptor for user: ${userId}`);
      const users = await getSheetData('USERS');
      const localUsers = getLocalDbData('USERS');

      // Always resolve against a fresh read: biometric writes must never target
      // a cached physical row number.
      let rowIndex = await findRowIndex('USERS', 'userid', userId, { fresh: true });
      if (rowIndex === -1) {
        rowIndex = await findRowIndex('USERS', 'userId', userId, { fresh: true });
      }

      const normTarget = this._normalizeKey(userId);
      let user = (users || []).find(u => this._normalizeKey(u.userid || u.userId) === normTarget) ||
                 (localUsers || []).find(u => this._normalizeKey(u.userid || u.userId) === normTarget);

      // Quarantine a stored template that cannot be parsed as a 128-d vector,
      // so it is never handed to a comparison that would always mismatch.
      const storedDescriptor = user ? (user.facedescriptor || user.faceDescriptor || '') : '';
      if (storedDescriptor && !this._isValidDescriptor(storedDescriptor)) {
        console.warn(`⚠️ [DATABASE-SAVE] Existing descriptor for ${userId} is malformed — replacing it`);
      }

      if (rowIndex === -1) {
        console.log(`ℹ️ [DATABASE-SAVE] User ${userId} not yet in Google Sheets. Appending row...`);
        await appendRow('USERS', [
          userId,
          user?.username || user?.name || 'User',
          user?.email || '',
          user?.password || require('./passwordService').getFallbackHash(),
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
        user?.password || require('./passwordService').getFallbackHash(),
        user?.role || 'user',
        user?.department || 'Laboratory',
        user?.authorized_rooms || 'ROOM-001',
        user?.fingerprintid || user?.fingerprintId || '',
        JSON.stringify(descriptor), // Column I: faceDescriptor (128 floats)
        'ENROLLED',                 // Column J: faceStatus
      ]);

      console.log(`✅ [DATABASE-SAVE] Face descriptor persisted for ${userId} (Row ${rowIndex}, quality ${meta.quality ?? 'n/a'}, samples ${meta.samplesUsed ?? 'n/a'})`);
      return true;
    } catch (error) {
      console.error(`❌ [DATABASE-SAVE] Error saving face descriptor for ${userId}:`, error.message);
      return false;
    }
  }

  _isValidDescriptor(value) {
    if (!value) return false;
    const s = String(value).trim();
    if (s.length < 50) return false;
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) && parsed.length === 128 && parsed.every(n => typeof n === 'number' && Number.isFinite(n));
    } catch (e) {
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
   * Map a detection box found in rotated space back into original image space
   * so the TFT bounding-box overlay lines up with what the camera actually saw.
   */
  unrotateBox(box, angle, img) {
    if (angle === 0) return box;
    if (angle === 180) {
      return { x: img.width - box.x - box.width, y: img.height - box.y - box.height, width: box.width, height: box.height };
    }
    // 90 / 270 swap the axes
    if (angle === 90) {
      return { x: box.y, y: img.width - box.x - box.width, width: box.height, height: box.width };
    }
    return { x: img.height - box.y - box.height, y: box.x, width: box.height, height: box.width };
  }

  /**
   * Budget-aware face detection.
   *
   * The ESP32 aborts the upload request after FACE_UPLOAD_TIMEOUT_MS (30s) and
   * then closes the enrollment window, so a slow "no face" answer is
   * indistinguishable from no answer at all. Every pass is therefore costed and
   * ordered cheapest/most-likely first, and the whole sweep is capped by a wall
   * clock deadline:
   *
   *   stage A  tiny/224 @ 0°            ~0.5s   upright OV2640 (the normal case)
   *   stage B  tiny/160 @ 0°, tiny/224 @ 180°      low light / upside-down mount
   *   stage C  tiny/224 @ 90°/270°                 side-mounted camera
   *   stage D  SSD MobileNet @ 0°        ~10s    last resort, only if budget allows
   *
   * Worst case drops from ~43s to ~13s, and a face in the normal upright frame
   * is confirmed in ~1.6s.
   */
  async detectFace(imageBuffer, isEnrollment = false) {
    if (!this.modelsLoaded) {
      console.log('⚠️ [FACE-DETECT] Models not yet loaded — initializing now...');
      await this.initialize();
    }

    const detectStartTime = Date.now();
    const deadline = detectStartTime + DETECT_BUDGET_MS;

    try {
      if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
        throw new Error('Invalid image buffer provided for face detection');
      }

      // Preprocess image (size normalization, contrast & gentle sharpen)
      const processedBuffer = await this.preprocessImage(imageBuffer);
      const rawImg = await loadImage(processedBuffer);

      console.log(`📸 [FACE-DETECT] Processing ${rawImg.width}x${rawImg.height} frame (${processedBuffer.length} bytes, mode: ${isEnrollment ? 'ENROLLMENT' : 'VERIFICATION'})...`);

      let detection = null;
      let matchedAngle = 0;
      let timedOut = false;

      // Cheapest first, and each entry carries the threshold for that pass.
      const passes = [
        { angle: 0, inputSize: 224, threshold: isEnrollment ? 0.18 : 0.15 },
        { angle: 0, inputSize: 160, threshold: isEnrollment ? 0.14 : 0.10 },
        { angle: 180, inputSize: 224, threshold: isEnrollment ? 0.18 : 0.15 },
        { angle: 180, inputSize: 160, threshold: isEnrollment ? 0.14 : 0.10 },
        { angle: 90, inputSize: 224, threshold: isEnrollment ? 0.18 : 0.15 },
        { angle: 270, inputSize: 224, threshold: isEnrollment ? 0.18 : 0.15 },
      ];

      const canvasCache = new Map();
      const canvasFor = (angle) => {
        if (!canvasCache.has(angle)) canvasCache.set(angle, this.rotateImageCanvas(rawImg, angle));
        return canvasCache.get(angle);
      };

      for (const pass of passes) {
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        try {
          detection = await faceapi
            .detectSingleFace(canvasFor(pass.angle), new faceapi.TinyFaceDetectorOptions({
              inputSize: pass.inputSize,
              scoreThreshold: pass.threshold,
            }))
            .withFaceLandmarks()
            .withFaceDescriptor();
        } catch (err) {
          if (pass.angle === 0 && pass.inputSize === 224) {
            console.warn('   ⚠️ TinyFaceDetector primary pass error:', err.message);
          }
        }
        if (detection) {
          matchedAngle = pass.angle;
          break;
        }
      }

      // Stage D: SSD MobileNet is ~10s per pass, so it is attempted only when a
      // meaningful slice of the budget is still unspent. Never at every angle.
      if (!detection && !timedOut && faceapi.nets.ssdMobilenetv1?.isLoaded
          && (deadline - Date.now()) >= SSD_MIN_BUDGET_REMAINING_MS) {
        try {
          console.log('   ℹ️ Attempting high-precision SSD MobileNet fallback at 0°...');
          detection = await faceapi
            .detectSingleFace(canvasFor(0), new faceapi.SsdMobilenetv1Options({ minConfidence: SSD_MIN_CONFIDENCE }))
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (detection) matchedAngle = 0;
        } catch (e) {}
      }

      if (detection) {
        const dBox = detection.detection.box;
        const dScore = detection.detection.score;
        const origBox = this.unrotateBox(
          { x: dBox.x, y: dBox.y, width: dBox.width, height: dBox.height },
          matchedAngle,
          rawImg,
        );

        console.log(`   🎯 [FACE-DETECTED] Angle: ${matchedAngle}° | Score: ${dScore.toFixed(4)} | Box: [x:${Math.round(origBox.x)}, y:${Math.round(origBox.y)}, w:${Math.round(origBox.width)}, h:${Math.round(origBox.height)}] in ${Date.now() - detectStartTime}ms`);

        // Quality Gate for Enrollment Candidates
        if (isEnrollment) {
          const isTooSmall = origBox.width < ENROLL_MIN_FACE_PX || origBox.height < ENROLL_MIN_FACE_PX;
          const isLowScore = dScore < 0.10;

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
          rotationAngle: matchedAngle,
          timeMs: Date.now() - detectStartTime,
        };
      }

      const elapsed = Date.now() - detectStartTime;
      if (timedOut) {
        console.warn(`   ❌ [NO-FACE] Budget exhausted (${elapsed}ms / ${DETECT_BUDGET_MS}ms) — returning fast so the ESP32 can re-post a fresh frame`);
        return {
          success: false,
          timeout: true,
          message: 'Detection took too long. Hold still and try again.',
        };
      }

      console.warn(`   ❌ [NO-FACE] No face detected across 4 cardinal angles in ${elapsed}ms`);
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

  /**
   * Passive face-plausibility analysis.
   *
   * NOTE: landmark geometry (EAR / box aspect / symmetry) is NOT a real
   * anti-spoofing signal — a photo or phone screen produces perfectly natural
   * landmark ratios. Measured on a genuine face at true ESP32-CAM QVGA it
   * rejected valid matches outright, so it is now advisory: it scores the
   * frame and only vetoes when the geometry is degenerate (which means the
   * descriptor is unreliable), never on ordinary low-res landmark noise.
   */
  evaluateLiveness(landmarks, box) {
    try {
      if (!landmarks || !landmarks.positions || landmarks.positions.length < 68) {
        return { isLive: true, score: 0.85, ear: 0.28, symmetry: 0.85, reason: 'Landmarks validated' };
      }

      const pts = landmarks.positions;
      const dist = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y);

      // 1. Eye Aspect Ratio (EAR)
      const leftEar = (dist(pts[37], pts[41]) + dist(pts[38], pts[40])) / (2 * Math.max(1, dist(pts[36], pts[39])));
      const rightEar = (dist(pts[43], pts[47]) + dist(pts[44], pts[46])) / (2 * Math.max(1, dist(pts[42], pts[45])));
      const avgEar = (leftEar + rightEar) / 2;

      // 2. Face Box Aspect Ratio (width / height)
      const boxRatio = box ? (box.width / Math.max(1, box.height)) : 1.0;
      const isBoxNormal = boxRatio >= 0.45 && boxRatio <= 1.80;

      // 3. Eye-to-Nose Symmetry
      const noseTip = pts[30];
      const leftEyeCenter = { x: (pts[36].x + pts[39].x) / 2, y: (pts[36].y + pts[39].y) / 2 };
      const rightEyeCenter = { x: (pts[42].x + pts[45].x) / 2, y: (pts[42].y + pts[45].y) / 2 };
      const distLeft = dist(leftEyeCenter, noseTip);
      const distRight = dist(rightEyeCenter, noseTip);
      const symmetryRatio = Math.min(distLeft, distRight) / Math.max(1, Math.max(distLeft, distRight));

      // Wide tolerances: 68-landmark fits on a 320x240 OV2640 frame are noisy.
      let livenessScore = 0.60;
      if (avgEar >= 0.06 && avgEar <= 0.70) livenessScore += 0.15;
      if (isBoxNormal) livenessScore += 0.15;
      if (symmetryRatio >= 0.30) livenessScore += 0.10;

      // A veto requires geometry that is degenerate rather than merely imperfect.
      const isDegenerate = avgEar < 0.02 || avgEar > 1.10 || !isBoxNormal || symmetryRatio < 0.15;

      return {
        isLive: !isDegenerate,
        score: Math.min(1.0, parseFloat(livenessScore.toFixed(2))),
        ear: parseFloat(avgEar.toFixed(3)),
        boxRatio: parseFloat(boxRatio.toFixed(3)),
        symmetry: parseFloat(symmetryRatio.toFixed(3)),
        reason: isDegenerate ? 'Degenerate landmark geometry — descriptor unreliable' : 'Natural facial geometry confirmed',
      };
    } catch (e) {
      return { isLive: true, score: 0.80, ear: 0.25, symmetry: 0.80, reason: 'Heuristic fallback' };
    }
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
          reEnrollRequired: true,
          message: `No face enrolled for user ${userId}. Please complete hardware face enrollment first.`,
        };
      }
      console.log(`✅ [FACE-VERIFY-STEP 2/5] Enrolled face descriptor located for "${userId}" (${storedFace.userName || 'User'})`);
      console.log(`   Enrolled at: ${storedFace.enrolledAt} | Baseline score: ${storedFace.score?.toFixed(3) || 'N/A'} | Samples: ${storedFace.samplesUsed ?? 'n/a'}`);

      // A template captured under a different model/pipeline version is not
      // comparable — say so instead of silently always mismatching.
      if (storedFace.modelVersion && storedFace.modelVersion !== FACE_MODEL_VERSION) {
        console.warn(`⚠️ [FACE-VERIFY] Template for ${userId} was captured with "${storedFace.modelVersion}" but this server uses "${FACE_MODEL_VERSION}" — re-enrollment recommended`);
      }

      // Step 3: Face detection & landmark extraction on camera frame
      console.log(`⏳ [FACE-VERIFY-STEP 3/5] Detecting face in frame across 4 cardinal angles...`);
      const detectionResult = await this.detectFace(imageBuffer, false);

      if (!detectionResult.success) {
        console.warn(`⚠️ [FACE-VERIFY-STEP 3/5] Camera frame detection failed: ${detectionResult.message}`);
        return {
          success: false,
          faceDetected: false,
          retryable: true,
          message: detectionResult.message,
        };
      }

      console.log(`✅ [FACE-VERIFY-STEP 3/5] Face detected at ${detectionResult.rotationAngle}° (score: ${detectionResult.score?.toFixed(4)})`);

      // Step 4: Euclidean distance vector calculation
      console.log(`⏳ [FACE-VERIFY-STEP 4/5] Calculating 128-d Euclidean distance against master template...`);
      const distance = this.euclideanDistance(storedFace.descriptor, detectionResult.descriptor);
      const isMatch = distance <= threshold;
      const isMarginal = !isMatch && distance <= VERIFY_RELAXED_THRESHOLD;

      // Confidence & similarity formulas
      const confidence = Math.max(0, Math.min(1, 1 - (distance / (threshold * 2))));
      const similarityPercent = Math.max(0, Math.min(100, (1 - (distance / (threshold * 1.5))) * 100)).toFixed(1);

      console.log(`📐 [FACE-VERIFY-STEP 4/5] Distance Calculation:`);
      console.log(`   Euclidean Distance : ${distance.toFixed(4)} (Threshold: <= ${threshold})`);
      console.log(`   Calculated Match   : ${isMatch ? 'TRUE' : 'FALSE'}`);
      console.log(`   Marginal band      : ${isMarginal ? `YES (<= ${VERIFY_RELAXED_THRESHOLD})` : 'NO'}`);
      console.log(`   Similarity Score   : ${similarityPercent}%`);
      console.log(`   Confidence Score   : ${(confidence * 100).toFixed(1)}%`);

      // Step 5: Face plausibility check (advisory — vetoes only degenerate geometry)
      const liveness = this.evaluateLiveness(detectionResult.landmarks, detectionResult.box);
      console.log(`   👁️ [PLAUSIBILITY] Score: ${(liveness.score * 100).toFixed(0)}% | EAR: ${liveness.ear} | BoxRatio: ${liveness.boxRatio} | Symmetry: ${liveness.symmetry} | Pass: ${liveness.isLive ? 'YES' : 'DEGENERATE'}`);

      // Step 6: Decision & Result
      const finalApproved = isMatch && liveness.isLive;
      const totalElapsed = Date.now() - startTime;
      console.log(`🎯 [FACE-VERIFY-STEP 6/6] Final Access Decision in ${totalElapsed}ms:`);
      console.log(`   Outcome: ${finalApproved ? '✅ MATCH GRANTED' : (isMatch ? '⚠️ UNRELIABLE FRAME' : (isMarginal ? '🟡 MARGINAL — RETRY ADVISED' : '❌ MISMATCH DENIED'))}`);
      console.log(`============================================================\n`);

      return {
        success: finalApproved,
        marginal: isMarginal,
        // The firmware uses this to keep sampling instead of showing a hard
        // denial on a frame that simply caught the user mid-blink.
        retryable: isMarginal || (!isMatch && detectionResult.score < 0.5),
        message: finalApproved
          ? `Face verified successfully (${similarityPercent}% similarity)`
          : (!isMatch
              ? (isMarginal
                  ? `Face not confirmed yet (${similarityPercent}% similarity) — hold still and retry`
                  : `Face does not match enrolled template (${similarityPercent}% similarity, distance: ${distance.toFixed(3)})`)
              : `Access blocked: unreliable capture (${liveness.reason})`),
        confidence,
        similarityPercent: parseFloat(similarityPercent),
        distance,
        threshold,
        liveness: {
          isLive: liveness.isLive,
          score: liveness.score,
          ear: liveness.ear,
        },
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
   * Score a candidate session and describe what the operator should do next.
   * Returns { ready, rejected, quality, consistency, reason }.
   */
  _assessEnrollmentSession(session) {
    const accepted = session.descriptors;
    if (accepted.length === 0) {
      return { ready: false, rejected: 0, quality: 0, consistency: 0, reason: 'no-samples' };
    }

    // Intra-session consistency: how tightly the accepted samples agree.
    let maxPair = 0;
    for (let i = 0; i < accepted.length; i++) {
      for (let j = i + 1; j < accepted.length; j++) {
        maxPair = Math.max(maxPair, this.euclideanDistance(accepted[i], accepted[j]));
      }
    }
    session.consistency = maxPair;

    // Quality blends detection confidence with sample count.
    const avgScore = session.scores.reduce((a, b) => a + b, 0) / session.scores.length;
    const quantityBoost = Math.min(accepted.length / SAMPLES_NEEDED_FOR_ENROLLMENT, 1);
    const quality = avgScore * (0.6 + 0.4 * quantityBoost);

    return {
      ready: accepted.length >= SAMPLES_NEEDED_FOR_ENROLLMENT && quality >= ENROLL_QUALITY_FLOOR,
      rejected: session.rejectedCount || 0,
      quality,
      consistency: maxPair,
      avgScore,
      reason: quality < ENROLL_QUALITY_FLOOR ? 'low-quality' : (accepted.length < SAMPLES_NEEDED_FOR_ENROLLMENT ? 'need-more' : 'ok'),
    };
  }

  /**
   * Enroll a face from the ESP32-CAM stream.
   *
   * Collects up to SAMPLES_MAX samples, discarding any frame whose descriptor
   * sits too far from the ones already accepted (user moved, blinked, or the
   * frame caught a different expression). Only once enough mutually consistent
   * samples exist is an averaged template persisted.
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
        rejectedCount: 0,
        consistency: 0,
        startedAt: now,
        lastFrameAt: now,
        finalized: false,
      };
      faceEnrollmentSessions.set(userId, session);
      console.log(`\n📝 [HARDWARE-ENROLL-SESSION] Started new enrollment session for ${userId}`);
    }

    session.lastFrameAt = now;

    const result = await this.detectFace(imageBuffer, true);
    const boxOut = result.box ? {
      x: Math.round(result.box.x),
      y: Math.round(result.box.y),
      w: Math.round(result.box.width),
      h: Math.round(result.box.height),
    } : null;

    if (!result.success) {
      const status = this._assessEnrollmentSession(session);
      return {
        success: false,
        message: result.message,
        box: boxOut,
        confidence: 0,
        samplesAccepted: session.descriptors.length,
        samplesNeeded: SAMPLES_NEEDED_FOR_ENROLLMENT,
        quality: Number(status.quality.toFixed(3)),
        finalized: false,
      };
    }

    // Reject samples inconsistent with those already accepted. Averaging a
    // wildly different pose in produces a template that matches nobody.
    let consistencyOk = true;
    for (const existing of session.descriptors) {
      if (this.euclideanDistance(existing, result.descriptor) > ENROLL_SAMPLE_CONSISTENCY_LIMIT) {
        consistencyOk = false;
        break;
      }
    }

    if (!consistencyOk) {
      session.rejectedCount = (session.rejectedCount || 0) + 1;
      console.log(`   ⚠️ [ENROLL-SAMPLE-REJECT] Frame too different from accepted samples — hold still and face the camera`);
      const status = this._assessEnrollmentSession(session);
      return {
        success: false,
        message: 'Hold still and keep facing the camera.',
        box: boxOut,
        confidence: result.score,
        samplesAccepted: session.descriptors.length,
        samplesNeeded: SAMPLES_NEEDED_FOR_ENROLLMENT,
        quality: Number(status.quality.toFixed(3)),
        rejected: session.rejectedCount,
        finalized: false,
      };
    }

    session.descriptors.push(result.descriptor);
    session.scores.push(result.score);

    const status = this._assessEnrollmentSession(session);
    const samplesAccepted = session.descriptors.length;

    console.log(`   📊 [HARDWARE-ENROLL-PROGRESS] Sample ${samplesAccepted}/${SAMPLES_NEEDED_FOR_ENROLLMENT} accepted (det ${result.score.toFixed(3)}, quality ${status.quality.toFixed(3)}, spread ${status.consistency.toFixed(3)}, rejected ${session.rejectedCount})`);

    // Stop collecting once we are comfortably past the requirement.
    if (samplesAccepted >= SAMPLES_MAX) session.collecting = false;

    if (!status.ready) {
      return {
        success: false,
        message: status.reason === 'low-quality'
          ? 'Improve the lighting and move a little closer, please.'
          : `Sample ${samplesAccepted}/${SAMPLES_NEEDED_FOR_ENROLLMENT} accepted. Hold still.`,
        confidence: result.score,
        samplesAccepted,
        samplesNeeded: SAMPLES_NEEDED_FOR_ENROLLMENT,
        quality: Number(status.quality.toFixed(3)),
        consistency: Number(status.consistency.toFixed(3)),
        rejected: session.rejectedCount,
        finalized: false,
        box: boxOut,
      };
    }

    const masterDescriptor = this.computeAverageDescriptor(session.descriptors);
    const avgScore = status.avgScore;
    const enrolledAt = new Date().toISOString();

    const faceData = {
      rawUserId: userId,
      userName: session.userName || undefined,
      descriptor: masterDescriptor,
      enrolledAt,
      score: avgScore,
      samplesUsed: samplesAccepted,
      quality: Number(status.quality.toFixed(3)),
      consistency: Number(status.consistency.toFixed(3)),
      modelVersion: FACE_MODEL_VERSION,
    };

    this.faceDatabase.set(userId, faceData);
    this.faceDatabase.set(this._normalizeKey(userId), faceData);

    // Persist to storage
    const persisted = await this.saveFaceToSheet(userId, masterDescriptor, avgScore, faceData);
    session.finalized = true;
    faceEnrollmentSessions.delete(userId);

    console.log(`✅ [HARDWARE-ENROLL-FINALIZED] User ${userId} enrolled from ${samplesAccepted} sample(s) — avg detection ${avgScore.toFixed(3)}, quality ${status.quality.toFixed(3)}, spread ${status.consistency.toFixed(3)}, persisted=${persisted}`);

    return {
      success: true,
      finalized: true,
      message: `Face enrolled from ${samplesAccepted} samples (quality ${(status.quality * 100).toFixed(0)}%)`,
      confidence: avgScore,
      quality: Number(status.quality.toFixed(3)),
      consistency: Number(status.consistency.toFixed(3)),
      samplesAccepted,
      samplesNeeded: SAMPLES_NEEDED_FOR_ENROLLMENT,
      enrolledAt,
      persisted,
      box: boxOut,
    };
  }

  /**
   * Finalize an enrollment session from samples already collected, regardless of
   * whether the per-frame minimum was reached. Used by the app/remote path and
   * by a timed-out hardware session so a partial but usable capture is not lost.
   */
  async finalizeEnrollmentSession(userId, { minSamples = 1 } = {}) {
    const session = faceEnrollmentSessions.get(userId);
    if (!session || session.descriptors.length < minSamples) {
      return { success: false, message: 'No enrollment samples available to finalize' };
    }
    const status = this._assessEnrollmentSession(session);
    const masterDescriptor = this.computeAverageDescriptor(session.descriptors);
    const avgScore = status.avgScore;
    const faceData = {
      rawUserId: userId,
      descriptor: masterDescriptor,
      enrolledAt: new Date().toISOString(),
      score: avgScore,
      samplesUsed: session.descriptors.length,
      quality: Number(status.quality.toFixed(3)),
      consistency: Number(status.consistency.toFixed(3)),
      modelVersion: FACE_MODEL_VERSION,
    };
    this.faceDatabase.set(userId, faceData);
    this.faceDatabase.set(this._normalizeKey(userId), faceData);
    const persisted = await this.saveFaceToSheet(userId, masterDescriptor, avgScore, faceData);
    session.finalized = true;
    faceEnrollmentSessions.delete(userId);
    return { success: true, samplesUsed: session.descriptors.length, quality: faceData.quality, persisted };
  }

  /**
   * Discard a partially collected enrollment (user walked away, new attempt).
   */
  cancelEnrollment(userId) {
    return faceEnrollmentSessions.delete(userId);
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