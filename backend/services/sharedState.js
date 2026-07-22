// sharedState.js
// Stores in-memory application state shared across multiple routes

const pendingCommands = new Map(); // roomId -> { command, userName, adminId, timestamp }
const deviceStatus = new Map();
const enrollmentStatus = new Map();
const pendingFaceAuth = new Map(); // roomId -> { userId, fingerId, timestamp, status }

// ==================== GARBAGE COLLECTION ====================
// Prevent memory leaks by cleaning up pending face auths older than 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [roomId, data] of pendingFaceAuth.entries()) {
    if (now - data.timestamp > 60000) { // 60 seconds TTL
      console.log(`🧹 Garbage Collector: Removed stale pendingFaceAuth for room ${roomId}`);
      pendingFaceAuth.delete(roomId);
    }
  }
}, 30000); // Check every 30 seconds

module.exports = {
  pendingCommands,
  deviceStatus,
  enrollmentStatus,
  pendingFaceAuth
};
