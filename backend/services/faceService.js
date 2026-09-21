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
  findRowIndex,
  updateRow,
} = require('./sheetsService');

// Import shared state for multi-sample enrollment sessions
const { faceEnrollmentSessions } = require('./sharedState');

// ==================== CONSTANTS ====================

const ENROLL_MIN_CONFIDENCE = 0.30;     // SSD detection threshold for enrollment candidates
const ENROLL_MIN_SCORE = 0.35;          // Detection score threshold for enrollment quality gate
const ENROLL_MIN_FACE_PX = 45;          // Minimum face box dimension (px) for enrollment
const VERIFY_CONFIDENCE_PRIMARY = 0.20; // Primary detection threshold for verification
const VERIFY_CONFIDENCE_FALLBACK = 0.12;// Fallback for low-light verification
const VERIFY_DISTANCE_THRESHOLD = 0.65; // Euclidean distance threshold for match (<= 0.65 is standard for SSD MobileNet)
const SAMPLES_NEEDED_FOR_ENROLLMENT = 3;// Number of good samples before averaging and saving
const HIGH_QUALITY_SINGLE_SCORE = 0.80; // If a single sample scores >= 0.80, can enroll immediately

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
      console.log('   ⏳ Step 1/3: Loading SSD MobileNet v1 (Face Detection)...');
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(localModelPath);

      console.log('   ⏳ Step 2/3: Loading Face Landmark 68 Net (Alignment)...');
      await faceapi.nets.faceLandmark68Net.loadFromDisk(localModelPath);

      console.log('   ⏳ Step 3/3: Loading Face Recognition Net (128-d Embeddings)...');
      await faceapi.nets.faceRecognitionNet.loadFromDisk(localModelPath);

      this.modelsLoaded = true;
      const elapsed = Date.now() - startTime;
      console.log(`✅ [FACE-INIT-SUCCESS] All neural weights loaded from local disk in ${elapsed}ms!`);

      // Load enrolled face descriptors from persistent storage
      await this.loadFacesFromSheet();
      console.log(`========================================\n`);
    } catch (error) {
      console.warn(`⚠️ [FACE-INIT-WARN] Local disk model load failed (${error.message}). Attempting CDN fallback...`);
      try {
        await faceapi.nets.ssdMobilenetv1.loadFromUri(this.modelUrl);
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

      const processed = await sharp(imageBuffer)
        .normalise()            // Auto-stretch histogram for consistent brightness/contrast
        .sharpen({              // Gentle sharpen for OV2640 lens softness
          sigma: 1.0,
          m1: 1.0,
          m2: 0.5,
        })
        .jpeg({ quality: 95 })  // Re-encode at high quality
        .toBuffer();

      const elapsed = Date.now() - startTime;
      console.log(`   🔧 [PREPROCESS] ${origSize} bytes (${meta.width}x${meta.height} ${meta.format}) → ${processed.length} bytes in ${elapsed}ms`);
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
    } catch (error) {
      console.error('❌ [DATABASE] Error loading faces from database:', error.message);
    }
  }

  /**
   * Save a face descriptor to persistent storage (Column I: faceDescriptor, Column J: faceStatus)
   */
  async saveFaceToSheet(userId, descriptor, score) {
    try {
      console.log(`💾 [DATABASE-SAVE] Saving face descriptor for user: ${userId}`);
      const users = await getSheetData('USERS');

      let rowIndex = await findRowIndex('USERS', 'userid', userId);
      if (rowIndex === -1) {
        rowIndex = await findRowIndex('USERS', 'userId', userId);
      }

      if (rowIndex === -1) {
        console.error(`❌ [DATABASE-SAVE] User ${userId} not found in USERS table`);
        return false;
      }

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
   * Detect face in buffer with automatic 4-way rotation matrix (0°, 180°, 90°, 270°)
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

      // Preprocess image (brightness normalization & gentle sharpen)
      const processedBuffer = await this.preprocessImage(imageBuffer);
      const rawImg = await loadImage(processedBuffer);

      console.log(`📸 [FACE-DETECT] Processing ${rawImg.width}x${rawImg.height} frame (${processedBuffer.length} bytes, mode: ${isEnrollment ? 'ENROLLMENT' : 'VERIFICATION'})...`);

      // 4 cardinal orientations
      const angles = [0, 180, 90, 270];
      const confidenceLevels = isEnrollment
        ? [ENROLL_MIN_CONFIDENCE]
        : [VERIFY_CONFIDENCE_PRIMARY, VERIFY_CONFIDENCE_FALLBACK];

      for (const minConf of confidenceLevels) {
        const options = new faceapi.SsdMobilenetv1Options({ minConfidence: minConf });

        for (const angle of angles) {
          const cvs = this.rotateImageCanvas(rawImg, angle);

          const detection = await faceapi
            .detectSingleFace(cvs, options)
            .withFaceLandmarks()
            .withFaceDescriptor();

          if (detection) {
            const dBox = detection.detection.box;
            const dScore = detection.detection.score;
            let origBox = { x: dBox.x, y: dBox.y, width: dBox.width, height: dBox.height };

            // Transform bounding box back to original orientation
            if (angle === 180) {
              origBox = {
                x: rawImg.width - dBox.x - dBox.width,
                y: rawImg.height - dBox.y - dBox.height,
                width: dBox.width,
                height: dBox.height,
              };
            } else if (angle === 90) {
              origBox = {
                x: dBox.y,
                y: rawImg.height - dBox.x - dBox.width,
                width: dBox.height,
                height: dBox.width,
              };
            } else if (angle === 270) {
              origBox = {
                x: rawImg.width - dBox.y - dBox.height,
                y: dBox.x,
                width: dBox.height,
                height: dBox.width,
              };
            }

            console.log(`   🎯 [FACE-DETECTED] Angle: ${angle}° | Score: ${dScore.toFixed(4)} | Box: [x:${Math.round(origBox.x)}, y:${Math.round(origBox.y)}, w:${Math.round(origBox.width)}, h:${Math.round(origBox.height)}] in ${Date.now() - detectStartTime}ms`);

            // Quality Gate for Enrollment Candidates
            if (isEnrollment) {
              const isTooSmall = origBox.width < ENROLL_MIN_FACE_PX || origBox.height < ENROLL_MIN_FACE_PX;
              const isLowScore = dScore < ENROLL_MIN_SCORE;

              if (isTooSmall || isLowScore) {
                console.warn(`   ⚠️ [ENROLL-QUALITY-GATE-REJECT] Face rejected: score=${dScore.toFixed(3)} (min ${ENROLL_MIN_SCORE}), size=${Math.round(origBox.width)}x${Math.round(origBox.height)} (min ${ENROLL_MIN_FACE_PX}px)`);
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
              rotationAngle: angle,
              timeMs: Date.now() - detectStartTime,
            };
          }
        }
      }

      console.warn(`   ❌ [NO-FACE] No face detected across all 4 angles in ${Date.now() - detectStartTime}ms`);
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