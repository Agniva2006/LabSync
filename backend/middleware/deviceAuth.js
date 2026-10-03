const crypto = require('crypto');

/**
 * Device + service authentication.
 *
 * The ESP32 endpoints previously accepted any request that reached them, which
 * meant anyone could POST {command:"face_unlock"} and open a door, enroll a face
 * for an arbitrary userId, or wipe the biometric database.
 *
 * The ESP32 cannot carry a JWT, but it can compute an HMAC-SHA256 over a shared
 * secret. This middleware therefore verifies a per-request signature:
 *
 *   X-Device-Id     identifies the device (must be a configured device)
 *   X-Device-Ts     unix milliseconds
 *   X-Device-Nonce  random hex, unique per request
 *   X-Device-Sig    hex HMAC-SHA256(secret, `${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`)
 *
 * The timestamp window plus nonce replay cache stop a captured request from
 * being replayed to open a door twice.
 */

const REPLAY_WINDOW_MS = parseInt(process.env.DEVICE_SIG_WINDOW_MS || '120000', 10);
const MAX_NONCE_ENTRIES = 5000;

// deviceId -> { secret, rooms: [roomId], enabled }
const devices = new Map();
let loaded = false;

/**
 * Devices are configured via DEVICE_SECRETS env var:
 *   DEVICE_SECRETS='{"ROOM-001-esp32-01":"<hex>","ROOM-002-esp32-01":"<hex>"}'
 * DEVICE_ROOMS binds ids to rooms. A single DEVICE_SECRET covers the simple
 * single-door case.
 */
function loadDevices() {
  if (loaded) return devices;
  loaded = true;

  try {
    if (process.env.DEVICE_SECRETS) {
      const parsed = JSON.parse(process.env.DEVICE_SECRETS);
      const rooms = JSON.parse(process.env.DEVICE_ROOMS || '{}');
      for (const [id, secret] of Object.entries(parsed)) {
        devices.set(id, {
          id,
          secret: String(secret),
          rooms: Array.isArray(rooms[id]) ? rooms[id] : (rooms[id] ? [rooms[id]] : []),
          enabled: true,
          lastSeen: null,
        });
      }
      console.log(`🔐 [DEVICE-AUTH] Loaded ${devices.size} device credential(s) from DEVICE_SECRETS`);
    } else if (process.env.DEVICE_SECRET) {
      const id = process.env.DEVICE_ID || 'esp32-01';
      devices.set(id, {
        id,
        secret: process.env.DEVICE_SECRET,
        rooms: (process.env.DEVICE_ROOM || 'ROOM-001').split(',').map(s => s.trim()).filter(Boolean),
        enabled: true,
        lastSeen: null,
      });
      console.log(`🔐 [DEVICE-AUTH] Loaded 1 device credential ('${id}') from DEVICE_SECRET`);
    } else {
      console.warn('⚠️  [DEVICE-AUTH] No DEVICE_SECRET / DEVICE_SECRETS configured — hardware endpoints will reject all requests.');
      console.warn('⚠️  [DEVICE-AUTH] Run: node scripts/generate_device_secret.js');
    }
  } catch (e) {
    console.error(`❌ [DEVICE-AUTH] Failed to load device credentials: ${e.message}`);
  }
  return devices;
}

function isConfigured() {
  loadDevices();
  return devices.size > 0;
}

