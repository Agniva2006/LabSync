const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 127.0.0.1 explicitly: `localhost` resolves to ::1 first in Node, but the
// server binds IPv4 0.0.0.0, which yields ECONNREFUSED.
const BASE = `http://127.0.0.1:${process.env.PORT || 5000}`;
const FACE = path.join(__dirname, '../face.jpg');
const USER = 'TEST-HTTP-001';
const SECRET = process.env.DEVICE_SECRET || 'test-device-secret';
const DEVICE_ID = process.env.DEVICE_ID || 'test-esp32-01';
let failures = 0;

const check = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' :: ' + detail : ''}`);
};

/** Mirrors middleware/deviceAuth.js computeSignature, client side. */
function sign(method, urlPath, body) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(8).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const canonical = `${method.toUpperCase()}\n${urlPath}\n${ts}\n${nonce}\n${bodyHash}`;
  const sig = crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
  return { 'X-Device-Id': DEVICE_ID, 'X-Device-Ts': ts, 'X-Device-Nonce': nonce, 'X-Device-Sig': sig };
}

/** Multipart uploads sign only identity + timestamp (body not hashable on-device). */
const deviceHeaders = () => ({
  'X-Device-Id': DEVICE_ID,
  'X-Device-Ts': String(Date.now()),
});

const post = async (pathname, fields, file, { unsigned = false } = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('faceImage', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), 'face.jpg');
  const t = Date.now();
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    body: fd,
    headers: unsigned ? {} : deviceHeaders(),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, ms: Date.now() - t };
};

const postSigned = async (pathname, payload) => {
  const body = JSON.stringify(payload);
  const urlPath = `/api/esp32${pathname}`;
  const t = Date.now();
  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign('POST', urlPath, body) },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => ({})), ms: Date.now() - t };
};

const getSigned = async (pathname) => {
  const urlPath = `/api/esp32${pathname}`;
  const res = await fetch(`${BASE}${urlPath}`, { headers: sign('GET', urlPath, '') });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const get = async (p) => {
  const res = await fetch(`${BASE}${p}`);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

(async () => {
  console.log('\n########## HTTP API E2E + DEVICE AUTH ##########\n');

  // ---------------------------------------------------------------
  console.log('>>> 1. DEVICE AUTHENTICATION');
  let r = await postSigned('/send-command', { roomId: 'ROOM-001', command: 'face_unlock' });
  check('UNSIGNED door-unlock request is REJECTED', r.status === 401,
    `HTTP ${r.status} ${r.json.error || ''}`);

  const body = JSON.stringify({ roomId: 'ROOM-001', command: 'face_unlock' });
  let res = await fetch(`${BASE}/api/esp32/send-command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign('POST', '/api/esp32/send-command', body) },
    body,
  });
  let json = await res.json();
  check('SIGNED door-unlock request is ACCEPTED', res.status === 200, `HTTP ${res.status}`);
  await fetch(`${BASE}/api/esp32/command-ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign('POST', '/api/esp32/command-ack', JSON.stringify({ roomId: 'ROOM-001' })) },
    body: JSON.stringify({ roomId: 'ROOM-001' }),
  });

  // replay the exact same signed request
  res = await fetch(`${BASE}/api/esp32/send-command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign('POST', '/api/esp32/send-command', body) },
    body,
  });
  json = await res.json();
  check('REPLAYED signed request is REJECTED', res.status === 401 && json.error === 'replay_detected',
    `HTTP ${res.status} ${json.error}`);

  const stale = sign('POST', '/api/esp32/send-command', body);
  stale['X-Device-Ts'] = String(Date.now() - 10 * 60 * 1000);
  stale['X-Device-Nonce'] = crypto.randomBytes(8).toString('hex');
  stale['X-Device-Sig'] = crypto.createHmac('sha256', SECRET)
    .update(`POST\n/api/esp32/send-command\n${stale['X-Device-Ts']}\n${stale['X-Device-Nonce']}\n${crypto.createHash('sha256').update(body).digest('hex')}`).digest('hex');
  res = await fetch(`${BASE}/api/esp32/send-command`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...stale }, body });
  json = await res.json();
  check('STALE timestamp is REJECTED', res.status === 401 && json.error === 'stale_request', `HTTP ${res.status} ${json.error}`);

  const wrongSig = sign('POST', '/api/esp32/send-command', body);
  wrongSig['X-Device-Sig'] = 'deadbeef'.repeat(8);
  res = await fetch(`${BASE}/api/esp32/send-command`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...wrongSig }, body });
  json = await res.json();
  check('BAD signature is REJECTED', res.status === 401 && json.error === 'invalid_signature', `HTTP ${res.status} ${json.error}`);

  res = await fetch(`${BASE}/api/esp32/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign('POST', '/api/esp32/heartbeat', '{"deviceId":"x"}') },
    body: '{"deviceId":"x"}',
  });
  check('SIGNED heartbeat ACCEPTED', res.status === 200, `HTTP ${res.status}`);

  // ---------------------------------------------------------------
  console.log('\n>>> 2. HARDWARE ENROLL  POST /api/face/enroll-hardware');
  const frames = [];
  for (let i = 0; i < 4; i++) {
    const src = fs.readFileSync(FACE);
    frames.push(src);
    if (i > 0) break;
  }
  let finalized = null, framesUsed = 0;
  const variants = [FACE, FACE, FACE, FACE];
  for (let i = 0; i < variants.length; i++) {
    r = await post('/api/face/enroll-hardware', { userId: USER }, variants[i]);
    framesUsed++;
    if (r.json.finalized) { finalized = r; break; }
  }
  console.log(`     HTTP ${r.status} after ${framesUsed} frame(s) in ${r.ms}ms :: ${r.json.message}`);
  check('hardware enroll finalized', r.json.finalized === true, r.json.message);
  check('quality reported', r.json.quality > 0, String(r.json.quality));
  check('each frame inside ESP32 30s window', r.ms < 30000, `${r.ms}ms`);

  r = await post('/api/face/enroll-hardware', { userId: USER }, FACE, { unsigned: true });
  check('UNSIGNED enroll-hardware REJECTED', r.status === 401, `HTTP ${r.status} ${r.json.error}`);

  // ---------------------------------------------------------------
  console.log('\n>>> 3. FACE VERIFY  POST /api/face/verify');
  r = await post('/api/face/verify', { userId: USER, roomId: 'ROOM-001' }, FACE);
  console.log(`     HTTP ${r.status} in ${r.ms}ms :: ${r.json.message}`);
  check('HTTP 200 (match granted)', r.status === 200, `${r.status}`);
  check('distance under threshold', r.json.distance <= 0.70, String(r.json.distance));
  check('inside ESP32 30s window', r.ms < 30000, `${r.ms}ms`);

  // ---------------------------------------------------------------
  console.log('\n>>> 4. FINGERPRINT -> USER RESOLUTION (multi-slot "22,33")');
  for (const slot of [22, 33, 99]) {
    const g = await getSigned(`/user-by-finger/${slot}`);
    check(`slot ${slot} resolves`, slot === 99 ? g.json.found === false : g.json.found === true,
      g.json.found ? `-> ${g.json.userName} (${g.json.userId})` : 'not found');
  }

  // ---------------------------------------------------------------
  console.log('\n>>> 5. COMMAND ACK / RETRY');
  await postSigned('/send-command', { roomId: 'ROOM-001', command: 'face_unlock' });
  let g1 = await getSigned('/get-commands/ROOM-001');
  check('command delivered with an id', g1.json.hasCommand === true && !!g1.json.commandId, g1.json.commandId);
  let g2 = await getSigned('/get-commands/ROOM-001');
  check('command REDELIVERED until acked (not lost on first poll)', g2.json.hasCommand === true && g2.json.commandId === g1.json.commandId);
  await postSigned('/command-ack', { roomId: 'ROOM-001', commandId: g1.json.commandId, ok: true });
  let g3 = await getSigned('/get-commands/ROOM-001');
  check('command removed AFTER ack', g3.json.hasCommand === false);

  // ---------------------------------------------------------------
  console.log('\n>>> 6. DEBUG ENDPOINTS HIDDEN');
  g1 = await getSigned('/debug/pending');
  check('debug/pending not mounted', g1.status === 404, `HTTP ${g1.status}`);
  g1 = await getSigned('/debug/clear-all');
  check('debug/clear-all not mounted', g1.status === 404, `HTTP ${g1.status}`);

  // ---------------------------------------------------------------
  console.log('\n>>> 7. FACE STATUS REQUIRES AUTH');
  let anon = await fetch(`${BASE}/api/face/status/${USER}`);
  check('unauthenticated face status REJECTED', anon.status === 401, `HTTP ${anon.status}`);

  // ---------------------------------------------------------------
  console.log('\n>>> CLEANUP');
  fs.readdirSync(__dirname).filter(f => f.startsWith('_h')).forEach(f => fs.unlinkSync(path.join(__dirname, f)));

  console.log(`\n########## ${failures === 0 ? 'ALL HTTP CHECKS PASSED' : failures + ' HTTP CHECK(S) FAILED'} ##########\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HTTP E2E ERROR:', e); process.exit(1); });