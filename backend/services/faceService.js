const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');
const { Canvas, Image, ImageData, createCanvas, loadImage } = canvas;
const path = require('path');
const sharp = require('sharp');

// Monkey patch faceapi to use canvas in Node
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// Import sheets service for persistent storage
const {
  getSheetData,
  findRowIndex,
  updateRow,
} = require('./sheetsService');

// Import shared state for multi-sample enrollment sessions
const { faceEnrollmentSessions } = require('./sharedState');

// ==================== CONSTANTS ====================

const ENROLL_MIN_CONFIDENCE = 0.40;  // SSD detection threshold for enrollment candidates
const ENROLL_MIN_SCORE = 0.45;       // Detection score threshold for enrollment quality gate
const ENROLL_MIN_FACE_PX = 65;       // Minimum face box dimension (px) for enrollment
const VERIFY_CONFIDENCE_PRIMARY = 0.25; // Primary detection threshold for verification
const VERIFY_CONFIDENCE_FALLBACK = 0.15; // Fallback for low-light verification
const VERIFY_DISTANCE_THRESHOLD = 0.65; // Euclidean distance threshold for match
const SAMPLES_NEEDED_FOR_ENROLLMENT = 3; // Number of good samples before averaging and saving
const HIGH_QUALITY_SINGLE_SCORE = 0.85;  // If a single sample scores this high, enroll immediately

class FaceRecognitionService {
  constructor() {
    this.modelsLoaded = false;
    this.faceDatabase = new Map(); // userId → { descriptor, enrolledAt, score }
    this.modelUrl = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
    console.log('🔧 FaceRecognitionService initialized (Sheets-backed persistence + sharp preprocessing)');
  }

  // ==================== INITIALIZATION ====================

  async initialize() {
    if (this.modelsLoaded) {
      console.log('✅ Models already loaded');
      return;
    }

    const localModelPath = path.resolve(__dirname, '../models');
    console.log(`📦 Loading face recognition models from local disk (${localModelPath})...`);

    try {
      console.log('⏳ Loading SSD MobileNet v1...');
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(localModelPath);

      console.log('⏳ Loading Face Landmark 68...');
      await faceapi.nets.faceLandmark68Net.loadFromDisk(localModelPath);

      console.log('⏳ Loading Face Recognition Net...');
      await faceapi.nets.faceRecognitionNet.loadFromDisk(localModelPath);

      this.modelsLoaded = true;
      console.log('✅ All face recognition models loaded from local disk instantly!');

      // Load face descriptors from Google Sheets
      await this.loadFacesFromSheet();
    } catch (error) {
      console.warn('⚠️ Local model load failed, falling back to CDN:', error.message);
      try {
        await faceapi.nets.ssdMobilenetv1.loadFromUri(this.modelUrl);
        await faceapi.nets.faceLandmark68Net.loadFromUri(this.modelUrl);
        await faceapi.nets.faceRecognitionNet.loadFromUri(this.modelUrl);
        this.modelsLoaded = true;
        console.log('✅ All face recognition models loaded from CDN');
        await this.loadFacesFromSheet();
      } catch (cdnError) {
        console.error('❌ Error loading models from CDN:', cdnError.message);
        throw cdnError;
      }
    }
  }

  // ==================== IMAGE PRE-PROCESSING ====================

