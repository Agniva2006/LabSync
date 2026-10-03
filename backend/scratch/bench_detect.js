const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const t0 = Date.now();
const faceService = require('../services/faceService');

const IMG = process.argv[2] || path.join(__dirname, '../face.jpg');

(async () => {
  console.log('=== BENCH START ===');
  const tLoad = Date.now();
  await faceService.initialize();
  console.log(`model load + DB load: ${Date.now() - tLoad}ms`);

  const buf = fs.readFileSync(IMG);
  console.log(`image: ${IMG} (${buf.length} bytes)`);

  // Worst case: no face detected -> full 4 angles x up to 3 detector passes
  const t1 = Date.now();
  const r1 = await faceService.detectFace(buf, false);
  console.log(`detectFace(no-face worst case) => success=${r1.success} msg="${r1.message}" in ${Date.now() - t1}ms`);

  // Enrollment-mode worst case
  const t2 = Date.now();
  const r2 = await faceService.detectFace(buf, true);
  console.log(`detectFace(enroll mode) => success=${r2.success} in ${Date.now() - t2}ms`);

  // Preprocess-only cost, for reference
  const t3 = Date.now();
  await faceService.preprocessImage(buf);
  console.log(`preprocessImage: ${Date.now() - t3}ms`);

  console.log(`=== BENCH END total ${Date.now() - t0}ms ===`);
  process.exit(0);
})().catch(e => { console.error('BENCH ERROR:', e); process.exit(1); });