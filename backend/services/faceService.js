const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');
const { Canvas, Image, ImageData, createCanvas, loadImage } = canvas;
const path = require('path');

// Monkey patch faceapi to use canvas in Node
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// Import sheets service for persistent storage
const {
  getSheetData,
  findRowIndex,
  updateRow,
} = require('./sheetsService');

class FaceRecognitionService {
  constructor() {
    this.modelsLoaded = false;
    this.faceDatabase = new Map(); // userId → { descriptor, enrolledAt, score }
    this.modelUrl = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
    console.log('🔧 FaceRecognitionService initialized (Sheets-backed persistence)');
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

  // ==================== SHEETS PERSISTENCE ====================

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
        const userId = user.userid || user.userId;
        // Column I: faceDescriptor (JSON string of 128 floats)
        const descriptorStr = user.facedescriptor || user.faceDescriptor || '';

        if (userId && descriptorStr && descriptorStr.trim() !== '') {
          try {
            const parsed = JSON.parse(descriptorStr);
            if (Array.isArray(parsed) && parsed.length === 128) {
              this.faceDatabase.set(userId, {
                descriptor: parsed,
                enrolledAt: user.faceenrolledat || user.faceEnrolledAt || new Date().toISOString(),
                score: parseFloat(user.facescore || user.faceScore || '0.9'),
              });
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
      // Don't throw — server can still run without pre-loaded faces
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

      // Find user row — try lowercase then camelCase column name
      let rowIndex = await findRowIndex('USERS', 'userid', userId);
      if (rowIndex === -1) {
        rowIndex = await findRowIndex('USERS', 'userId', userId);
      }

      if (rowIndex === -1) {
        console.error(`❌ User ${userId} not found in USERS sheet`);
        return false;
      }

      // Find user data
      const user = users.find(u => (u.userid || u.userId) === userId);
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
      if (rowIndex === -1) rowIndex = await findRowIndex('USERS', 'userId', userId);

      if (rowIndex === -1) return false;

      const user = users.find(u => (u.userid || u.userId) === userId);
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

  async detectFace(imageBuffer) {
    if (!this.modelsLoaded) {
      console.log('⚠️ Models not yet loaded — initializing now...');
      await this.initialize();
    }

    try {
      if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
        throw new Error('Invalid image buffer');
      }

      console.log(`📷 Detecting face in ${imageBuffer.length} byte image...`);
      const rawImg = await loadImage(imageBuffer);

      // Try 4 cardinal orientations: 0°, 180° (upside down), 90°, 270° (sideways)
      const angles = [0, 180, 90, 270];
      const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.25 });

      for (const angle of angles) {
        const cvs = this.rotateImageCanvas(rawImg, angle);

        const detection = await faceapi
          .detectSingleFace(cvs, options)
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (detection) {
          console.log(`   ✅ Face detected at angle ${angle}° — confidence: ${detection.detection.score.toFixed(4)}`);
          return {
            success: true,
            descriptor: Array.from(detection.descriptor), // 128 floats
            landmarks: detection.landmarks,
            box: detection.detection.box,
            score: detection.detection.score,
            rotationAngle: angle,
          };
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

  // ==================== FACE ENROLLMENT ====================

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

      for (let i = 0; i < imageBuffers.length; i++) {
        console.log(`   Processing sample ${i + 1}/${imageBuffers.length}...`);
        const result = await this.detectFace(imageBuffers[i]);
        if (result.success) {
          validDescriptors.push(result.descriptor);
          scores.push(result.score);
          lastAngle = result.rotationAngle || 0;
        } else {
          console.warn(`   ⚠️ Sample ${i + 1} face detection failed: ${result.message}`);
        }
      }

      if (validDescriptors.length === 0) {
        return {
          success: false,
          message: 'No face detected in any of the provided enrollment samples.',
        };
      }

      // Compute normalized average 128-d descriptor
      const masterDescriptor = this.computeAverageDescriptor(validDescriptors);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

      // Store in memory Map
      const faceData = {
        descriptor: masterDescriptor,
        enrolledAt: new Date().toISOString(),
        score: avgScore,
        samplesUsed: validDescriptors.length,
      };
      this.faceDatabase.set(userId, faceData);

      // Persist to Google Sheets (Column I: faceDescriptor, Column J: faceStatus)
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
      };
    } catch (error) {
      console.error('❌ Multi-sample enrollment error:', error.message);
      return { success: false, message: `Enrollment failed: ${error.message}` };
    }
  }

  async enrollFace(userId, imageBuffer) {
    if (!imageBuffer) return { success: false, message: 'No image provided' };
    return this.enrollFaceMultiSample(userId, [imageBuffer]);
  }

  // ==================== FACE VERIFICATION ====================

  async verifyFace(userId, imageBuffer, threshold = 0.6) {
    console.log(`\n🔍 VERIFYING FACE: ${userId} (threshold: ${threshold})`);

    try {
      if (!userId || typeof userId !== 'string') {
        return { success: false, message: 'Invalid user ID' };
      }

      if (!this.faceDatabase.has(userId)) {
        console.log(`⚠️ User ${userId} not in memory cache — reloading from Sheets...`);
        await this.loadFacesFromSheet();
      }

      const storedFace = this.faceDatabase.get(userId);
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
      const confidence = Math.max(0, Math.min(1, 1 - distance));
      const similarityPercent = (confidence * 100).toFixed(1);

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
    if (!this.faceDatabase.has(userId)) {
      return { success: false, message: 'No face enrolled for this user' };
    }
    this.faceDatabase.delete(userId);
    await this.clearFaceFromSheet(userId);
    console.log(`✅ Face deleted for ${userId}`);
    return { success: true, message: 'Face deleted successfully' };
  }

  getEnrolledCount() { return this.faceDatabase.size; }
  isUserEnrolled(userId) { return this.faceDatabase.has(userId); }
  getEnrolledUsers() { return Array.from(this.faceDatabase.keys()); }
}

module.exports = new FaceRecognitionService();