  /**
   * Pre-process ESP32-CAM JPEG for optimal face detection.
   * The OV2640 at 320x240 in low-light/variable-exposure conditions produces
   * images that benefit from normalization before face-api.js processes them.
   *
   * Steps:
   *   1. Decode JPEG
   *   2. Normalize brightness/contrast (linear stretch)
   *   3. Sharpen slightly (ESP32-CAM JPEGs can be soft)
   *   4. Re-encode as JPEG at quality 95
   *
   * @param {Buffer} imageBuffer - Raw JPEG from ESP32-CAM
   * @returns {Promise<Buffer>} - Normalized JPEG buffer
   */
  async preprocessImage(imageBuffer) {
    try {
      const processed = await sharp(imageBuffer)
        .normalise()            // Auto-stretch histogram for consistent brightness/contrast
        .sharpen({              // Gentle sharpen for OV2640 softness
          sigma: 1.0,
          m1: 1.0,
          m2: 0.5,
        })
        .jpeg({ quality: 95 })  // Re-encode without excessive compression
        .toBuffer();

      console.log(`   🔧 Preprocessed: ${imageBuffer.length} → ${processed.length} bytes`);
      return processed;
    } catch (err) {
      // If sharp fails (corrupt JPEG, etc.), fall back to original buffer
      console.warn(`   ⚠️ sharp preprocessing failed (${err.message}), using raw image`);
      return imageBuffer;
    }
  }

  // ==================== SHEETS PERSISTENCE ====================

  /**
   * Helper: Normalize user ID for resilient map key lookup
   */
  _normalizeKey(id) {
    return String(id || '').trim().toLowerCase();
  }

  /**
   * Load all enrolled face descriptors from USERS Google Sheet
   * Called once on server start — populates in-memory faceDatabase Map
   */
  async loadFacesFromSheet() {
    try {
      console.log('📊 Loading face descriptors from Google Sheets...');
      const users = await getSheetData('USERS');
      let loaded = 0;

      for (const user of users) {
        // Support all casing permutations for userId
        const userId = user.userid || user.userId || user.USERID || user.id || '';
        // Column I: faceDescriptor (JSON string of 128 floats)
        const descriptorStr = user.facedescriptor || user.faceDescriptor || user.FACEDESCRIPTOR || '';

        if (userId && descriptorStr && descriptorStr.trim() !== '') {
          try {
            const parsed = JSON.parse(descriptorStr);
            if (Array.isArray(parsed) && parsed.length === 128) {
              const faceEntry = {
                rawUserId: userId,
                descriptor: parsed,
                enrolledAt: user.faceenrolledat || user.faceEnrolledAt || new Date().toISOString(),
                score: parseFloat(user.facescore || user.faceScore || '0.9'),
              };

              // Store both exact ID and normalized lowercase ID
              this.faceDatabase.set(userId, faceEntry);
              this.faceDatabase.set(this._normalizeKey(userId), faceEntry);
              loaded++;
            } else {
              console.warn(`⚠️ Invalid descriptor format for ${userId} (length: ${parsed?.length})`);
            }
          } catch (parseErr) {
            console.warn(`⚠️ Could not parse face descriptor for ${userId}: ${parseErr.message}`);
          }
        }
      }

      console.log(`✅ Loaded ${loaded} face descriptor(s) from Google Sheets`);
    } catch (error) {
      console.error('❌ Error loading faces from Sheets:', error.message);
    }
  }

  /**
   * Save a face descriptor to the USERS Google Sheet (column I: faceDescriptor)
   * Also sets faceStatus = ENROLLED
   */
  async saveFaceToSheet(userId, descriptor, score) {
    try {
      console.log(`💾 Saving face descriptor to Sheets for user: ${userId}`);
      const users = await getSheetData('USERS');

      // Case-insensitive row search — try both column header casings
      let rowIndex = await findRowIndex('USERS', 'userid', userId);
      if (rowIndex === -1) {
        rowIndex = await findRowIndex('USERS', 'userId', userId);
      }

      if (rowIndex === -1) {
        console.error(`❌ User ${userId} not found in USERS sheet`);
        return false;
      }

      // Find user data
      const normTarget = this._normalizeKey(userId);
      const user = users.find(u => this._normalizeKey(u.userid || u.userId) === normTarget);
      if (!user) return false;

      // Write full row with updated faceDescriptor + faceStatus
      await updateRow('USERS', rowIndex, [
        user.userid || user.userId || userId,
        user.username || user.name || '',
        user.email || '',
        user.password || '',
        user.role || 'user',
        user.department || '',
        user.authorized_rooms || '',
        user.fingerprintid || user.fingerprintId || '',
        JSON.stringify(descriptor),   // Column I: faceDescriptor
        'ENROLLED',                   // Column J: faceStatus
      ]);

      console.log(`✅ Face descriptor saved to Sheets for ${userId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error saving face to Sheets for ${userId}:`, error.message);
      return false;
    }
  }

