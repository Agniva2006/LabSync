// sharedState.js
// Stores in-memory application state shared across multiple routes

const pendingCommands = new Map(); // roomId -> { command, userName, adminId, timestamp }
const deviceStatus = new Map();
const enrollmentStatus = new Map();
const pendingFaceAuth = new Map(); // roomId -> { userId, fingerId, timestamp, status }
const cameraRegistry = new Map(); // roomId -> { ip, lastSeen, status }

// ==================== MULTI-SAMPLE FACE ENROLLMENT SESSIONS ====================
// Tracks descriptors across multiple async ESP32-CAM frames during enrollment.
// Each session accumulates good descriptors until enough samples are collected,
// then computes an averaged descriptor for a robust enrolled face template.
// Format: userId -> { descriptors: Float64Array[], scores: Number[], startedAt: Number, lastFrameAt: Number, finalized: Boolean }
const faceEnrollmentSessions = new Map();

// ==================== GARBAGE COLLECTION ====================

setInterval(() => {
  const now = Date.now();

  // Clean stale pendingFaceAuth (12s matches ESP32's 10s face window + 2s grace)
  for (const [roomId, data] of pendingFaceAuth.entries()) {
    if (now - data.timestamp > 12000) {
      console.log(`🧹 GC: Removed stale pendingFaceAuth for room ${roomId}`);
      pendingFaceAuth.delete(roomId);
    }
  }

  // Clean stale face enrollment sessions (30s TTL — enrollment should complete within this)
  for (const [userId, session] of faceEnrollmentSessions.entries()) {
    if (now - session.lastFrameAt > 30000) {
      console.log(`🧹 GC: Removed stale faceEnrollmentSession for user ${userId}`);
      faceEnrollmentSessions.delete(userId);
    }
  }
}, 15000); // Check every 15 seconds

module.exports = {
  pendingCommands,
  deviceStatus,
  enrollmentStatus,
  pendingFaceAuth,
  cameraRegistry,
  faceEnrollmentSessions
};
