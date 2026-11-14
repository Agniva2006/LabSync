const { getSheetData, logAccessEvent } = require('./sheetsService');
const { createNotification } = require('./notificationService');
const faceService = require('./faceService');

// In-memory store for tracking failed attempts per room
// Format: { roomId: { count: Number, firstFailTime: Number } }
const failedAttemptsMap = new Map();

const MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Check if the user is subject to Night Lockout.
 * Night Lockout applies between 22:00 (10 PM) and 06:00 (6 AM) for non-admins.
 * @param {string} userId - The user ID to check
 * @returns {Promise<{lockedOut: boolean, message?: string}>}
 */
async function checkNightLockout(userId) {
  try {
    // Lockout window is evaluated in IST (Asia/Kolkata), the deployment region.
    // Using raw server time made the policy depend on the host timezone —
    // a UTC Cloud Run box would open the lab 5.5h too early.
    const istHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }), 10);
    const currentHour = isNaN(istHour) ? new Date().getHours() : istHour;
    
    // Check if current time is between 22:00 and 06:00
    const isNightTime = currentHour >= 22 || currentHour < 6;
    
    if (!isNightTime) {
      return { lockedOut: false };
    }

    // Fetch user role from the in-memory face cache first (no Sheets round-trip
    // in the door-access hot path), falling back to a sheet read.
    const cached = faceService.faceDatabase?.get(userId) || faceService.faceDatabase?.get(String(userId).toLowerCase());
    let role = cached?.role || '';
    if (!role) {
      const users = await getSheetData('USERS');
      const user = users.find(u => u.userid === userId || u.userId === userId);
      role = user && user.role ? user.role : '';
    }
    role = String(role).toLowerCase();
    
    // Admins and Professors bypass the lockout
    if (role === 'admin' || role === 'professor') {
      return { lockedOut: false };
    }

    return { 
      lockedOut: true, 
      message: 'Night Lockout Policy Active (22:00 - 06:00). Contact admin for emergency access.' 
    };
  } catch (error) {
    // Fail CLOSED. Returning lockedOut:false here meant that any Google Sheets
    // timeout silently disabled the night policy, letting anyone walk into a
    // restricted lab between 22:00 and 06:00.
    console.error('❌ Error checking night lockout — failing CLOSED:', error.message);
    return {
      lockedOut: true,
      message: 'Access policy could not be verified. Please retry or contact the administrator.',
      reason: 'policy_lookup_failed',
    };
  }
}

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
  checkNightLockout,
  trackFailedAttempt,
  clearFailedAttempts
};
