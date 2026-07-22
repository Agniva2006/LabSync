/**
 * CLI Test Tool to test face verification directly without the ESP32 hardware.
 * Put a clear photo of yourself named "test_face.jpg" in the backend folder.
 * Run: node scripts/test_verify.js
 */

const fs = require('fs');
const path = require('path');

async function main() {
  console.log('🚀 LabSync Backend CLI - Face Verification Test\n');

  const faceImgPath = path.join(__dirname, '../test_face.jpg');
  if (!fs.existsSync(faceImgPath)) {
    console.error('❌ Error: "test_face.jpg" not found in the backend/ folder.');
    console.log('👉 Please put a photo of your face named "test_face.jpg" inside:');
    console.log(`   ${path.join(__dirname, '..')}\n`);
    process.exit(1);
  }

  const BASE_URL = 'http://localhost:5000/api';
  const USER_ID = 'USR-001'; // The user ID we are testing against

  try {
    console.log(`1. Reading test_face.jpg (${fs.statSync(faceImgPath).size} bytes)...`);
    const fileBuffer = fs.readFileSync(faceImgPath);

    console.log(`2. Sending image to ${BASE_URL}/face/verify for user ${USER_ID}...`);
    
    // We construct a raw multipart/form-data request since we are in Node without FormData built-in easily
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    let body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\n${USER_ID}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="faceImage"; filename="test_face.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const verifyRes = await fetch(`${BASE_URL}/face/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      body: body
    });

    const verifyData = await verifyRes.json();
    console.log('\n📥 Response from server:');
    console.log(JSON.stringify(verifyData, null, 2));

    if (verifyData.success) {
      console.log(`\n✅ Verification SUCCESS! Confidence: ${verifyData.confidence.toFixed(4)}`);
      if (verifyData.box) {
        console.log(`   Bounding Box Found: x=${verifyData.box.x}, y=${verifyData.box.y}, w=${verifyData.box.w}, h=${verifyData.box.h}`);
      }
    } else {
      console.log(`\n❌ Verification FAILED: ${verifyData.message}`);
    }

  } catch (err) {
    console.error('\n❌ Unexpected error:', err.message);
  }
}

main();
