const path = require('path');
const sharp = require('sharp');
const faceService = require('../services/faceService');

// Generate an ESP32-CAM QVGA frame with NO face (uniform wall) to force the
// worst case: 4 angles x up to 3 detector passes, all returning null.
(async () => {
  const buf = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 140, g: 140, b: 140 } },
  }).jpeg().toBuffer();
  require('fs').writeFileSync(path.join(__dirname, 'noface_qvga.jpg'), buf);

  await faceService.initialize();

  const t1 = Date.now();
  const r1 = await faceService.detectFace(buf, false);
  console.log(`\n### detectFace(NO-FACE, verification) => success=${r1.success}`);
  console.log(`### WORST-CASE LATENCY: ${Date.now() - t1}ms`);

  const t2 = Date.now();
  const r2 = await faceService.detectFace(buf, true);
  console.log(`### detectFace(NO-FACE, enrollment) => success=${r2.success} in ${Date.now() - t2}ms`);

  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });