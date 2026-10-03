/**
 * Generate a device shared secret for ESP32 HMAC authentication.
 *
 *   node scripts/generate_device_secret.js [deviceId] [roomId,roomId]
 *
 * Prints the .env lines to paste into backend/.env and the matching constants to
 * paste into the firmware (hardware/ESP32_TFT_Fingerprint_Client/Esp32.ino).
 */
const crypto = require('crypto');

const deviceId = process.argv[2] || 'ROOM-001-esp32-01';
const rooms = (process.argv[3] || 'ROOM-001').split(',').map(s => s.trim()).filter(Boolean);

const single = crypto.randomBytes(32).toString('hex');
const camera = crypto.randomBytes(32).toString('hex');

console.log('\n=========== LabSync device credentials ===========\n');
console.log(`Device ID : ${deviceId}`);
console.log(`Rooms     : ${rooms.join(', ')}\n`);

console.log('--- 1. backend/.env ---');
console.log(`DEVICE_ID=${deviceId}`);
console.log(`DEVICE_SECRET=${single}`);
console.log(`DEVICE_ROOM=${rooms.join(',')}`);
console.log('\n--- 2. firmware (Esp32.ino / Camera.ino) ---');
console.log(`const char *DEVICE_ID        = "${deviceId}";`);
console.log(`const char *DEVICE_SECRET    = "${single}";`);
console.log(`const char *CAMERA_DEVICE_ID = "${deviceId}-cam";`);
console.log(`const char *CAMERA_SECRET    = "${camera}";`);
console.log('\n--- 3. add the camera as a second credential ---');
console.log(`DEVICE_SECRETS={"${deviceId}":"${single}","${deviceId}-cam":"${camera}"}`);
console.log(`DEVICE_ROOMS={"${deviceId}":"${rooms.join(',')}","${deviceId}-cam":"${rooms.join(',')}"}`);
console.log('\nKeep these out of version control. Never commit the secrets.\n');
