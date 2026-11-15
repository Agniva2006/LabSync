const { logAccessEvent } = require('./sheetsService');
const { createNotification } = require('./notificationService');

// In-memory store for tracking failed attempts per room
// Format: { roomId: { count: Number, firstFailTime: Number } }
const failedAttemptsMap = new Map();

const MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Track a failed authentication attempt for a room.
 * If failures exceed MAX_FAILURES within FAILURE_WINDOW_MS, trigger an IDS alert.
 * @param {string} roomId 
 * @param {string} authMethod (FACE or FINGERPRINT)
 */
async function trackFailedAttempt(roomId, authMethod) {
  if (!roomId) return;

  const now = Date.now();
  let record = failedAttemptsMap.get(roomId);

  if (!record) {
    record = { count: 1, firstFailTime: now };
  } else {
    // If the window has expired, reset
    if (now - record.firstFailTime > FAILURE_WINDOW_MS) {
      record = { count: 1, firstFailTime: now };
    } else {
      record.count += 1;
    }
  }

  failedAttemptsMap.set(roomId, record);

  console.log(`⚠️ IDS tracking: Room ${roomId} has ${record.count} failed attempts.`);

  if (record.count >= MAX_FAILURES) {
    console.log(`🚨 INTRUSION ALERT TRIGGERED FOR ROOM ${roomId}!`);
    
    // 1. Log to sheets
    await logAccessEvent({
      action: 'INTRUSION_ALERT',
      authMethod: authMethod,
      status: 'CRITICAL',
      userId: 'UNKNOWN',
      roomId: roomId,
      details: `Multiple failed authentications (${record.count} in 2 mins). Possible brute force.`
    });

    // 2. Notify Admin
    await createNotification(
      'ADMIN', 
      '🚨 INTRUSION ALERT',
      `Multiple failed ${authMethod} attempts detected at Room ${roomId}. Please investigate immediately.`,
      'error'
    );

    // Reset after trigger so we don't spam
    failedAttemptsMap.delete(roomId);
  }
}

/**
 * Clear failed attempts if a successful auth happens
 * @param {string} roomId 
 */
function clearFailedAttempts(roomId) {
  if (roomId && failedAttemptsMap.has(roomId)) {
    failedAttemptsMap.delete(roomId);
  }
}

module.exports = {
  trackFailedAttempt,
  clearFailedAttempts
};
