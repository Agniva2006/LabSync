const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const faceService = require('../services/faceService');

const TEST_USER = 'TEST-E2E-001';
const FACE = path.join(__dirname, '../face.jpg');

const fmt = (n) => `${String(n).padStart(6)}ms`;
let failures = 0;

function check(label, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${mark}] ${label}${detail ? ' :: ' + detail : ''}`);
}

async function derive(src, name, apply) {
  const out = path.join(__dirname, name);
  const pipeline = sharp(src);
  await apply(pipeline);
  await pipeline.jpeg({ quality: 92 }).toFile(out);
  return fs.readFileSync(out);
}

(async () => {
  console.log('\n############ FULL E2E: FACE + FINGERPRINT ############\n');

  const t0 = Date.now();
  await faceService.initialize();
  console.log(`[init] models + DB loaded in ${fmt(Date.now() - t0)}\n`);

  const base = fs.readFileSync(FACE);

  // ---------------------------------------------------------------
  console.log('>>> 1. FACE ENROLLMENT (hardware path: enrollFaceFromHardware)');
  // The firmware loops posting frames until the server reports finalized, so
  // drive it exactly that way. Each frame is a slightly different capture, as
  // it would be from a live OV2640.
  const enrollFrames = await Promise.all([
    derive(FACE, '_e1.jpg', p => p),
    derive(FACE, '_e2.jpg', p => p.modulate({ brightness: 0.94 })),
    derive(FACE, '_e3.jpg', p => p.jpeg({ quality: 82 })),
    derive(FACE, '_e4.jpg', p => p.modulate({ brightness: 1.06 })),
  ]);

  let t = Date.now();
  let enroll1 = null;
  let framesUsed = 0;
  for (let i = 0; i < enrollFrames.length; i++) {
    enroll1 = await faceService.enrollFaceFromHardware(TEST_USER, enrollFrames[i]);
    framesUsed = i + 1;
    if (enroll1.finalized) break;
  }
  console.log(`     finalized after ${framesUsed} frame(s) in ${fmt(Date.now() - t)}`);
  console.log(`     msg="${enroll1.message}" quality=${enroll1.quality} spread=${enroll1.consistency}`);
  check('enrollment finalized', enroll1.finalized === true, `msg="${enroll1.message}"`);
  check('required multiple samples, not one', framesUsed >= 3, `${framesUsed} frames`);
  check('descriptor captured', faceService.isUserEnrolled(TEST_USER));
  check('sample box returned for TFT overlay', !!enroll1.box, JSON.stringify(enroll1.box));
  check('quality score persisted', enroll1.quality > 0, String(enroll1.quality));
  check('consistency (intra-sample spread) reported', enroll1.consistency !== undefined, String(enroll1.consistency));

  // ---------------------------------------------------------------
  console.log('\n>>> 2. FACE VERIFICATION (same person, same frame)');
  t = Date.now();
  const v1 = await faceService.verifyFace(TEST_USER, base);
  console.log(`     took ${fmt(Date.now() - t)}`);
  check('verified match', v1.success === true,
    `distance=${v1.distance?.toFixed(4)} sim=${v1.similarityPercent}% liveness=${v1.liveness?.score}`);
  check('distance under threshold', v1.distance <= 0.70, `${v1.distance?.toFixed(4)} <= 0.70`);

  // ---------------------------------------------------------------
  console.log('\n>>> 3. ROBUSTNESS — same face after ESP32-style degradation');
  // preprocessImage already normalises any frame to fit inside 320x240, so the
  // meaningful degradation axis is information loss, not geometry. Simulate a
  // genuinely low-detail capture: downscale hard, then restore QVGA size.
  const variants = [
    ['Half-resolution capture (VGA -> QVGA detail loss)',
      p => p.resize(180, 320, { fit: 'inside' }).resize(320, 240, { fit: 'inside' })],
    ['Quarter-resolution + dim lab',
      p => p.resize(110, 200, { fit: 'inside' }).resize(320, 240, { fit: 'inside' }).modulate({ brightness: 0.6 })],
    ['JPEG q40 (compressed link)', p => p.jpeg({ quality: 40 })],
    ['Upside-down (180 deg mount)', p => p.rotate(180)],
    ['Blurred (motion / soft lens)', p => p.blur(1.2)],
  ];
  for (const [label, apply] of variants) {
    const buf = await derive(FACE, `_v_${label.replace(/\W+/g, '_')}.jpg`, apply);
    const v = await faceService.verifyFace(TEST_USER, buf);
    check(label, v.success === true,
      v.success ? `sim=${v.similarityPercent}%` : `${v.message} (${fmt(v.timeMs)})`);
  }

  // ---------------------------------------------------------------
  console.log('\n>>> 4. NEGATIVE — different person / no face must be DENIED');
  const noFace = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 150, g: 150, b: 150 } } }).jpeg().toBuffer();
  const vNo = await faceService.verifyFace(TEST_USER, noFace);
  check('blank frame denied', vNo.success === false, vNo.message);

  const vUnknown = await faceService.verifyFace('NO-SUCH-USER-999', base);
  check('unenrolled user denied cleanly', vUnknown.success === false && vUnknown.noFaceEnrolled === true, vUnknown.message);

  // ---------------------------------------------------------------
  console.log('\n>>> 5. PERSISTENCE — descriptor is written to durable storage');
  const persisted = faceService.getDescriptorForUser(TEST_USER);
  check('in-memory descriptor readable', !!persisted?.descriptor);

  const { getLocalDbData: readDb } = require('../services/sheetsService');
  const stored = (readDb('USERS') || []).find(u => String(u.userid || u.userId).toUpperCase() === TEST_USER);
  check('descriptor written to local_db.json', !!stored && String(stored.facedescriptor || '').length > 50,
    stored ? `${String(stored.facedescriptor || '').length} chars, status=${stored.facestatus}` : 'user row missing');
  check('faceStatus flipped to ENROLLED', stored && stored.facestatus === 'ENROLLED', stored?.facestatus);

  // ---------------------------------------------------------------
  console.log('\n>>> 6. FINGERPRINT SLOT RESOLUTION (multi-slot cell "22,33")');
  const { getLocalDbData } = require('../services/sheetsService');
  const users = getLocalDbData('USERS');
  const arun = users.find(u => String(u.userid || '').startsWith('USR-1789'));
  check('fixture has multi-slot fingerprint user', !!arun, arun ? `fingerprintid="${arun.fingerprintid}"` : 'not found');

  if (arun) {
    await faceService.loadFacesFromSheet();
    check('slot 22 resolves', !!faceService.getUserByFingerprintId(22));
    check('slot 33 resolves (previously broken)', !!faceService.getUserByFingerprintId(33),
      'was parseInt("22,33") === 22 only');
    check('slot 99 does not resolve', faceService.getUserByFingerprintId(99) === null);
  }

  // ---------------------------------------------------------------
  console.log('\n>>> CLEANUP');
  await faceService.deleteFace(TEST_USER);
  check('deleteFace clears memory', !faceService.isUserEnrolled(TEST_USER));

  for (const f of fs.readdirSync(__dirname)) {
    if (f.startsWith('_v_') || f.startsWith('_e') || f === 'noface_qvga.jpg') fs.unlinkSync(path.join(__dirname, f));
  }

  console.log(`\n############ ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ############\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('E2E ERROR:', e); process.exit(1); });