  /**
   * Clear face descriptor from USERS sheet (on delete)
   */
  async clearFaceFromSheet(userId) {
    try {
      const users = await getSheetData('USERS');

      let rowIndex = await findRowIndex('USERS', 'userid', userId);
      if (rowIndex === -1) {
        rowIndex = await findRowIndex('USERS', 'userId', userId);
      }

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

      console.log(`✅ Face descriptor cleared from Sheets for ${userId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error clearing face from Sheets:`, error.message);
      return false;
    }
  }

  // ==================== FACE DETECTION ====================

  rotateImageCanvas(img, angle) {
    if (angle === 0) {
      const cvs = createCanvas(img.width, img.height);
      const ctx = cvs.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return cvs;
    }

    const is90or270 = angle === 90 || angle === 270;
    const width = is90or270 ? img.height : img.width;
    const height = is90or270 ? img.width : img.height;

    const cvs = createCanvas(width, height);
    const ctx = cvs.getContext('2d');

    ctx.translate(width / 2, height / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);

    return cvs;
  }

  async detectFace(imageBuffer, isEnrollment = false) {
    if (!this.modelsLoaded) {
      console.log('⚠️ Models not yet loaded — initializing now...');
      await this.initialize();
    }

    try {
      if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
        throw new Error('Invalid image buffer');
      }

      // Pre-process ESP32-CAM image for consistent detection quality
      const processedBuffer = await this.preprocessImage(imageBuffer);

      console.log(`📷 Detecting face in ${processedBuffer.length} byte image (mode: ${isEnrollment ? 'ENROLLMENT-QUALITY' : 'VERIFICATION'})...`);
      const rawImg = await loadImage(processedBuffer);

      // Try 4 cardinal orientations: 0°, 180° (upside down), 90°, 270° (sideways)
      const angles = [0, 180, 90, 270];

      // For enrollment: require clean, high-confidence frame.
      // For verification: standard confidence + fallback for low-light.
      const confidenceLevels = isEnrollment ? [ENROLL_MIN_CONFIDENCE] : [VERIFY_CONFIDENCE_PRIMARY, VERIFY_CONFIDENCE_FALLBACK];

      for (const minConf of confidenceLevels) {
        const options = new faceapi.SsdMobilenetv1Options({ minConfidence: minConf });

        for (const angle of angles) {
          const cvs = this.rotateImageCanvas(rawImg, angle);

          const detection = await faceapi
            .detectSingleFace(cvs, options)
            .withFaceLandmarks()
            .withFaceDescriptor();

          if (detection) {
            console.log(`   ✅ Face detected at angle ${angle}° (conf: ${minConf}) — score: ${detection.detection.score.toFixed(4)}`);
            const dBox = detection.detection.box;
            let origBox = { x: dBox.x, y: dBox.y, width: dBox.width, height: dBox.height };

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

            // Quality Gate for Enrollment: Reject blurry, far-away, or low-scoring faces
            if (isEnrollment) {
              const dScore = detection.detection.score;
              const isTooSmall = origBox.width < ENROLL_MIN_FACE_PX || origBox.height < ENROLL_MIN_FACE_PX;
              const isLowScore = dScore < ENROLL_MIN_SCORE;

              if (isTooSmall || isLowScore) {
                console.warn(`   ⚠️ Enrollment rejected low quality frame: score=${dScore.toFixed(3)}, size=${Math.round(origBox.width)}x${Math.round(origBox.height)}`);
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
              descriptor: Array.from(detection.descriptor), // 128 floats
              landmarks: detection.landmarks,
              box: origBox,
              score: detection.detection.score,
              rotationAngle: angle,
            };
          }
        }
      }

      return {
        success: false,
        message: 'No face detected. Ensure face is clearly visible, well-lit, and centered.',
      };
    } catch (error) {
      console.error('❌ Face detection error:', error.message);
      return { success: false, message: `Face detection failed: ${error.message}` };
    }
  }

