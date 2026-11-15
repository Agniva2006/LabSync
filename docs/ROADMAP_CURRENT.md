# LabSync — Current Working Roadmap (Micro-Step by Micro-Step)

> Status: ALL identified issues FIXED as of 2026-11-15.
> Authored during debugging of the "ghost users / same finger fails to verify" incident.

---

## 0. What Was Broken (Root Causes)

| # | Bug | Root Cause | Fixed In |
|---|-----|-----------|----------|
| 1 | Deleted user's finger STILL unlocked door | `finger.deleteModel(slot)` was never called — slot lived in sensor flash forever | `Esp32.ino` — new `DELETE_FP:<slot>` command handler |
| 2 | Deleted user STILL resolved by fingerprint lookup | Slots matched in Sheets via `fingerprintSlotsMatch` on a row that no longer existed → fell through to stale in-memory entry | `adminRoutes.js /users/delete` — purge `faceDatabase` + `enrollmentStatus` + sessions |
| 3 | Deleted users resurrected on server restart | `syncAndHealAllBiometrics()` only ADDED entries, never pruned | `faceService.js` — prune step drops any memory entry not in Sheets |
| 4 | "Welcome WRONG NAME" + same finger fails verify | `authRoutes /register` auto-assigned `maxFpId + 1` to accounts that never enrolled — sensor slot N matched a totally unrelated person | `authRoutes.js` — slot only assigned by real hardware enrollment |
| 5 | Stale cached row number wrote face descriptor onto wrong user's row | `findRowIndex` without `{fresh:true}` in biometric writes | `esp32Routes.js enrollment-complete` & `bind-fingerprint` |
| 6 | Backend `ENFORCE_DEVICE_AUTH=true` blocked ALL ESP32 traffic silently | Firmware never sent `X-Device-Id`/`X-Device-Ts`/`X-Device-Sig` headers | `Esp32.ino` — mbedtls HMAC signing added to `httpGet`, `httpPostJson`, `postMultipartStreaming` |

---

## 1. Current Runtime Flow — Step by Step

### Phase A — Server Boot
```
A1. node server.js                          → loads .env, Sheets creds
A2. Load face-api models from ./models      → TinyFaceDetector + Landmark68 + FaceRecognition (+SSD fallback)
A3. loadFacesFromSheet()                    → reads USERS tab, parses 128-d descriptors into faceDatabase Map
A4. syncAndHealAllBiometrics()              → heals ENROLLED-but-malformed rows, PRUNES deleted users ← NEW
A5. Server listening on :5000               → ESP32 + Flutter + Camera can now reach /api/*
```

### Phase B — User Registration (Flutter app → /api/auth/register)
```
B1. POST /register {name, email, password, department}
B2. bcrypt(password, 10) + generate userId (USR-XXXXXXXXXXXX)
B3. AppendRow USERS [userId, name, email, hash, role, dept, 'ROOM-001', '', '', 'NOT_ENROLLED']
    ← fingerprintId is EMPTY now (was maxFpId+1, the wrong-name bug)
B4. JWT issued; welcome notification created
```

### Phase C — Hardware Enrollment (ESP32 TFT terminal)
```
C1. Admin long-presses finger >1.2s  →  TFT Admin Menu shows
    └─ tap <0.6s = enroll user
    └─ tap 0.6–1.5s = enroll admin
    └─ tap >1.5s = admin unlock

    OR remotely: Flutter "Enroll on ESP32" → POST /door-control/start-enrollment
       → backend queues command ENROLL:<userId>:<name>:<role> for ROOM-001

C2. ESP32 polls GET /api/esp32/get-commands/ROOM-001 every 3s (SIGNED ← NEW)
C3. Picks up ENROLL command → enters runEnrollmentSequence()

C4. [STEP 0] Find free DSP slot:
    for slot = 1..capacity: if loadModel(slot) != OK → slot is free
    NOTE: this works but has a 1-in-N race; see §3 Future Fix

C5. [STEP 1] Fingerprint scan 1 → image2Tz(1)
C6. Finger released → scan 2 → image2Tz(2)
C7. createModel() merges → storeModel(nextId)
C8. POST /api/esp32/enrollment-complete (fingerId, userId, userName, role) [SIGNED ← NEW]
    → backend does a FRESH findRowIndex (row-number-correct ← NEW FIX)
    → writes fingerprintId into Sheets column H
    → refreshes faceDatabase fingerprint→userId mapping immediately

C9. [STEP 2] Face: camera wakes, TFT live view, quality-gated frames
    POST /api/face/enroll-hardware (multipart JPEG) [SIGNED ← NEW]
    → faceService.enrollFaceFromHardware() collects ≥1 consistent sample
    → saves 128-d descriptor in-memory + persists to Sheets columns I,J
    → ESP32 gets {success:true, box:{...}} → GREEN overlay
C10. Enrollment ACK'd via /command-ack so it never runs twice
```

