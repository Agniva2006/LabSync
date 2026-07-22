/**
 * CLI Test Tool to enroll face and fingerprint without using the Flutter app.
 * Run: node scripts/test_enroll.js
 */
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('🚀 LabSync Backend CLI Test Tool\n');

  const faceImgPath = path.join(__dirname, '../face.jpg');
  if (!fs.existsSync(faceImgPath)) {
    console.error('❌ Error: face.jpg not found in the backend/ folder.');
    console.log('👉 Please take a photo of your face, rename it to "face.jpg", and save it inside:');
    console.log(`   ${path.join(__dirname, '..')}\n`);
    process.exit(1);
  }

  const BASE_URL = 'http://localhost:5000/api';

  try {
    // We will use your existing user in Google Sheets (Agniva Ghosh, agnivaghosh2006@gmail.com)
    // The password is 'user123' (which our backend will automatically upgrade to a bcrypt hash)
    const email = 'agnivaghosh2006@gmail.com';
    const password = 'password2006';

    console.log(`1. Logging in as existing user: ${email}...`);
    let loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    let loginData = await loginRes.json();

    // If login fails (maybe because user isn't there or password differs), let's register the user instead
    if (!loginData.success) {
      console.log('⚠️ Login failed. Attempting to register the user instead...');
      const regRes = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Agniva Ghosh',
          email: email,
          password: 'password2006', // use password2006 for new user
          department: 'Computer Science'
        })
      });
      const regData = await regRes.json();
      console.log('   Registration response:', regData.message || regData);

      // Now log in with the new password
      console.log('   Logging in with new account...');
      loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password2006' })
      });
      loginData = await loginRes.json();
    }

    if (!loginData.success) {
      throw new Error(loginData.message || 'Login failed completely');
    }

    const token = loginData.token;
    const userId = loginData.user.userId || loginData.user.id;
    console.log('✅ Login Success! Token retrieved.');
    console.log(`   User ID: ${userId}`);

    // 2. Upload face image
    console.log('\n2. Uploading face.jpg to enroll face...');
    const imgBuffer = fs.readFileSync(faceImgPath);
    const blob = new Blob([imgBuffer], { type: 'image/jpeg' });

    const form = new FormData();
    form.append('userId', userId);
    form.append('userName', 'Agniva Ghosh');
    form.append('faceImage', blob, 'face.jpg');

    const uploadRes = await fetch(`${BASE_URL}/face/enroll`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: form
    });
    const uploadData = await uploadRes.json();
    console.log('   Face Enrollment Response:', uploadData);

    // 3. Trigger Fingerprint Enrollment
    console.log('\n3. Sending fingerprint enrollment command to ESP32...');
    const enrollRes = await fetch(`${BASE_URL}/door-control/start-enrollment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        roomId: 'ROOM-001',
        userId: userId,
        userName: 'Agniva Ghosh'
      })
    });
    const enrollData = await enrollRes.json();
    console.log('   Fingerprint command queued:', enrollData);

    console.log('\n🎉 ALL DONE!');
    console.log('👉 Now look at your ESP32 TFT screen. It should show the Fingerprint Scan prompt.');
    console.log('👉 After scanning your finger twice, place your finger on the sensor to trigger face recognition!');

  } catch (error) {
    console.error('\n❌ Execution failed:', error.message);
  }
}

main();
