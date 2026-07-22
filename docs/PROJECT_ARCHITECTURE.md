# 🏛️ LabSync - Complete Project Architecture & Codebase Guide

Welcome to **LabSync**! This document provides a complete technical reference for developers, maintainers, and new interns onboarding to the project.

---

## 📋 Table of Contents
1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Repository Structure](#3-repository-structure)
4. [Database Schema (Google Sheets)](#4-database-schema-google-sheets)
5. [Subsystem Architecture](#5-subsystem-architecture)
   - [Backend Node.js Service](#backend-nodejs-service)
   - [Hardware Modules (ESP32 & ESP32-CAM)](#hardware-modules-esp32--esp32-cam)
   - [Frontend Flutter Application](#frontend-flutter-application)
6. [Developer Setup & Quick Start](#6-developer-setup--quick-start)
7. [Environment & Credentials](#7-environment--credentials)

---

## 1. System Overview

**LabSync** is an IoT laboratory access control and biometric management system. It provides:
- **Dual Biometric Authentication**: Optical fingerprint scanning (Adafruit DSP sensor) paired with facial recognition (TensorFlow.js / SSD MobileNet v1).
- **Physical Access Control**: Low-latency 5V relay door triggers with automatic mechanical safety timers.
- **Real-Time Monitoring & Telemetry**: Room access logs, night lockout enforcement, equipment borrowing, and device heartbeat monitoring.
- **Multi-Platform Management App**: Flutter Web & Mobile dashboard for admins and lab researchers.

```
┌────────────────────────┐      ┌─────────────────────────┐      ┌─────────────────────────┐
│ Flutter Admin/User UI  │ <--> │ Node.js Express Backend │ <--> │ Google Sheets Database  │
│ (Web / Mobile App)     │      │ (REST API & AI Engine)  │      │ (Persistence Layer)     │
└────────────────────────┘      └─────────────────────────┘      └─────────────────────────┘
                                             ▲
                                             │ HTTP REST / Polling
                                             ▼
                               ┌──────────────────────────┐
                               │  ESP32 Hardware Client   │
                               │  (TFT, Fingerprint, CAM) │
                               └──────────────────────────┘
```

---

## 2. Technology Stack

| Layer | Technology / Library | Purpose |
| :--- | :--- | :--- |
| **Backend Core** | Node.js (v20+), Express.js | REST API, command queueing, auth |
| **AI / Biometrics** | `@vladmandic/face-api`, `node-canvas` | 128-d face embeddings, 4-way auto-rotation (0°, 90°, 180°, 270°) |
| **Database** | Google Sheets API (`googleapis`) | Zero-cost persistent cloud storage |
| **Hardware Client** | ESP32 DevKit (WROOM-32) | TFT display driver, Adafruit optical fingerprint sensor, 5V relay switch |
| **Hardware Camera** | ESP32-CAM (AI-Thinker OV2640) | VGA (640x480) HTTP image stream server |
| **Frontend App** | Flutter 3.x (Dart), GoRouter | Cross-platform web & mobile UI with glassmorphism styling |

---

## 3. Repository Structure

```
LabSync-main/
├── backend/                        # Node.js Express REST API & AI Engine
│   ├── config/                     # Service account & credentials
│   ├── middleware/                 # Auth JWT & rate limiting middleware
│   ├── models/                     # Local binary face-api neural weights (.bin)
│   ├── routes/                     # REST API endpoint handlers
│   │   ├── adminRoutes.js          # Admin user management & room assignment
│   │   ├── authRoutes.js           # JWT authentication & registration
│   │   ├── doorControlRoutes.js    # Manual door trigger & command queueing
│   │   ├── dualAuthRoutes.js       # Dual fingerprint + face auth sequence
│   │   ├── esp32Routes.js          # ESP32 polling, status, & telemetry
│   │   ├── faceRoutes.js           # Face enrollment & verification endpoints
│   │   ├── inventoryRoutes.js      # Lab equipment inventory tracking
│   │   ├── notificationRoutes.js   # User alerts & system notifications
│   │   ├── requestRoutes.js        # Borrowing & access permission requests
│   │   ├── roomAccessRoutes.js     # Room occupancy & historical logs
│   │   └── roomRoutes.js           # Room metadata
│   ├── services/                   # Business logic & hardware integrations
│   │   ├── faceService.js          # Face detection, auto-rotation, descriptor averaging
│   │   ├── notificationService.js  # In-app & push alerts
│   │   ├── securityService.js      # Night lockout & anti-tamper tracking
│   │   ├── sharedState.js          # In-memory queues & maps (no DB quota burn)
│   │   └── sheetsService.js        # Google Sheets CRUD operations
│   ├── server.js                   # Main application entry point
│   └── package.json
│
├── hardware/                       # Microcontroller Firmware (Arduino C++)
│   ├── ESP32_TFT_Fingerprint_Client/
│   │   └── ESP32_TFT_Fingerprint_Client.ino  # Main room access board firmware
│   └── ESP32_CAM_Server/
│       └── ESP32_CAM_Server.ino              # Camera module firmware
│
├── lib/                            # Flutter Cross-Platform Application
│   ├── core/                       # App colors, constants, global state
│   ├── models/                     # Data models (User, Room, Log, Equipment)
│   ├── screens/                    # UI screens (Admin, User, Auth, Biometrics)
│   │   ├── admin/                  # Admin dashboard & fingerprint enrollment
│   │   ├── user/                   # User dashboard, face enrollment, profile
│   │   └── auth/                   # Login & registration screens
│   ├── services/                   # Frontend API client service
│   └── widgets/                    # Reusable UI widgets (GlassCard, NeonButton)
│   └── main.dart                   # Flutter app entry point
│
└── docs/                           # Documentation & Guides
    ├── PROJECT_ARCHITECTURE.md     # This document
    └── SYSTEM_WORKFLOWS.md         # Detailed sequence flows & error handling
```

---

## 4. Database Schema (Google Sheets)

LabSync uses a Google Spreadsheet (`LabSync DB`) as its primary database. Each table is represented by a separate tab:

### 1. `USERS` Table (10 Columns)
| Col | Field Name | Description |
| :--- | :--- | :--- |
| **A** | `userId` | Unique user identifier (e.g. `USR-001`) |
| **B** | `username` | User full name (e.g. `Milan Samanta`) |
| **C** | `email` | User login email |
| **D** | `password` | Bcrypt hashed password |
| **E** | `role` | Access level (`admin` / `user`) |
| **F** | `department` | Department (e.g. `Computer Science`) |
| **G** | `authorized_rooms` | Comma-separated room access list (`ROOM-001,ROOM-002`) |
| **H** | `fingerprintId` | Hardware slot ID on Adafruit sensor (1 to 1000) |
| **I** | `faceDescriptor` | JSON array of 128 float embedding values |
| **J** | `faceStatus` | Biometric status (`ENROLLED` / `NOT_ENROLLED`) |

### 2. `ROOM_ACCESS` Table (Logs)
| Col | Field | Description |
| :--- | :--- | :--- |
| **A** | `logId` | Timestamped log ID (`LOG-1784...`) |
| **B** | `userId` | User ID involved in entry/exit |
| **C** | `roomId` | Target room (e.g. `ROOM-001`) |
| **D** | `authMethod` | Method used (`FINGERPRINT`, `FACE`, `DUAL`, `ADMIN_OVERRIDE`) |
| **E** | `timestamp` | ISO date time string |
| **F** | `status` | Access outcome (`SUCCESS`, `DENIED`, `NIGHT_LOCKOUT`, `TIMEOUT`) |
| **G** | `details` | Diagnostic information or error reason |

---

## 5. Subsystem Architecture

### Backend Node.js Service
- **Express Server (`server.js`)**: Runs on port 5000. Uses CORS, JSON body parsers (50MB limit for image buffers), and global rate limiting.
- **Biometric Engine (`faceService.js`)**:
  - Uses `@vladmandic/face-api` (SSD MobileNet v1 + FaceLandmark68 + FaceRecognitionNet).
  - Neural weights are loaded from `backend/models` on startup in **< 50ms**.
  - Includes a **4-way auto-rotation matrix** using `node-canvas` to evaluate 0°, 180° (inverted), 90°, and 270° orientations automatically.
  - Multi-sample descriptor averaging combines multiple captures into a master 128-float face embedding.

### Hardware Modules (ESP32 & ESP32-CAM)
1. **ESP32 TFT & Fingerprint Client**:
   - Interfaced with Adafruit Optical Fingerprint Sensor over UART (57600 baud).
   - ST7789 / ILI9341 TFT display for real-time status and bounding box visualization.
   - Non-blocking HTTP polling loop fetches door unlock/enrollment commands every 3s.
   - Step 2 fingerprint enrollment retry loop (up to 4 attempts) prevents touch-release mismatch errors.
2. **ESP32-CAM Server**:
   - Operates OV2640 camera sensor at **VGA (640x480)** resolution with hardware contrast (+1), brightness (+1), and auto-exposure control.
   - Exposes `/capture`, `/start`, `/stop`, and `/status` endpoints.

### Frontend Flutter Application
- Responsive web and mobile client featuring a dark glassmorphism aesthetic.
- Interacts with backend REST API using `ApiService`.
- Handles live admin command triggers, real-time polling, and biometric enrollment interfaces.

---

## 6. Developer Setup & Quick Start

### Prerequisites
- Node.js v20.x or higher
- Flutter SDK 3.x
- Arduino IDE (with ESP32 board support v2.0+)

### 1. Backend Setup
```bash
# Navigate to backend directory
cd backend

# Install node dependencies
npm install

# Download face recognition models (if missing)
node ../scratch/download_bin_models.js

# Start the server
npm start
```
*The server will boot on `http://localhost:5000`.*

### 2. Hardware Flashing
1. **ESP32 TFT Client**: Open `hardware/ESP32_TFT_Fingerprint_Client/ESP32_TFT_Fingerprint_Client.ino` in Arduino IDE. Set Wi-Fi credentials (`WIFI_SSID`, `WIFI_PASSWORD`) and server IP (`SERVER_URL`). Select board **ESP32 Dev Module** and flash.
2. **ESP32-CAM**: Open `hardware/ESP32_CAM_Server/ESP32_CAM_Server.ino` in Arduino IDE. Select board **AI Thinker ESP32-CAM**, enable PSRAM, and flash.

### 3. Frontend Flutter Setup
```bash
# Navigate to project root
cd ..

# Fetch Flutter packages
flutter pub get

# Run web app locally
flutter run -d chrome
```

---

## 7. Environment & Credentials

- **Google Sheets API**: Place your Google service account credentials file (`service-account.json` or `credentials.json`) in `backend/config/`.
- **JWT Secret**: Configured via `backend/.env`:
  ```env
  PORT=5000
  JWT_SECRET=your_jwt_secret_key_here
  SPREADSHEET_ID=your_google_sheet_id_here
  ```
