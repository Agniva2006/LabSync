# 🔌 LabSync Hardware Flashing Guide

> 📖 **Full System Architecture & Workflow**: For the complete end-to-end hardware, backend, database, and Flutter workflow manual with diagrams, see **[COMPLETE_SYSTEM_WORKFLOW.md](file:///c:/Users/User/Desktop/best_resume_maker/project_done_during_internship_IIT_KGP/LabSync/hardware/COMPLETE_SYSTEM_WORKFLOW.md)**.

Step-by-step guide for lab personnel to flash and test the ESP32 devices.

---

## Prerequisites

- **Arduino IDE** (v2.0+) installed
- **ESP32 Board Support** installed in Arduino IDE:
  - Go to `File → Preferences → Additional Board URLs`
  - Add: `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
  - Go to `Tools → Board → Boards Manager` → search "esp32" → install

### Required Libraries (Install via Arduino Library Manager)

| Library | Used By |
|---------|---------|
| `Adafruit Fingerprint Sensor Library` | ESP32 DevKit |
| `Adafruit GFX Library` | ESP32 DevKit |
| `Adafruit ILI9341` | ESP32 DevKit |
| `ArduinoJson` | Both |
| `TJpg_Decoder` | ESP32 DevKit |

---

## ⚠️ Step 1: Change WiFi Credentials

**BOTH files** must use the **SAME WiFi network**.

### In `Camera.ino` (lines ~53-54):
```cpp
const char *WIFI_SSID = "YOUR_WIFI_NAME";      // ← Change this
const char *WIFI_PASSWORD = "YOUR_WIFI_PASS";   // ← Change this
```

### In `Esp32.ino` (lines ~41-42):
```cpp
const char *WIFI_SSID = "YOUR_WIFI_NAME";      // ← Change this
const char *WIFI_PASSWORD = "YOUR_WIFI_PASS";   // ← Change this
```

---

## Step 2: Flash ESP32-CAM

1. Open `hardware/ESP32_CAM_Server/Camera.ino` in Arduino IDE
2. Connect ESP32-CAM via USB-to-Serial adapter (GPIO0 → GND for flash mode)
3. Select board: **Tools → Board → AI Thinker ESP32-CAM**
4. Enable PSRAM: **Tools → PSRAM → Enabled**
5. Select correct COM port
6. Click **Upload**
7. After upload: disconnect GPIO0 from GND, press reset
8. Open **Serial Monitor** (115200 baud) — note the IP address printed

---

## Step 3: Flash ESP32 DevKit

1. Open `hardware/ESP32_TFT_Fingerprint_Client/Esp32.ino` in Arduino IDE
2. Connect ESP32 DevKit via USB
3. Select board: **Tools → Board → ESP32 Dev Module**
4. Select correct COM port
5. Click **Upload**
6. Open **Serial Monitor** (115200 baud) — verify it connects to WiFi

---

## Step 4: Verify Connection

### ✅ Both devices should:
1. Connect to the same WiFi
2. ESP32-CAM registers as `esp32cam.local` via mDNS
3. ESP32 DevKit discovers the camera automatically
4. ESP32 DevKit polls the backend at `https://labsync-pnr8.onrender.com`

### ⚠️ If camera discovery fails:
If your WiFi router doesn't support mDNS (common with mobile hotspots):

1. Check the **ESP32-CAM Serial Monitor** for its IP address (e.g., `192.168.1.100`)
2. In `Esp32.ino`, set the fallback IP:
```cpp
const char *CAMERA_IP_FALLBACK = "192.168.1.100"; // ← Set to CAM IP
```
3. Re-flash the ESP32 DevKit

---

## Step 5: Test End-to-End

1. Install the LabSync APK on an Android phone (same WiFi)
2. Login with admin credentials
3. Go to **Fingerprint Enrollment** → send enroll command
4. The ESP32 DevKit TFT screen should show "Place Finger"
5. Complete fingerprint enrollment
6. Test **Dual Auth**: place finger → face capture → door unlock

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ESP32 won't connect to WiFi | Double-check SSID/password. Ensure 2.4GHz network (ESP32 doesn't support 5GHz) |
| Camera not found | Check both on same WiFi. Try fallback IP method above |
| Backend timeout (~30s first request) | Render free tier cold starts. Wait and retry — subsequent requests are fast |
| Fingerprint sensor not responding | Check TX/RX wiring. Baud rate must be 57600 |
| TFT display blank | Check SPI wiring: CS=15, RST=4, DC=2 |