  // ==================== MULTI-SAMPLE DESCRIPTOR COMPUTATION ====================

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

    // Normalize to unit length
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

  // ==================== FACE ENROLLMENT (MULTI-SAMPLE) ====================

  async enrollFaceMultiSample(userId, imageBuffers) {
    console.log(`\n📝 ENROLLING FACE (MULTI-SAMPLE): ${userId} (${imageBuffers.length} sample(s))`);

    try {
      if (!userId || typeof userId !== 'string') {
        return { success: false, message: 'Invalid user ID' };
      }
      if (!Array.isArray(imageBuffers) || imageBuffers.length === 0) {
        return { success: false, message: 'No image buffers provided for enrollment' };
      }

      const validDescriptors = [];
      const scores = [];
      let lastAngle = 0;
      let lastBox = null;

      for (let i = 0; i < imageBuffers.length; i++) {
        console.log(`   Processing sample ${i + 1}/${imageBuffers.length}...`);
        const result = await this.detectFace(imageBuffers[i], true);
        if (result.box) lastBox = result.box;

        if (result.success) {
          validDescriptors.push(result.descriptor);
          scores.push(result.score);
          lastAngle = result.rotationAngle || 0;
        } else {
          console.warn(`   ⚠️ Sample ${i + 1} face detection rejected: ${result.message}`);
        }
      }

      if (validDescriptors.length === 0) {
        return {
          success: false,
          message: 'No clean face detected. Please ensure face is well-lit, centered, and looking directly at camera.',
          box: lastBox ? {
            x: Math.round(lastBox.x),
            y: Math.round(lastBox.y),
            w: Math.round(lastBox.w || lastBox.width),
            h: Math.round(lastBox.h || lastBox.height),
          } : null,
        };
      }

      // Compute normalized average 128-d descriptor
      const masterDescriptor = this.computeAverageDescriptor(validDescriptors);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

      // Store in memory Map with both exact and normalized keys
      const faceData = {
        rawUserId: userId,
        descriptor: masterDescriptor,
        enrolledAt: new Date().toISOString(),
        score: avgScore,
        samplesUsed: validDescriptors.length,
      };
      this.faceDatabase.set(userId, faceData);
      this.faceDatabase.set(this._normalizeKey(userId), faceData);

      // Persist to Google Sheets
      const saved = await this.saveFaceToSheet(userId, masterDescriptor, avgScore);
      if (!saved) {
        console.warn('⚠️ Face saved in memory but Sheets save failed');
      }

      console.log(`✅ Multi-sample face enrolled for ${userId} using ${validDescriptors.length}/${imageBuffers.length} samples!`);

      return {
        success: true,
        message: `Face enrolled successfully using ${validDescriptors.length} sample(s)`,
        confidence: avgScore,
        samplesUsed: validDescriptors.length,
        rotationAngle: lastAngle,
        box: lastBox ? {
          x: Math.round(lastBox.x),
          y: Math.round(lastBox.y),
          w: Math.round(lastBox.width),
          h: Math.round(lastBox.height),
        } : null,
      };
    } catch (error) {
      console.error('❌ Multi-sample enrollment error:', error.message);
      return { success: false, message: `Enrollment failed: ${error.message}` };
    }
  }

  /**
   * Single-buffer enrollment (called by /api/face/enroll when a single image is provided).
   * Delegates to multi-sample with a single buffer.
   */
  async enrollFace(userId, imageBuffer) {
    if (!imageBuffer) return { success: false, message: 'No image provided' };
    return this.enrollFaceMultiSample(userId, [imageBuffer]);
  }

