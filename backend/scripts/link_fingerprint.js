/**
 * One-time script: Links an existing hardware fingerprint ID to a user in Google Sheets.
 * Run: node scripts/link_fingerprint.js
 *
 * Use this when a fingerprint was already enrolled on the hardware sensor
 * but the backend database was never updated with the fingerprint ID.
 */

require('dotenv').config();
const { getSheetData, findRowIndex, updateRow } = require('../services/sheetsService');

const USER_ID     = 'USR-001';          // The user to update
const FINGER_ID   = 1;                   // The slot ID returned by the hardware

async function main() {
  console.log(`\n🔗 Linking Fingerprint ID ${FINGER_ID} → User ${USER_ID}\n`);

  // 1. Load user
  const users = await getSheetData('USERS');
  let user = users.find(u => (u.userid || u.userId) === USER_ID);
  if (!user) {
    console.error(`❌ User ${USER_ID} not found in USERS sheet. Check the userId.`);
    process.exit(1);
  }

  console.log(`✅ Found user: ${user.username || user.name} (${user.email})`);
  console.log(`   Current fingerprintId: "${user.fingerprintid || user.fingerprintId || 'none'}"`);

  // 2. Find row index
  let rowIndex = await findRowIndex('USERS', 'userid', USER_ID);
  if (rowIndex === -1) rowIndex = await findRowIndex('USERS', 'userId', USER_ID);
  if (rowIndex === -1) {
    console.error('❌ Could not locate row in sheet. Aborting.');
    process.exit(1);
  }

  // 3. Update only the fingerprintId column — preserve all other fields
  await updateRow('USERS', rowIndex, [
    user.userid   || user.userId   || '',
    user.username || user.name     || '',
    user.email                     || '',
    user.password                  || '',
    user.role                      || 'user',
    user.department                || '',
    user.authorized_rooms          || '',
    FINGER_ID.toString(),                                          // ← fingerprintId
    user.facedescriptor || user.faceDescriptor || '',              // preserve face
    user.facestatus     || user.faceStatus     || 'NOT_ENROLLED',  // preserve face status
  ]);

  console.log(`\n🎉 Done! fingerprintId = ${FINGER_ID} saved for ${USER_ID}`);
  console.log('👉 Now place your finger on the sensor — the ESP32 will find the match!\n');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
