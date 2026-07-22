# 🔄 LabSync - Complete System Workflows & Integration Guide

This guide details all end-to-end execution flows, state machine transitions, sequence diagrams, and error handling mechanisms in **LabSync**.

---

## 📋 Table of Contents
1. [Biometric Fingerprint Enrollment Sequence](#1-biometric-fingerprint-enrollment-sequence)
2. [Dual-Biometric Authentication Sequence](#2-dual-biometric-authentication-sequence)
3. [Auto-Rotation & Face Recognition Pipeline](#3-auto-rotation--face-recognition-pipeline)
4. [Hardware & Network Fault Tolerance](#4-hardware--network-fault-tolerance)
5. [Error Code Dictionary & Recovery Steps](#5-error-code-dictionary--recovery-steps)

---

## 1. Biometric Fingerprint Enrollment Sequence

This workflow registers a user's fingerprint on the Adafruit optical sensor via admin command from the Flutter App.

### Sequence Flow Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Admin (Flutter App)
    participant API as Backend (Express)
    participant DevKit as ESP32 (TFT & Sensor)
    participant DB as Google Sheets DB

    Admin->>API: POST /api/esp32/start-enrollment (userId, roomId)
    API->>API: Clear previous enrollment status map
    API-->>Admin: { success: true, message: "Enrollment command queued" }
    
    loop Every 3 seconds
        DevKit->>API: GET /api/esp32/get-commands/:roomId
        API-->>DevKit: { command: "ENROLL:USR-004:Milan Samanta" }
    end

    DevKit->>DevKit: Display TFT: "Step 1: Place Finger"
    DevKit->>DevKit: Detect finger & convert template (image2Tz(1))
    DevKit->>DevKit: Display TFT: "Lift Finger..."
    DevKit->>DevKit: Wait for finger removal

    loop Attempt 1 to 4 (Step 2 Retry Loop)
        DevKit->>DevKit: Display TFT: "Step 2: Place Finger Again"
        DevKit->>DevKit: Detect finger & convert template (image2Tz(2))
        DevKit->>DevKit: Call DSP createModel() (0x05)
        alt Matched (0x00)
            DevKit->>DevKit: Find open slot & storeModel(nextId)
            DevKit->>API: POST /api/esp32/enrollment-complete (fingerId, userId)
            API->>DB: Update USERS Table (Column H: fingerprintId)
            API-->>DevKit: { success: true }
            DevKit->>DevKit: Display TFT: "ENROLLED! Slot 4"
        else Mismatch (0x0A / 10)
            DevKit->>DevKit: Display TFT: "Scan mismatch! Lift & place again (Attempt X/4)"
        end
    end

    alt Max Attempts Reached / Error
        DevKit->>API: POST /api/esp32/enrollment-failed (error, details)
        API-->>DevKit: { success: true }
        DevKit->>DevKit: Display TFT: "ENROLLMENT FAILED"
    end

    loop Every 1 second
        Admin->>API: GET /api/esp32/enrollment-status/:userId
        API-->>Admin: { enrolled: true, fingerprintId: 4 } OR { failed: true, error: "..." }
    end
```

---

## 2. Dual-Biometric Authentication Sequence

Dual-biometric authentication requires a valid fingerprint match followed immediately by facial verification.

```mermaid
sequenceDiagram
    autonumber
    actor User as User at Door
    participant DevKit as ESP32 (TFT & Relay)
    participant Cam as ESP32-CAM Module
    participant API as Backend Engine
    participant DB as Google Sheets DB

    User->>DevKit: Place finger on optical sensor
    DevKit->>DevKit: Search sensor DSP memory (fingerSearch)
    DevKit->>API: GET /api/esp32/user-by-finger/:fingerId
    API->>DB: Query USERS table for matching fingerprintId
    API-->>DevKit: { found: true, userId: "USR-004", userName: "Milan Samanta" }

    DevKit->>API: POST /api/esp32/fingerprint-verified
    API->>API: Check Night Lockout rules
    API->>API: Store pendingFaceAuth state (30s TTL)
    API-->>DevKit: { success: true, message: "Awaiting face auth" }

    DevKit->>Cam: GET /start (Enable camera feed)
    DevKit->>DevKit: Stream live VGA preview on TFT display

    DevKit->>Cam: GET /capture (Fetch JPEG frame)
    Cam-->>DevKit: Return JPEG Buffer (VGA 640x480)

    DevKit->>API: POST /api/face/verify (userId, faceImage)
    API->>API: Run 4-Way Auto-Rotation (0°, 180°, 90°, 270°)
    API->>API: SSD MobileNet Face Detection & 68 Landmarks
    API->>API: Extract 128-d vector & compute Euclidean Distance vs stored descriptor
    
    alt Match Valid (Distance < 0.6, e.g. 94.5% Similarity)
        API->>API: Queue command 'face_unlock' for roomId
        API-->>DevKit: { success: true, similarityPercent: 94.5, box: {...} }
        DevKit->>DevKit: Trigger 5V Relay (GPIO LOW) for 5000ms
        DevKit->>DevKit: Display TFT: "ACCESS GRANTED - Welcome Milan!"
        API->>DB: Log SUCCESS event to ROOM_ACCESS table
    else Mismatch / Timeout
        API->>API: Queue command 'face_deny' for roomId
        API-->>DevKit: { success: false, similarityPercent: 32.1 }
        DevKit->>DevKit: Display TFT: "ACCESS DENIED - Face Mismatch"
        API->>DB: Log DENIED event to ROOM_ACCESS table
    end

    DevKit->>Cam: GET /stop (Disable camera feed)
```

---

## 3. Auto-Rotation & Face Recognition Pipeline

Incoming camera frames from ESP32-CAM or Mobile/Web clients are processed through our multi-stage biometric pipeline in `backend/services/faceService.js`:

```
┌─────────────────────────────┐
│  Incoming JPEG Image Buffer │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐      0° / 180° / 90° / 270°
│  Canvas Transformation      │ ─────────────────────────────────┐
│  Multi-Angle Rotation       │                                  │
└──────────────┬──────────────┘                                  │
               │                                                 │
               ▼                                                 ▼
┌─────────────────────────────┐                     ┌─────────────────────────────┐
│ SSD MobileNet v1            │                     │ Face Landmark 68            │
│ Neural Face Detector        │ ──────────────────> │ Feature Extraction          │
└─────────────────────────────┘                     └────────────┬────────────────┘
                                                                 │
                                                                 ▼
┌─────────────────────────────┐                     ┌─────────────────────────────┐
│  Euclidean Distance Math    │                     │ Face Recognition Net        │
│  d = sqrt( sum( (a-b)^2 ) ) │ <────────────────── │ 128-d Feature Vector        │
└──────────────┬──────────────┘                     └─────────────────────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Match Evaluation           │  If Distance < 0.6  --> MATCH SUCCESS
│  Similarity % Calculation   │  If Distance >= 0.6 --> MATCH FAILED
└─────────────────────────────┘
```

---

## 4. Hardware & Network Fault Tolerance

### 1. In-Memory Command & Status Queues (`sharedState.js`)
To eliminate Google Sheets API rate-limit quota exhaustion during frequent 3-second hardware polling, all active commands, pending face states, and device heartbeats operate strictly in-memory:
- `pendingCommands`: Map of `roomId` $\rightarrow$ active commands (`enroll`, `face_unlock`, `face_deny`).
- `enrollmentStatus`: Map of `userId` $\rightarrow$ active enrollment progress/completion.
- `pendingFaceAuth`: Map of `roomId` $\rightarrow$ dual auth state with 30-second TTL expiration.

### 2. Network Resilience & Auto-Discovery
- **mDNS Auto-Discovery**: ESP32 client resolves `esp32cam.local` dynamically over mDNS.
- **Hardcoded IP Fallback**: If mDNS fails due to router isolation, the firmware automatically falls back to static IP (`http://192.168.154.133`).
- **HTTP Timeout Margin**: Client HTTP request timeouts are set to **45 seconds** to accommodate network jitter.

---

## 5. Error Code Dictionary & Recovery Steps

### Adafruit Fingerprint Sensor DSP Codes (Hex / Decimal)

| Code | Name | Meaning | Root Cause & Resolution |
| :--- | :--- | :--- | :--- |
| `0x00` (0) | `FINGERPRINT_OK` | Command succeeded | Normal operation. |
| `0x01` (1) | `FINGERPRINT_PACKETRECIEVEERR` | Communication error | Check TX/RX wiring between ESP32 and sensor. |
| `0x02` (2) | `FINGERPRINT_NOFINGER` | No finger on sensor | User lifted finger or touched too lightly. |
| `0x06` (6) | `FINGERPRINT_IMAGEFAIL` | Image capture failed | Dirty sensor glass or low illumination. |
| `0x07` (7) | `FINGERPRINT_IMAGEMESS` | Blurry image | User moved finger during conversion. |
| `0x0A` (10)| `FINGERPRINT_ENROLLMISMATCH` | Scans did not match | User shifted finger position significantly between Step 1 and Step 2. Firmware automatically triggers Step 2 retry loop (up to 4 attempts). |
| `0x0B` (11)| `FINGERPRINT_BADLOCATION` | Invalid storage ID | Slot index is outside 1 to 1000 range. |
| `0x22` (34)| `FINGERPRINT_FLASHERR` | Flash writing failed | Hardware flash sensor error. Reset sensor power. |

### Network & Library Error Codes

| Code | Component | Cause | Resolution |
| :--- | :--- | :--- | :--- |
| `-11` | ESP32 HTTPClient | `HTTPC_ERROR_READ_TIMEOUT` | Raised when backend takes > 25s to respond. Fixed by pre-downloading neural models to `backend/models` for instant disk load. |
| `-1` | ESP32 HTTPClient | `HTTPC_ERROR_CONNECTION_REFUSED` | Server offline or wrong IP address configured in `SERVER_URL`. |
| `400` | Node Backend | Missing required body parameters | Verify JSON payload fields (`userId`, `roomId`, `faceImage`). |
| `401` | Node Backend | Face mismatch or unauthorized | User face similarity < 60%. Retake enrollment or improve lighting. |
