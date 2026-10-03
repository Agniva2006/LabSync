// sharedState.js
// Stores in-memory application state shared across multiple routes.
//
// Every map here is unbounded unless a TTL is enforced, so the GC below is what
// keeps a long-running process from leaking memory on a headless lab terminal
// that polls every 3 seconds, forever.

const pendingCommands = new Map();    // roomId -> { commandId, command, userName, adminId, timestamp }
const deviceStatus = new Map();       // deviceId -> { roomId, rssi, freeHeap, uptime, lastSeen }
const enrollmentStatus = new Map();   // userId -> { completed, fingerprintId, faceEnrolled, ... }
const pendingFaceAuth = new Map();    // roomId -> { userId, fingerId, timestamp, status }
const cameraRegistry = new Map();     // roomId -> { ip, lastSeen }
const heartbeatCounters = new Map();  // deviceId -> Number

// ==================== MULTI-SAMPLE FACE ENROLLMENT SESSIONS ====================
// Tracks descriptors across multiple ESP32-CAM frames during enrollment. Frames
// that disagree with the ones already accepted are rejected, so the session
// accumulates a tight set of consistent captures to average into a template.
// Format: userId -> { descriptors: Number[][], scores: Number[], rejectedCount,
//                     consistency, startedAt, lastFrameAt, finalized }
const faceEnrollmentSessions = new Map();

// ==================== TTL POLICY ====================

const TTL = {
  // Face window: ESP32 allows 30s for the face step + 15s grace before giving up.
  pendingFaceAuth: parseInt(process.env.TTL_PENDING_FACE_AUTH_MS || '90000', 10),
  // Enrollment collects several frames; allow a full attempt before discarding.
  faceEnrollmentSession: parseInt(process.env.TTL_ENROLL_SESSION_MS || '120000', 10),
  // An unacknowledged command is retried on each poll until this expires.
  pendingCommand: parseInt(process.env.TTL_PENDING_COMMAND_MS || '120000', 10),
  // A device that has not heartbeated (30s interval) for 3 minutes is gone.
  deviceStatus: parseInt(process.env.TTL_DEVICE_STATUS_MS || '180000', 10),
  cameraRegistry: parseInt(process.env.TTL_CAMERA_REGISTRY_MS || '900000', 10),
  enrollmentStatus: parseInt(process.env.TTL_ENROLLMENT_STATUS_MS || '3600000', 10),
};

const GC_INTERVAL_MS = parseInt(process.env.GC_INTERVAL_MS || '30000', 10);

function age(entry, field, now) {
  const value = entry && entry[field];
  if (!value) return Infinity;
  const t = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(t) ? now - t : Infinity;
}

function sweep(map, ttlMs, field, now, label) {
  let removed = 0;
  for (const [key, value] of map.entries()) {
    if (age(value, field, now) > ttlMs) {
      map.delete(key);
      removed++;
    }
  }
  if (removed > 0) console.log(`🧹 [GC] ${label}: dropped ${removed} stale entr${removed === 1 ? 'y' : 'ies'}`);
  return removed;
}

// ==================== GARBAGE COLLECTION ====================

const gcTimer = setInterval(() => {
  const now = Date.now();

  sweep(pendingFaceAuth, TTL.pendingFaceAuth, 'timestamp', now, 'pendingFaceAuth');
  sweep(faceEnrollmentSessions, TTL.faceEnrollmentSession, 'lastFrameAt', now, 'faceEnrollmentSessions');
  sweep(pendingCommands, TTL.pendingCommand, 'timestamp', now, 'pendingCommands');
  sweep(deviceStatus, TTL.deviceStatus, 'lastSeen', now, 'deviceStatus');
  sweep(cameraRegistry, TTL.cameraRegistry, 'lastSeen', now, 'cameraRegistry');
  sweep(enrollmentStatus, TTL.enrollmentStatus, 'enrolledAt', now, 'enrollmentStatus');

  // Heartbeat counters only matter while a device is alive.
  if (deviceStatus.size > 200) {
    heartbeatCounters.clear();
  }
}, GC_INTERVAL_MS);

// Do not hold the event loop open purely for the GC timer.
gcTimer.unref?.();

/** Total in-memory state size, for the diagnostics endpoint. */
function stateSize() {
  return {
    pendingCommands: pendingCommands.size,
    pendingFaceAuth: pendingFaceAuth.size,
    deviceStatus: deviceStatus.size,
    enrollmentStatus: enrollmentStatus.size,
    cameraRegistry: cameraRegistry.size,
    faceEnrollmentSessions: faceEnrollmentSessions.size,
    ttlPolicy: TTL,
  };
}

module.exports = {
  pendingCommands,
  deviceStatus,
  enrollmentStatus,
  pendingFaceAuth,
  cameraRegistry,
  faceEnrollmentSessions,
  heartbeatCounters,
  stateSize,
  TTL,
};