### Phase D — Verification (Every Door Access)
```
D1. Finger on sensor → fingerSearch() → matches DSP slot <200ms
D2. GET /api/esp32/user-by-finger/<slot> [SIGNED]
    → fingerprintSlotsMatch() finds the SINGLE matching userId
    → if 2+ users claim same slot → warns & picks most-recent (defensive)
    → response {found, userId, userName, role, faceEnrolled}
D3. TFT: "IDENTIFIED: Milan"
D4. POST /api/esp32/fingerprint-verified [SIGNED]
    → opens 50s pendingFaceAuth window for this room
    → logs ROOM_ACCESS status=PENDING_FACE
D5. Camera wakes, frame every 900ms → POST /api/face/verify (multipart JPEG) [SIGNED]
    → detectFace() budget-aware (224→160→180°→SSD fallback)
    → Euclidean distance vs stored 128-d descriptor
    → d ≤ 0.70 → MATCH; 0.70–0.80 → marginal (retry)
    → liveness advisory check → final decision
D6. If MATCH → backend queues face_unlock for this room → ESP32 sees it
D7. Relay GPIO 26 HIGH for 5s → door opens → TFT "WELCOME Milan!"
D8. POST /api/room-access logs GRANTED with distance/similarity/time
```

### Phase E — User Deletion (Flutter admin → /api/admin/users/delete)
```
E1. POST /admin/users/delete {userIds: [...]} (admin JWT required)
E2. For each userId:
    a) Capture fingerprintId BEFORE deleting row ← NEW
    b) FRESH findRowIndex + deleteRow in Sheets
    c) faceService.deleteFace() → clears in-memory face entry + descriptor in Sheets (no-op if row gone)
    d) enrollmentStatus.delete(userId), faceEnrollmentSessions.delete(userId) ← NEW
    e) Queue DELETE_FP:<slot> for the room's ESP32 ← NEW
E3. loadFacesFromSheet() forces a fresh reload so ghosts never survive ← NEW
E4. ESP32 picks up DELETE_FP via command poll → finger.deleteModel(slot) → ACK
    → DSP slot freed, finger stops matching forever ← NEW
```

### Phase F — Device HMAC Signing (every HTTP call) ← NEW
```
F1. Firmware builds canonical string: METHOD\npath\nts\nnonce\nsha256(body)
F2. HMAC-SHA256(canonical, DEVICE_SECRET) → hex signature
F3. Headers: X-Device-Id, X-Device-Ts, X-Device-Nonce, X-Device-Sig
F4. Backend deviceAuth.computeSignature() re-computes; mismatch → 401
F5. Verified working end-to-end (curl with real sig → 200; no sig → 401)
```

---

## 2. Files Changed in This Fix Session

```
backend/routes/adminRoutes.js        → /users/delete full purge + DELETE_FP queue
backend/routes/esp32Routes.js        → fresh row reads on enrollment-complete/bind-fingerprint
backend/routes/authRoutes.js         → no fingerprint slot pre-reservation on register
backend/services/faceService.js      → syncAndHealAllBiometrics() prune step
hardware/.../Esp32.ino               → DELETE_FP handler, mbedtls HMAC signing on all HTTP
docs/ROADMAP_CURRENT.md              → this file
```

---

## 3. Remaining Hardening (Not Blocking, But Worth Doing Next)

| Priority | Item | Why |
|----------|------|-----|
| 🟠 P1 | Fix DSP slot-probe race: use `getTemplateCount()` instead of probing each slot with `loadModel()` | Faster (1 call vs N calls), no risk of probing CharBuffer |
| 🟠 P1 | Replace bootEpochOffset with real NTP-synced epoch on WiFi connect | Backend replay window accepts millis-since-boot today, but proper timestamps are safer long-term |
| 🟡 P2 | Move backend from Google Sheets to SQLite/Postgres for >100 users | Sheets is fine <100 rows; API latency 1.5–2s per read |
| 🟡 P2 | Rate-limit `/admin/users/delete` and require confirm token | Currently single call wipes instantly |
| 🟢 P3 | Camera.ino HMAC signing too (same pattern as Esp32.ino) | Currently only Master ESP32 is signed |
| 🟢 P3 | Auto-prune `ROOM_ACCESS` rows older than 90 days | Sheet grows forever otherwise |

---

## 4. Quick Reference — Key Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/esp32/fingerprint-verified` | Opens face-verification window (dual-auth step 1) |
| GET  | `/api/esp32/user-by-finger/:slot` | Resolve DSP slot → userId (TFT welcome) |
| POST | `/api/esp32/enrollment-complete` | Persist fingerprintId to Sheets |
| GET  | `/api/esp32/get-commands/:roomId` | ESP32 command poll (ENROLL / unlock / DELETE_FP) |
| POST | `/api/esp32/command-ack` | Confirm command executed |
| POST | `/api/face/enroll-hardware` | Face enrollment from ESP32-CAM (multipart) |
| POST | `/api/face/verify` | Face verification from ESP32-CAM (multipart) |
| POST | `/api/admin/users/delete` | Delete user(s) + purge everything |
| ALL  | `/api/esp32/sync-biometrics` | Force Sheets→memory reconciliation |

---

## 5. Device Auth Setup (for new deployments)

```
backend/.env:
  DEVICE_ID=test-esp32-01
  DEVICE_SECRET=test-device-secret
  ENFORCE_DEVICE_AUTH=true

Esp32.ino constants (must match):
  DEVICE_ID       = "test-esp32-01"
  DEVICE_SECRET   = "test-device-secret"

Generate fresh creds:
  cd backend && node scripts/generate_device_secret.js [deviceId] [rooms]
  → paste printed values into .env AND firmware, then reflash ESP32.
```
