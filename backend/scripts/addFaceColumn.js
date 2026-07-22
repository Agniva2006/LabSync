/**
 * One-time migration script: adds 'faceDescriptor' column to USERS sheet
 * Run: node backend/scripts/addFaceColumn.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getSheetData, updateRow } = require('../services/sheetsService');
const { google } = require('googleapis');

async function getAuthClient() {
  const fs = require('fs');
  const path = require('path');
  
  let credentials;
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch (e) {
      throw new Error('Invalid GOOGLE_CREDENTIALS environment variable');
    }
  } else {
    const filePath = path.join(__dirname, '../config/service-account.json');
    try {
      credentials = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      throw new Error('service-account.json file not found in backend/config/');
    }
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function main() {
  console.log('🔧 LabSync Sheets Migration: Adding faceDescriptor column to USERS sheet\n');

  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;

    // Read current headers (row 1)
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'USERS!A1:Z1',
    });

    const headers = (headerResponse.data.values?.[0] || []).map(h => h.toLowerCase());
    console.log('Current USERS headers:', headers);

    // Check if faceDescriptor already exists
    if (headers.includes('facedescriptor') || headers.includes('faceDescriptor')) {
      console.log('✅ faceDescriptor column already exists — no migration needed');
      process.exit(0);
    }

    // Add header row entries
    const newHeaders = [
      'userId', 'username', 'email', 'password', 'role', 'department',
      'authorized_rooms', 'fingerprintId', 'faceDescriptor', 'faceStatus'
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'USERS!A1:J1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [newHeaders],
      },
    });

    console.log('✅ USERS sheet headers updated:');
    console.log('   A: userId');
    console.log('   B: username');
    console.log('   C: email');
    console.log('   D: password');
    console.log('   E: role');
    console.log('   F: department');
    console.log('   G: authorized_rooms');
    console.log('   H: fingerprintId');
    console.log('   I: faceDescriptor  ← NEW');
    console.log('   J: faceStatus      ← NEW');
    console.log('\n✅ Migration complete! You can now enroll faces and they will persist.');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

main();
