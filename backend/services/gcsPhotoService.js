/**
 * Google Cloud Storage photo archive.
 *
 * Stores the raw JPEG captured during face ENROLLMENT and VERIFICATION so an
 * admin can later re-analyse the photo that produced a given descriptor /
 * fingerprint ID. Filenames carry userId, fingerprintId, descriptor hash and a
 * timestamp, making every archive object self-describing:
 *
 *   labsync-faces/<userId>/enroll-<fingerprintId>-<ts>-<descriptorHash>.jpg
 *   labsync-faces/<userId>/verify-<match|miss>-<ts>-<descriptorHash>.jpg
 *
 * Credentials come from the same source as Google Sheets:
 *   - GOOGLE_CREDENTIALS env var (JSON string), or
 *   - backend/config/service-account.json
 * An optional GCS_BUCKET env var picks the bucket (default: labsync-faces).
 *
 * Archiving is strictly best-effort: a storage failure must NEVER fail or slow
 * an access-control decision, so every call logs and swallows its errors.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

let storageClient = null;
let bucketName = process.env.GCS_BUCKET || 'labsync-faces';

try {
  let credentials = null;

  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch (e) {
      console.warn('⚠️ [GCS-INIT] Failed to parse GOOGLE_CREDENTIALS json:', e.message);
    }
  }

  if (!credentials) {
    const filePath = path.join(__dirname, '../config/service-account.json');
    if (fs.existsSync(filePath)) {
      try {
        credentials = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        console.warn(`⚠️ [GCS-INIT] Failed to parse ${filePath}:`, e.message);
      }
    }
  }

  if (credentials) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
    });
    storageClient = google.storage({ version: 'v1', auth });
    console.log(`🌐 [GCS-INIT] Google Cloud Storage client initialized (bucket: ${bucketName})`);
  } else {
    console.warn('ℹ️ [GCS-INIT] No Google credentials — enrollment photos will NOT be archived to GCS.');
  }
} catch (initError) {
  console.error(`❌ [GCS-INIT] Initialization error: ${initError.message}`);
}

function isConfigured() {
  return !!storageClient;
}

/** Short deterministic fingerprint of a descriptor, for traceable filenames. */
function descriptorHash(descriptor) {
  try {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(descriptor))
      .digest('hex')
      .slice(0, 12);
  } catch (e) {
    return 'nohash';
  }
}

/** Only sanitize the userId portion used in object paths. */
function safeId(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

/**
 * Upload a face JPEG to the archive bucket.
 *
 * @param {object} opts
 * @param {Buffer}  opts.buffer        Raw JPEG bytes
 * @param {string}  opts.userId        Owner of the biometric template
 * @param {string}  opts.kind          'enroll' | 'verify'
 * @param {string}  [opts.fingerprintId] Sensor slot linked to this user
 * @param {Array}   [opts.descriptor]  128-d descriptor captured/compared
 * @param {boolean} [opts.matched]     Verification outcome (for verify photos)
 * @param {object}  [opts.meta]        Extra metadata stored on the object
 * @returns {Promise<{archived: boolean, gsUri?: string, error?: string}>}
 */
async function archiveFaceImage({ buffer, userId, kind = 'enroll', fingerprintId = '', descriptor = null, matched = null, meta = {} }) {
  if (!storageClient) {
    return { archived: false, error: 'GCS not configured' };
  }
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { archived: false, error: 'No image buffer' };
  }

  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    const segments = [
      'labsync-faces',
      safeId(userId),
      `${kind}${matched !== null && matched !== undefined ? (matched ? '-match' : '-miss') : ''}`,
      `${fingerprintId ? `fp${safeId(fingerprintId)}-` : ''}${descriptor ? descriptorHash(descriptor) + '-' : ''}${ts}.jpg`,
    ];
    const objectName = segments.join('/');

    await storageClient.objects.insert({
      bucket: bucketName,
      uploadType: 'media',
      name: objectName,
      media: { mimeType: 'image/jpeg', body: buffer },
    });

    const gsUri = `gs://${bucketName}/${objectName}`;
    console.log(`☁️ [GCS-ARCHIVE] Stored ${kind} photo → ${gsUri} (${buffer.length} bytes)`);

    // Best-effort metadata write via patch (labels are limited; keep it simple).
    if (meta && Object.keys(meta).length > 0) {
      try {
        await storageClient.objects.update({
          bucket: bucketName,
          object: objectName,
          requestBody: {
            metadata: Object.fromEntries(
              Object.entries(meta).map(([k, v]) => [k, String(v).slice(0, 256)])
            ),
          },
        });
      } catch (metaErr) {
        console.warn(`⚠️ [GCS-ARCHIVE] Metadata patch skipped: ${metaErr.message}`);
      }
    }

    return { archived: true, gsUri };
  } catch (err) {
    console.error(`❌ [GCS-ARCHIVE] Failed to archive ${kind} photo for ${userId}: ${err.message}`);
    return { archived: false, error: err.message };
  }
}

module.exports = {
  isConfigured,
  archiveFaceImage,
  descriptorHash,
  bucketName: () => bucketName,
};