function computeSignature(secret, method, path, ts, nonce, body) {
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const canonical = `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

/** Constant-time compare that tolerates length mismatch without throwing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Replay cache: `${deviceId}:${nonce}` -> expiry
const seenNonces = new Map();

function pruneNonces(now) {
  for (const [key, expiry] of seenNonces) {
    if (expiry <= now) seenNonces.delete(key);
  }
  if (seenNonces.size > MAX_NONCE_ENTRIES) {
    const keys = Array.from(seenNonces.keys()).slice(0, seenNonces.size - MAX_NONCE_ENTRIES);
    keys.forEach(k => seenNonces.delete(k));
  }
}

/**
 * Capture the raw body for HMAC verification.
 *
 * This must NOT be done by attaching 'data'/'next' listeners to the request
 * stream: that starts flowing mode and races 'end', which in Express 4 leaves
 * body-parser waiting forever and the request hangs.
 *
 * The supported hook is body-parser's `verify` callback, which receives the
 * exact bytes that were parsed. Server.js passes this to express.json().
 *
 * Multipart uploads are deliberately excluded: hashing a multi-megabyte JPEG on
 * a microcontroller is impractical, so those routes use requireDeviceAuth
 * (identity + freshness) instead of a full body signature.
 */
function captureRawBody(rawBuffer) {
  if (rawBuffer === undefined || rawBuffer === null) {
    return undefined;
  }
  return Buffer.isBuffer(rawBuffer) ? rawBuffer.toString('utf8') : String(rawBuffer);
}

/** Verify a full device signature. Attaches req.device. */
function verifyDeviceSignature(req, res, next) {
  loadDevices();

  if (devices.size === 0) {
    console.error('❌ [DEVICE-AUTH] Rejected request: no device credentials configured');
    return res.status(503).json({
      success: false,
      error: 'device_auth_not_configured',
      message: 'Device authentication is not configured on this server.',
    });
  }

  const deviceId = req.headers['x-device-id'];
  const ts = req.headers['x-device-ts'];
  const nonce = req.headers['x-device-nonce'];
  const sig = req.headers['x-device-sig'];

  if (!deviceId || !ts || !nonce || !sig) {
    return res.status(401).json({
      success: false,
      error: 'device_auth_missing',
      message: 'Missing device authentication headers (X-Device-Id, X-Device-Ts, X-Device-Nonce, X-Device-Sig).',
    });
  }

  const device = devices.get(String(deviceId));
  if (!device || !device.enabled) {
    console.warn(`⚠️  [DEVICE-AUTH] Unknown device id "${deviceId}"`);
    return res.status(401).json({ success: false, error: 'unknown_device', message: 'Unknown device.' });
  }

  const now = Date.now();
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > REPLAY_WINDOW_MS) {
    console.warn(`⚠️  [DEVICE-AUTH] Stale timestamp from ${deviceId} (${ts})`);
    return res.status(401).json({ success: false, error: 'stale_request', message: 'Request timestamp outside allowed window.' });
  }

  pruneNonces(now);
  const nonceKey = `${deviceId}:${nonce}`;
  if (seenNonces.has(nonceKey)) {
    console.warn(`🚨 [DEVICE-AUTH] Replay detected from ${deviceId} (nonce ${nonce})`);
    return res.status(401).json({ success: false, error: 'replay_detected', message: 'Duplicate request nonce.' });
  }

  const expected = computeSignature(device.secret, req.method, req.originalUrl || req.url, ts, nonce, req.rawBody);
  if (!safeEqual(expected, sig)) {
    console.warn(`🚨 [DEVICE-AUTH] Bad signature from ${deviceId} for ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ success: false, error: 'invalid_signature', message: 'Invalid device signature.' });
  }

  seenNonces.set(nonceKey, now + REPLAY_WINDOW_MS);
  device.lastSeen = new Date(now).toISOString();
  req.device = device;
  next();
}

/**
 * For multipart routes (JPEG uploads) where hashing the body on-device is not
 * practical: require a valid device id and a fresh timestamp. Stronger than the
 * status quo, weaker than a full body signature.
 */
function requireDeviceAuth(req, res, next) {
  loadDevices();

  if (devices.size === 0) {
    return res.status(503).json({
      success: false,
      error: 'device_auth_not_configured',
      message: 'Device authentication is not configured on this server.',
    });
  }

  const deviceId = req.headers['x-device-id'];
  const ts = req.headers['x-device-ts'];

  if (!deviceId || !ts) {
    return res.status(401).json({
      success: false,
      error: 'device_auth_missing',
      message: 'Missing device authentication headers (X-Device-Id, X-Device-Ts).',
    });
  }

  const device = devices.get(String(deviceId));
  if (!device || !device.enabled) {
    return res.status(401).json({ success: false, error: 'unknown_device', message: 'Unknown device.' });
  }

  const now = Date.now();
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > REPLAY_WINDOW_MS) {
    return res.status(401).json({ success: false, error: 'stale_request', message: 'Request timestamp outside allowed window.' });
  }

  device.lastSeen = new Date(now).toISOString();
  req.device = device;
  next();
}

/** Ensure the authenticated device is allowed to act on this room. */
function requireRoomAccess(roomId) {
  return (req, res, next) => {
    const device = req.device;
    if (!device) {
      return res.status(401).json({ success: false, error: 'device_auth_missing', message: 'Device not authenticated.' });
    }
    if (device.rooms.length > 0 && roomId && !device.rooms.includes(String(roomId))) {
      console.warn(`🚨 [DEVICE-AUTH] Device ${device.id} (rooms: ${device.rooms}) attempted to act on room ${roomId}`);
      return res.status(403).json({ success: false, error: 'room_not_authorized', message: 'Device is not registered for this room.' });
    }
    next();
  };
}

function listDevices() {
  loadDevices();
  return Array.from(devices.values()).map(d => ({
    id: d.id,
    rooms: d.rooms,
    enabled: d.enabled,
    lastSeen: d.lastSeen,
  }));
}

module.exports = {
  captureRawBody,
  verifyDeviceSignature,
  requireDeviceAuth,
  requireRoomAccess,
  isConfigured,
  computeSignature,
  listDevices,
  REPLAY_WINDOW_MS,
};