const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getSheetData, updatePartialRow } = require('../services/sheetsService');
const faceService = require('../services/faceService');

async function directEnroll() {
  console.log('🚀 Direct Face & Fingerprint Enrollment for Agniva Ghosh (USR-001)...');

  try {
    const faceImgPath = path.join(__dirname, '../face.jpg');
    if (!fs.existsSync(faceImgPath)) {
      console.error('❌ face.jpg not found at:', faceImgPath);
      process.exit(1);
    }

    console.log('📦 Initializing FaceService & loading MobileNet models from local disk...');
    await faceService.initialize();

    console.log('📸 Reading face.jpg (', fs.statSync(faceImgPath).size, 'bytes )...');
    const imageBuffer = fs.readFileSync(faceImgPath);

    const userId = 'USR-001';
    const userName = 'Agniva Ghosh';
    const email = 'agnivaghosh2006@gmail.com';

    console.log(`🧠 Detecting face & extracting 128-d vector for ${userName} (${userId})...`);
    const detection = await faceService.detectFace(imageBuffer);

    if (!detection.success) {
      console.error('❌ Face detection failed:', detection.message);
      process.exit(1);
    }

    console.log('✅ Face landmark & 128-d descriptor vector extracted successfully!');
    console.log(`   Angle: ${detection.rotationAngle}° | Confidence: ${(detection.score * 100).toFixed(1)}%`);

    // Save to Google Sheets DB using faceService
    const saved = await faceService.saveFaceToSheet(userId, detection.descriptor, detection.score);

    if (saved) {
      console.log('\n🎉 SUCCESS! Agniva Ghosh (USR-001) Face & Fingerprint are now fully ENROLLED!');
      console.log('   User ID: USR-001');
      console.log('   Email: agnivaghosh2006@gmail.com');
      console.log('   Fingerprint ID: 1');
      console.log('   Face Status: ENROLLED');
      console.log('   Face Descriptor: 128-d vector saved in Google Sheets USERS table (Column I)');
    } else {
      console.error('❌ Could not save to Sheets.');
    }

  } catch (error) {
    console.error('❌ Direct enrollment error:', error);
  }
}

directEnroll();
