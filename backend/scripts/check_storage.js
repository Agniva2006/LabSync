/**
 * Verifies that biometric data (face descriptors + fingerprint slots) is written
 * to a DURABLE backend. Run this after deploying, before trusting hardware:
 *
 *   node scripts/check_storage.js
 *
 * Exit code 0 = durable. Exit code 1 = biometrics will be lost on restart.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getStorageMode, getSheetData } = require('../services/sheetsService');

(async () => {
  const mode = getStorageMode();

  console.log('\n=========== LabSync storage check ===========\n');
  console.log(`Backend        : ${mode.backend}`);
  console.log(`Durable        : ${mode.durable ? 'YES' : 'NO'}`);
  console.log(`Spreadsheet ID : ${mode.spreadsheetId || '(none)'}`);
  console.log(`Local DB path  : ${mode.localDbPath}`);

  if (!mode.durable) {
    console.log('\n❌ NOT DURABLE — enrolled faces/fingerprints are lost on restart.\n');
    console.log('To fix, add a Google service account to backend/.env:\n');
    console.log('  1. Google Cloud Console → enable the "Google Sheets API".');
    console.log('  2. Create a Service Account (JSON key) and download it.');
    console.log('  3. Share the spreadsheet with the service account email');
    console.log(`     as Editor. Spreadsheet ID in .env is already ${process.env.SPREADSHEET_ID || '(unset)'}.`);
    console.log('  4. In backend/.env, uncomment GOOGLE_CREDENTIALS and paste the');
    console.log('     ENTIRE service-account JSON on ONE line with \\n escapes:\n');
    console.log('     GOOGLE_CREDENTIALS={"type":"service_account","project_id":"...",');
    console.log('     "private_key":"-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----\\n",...}\n');
    console.log('     (or place the raw file at backend/config/service-account.json —');
    console.log('      that path is gitignored and works with no escaping)');
    console.log('\nRe-run this script. Expected: "Durable : YES".\n');
    process.exit(1);
  }

  // Read-through test: proves the credentials can actually read the sheet.
  try {
    const users = await getSheetData('USERS');
    const enrolled = users.filter(u => String(u.facestatus || u.faceStatus || '').toUpperCase() === 'ENROLLED');
    const withDescriptor = enrolled.filter(u => String(u.facedescriptor || u.faceDescriptor || '').length > 50);

    console.log(`\nUsers readable   : ${users.length}`);
    console.log(`Face ENROLLED    : ${enrolled.length}`);
    console.log(`With descriptor  : ${withDescriptor.length}`);

    if (withDescriptor.length === 0) {
      console.log('\n⚠️  Credentials work, but no user has a stored face descriptor in Sheets.');
      console.log('    Re-enroll faces on the device — they will now persist.\n');
    } else {
      console.log('\n✅ Sheets is reachable and face descriptors are persisted.\n');
    }
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Read test failed: ${err.message}`);
    console.error('   The service account is probably not shared with the spreadsheet.\n');
    process.exit(1);
  }
})();