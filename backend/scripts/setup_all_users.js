const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getSheetData, updatePartialRow } = require('../services/sheetsService');

async function setupAllUsers() {
  console.log('🚀 Setting up fingerprint IDs and authorization metadata for ALL users...\n');

  try {
    const users = await getSheetData('USERS');
    console.log(`📊 Found ${users.length} total user records in Google Sheets "USERS" table:\n`);

    let assignedFpId = 1;

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const sheetRowIndex = i + 2;

      const uId = user.userId || user.userid || `USR-00${i + 1}`;
      const uName = user.username || user.name || `User ${i + 1}`;
      const uEmail = user.email || `user${i + 1}@labsync.com`;
      const uRole = (user.role || 'user').toLowerCase() === 'admin' ? 'admin' : 'user';
      const uDept = user.department || 'Computer Science';
      const uRooms = user.authorized_rooms || user.authorizedRooms || 'ROOM 001, ROOM 002';
      
      // Determine fingerprint ID
      let fpId = user.fingerprintId || user.fingerprintid || '';
      if (!fpId || fpId.trim() === '') {
        fpId = String(assignedFpId);
      }
      assignedFpId = Math.max(assignedFpId, parseInt(fpId) + 1);

      // Determine face status
      const desc = user.faceDescriptor || user.facedescriptor || '';
      const faceStatus = (desc && desc.trim().length > 10) ? 'ENROLLED' : (user.faceStatus || user.facestatus || 'NOT_ENROLLED');

      console.log(`👤 Row ${sheetRowIndex}: [${uRole.toUpperCase()}] ${uName} (${uId})`);
      console.log(`   Email: ${uEmail} | Fingerprint Slot: #${fpId} | Face Status: ${faceStatus}`);

      await updatePartialRow('USERS', sheetRowIndex, {
        userId: uId,
        username: uName,
        email: uEmail,
        role: uRole,
        department: uDept,
        authorized_rooms: uRooms,
        fingerprintId: String(fpId),
        faceStatus: faceStatus,
      });
    }

    console.log('\n🎉 ALL USERS FULLY CONFIGURED & CONNECTED!');
    console.log('👉 Each user now has a dedicated hardware Fingerprint Slot ID (1 to 12+), Role, and Room Permissions.');

  } catch (error) {
    console.error('❌ Setup error:', error);
  }
}

setupAllUsers();
