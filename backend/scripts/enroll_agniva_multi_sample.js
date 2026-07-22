const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getSheetData, updatePartialRow } = require('../services/sheetsService');
const faceService = require('../services/faceService');

async function enrollAgnivaMultiSample() {
  console.log('🚀 Multi-Angle High-Precision Face Enrollment for Agniva Ghosh (USR-001)...');

  try {
    const face1Path = path.join(__dirname, '../face.jpg');
    const face2Path = path.join(__dirname, '../test_face.jpg');

    const imageBuffers = [];
    if (fs.existsSync(face1Path)) {
      console.log('  📸 Loading face.jpg (', fs.statSync(face1Path).size, 'bytes)...');
      imageBuffers.push(fs.readFileSync(face1Path));
    }
    if (fs.existsSync(face2Path)) {
      console.log('  📸 Loading test_face.jpg (', fs.statSync(face2Path).size, 'bytes)...');
      imageBuffers.push(fs.readFileSync(face2Path));
    }

    if (imageBuffers.length === 0) {
      console.error('❌ No face images found.');
      process.exit(1);
    }

    console.log('📦 Initializing FaceService models...');
    await faceService.initialize();

    const userId = 'USR-001';
    const userName = 'Agniva Ghosh';
    const email = 'agnivaghosh2006@gmail.com';

    console.log(`🧠 Enrolling multi-sample face descriptors for ${userName} (${userId})...`);
    const enrollResult = await faceService.enrollFaceMultiSample(userId, imageBuffers);

    if (!enrollResult.success) {
      console.error('❌ Multi-sample enrollment failed:', enrollResult.message);
      process.exit(1);
    }

    console.log('\n✅ Multi-Sample Enrollment Successful!');
    console.log(`   Samples processed: ${enrollResult.samplesUsed}`);
    console.log(`   Average confidence score: ${(enrollResult.confidence * 100).toFixed(1)}%`);

    // Ensure fingerprintId is 1 in USERS table
    const users = await getSheetData('USERS');
    const userIndex = users.findIndex(u => (u.userId === userId || u.email === email));

    if (userIndex !== -1) {
      const sheetRowIndex = userIndex + 2;
      console.log(`📝 Updating Google Sheets USERS table at Row ${sheetRowIndex}...`);
      await updatePartialRow('USERS', sheetRowIndex, {
        username: userName,
        email: email,
        role: 'admin',
        fingerprintId: '1',
        faceStatus: 'ENROLLED',
      });
      console.log('✅ Google Sheets updated with Fingerprint ID 1 and ENROLLED status!');
    }

    console.log('\n🎉 DEMO READY FOR AGNIVA GHOSH!');
    console.log('   User ID: USR-001');
    console.log('   Name: Agniva Ghosh (ADMIN)');
    console.log('   Email: agnivaghosh2006@gmail.com');
    console.log('   Fingerprint ID: 1');
    console.log('   Face Vector: 128-d multi-angle master vector saved in Column I');

  } catch (error) {
    console.error('❌ Enrollment error:', error);
  }
}

enrollAgnivaMultiSample();