  // ==================== HARDWARE FACE ENROLLMENT (SESSION-BASED) ====================

  /**
   * Enroll a face from hardware (ESP32-CAM) with multi-sample accumulation.
   *
   * The ESP32 sends multiple JPEG frames asynchronously during the enrollment window.
   * Instead of overwriting the descriptor each time (last-write-wins bug), this method:
   *   1. Creates or retrieves an enrollment session for the userId
   *   2. Detects the face and accumulates the descriptor if quality passes
   *   3. Once SAMPLES_NEEDED_FOR_ENROLLMENT good samples are collected (or a single
   *      high-quality sample with score >= HIGH_QUALITY_SINGLE_SCORE), computes the
   *      averaged descriptor and saves to Sheets
   *
   * @param {string} userId
   * @param {Buffer} imageBuffer - Single JPEG from ESP32-CAM /capture
   * @returns {Object} - { success, message, box, confidence, samplesAccepted, samplesNeeded, finalized }
   */
  async enrollFaceFromHardware(userId, imageBuffer) {
    if (!userId || typeof userId !== 'string') {
      return { success: false, message: 'Invalid user ID' };
    }
    if (!imageBuffer) {
      return { success: false, message: 'No image provided' };
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
      console.log(`\n📝 HARDWARE ENROLLMENT SESSION STARTED for ${userId}`);
    }

    session.lastFrameAt = now;

    // Detect face with enrollment-quality gating
    const result = await this.detectFace(imageBuffer, true);

    if (!result.success) {
      // Face detected but rejected quality gate, or no face at all
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

    // Good sample — accumulate
    session.descriptors.push(result.descriptor);
    session.scores.push(result.score);

    const samplesAccepted = session.descriptors.length;
    const isHighQuality = result.score >= HIGH_QUALITY_SINGLE_SCORE;
    const hasEnoughSamples = samplesAccepted >= SAMPLES_NEEDED_FOR_ENROLLMENT;

    console.log(`   📊 Sample ${samplesAccepted}/${SAMPLES_NEEDED_FOR_ENROLLMENT} accepted (score: ${result.score.toFixed(3)}, highQ: ${isHighQuality})`);

    // Check if we should finalize
    if (hasEnoughSamples || isHighQuality) {
      // Compute averaged descriptor from all good samples
      const masterDescriptor = this.computeAverageDescriptor(session.descriptors);
      const avgScore = session.scores.reduce((a, b) => a + b, 0) / session.scores.length;

      // Store in memory
      const faceData = {
        rawUserId: userId,
        descriptor: masterDescriptor,
        enrolledAt: new Date().toISOString(),
        score: avgScore,
        samplesUsed: samplesAccepted,
      };
      this.faceDatabase.set(userId, faceData);
      this.faceDatabase.set(this._normalizeKey(userId), faceData);

      // Persist to Google Sheets
      const saved = await this.saveFaceToSheet(userId, masterDescriptor, avgScore);
      if (!saved) {
        console.warn('⚠️ Face saved in memory but Sheets save failed');
      }

      // Mark session as finalized
      session.finalized = true;

      console.log(`✅ HARDWARE ENROLLMENT FINALIZED for ${userId} — ${samplesAccepted} samples, avg score: ${avgScore.toFixed(3)}`);

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

    // Not enough samples yet — report progress
    return {
      success: false,
      message: `Sample accepted (${samplesAccepted}/${SAMPLES_NEEDED_FOR_ENROLLMENT}). Keep looking at camera.`,
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

  // ==================== FACE VERIFICATION ====================

  /**
   * Look up face entry with case-insensitivity and automatic Sheets fallback
   */
  async getFaceEntry(userId) {
    if (!userId) return null;
    const normKey = this._normalizeKey(userId);

    let entry = this.faceDatabase.get(userId) || this.faceDatabase.get(normKey);

    if (!entry) {
      console.log(`⚠️ User "${userId}" not in memory cache — reloading from Sheets...`);
      await this.loadFacesFromSheet();
      entry = this.faceDatabase.get(userId) || this.faceDatabase.get(normKey);
    }

    return entry;
  }

  async verifyFace(userId, imageBuffer, threshold = VERIFY_DISTANCE_THRESHOLD) {
    console.log(`\n🔍 VERIFYING FACE: ${userId} (threshold: ${threshold})`);

    try {
      if (!userId || typeof userId !== 'string') {
        return { success: false, message: 'Invalid user ID' };
      }

      const storedFace = await this.getFaceEntry(userId);
      if (!storedFace) {
        return {
          success: false,
          message: 'No face enrolled for this user. Please enroll face first.',
        };
      }

      const result = await this.detectFace(imageBuffer);
      if (!result.success) return result;

      // Distance between stored master descriptor and current frame
      const distance = this.euclideanDistance(storedFace.descriptor, result.descriptor);
      const isMatch = distance < threshold;

      // Improved confidence formula:
      // At distance=0, confidence=1.0 (100%)
      // At distance=threshold, confidence≈0.5 (50%)
      // At distance=threshold*2, confidence=0.0 (0%)
      // This gives more intuitive numbers than the old formula.
      const confidence = Math.max(0, Math.min(1, 1 - (distance / (threshold * 2))));
      const similarityPercent = Math.max(0, Math.min(100, confidence * 100)).toFixed(1);

      console.log(`   Distance: ${distance.toFixed(4)} | Match: ${isMatch} | Confidence: ${confidence.toFixed(4)} (${similarityPercent}%) | Angle: ${result.rotationAngle}°`);

      return {
        success: isMatch,
        message: isMatch ? `Face verified successfully (${similarityPercent}% match)` : `Face does not match enrolled face (${similarityPercent}% match)`,
        confidence,
        similarityPercent: parseFloat(similarityPercent),
        distance,
        threshold,
        rotationAngle: result.rotationAngle,
        score: result.score,
        box: result.box ? {
          x: Math.round(result.box.x),
          y: Math.round(result.box.y),
          w: Math.round(result.box.width),
          h: Math.round(result.box.height),
        } : null,
      };
    } catch (error) {
      console.error('❌ Verification error:', error.message);
      return { success: false, message: `Verification failed: ${error.message}` };
    }
  }

  // ==================== UTILITIES ====================

  euclideanDistance(desc1, desc2) {
    if (!desc1 || !desc2 || desc1.length !== desc2.length) {
      throw new Error('Descriptor length mismatch');
    }
    let sum = 0;
    for (let i = 0; i < desc1.length; i++) {
      const diff = desc1[i] - desc2[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  async deleteFace(userId) {
    console.log(`🗑️ Deleting face for user: ${userId}`);
    const normKey = this._normalizeKey(userId);
    this.faceDatabase.delete(userId);
    this.faceDatabase.delete(normKey);

    // Also clean up any active enrollment session
    faceEnrollmentSessions.delete(userId);

    await this.clearFaceFromSheet(userId);
    console.log(`✅ Face deleted for ${userId}`);
    return { success: true, message: 'Face deleted successfully' };
  }

  getEnrolledCount() { return Math.floor(this.faceDatabase.size / 2); }
  isUserEnrolled(userId) {
    const normKey = this._normalizeKey(userId);
    return this.faceDatabase.has(userId) || this.faceDatabase.has(normKey);
  }
  getEnrolledUsers() {
    const set = new Set();
    for (const [key, val] of this.faceDatabase.entries()) {
      if (val && val.rawUserId) set.add(val.rawUserId);
    }
    return Array.from(set);
  }

  /**
   * Get the current face descriptor for a user (used by enrollment-complete to preserve data)
   */
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