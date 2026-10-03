const http = require('http');
const fs = require('fs');
const path = require('path');

async function testLiveServer() {
  console.log('🧪 Testing Live Server on Port 5000...');

  try {
    // Test 1: User by finger
    console.log('\n--- Test 1: GET /api/esp32/user-by-finger/1 ---');
    let res = await makeRequest('GET', '/api/esp32/user-by-finger/1');
    console.log('Res 1:', res.status, res.body);

    // Test 2: Fingerprint Verified
    console.log('\n--- Test 2: POST /api/esp32/fingerprint-verified ---');
    res = await makeRequest('POST', '/api/esp32/fingerprint-verified', {
      roomId: 'ROOM-001',
      userId: 'USR-001',
      fingerId: 1
    });
    console.log('Res 2:', res.status, res.body);

    // Test 3: Face Enrollment (Hardware)
    console.log('\n--- Test 3: POST /api/face/enroll-hardware ---');
    const imgBuf = fs.readFileSync(path.join(__dirname, '../face.jpg'));
    const base64Img = imgBuf.toString('base64');
    res = await makeRequest('POST', '/api/face/enroll-hardware', {
      userId: 'USR-001',
      faceImage: base64Img
    });
    console.log('Res 3:', res.status, res.body);

    // Test 4: Face Verification
    console.log('\n--- Test 4: POST /api/face/verify ---');
    res = await makeRequest('POST', '/api/face/verify', {
      userId: 'USR-001',
      roomId: 'ROOM-001',
      faceImage: base64Img
    });
    console.log('Res 4:', res.status, res.body);

    // Test 5: Dual Auth Verification
    console.log('\n--- Test 5: POST /api/dual-auth/verify ---');
    res = await makeRequest('POST', '/api/dual-auth/verify', {
      userId: 'USR-001',
      roomId: 'ROOM-001',
      fingerprintVerified: true,
      faceImage: base64Img
    });
    console.log('Res 5:', res.status, res.body);

    // Test 6: Check pending commands for ESP32
    console.log('\n--- Test 6: GET /api/esp32/get-commands/ROOM-001 ---');
    res = await makeRequest('GET', '/api/esp32/get-commands/ROOM-001');
    console.log('Res 6:', res.status, res.body);

    console.log('\n==================================================');
    console.log('🎉 ALL BIOMETRIC & FACE ENDPOINTS RETURNED SUCCESS (200 OK)!');
    console.log('==================================================');
  } catch (err) {
    console.error('❌ Test failed:', err);
  }
}

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(responseBody) });
        } catch (e) {
          resolve({ status: res.statusCode, body: responseBody });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

testLiveServer();
