/*
  ╔══════════════════════════════════════════════════════════════╗
  ║        LabSync — ESP32 TFT Fingerprint Client v2.0           ║
  ║                                                              ║
  ║  FULL BACKEND INTEGRATION — Complete rewrite                 ║
  ║                                                              ║
  ║  Hardware:                                                   ║
  ║    • ESP32 DevKit / WROOM                                    ║
  ║    • R307 / AS608 fingerprint sensor (UART, GPIO 16/17)     ║
  ║    • ILI9341 2.2" TFT 320×240 (SPI, GPIO 15/2/4/23/18/19)  ║
  ║    • Relay module (GPIO 26) → door lock                      ║
  ║    • AI Thinker ESP32-CAM on same WiFi                       ║
  ║                                                              ║
  ║  Flow:                                                       ║
  ║    1. Finger touches sensor → fingerSearch() → get userId    ║
  ║    2. POST /api/esp32/fingerprint-verified                   ║
  ║    3. GET /start → ESP32-CAM (show face on TFT)             ║
  ║    4. GET /capture → JPEG bytes                              ║
  ║    5. POST /api/face/verify {userId, roomId, faceImage}      ║
  ║    6. Poll GET /api/esp32/get-commands/:roomId               ║
  ║    7. face_unlock → pulse relay → door opens 5s              ║
  ║                                                              ║
  ║  Libraries needed (install via Arduino Library Manager):     ║
  ║    • Adafruit_Fingerprint (by Adafruit)                      ║
  ║    • Adafruit_ILI9341 (by Adafruit)                          ║
  ║    • Adafruit_GFX (by Adafruit)                              ║
  ║    • TJpg_Decoder (by Bodmer)                                ║
  ║    • ArduinoJson (by Benoit Blanchon)                        ║
  ╚══════════════════════════════════════════════════════════════╝
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <NetworkClient.h>
#include <HTTPClient.h>
#include <ESPmDNS.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <TJpg_Decoder.h>
#include <Adafruit_Fingerprint.h>
#include <ArduinoJson.h>

// ==================== CONFIGURATION — CHANGE THESE ====================
const char* WIFI_SSID           = "Galaxy";
const char* WIFI_PASSWORD       = "password2006";
// Production Render Cloud Backend
const char* SERVER_URL          = "https://labsync-pnr8.onrender.com";
const char* CAMERA_IP_FALLBACK  = "192.168.154.133";              // ← Hardcoded CAM IP
const char* ROOM_ID             = "ROOM-001";
const char* CAMERA_MDNS_NAME    = "esp32cam";
// ======================================================================

// TFT pins (unchanged from original)
constexpr int TFT_CS   = 15;
constexpr int TFT_RST  = 4;
constexpr int TFT_DC   = 2;
constexpr int TFT_MOSI = 23;
constexpr int TFT_SCLK = 18;
constexpr int TFT_MISO = 19;

// Fingerprint UART
constexpr int FINGERPRINT_RX   = 16;
constexpr int FINGERPRINT_TX   = 17;
constexpr uint32_t FP_BAUD     = 57600;

// Door relay
constexpr int RELAY_PIN        = 26;
constexpr unsigned long RELAY_OPEN_MS = 5000; // 5 seconds door open

// Timing
constexpr uint32_t LIVE_VIEW_TIME_MS      = 10000; // 10s camera preview
constexpr uint32_t COMMAND_POLL_INTERVAL  = 3000;  // 3s poll interval
constexpr uint32_t FACE_AUTH_TIMEOUT_MS   = 30000; // 30s face auth window
constexpr uint32_t HEARTBEAT_INTERVAL_MS  = 30000; // 30s heartbeat
constexpr size_t   MAX_JPEG_BYTES         = 65000;  // Safe for ESP32 DevKit DRAM (no PSRAM)

// ==================== GLOBALS ====================
Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);
HardwareSerial   fpSerial(2);
Adafruit_Fingerprint finger(static_cast<Stream*>(&fpSerial));

uint8_t* jpegBuffer       = nullptr;
String   cameraBaseUrl    = "";
bool     fingerprintOK    = false;
unsigned long lastHeartbeat = 0;
unsigned long lastCommandPoll = 0;

// Current session
String currentUserId    = "";
String currentUserName  = "";
bool   awaitingFaceAuth = false;
unsigned long faceAuthStartTime = 0;

// ==================== COLORS ====================
#define COLOR_BG      ILI9341_BLACK
#define COLOR_CYAN    0x07FF
#define COLOR_GREEN   ILI9341_GREEN
#define COLOR_RED     ILI9341_RED
#define COLOR_YELLOW  ILI9341_YELLOW
#define COLOR_WHITE   ILI9341_WHITE
#define COLOR_GRAY    0x8410

// ==================== TFT DISPLAY HELPERS ====================

void tftShowStatus(const String& line1, const String& line2, uint16_t color = COLOR_WHITE) {
  tft.fillRect(0, 200, 320, 40, COLOR_BG);
  tft.setTextSize(1);
  tft.setTextColor(color, COLOR_BG);
  tft.setCursor(10, 205);
  tft.println(line1);
  if (line2.length() > 0) {
    tft.setCursor(10, 220);
    tft.println(line2);
  }
}

void tftShowFullScreen(const String& title, const String& subtitle, uint16_t titleColor) {
  tft.fillScreen(COLOR_BG);
  // Header bar
  tft.fillRect(0, 0, 320, 30, titleColor);
  tft.setTextColor(COLOR_BG, titleColor);
  tft.setTextSize(2);
  tft.setCursor(10, 7);
  tft.print("LABSYNC");

  // Main title
  tft.setTextColor(titleColor, COLOR_BG);
  tft.setTextSize(2);
  tft.setCursor(10, 50);
  tft.println(title);

  // Subtitle
  tft.setTextColor(COLOR_WHITE, COLOR_BG);
  tft.setTextSize(1);
  tft.setCursor(10, 85);
  tft.println(subtitle);
}

void tftSplashScreen() {
  tft.fillScreen(COLOR_BG);
  tft.fillRect(0, 0, 320, 40, COLOR_CYAN);
  tft.setTextColor(COLOR_BG, COLOR_CYAN);
  tft.setTextSize(3);
  tft.setCursor(40, 10);
  tft.print("LABSYNC");

  tft.setTextColor(COLOR_CYAN, COLOR_BG);
  tft.setTextSize(1);
  tft.setCursor(10, 60);
  tft.println("Smart Lab Access System");
  tft.setCursor(10, 75);
  tft.print("Room: "); tft.println(ROOM_ID);

  tft.setTextColor(COLOR_WHITE, COLOR_BG);
  tft.setCursor(10, 100);
  tft.println("Connecting...");
}

void tftShowWaiting() {
  tftShowFullScreen("PLACE FINGER", "On the sensor below", COLOR_CYAN);
  tft.setTextColor(COLOR_GRAY, COLOR_BG);
  tft.setTextSize(1);
  tft.setCursor(10, 110);
  tft.println("Fingerprint will unlock door");
  tft.setCursor(10, 125);
  tft.println("after face verification");

  // Draw finger icon hint
  tft.drawRect(140, 160, 40, 50, COLOR_CYAN);
  tft.setCursor(148, 220);
  tft.setTextColor(COLOR_CYAN, COLOR_BG);
  tft.println("SCAN");
}

// ==================== WIFI ====================

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  tftShowFullScreen("CONNECTING...", WIFI_SSID, COLOR_YELLOW);
  Serial.print("Connecting to WiFi");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print('.');
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
    tftShowStatus("WiFi: " + WiFi.localIP().toString(), "", COLOR_GREEN);
    delay(1000);
  } else {
    Serial.println("\nWiFi connection FAILED");
    tftShowStatus("WiFi FAILED - Retrying...", "", COLOR_RED);
    delay(2000);
  }
}

// ==================== FINGERPRINT SENSOR ====================

void initFingerprint() {
  fpSerial.begin(FP_BAUD, SERIAL_8N1, FINGERPRINT_RX, FINGERPRINT_TX);
  delay(500);

  fingerprintOK = finger.verifyPassword();
  if (fingerprintOK) {
    Serial.println("✅ Fingerprint sensor detected");
    finger.getParameters();
    Serial.printf("   Capacity: %d | Security level: %d\n",
                  finger.capacity, finger.security_level);
    tftShowStatus("Fingerprint: READY", String(finger.capacity) + " slots", COLOR_GREEN);
  } else {
    Serial.println("❌ Fingerprint sensor NOT detected");
    tftShowStatus("Fingerprint: NOT FOUND", "Check GPIO 16/17 wiring", COLOR_RED);
  }
  delay(1000);
}

// ==================== CAMERA (ESP32-CAM) ====================

bool ipIsZero(const IPAddress& ip) {
  return ip[0] == 0 && ip[1] == 0 && ip[2] == 0 && ip[3] == 0;
}

bool resolveCamera() {
  Serial.println("Finding ESP32-CAM (esp32cam.local)...");
  IPAddress camIp = MDNS.queryHost(CAMERA_MDNS_NAME, 3000);
  if (!ipIsZero(camIp)) {
    cameraBaseUrl = "http://" + camIp.toString();
    Serial.println("ESP32-CAM via mDNS: " + cameraBaseUrl);
    return true;
  }
  // mDNS failed (common on mobile hotspots) — use hardcoded IP
  Serial.println("mDNS failed, using hardcoded IP: " + String(CAMERA_IP_FALLBACK));
  cameraBaseUrl = "http://" + String(CAMERA_IP_FALLBACK);
  return true;
}

bool sendCameraCmd(const char* path) {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (cameraBaseUrl.length() == 0 && !resolveCamera()) return false;

  NetworkClient client;
  HTTPClient http;
  http.setConnectTimeout(2000);
  http.setTimeout(3000);
  http.useHTTP10(true);

  String url = cameraBaseUrl + path;
  if (!http.begin(client, url)) return false;

  int code = http.GET();
  http.end();
  return code == HTTP_CODE_OK;
}

// TJpg callback to draw on TFT
bool tftJpegOutput(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t* bitmap) {
  if (x >= tft.width() || y >= tft.height()) return false;
  tft.drawRGBBitmap(x, y, bitmap, w, h);
  return true;
}

// Fetch one JPEG frame and return bytes (for sending to backend)
size_t fetchJpegFrame(uint8_t* buf, size_t maxLen) {
  if (cameraBaseUrl.length() == 0) return 0;

  NetworkClient client;
  HTTPClient http;
  http.setConnectTimeout(2000);
  http.setTimeout(4000);
  http.useHTTP10(true);

  if (!http.begin(client, cameraBaseUrl + "/capture")) return 0;

  int code = http.GET();
  if (code != HTTP_CODE_OK) { http.end(); return 0; }

  int len = http.getSize();
  if (len <= 0 || (size_t)len > maxLen) { http.end(); return 0; }

  NetworkClient* stream = http.getStreamPtr();
  size_t received = 0;
  uint32_t timeout = millis();

  while (received < (size_t)len) {
    int avail = stream->available();
    if (avail > 0) {
      size_t toRead = min((size_t)avail, maxLen - received);
      toRead = min(toRead, (size_t)4096);
      int got = stream->read(buf + received, toRead);
      if (got > 0) { received += got; timeout = millis(); }
    } else if (millis() - timeout > 2500) break;
    else delay(1);
  }

  http.end();
  return received;
}

// Display frame on TFT
bool displayJpegOnTFT(uint8_t* buf, size_t len) {
  uint16_t w = 0, h = 0;
  if (TJpgDec.getJpgSize(&w, &h, buf, len) != JDR_OK) return false;

  uint8_t scale = 1;
  while ((w / scale > tft.width() || h / scale > tft.height()) && scale < 8) scale *= 2;
  TJpgDec.setJpgScale(scale);

  int16_t x = (tft.width()  - w / scale) / 2;
  int16_t y = (tft.height() - h / scale) / 2;
  return TJpgDec.drawJpg(x, y, buf, len) == JDR_OK;
}

// ==================== BACKEND HTTP HELPERS ====================

// GET request → return response body string
String httpGet(const String& path) {
  if (WiFi.status() != WL_CONNECTED) { connectWiFi(); return ""; }

  String url = String(SERVER_URL) + path;
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(15000);

  int code = 0;
  if (url.startsWith("https://")) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    if (!http.begin(secureClient, url)) return "";
    code = http.GET();
  } else {
    NetworkClient client;
    if (!http.begin(client, url)) return "";
    code = http.GET();
  }

  String body = (code == HTTP_CODE_OK) ? http.getString() : "";
  http.end();
  return body;
}

// POST JSON → return response body string
String httpPostJson(const String& path, const String& jsonBody) {
  if (WiFi.status() != WL_CONNECTED) { connectWiFi(); return ""; }

  String url = String(SERVER_URL) + path;
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(15000);

  int code = 0;
  if (url.startsWith("https://")) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    if (!http.begin(secureClient, url)) return "";
    http.addHeader("Content-Type", "application/json");
    code = http.POST(jsonBody);
  } else {
    NetworkClient client;
    if (!http.begin(client, url)) return "";
    http.addHeader("Content-Type", "application/json");
    code = http.POST(jsonBody);
  }

  String body = (code > 0) ? http.getString() : "";
  http.end();
  return body;
}

// POST multipart (image + fields) for face verification
// POST multipart helper (image + fields) using zero-heap streaming
bool postMultipartStreaming(const String& path, const String& part1, uint8_t* jpegBuf, size_t jpegLen, const String& part3, String& outResp) {
  if (WiFi.status() != WL_CONNECTED) { connectWiFi(); return false; }

  String serverStr = String(SERVER_URL);
  bool isHttps = serverStr.startsWith("https://");
  int protoEnd = serverStr.indexOf("://");
  String hostPort = (protoEnd != -1) ? serverStr.substring(protoEnd + 3) : serverStr;

  String host = hostPort;
  int port = isHttps ? 443 : 80;
  int colonIndex = hostPort.indexOf(':');
  if (colonIndex != -1) {
    host = hostPort.substring(0, colonIndex);
    port = hostPort.substring(colonIndex + 1).toInt();
  }

  const String boundary = "----LabSyncBoundary7344";
  size_t totalLen = part1.length() + jpegLen + part3.length();

  String response = "";

  if (isHttps) {
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(45);

    if (!client.connect(host.c_str(), port)) {
      Serial.println("❌ Direct HTTPS connection to backend failed");
      return false;
    }

    client.printf("POST %s HTTP/1.1\r\n", path.c_str());
    client.printf("Host: %s\r\n", host.c_str());
    client.printf("Content-Type: multipart/form-data; boundary=%s\r\n", boundary.c_str());
    client.printf("Content-Length: %u\r\n", totalLen);
    client.print("Connection: close\r\n\r\n");

    client.print(part1);

    size_t bytesSent = 0;
    while (bytesSent < jpegLen && client.connected()) {
      size_t chunkSize = (jpegLen - bytesSent > 1024) ? 1024 : (jpegLen - bytesSent);
      client.write(jpegBuf + bytesSent, chunkSize);
      bytesSent += chunkSize;
    }

    client.print(part3);
    client.flush();

    unsigned long startWait = millis();
    while (!client.available() && millis() - startWait < 45000) {
      delay(10);
    }

    while (client.available()) {
      response += (char)client.read();
    }
    client.stop();
  } else {
    NetworkClient client;
    client.setTimeout(45);

    if (!client.connect(host.c_str(), port)) {
      Serial.println("❌ Direct TCP connection to backend failed");
      return false;
    }

    client.printf("POST %s HTTP/1.1\r\n", path.c_str());
    client.printf("Host: %s:%d\r\n", host.c_str(), port);
    client.printf("Content-Type: multipart/form-data; boundary=%s\r\n", boundary.c_str());
    client.printf("Content-Length: %u\r\n", totalLen);
    client.print("Connection: close\r\n\r\n");

    client.print(part1);

    size_t bytesSent = 0;
    while (bytesSent < jpegLen && client.connected()) {
      size_t chunkSize = (jpegLen - bytesSent > 1024) ? 1024 : (jpegLen - bytesSent);
      client.write(jpegBuf + bytesSent, chunkSize);
      bytesSent += chunkSize;
    }

    client.print(part3);
    client.flush();

    unsigned long startWait = millis();
    while (!client.available() && millis() - startWait < 45000) {
      delay(10);
    }

    while (client.available()) {
      response += (char)client.read();
    }
    client.stop();
  }

  outResp = response;
  int bodyStart = response.indexOf("\r\n\r\n");
  if (bodyStart != -1) {
    outResp = response.substring(bodyStart + 4);
  }

  return (response.indexOf("200 OK") != -1 || response.indexOf("\"success\":true") != -1);
}

// POST multipart for face verification
bool postFaceVerify(const String& userId, const String& roomId,
                    uint8_t* jpegBuf, size_t jpegLen) {
  Serial.printf("📡 Stream-Posting face image for VERIFY (%u bytes)...\n", jpegLen);

  const String boundary = "----LabSyncBoundary7344";
  const String CRLF = "\r\n";

  String part1 =
    "--" + boundary + CRLF +
    "Content-Disposition: form-data; name=\"userId\"" + CRLF + CRLF +
    userId + CRLF +
    "--" + boundary + CRLF +
    "Content-Disposition: form-data; name=\"roomId\"" + CRLF + CRLF +
    roomId + CRLF +
    "--" + boundary + CRLF +
    "Content-Disposition: form-data; name=\"faceImage\"; filename=\"face.jpg\"" + CRLF +
    "Content-Type: image/jpeg" + CRLF + CRLF;
  String part3 = CRLF + "--" + boundary + "--" + CRLF;

  String resp;
  bool ok = postMultipartStreaming("/api/face/verify", part1, jpegBuf, jpegLen, part3, resp);

  if (!ok) {
    Serial.println("❌ Face verify response failed or non-200");
    return false;
  }

  Serial.println("📥 Face verify response: " + resp.substring(0, 200));

  DynamicJsonDocument doc(768);
  DeserializationError err = deserializeJson(doc, resp);
  if (err) return false;

  bool success = doc["success"] | false;
  const char* msg = doc["message"] | "No message";
  float confidence = doc["confidence"] | 0.0f;

  Serial.printf("%s Face verification: %s (confidence: %.3f)\n",
                success ? "✅" : "❌", msg, confidence);

  if (doc.containsKey("box") && !doc["box"].isNull()) {
    int bx = doc["box"]["x"] | 0;
    int by = doc["box"]["y"] | 0;
    int bw = doc["box"]["w"] | 0;
    int bh = doc["box"]["h"] | 0;

    uint16_t boxColor = success ? COLOR_GREEN : COLOR_RED;
    tft.drawRect(bx, by + 20, bw, bh, boxColor);
    tft.drawRect(bx + 1, by + 21, bw - 2, bh - 2, boxColor);

    tft.setTextSize(1);
    tft.setTextColor(boxColor, COLOR_BG);
    tft.setCursor(bx, by + 20 + bh + 2);
    tft.printf("%.0f%%", confidence * 100);
  }

  return success;
}

// POST multipart for hardware face ENROLLMENT
bool postFaceEnroll(const String& userId, uint8_t* jpegBuf, size_t jpegLen) {
  Serial.printf("📡 Stream-Posting face image for ENROLLMENT (%u bytes)...\n", jpegLen);

  const String boundary = "----LabSyncBoundary7344";
  const String CRLF = "\r\n";

  String part1 =
    "--" + boundary + CRLF +
    "Content-Disposition: form-data; name=\"userId\"" + CRLF + CRLF +
    userId + CRLF +
    "--" + boundary + CRLF +
    "Content-Disposition: form-data; name=\"faceImage\"; filename=\"face.jpg\"" + CRLF +
    "Content-Type: image/jpeg" + CRLF + CRLF;
  String part3 = CRLF + "--" + boundary + "--" + CRLF;

  String resp;
  bool ok = postMultipartStreaming("/api/face/enroll-hardware", part1, jpegBuf, jpegLen, part3, resp);

  if (ok) {
    DynamicJsonDocument doc(512);
    if (deserializeJson(doc, resp) == DeserializationError::Ok) {
      bool success = doc["success"] | false;
      if (success) {
        Serial.println("✅ Face enrolled successfully via hardware!");
        return true;
      }
    }
  }

  Serial.println("❌ Face enroll failed");
  return false;
}

// ==================== GET USER BY FINGERPRINT ID ====================

bool getUserByFingerId(int fingerId, String& outUserId, String& outUserName) {
  String path = "/api/esp32/user-by-finger/" + String(fingerId);
  String resp = httpGet(path);

  if (resp.length() == 0) {
    Serial.println("❌ No response from server (user-by-finger)");
    return false;
  }

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, resp) != DeserializationError::Ok) return false;

  bool found = doc["found"] | false;
  if (!found) return false;

  outUserId   = doc["userId"]   | "";
  outUserName = doc["userName"] | "";
  return outUserId.length() > 0;
}

// ==================== NOTIFY BACKEND: FINGERPRINT VERIFIED ====================

void notifyFingerprintVerified(const String& userId, int fingerId) {
  String body = "{\"roomId\":\"" + String(ROOM_ID) + "\",\"userId\":\"" + userId +
                "\",\"fingerId\":" + String(fingerId) + "}";
  String resp = httpPostJson("/api/esp32/fingerprint-verified", body);
  Serial.println("Fingerprint-verified POST: " + resp.substring(0, 100));
}

// ==================== POLL FOR DOOR COMMAND ====================

String pollForCommand(unsigned long timeoutMs) {
  unsigned long start = millis();
  Serial.printf("⏳ Waiting for door command (timeout: %lus)...\n", timeoutMs / 1000);

  while (millis() - start < timeoutMs) {
    String path = "/api/esp32/get-commands/" + String(ROOM_ID);
    String resp = httpGet(path);

    if (resp.length() > 0) {
      DynamicJsonDocument doc(512);
      if (deserializeJson(doc, resp) == DeserializationError::Ok) {
        bool hasCmd = doc["hasCommand"] | false;
        if (hasCmd) {
          String cmd = doc["command"] | "";
          Serial.println("📩 Command received: " + cmd);
          return cmd;
        }
      }
    }

    delay(COMMAND_POLL_INTERVAL);
  }

  return "timeout";
}

// ==================== DOOR RELAY ====================

void openDoor() {
  Serial.println("🔓 OPENING DOOR — relay pulse " + String(RELAY_OPEN_MS) + "ms");
  tftShowFullScreen("ACCESS GRANTED", "Door opening...", COLOR_GREEN);
  tftShowStatus("Door open for 5 seconds", "", COLOR_GREEN);

  digitalWrite(RELAY_PIN, HIGH);
  delay(RELAY_OPEN_MS);
  digitalWrite(RELAY_PIN, LOW);

  Serial.println("🔒 Door closed mechanically");
  tftShowStatus("Door closed", "Locking...", COLOR_CYAN);
  
  // Log the door close event to backend
  String body = "{\"roomId\":\"" + String(ROOM_ID) + "\"}";
  httpPostJson("/api/esp32/door-closed", body);
}

// ==================== HEARTBEAT ====================

void sendHeartbeat() {
  if (millis() - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeat = millis();

  String body = "{\"roomId\":\"" + String(ROOM_ID) + "\",\"deviceId\":\"ESP32-" +
                String(ROOM_ID) + "\",\"rssi\":" + String(WiFi.RSSI()) +
                ",\"freeHeap\":" + String(ESP.getFreeHeap()) +
                ",\"uptime\":" + String(millis() / 1000) + "}";

  httpPostJson("/api/esp32/heartbeat", body);
}

// ==================== FINGERPRINT ENROLLMENT SEQUENCE ====================

String getFingerprintErrorString(int p) {
  switch (p) {
    case 0x01: return "Communication error";
    case 0x02: return "Imaging error";
    case 0x03: return "Imaging error (bad packet)";
    case 0x06: return "Image too messy";
    case 0x07: return "Could not find features";
    case 0x08: return "Invalid image/no features";
    case 0x0A: return "Fingerprint scans did not match (createModel failed: 10)";
    case 0x0B: return "Invalid storage location";
    case 0x18: return "Flash writing error";
    case 0x1F: return "Failed to convert image";
    default: return "Unknown error (" + String(p) + ")";
  }
}

void reportEnrollmentFailure(const String& userId, const String& userName, int p, const String& stage) {
  String errStr = getFingerprintErrorString(p);
  String body = "{\"userId\":\"" + userId + "\",\"userName\":\"" + userName + 
                "\",\"error\":\"" + errStr + "\",\"details\":\"Code " + String(p) + " at " + stage + "\"}";
  httpPostJson("/api/esp32/enrollment-failed", body);
}

void runEnrollmentSequence(const String& userId, const String& userName) {
  Serial.printf("\n📝 ENROLLMENT SEQUENCE: %s (%s)\n", userName.c_str(), userId.c_str());
  tftShowFullScreen("ENROLLING FINGER", userName, COLOR_YELLOW);
  tftShowStatus("Place finger on sensor", "Hold still...", COLOR_YELLOW);

  // --- Step 1: First scan ---
  int p = -1;
  tft.setTextColor(COLOR_WHITE, COLOR_BG);
  tft.setCursor(10, 130); tft.println("STEP 1: Place finger (1st time)");

  Serial.println("Step 1: First scan");
  while (p != FINGERPRINT_OK) {
    p = finger.getImage();
    if (p == FINGERPRINT_OK) break;
    if (p != FINGERPRINT_NOFINGER) {
      Serial.printf("  getImage error: %d\n", p);
      delay(500);
    }
    delay(100);
  }

  // Convert image 1 immediately
  p = finger.image2Tz(1);
  if (p != FINGERPRINT_OK) {
    Serial.printf("❌ image2Tz(1) failed: %d\n", p);
    tftShowFullScreen("ENROLLMENT FAILED", "Try again", COLOR_RED);
    reportEnrollmentFailure(userId, userName, p, "Image 1 conversion");
    delay(2000);
    return;
  }

  Serial.println("✅ Step 1 scan converted successfully!");

  // Wait for finger to be lifted
  tftShowStatus("Lift finger...", "", COLOR_YELLOW);
  Serial.println("Lift finger...");
  while (finger.getImage() != FINGERPRINT_NOFINGER) delay(100);
  delay(500);

  // --- Step 2: Second scan (with up to 4 attempts) ---
  bool modelCreated = false;
  int attempts = 0;
  const int maxAttempts = 4;

  while (attempts < maxAttempts && !modelCreated) {
    attempts++;
    Serial.printf("Step 2: Second scan (Attempt %d/%d)\n", attempts, maxAttempts);
    tft.fillRect(0, 140, 320, 40, COLOR_BG);
    tft.setCursor(10, 145); tft.setTextColor(COLOR_WHITE, COLOR_BG);
    tft.printf("STEP 2: Place finger again (%d/%d)", attempts, maxAttempts);
    tftShowStatus("Place SAME finger again", "Hold firm...", COLOR_YELLOW);

    p = -1;
    while (p != FINGERPRINT_OK) {
      p = finger.getImage();
      if (p == FINGERPRINT_OK) break;
      if (p != FINGERPRINT_NOFINGER) {
        Serial.printf("  getImage error: %d\n", p);
        delay(500);
      }
      delay(100);
    }

    // Convert image 2 immediately
    p = finger.image2Tz(2);
    if (p != FINGERPRINT_OK) {
      Serial.printf("❌ image2Tz(2) failed (attempt %d): %d\n", attempts, p);
      tftShowStatus("Image blurry", "Lift and try again...", COLOR_YELLOW);
      while (finger.getImage() != FINGERPRINT_NOFINGER) delay(100);
      delay(500);
      continue;
    }

    // Attempt model creation
    p = finger.createModel();
    if (p == FINGERPRINT_OK) {
      Serial.println("✅ createModel successful! Fingerprints matched!");
      modelCreated = true;
      break;
    } else {
      Serial.printf("⚠️ createModel failed (attempt %d/%d): %d\n", attempts, maxAttempts, p);
      if (attempts < maxAttempts) {
        tftShowStatus("Scan mismatch!", "Lift & place firmly again", COLOR_YELLOW);
        while (finger.getImage() != FINGERPRINT_NOFINGER) delay(100);
        delay(600);
      }
    }
  }

  if (!modelCreated) {
    Serial.printf("❌ createModel failed after %d attempts: %d\n", maxAttempts, p);
    tftShowFullScreen("ENROLLMENT FAILED", "Prints did not match", COLOR_RED);
    reportEnrollmentFailure(userId, userName, p, "Model creation after " + String(maxAttempts) + " attempts");
    delay(2000);
    return;
  }

  // Find next available slot
  int nextId = 1;
  for (int i = 1; i <= finger.capacity; i++) {
    if (finger.loadModel(i) != FINGERPRINT_OK) { nextId = i; break; }
  }

  p = finger.storeModel(nextId);
  if (p != FINGERPRINT_OK) {
    Serial.printf("❌ storeModel(%d) failed: %d\n", nextId, p);
    tftShowFullScreen("ENROLLMENT FAILED", "Storage error", COLOR_RED);
    reportEnrollmentFailure(userId, userName, p, "Storage at slot " + String(nextId));
    delay(2000);
    return;
  }

  Serial.printf("✅ Fingerprint enrolled at slot %d for %s\n", nextId, userName.c_str());
  tftShowFullScreen("ENROLLED!", userName, COLOR_GREEN);
  tftShowStatus("Finger ID: " + String(nextId), "Notifying server...", COLOR_GREEN);

  // Notify backend fingerprint is enrolled
  String body = "{\"fingerId\":" + String(nextId) + ",\"userId\":\"" + userId +
                "\",\"userName\":\"" + userName + "\",\"roomId\":\"" + String(ROOM_ID) + "\"}";
  String resp = httpPostJson("/api/esp32/enrollment-complete", body);
  Serial.println("Enrollment complete POST: " + resp.substring(0, 100));

  delay(1500);

  // ==================== FACE ENROLLMENT PHASE ====================
  Serial.println("📸 Starting Face Enrollment phase...");
  tftShowFullScreen("FACE ENROLLMENT", "Starting camera...", COLOR_CYAN);
  
  if (cameraBaseUrl.length() == 0) resolveCamera();
  if (!sendCameraCmd("/start")) {
    cameraBaseUrl = "";
    resolveCamera();
    sendCameraCmd("/start");
  }

  awaitingFaceAuth = true;
  bool faceEnrolled = false;
  uint8_t captureAttempt = 0;

  tft.fillScreen(COLOR_BG);
  tft.fillRect(0, 0, 320, 20, COLOR_CYAN);
  tft.setTextColor(COLOR_BG, COLOR_CYAN);
  tft.setTextSize(1);
  tft.setCursor(5, 6);
  tft.print("FACE ENROLLMENT — " + userName);

  unsigned long previewStart = millis();

  while (millis() - previewStart < LIVE_VIEW_TIME_MS && !faceEnrolled) {
    size_t jpegLen = fetchJpegFrame(jpegBuffer, MAX_JPEG_BYTES);

    if (jpegLen > 0) {
      displayJpegOnTFT(jpegBuffer, jpegLen);
      tftShowStatus("Look at camera — enrolling...", "", COLOR_CYAN);

      captureAttempt++;
      if (captureAttempt % 3 == 0 && jpegLen > 5000) {
        Serial.printf("🔍 Attempting face enroll (frame %d, %u bytes)...\n", captureAttempt, jpegLen);
        faceEnrolled = postFaceEnroll(userId, jpegBuffer, jpegLen);

        if (faceEnrolled) {
          Serial.println("✅ Face enrolled successfully!");
          break;
        }
      }
    }
    delay(100);
  }

  sendCameraCmd("/stop");
  awaitingFaceAuth = false;

  if (faceEnrolled) {
    tftShowFullScreen("✅ ENROLLED", "Fingerprint & Face saved!", COLOR_GREEN);
    tftShowStatus("User fully registered", "", COLOR_GREEN);
  } else {
    tftShowFullScreen("❌ ENROLLMENT FAILED", "Face not captured", COLOR_RED);
    tftShowStatus("Please try again", "", COLOR_RED);
  }

  delay(3000);
  tftShowWaiting();
}

// ==================== CHECK FOR ADMIN COMMANDS ====================

void checkForAdminCommands() {
  if (millis() - lastCommandPoll < COMMAND_POLL_INTERVAL) return;
  lastCommandPoll = millis();

  if (awaitingFaceAuth) return; // Don't poll admin commands while doing face auth

  String path = "/api/esp32/get-commands/" + String(ROOM_ID);
  String resp = httpGet(path);
  if (resp.length() == 0) return;

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, resp) != DeserializationError::Ok) return;

  bool hasCmd = doc["hasCommand"] | false;
  if (!hasCmd) return;

  String cmd = doc["command"] | "";
  String cmdUserName = doc["userName"] | "";

  Serial.println("📩 Admin command: " + cmd);

  if (cmd == "unlock") {
    Serial.println("🔓 Admin remote unlock");
    tftShowFullScreen("ADMIN UNLOCK", "By: " + cmdUserName, COLOR_CYAN);
    openDoor();
    delay(2000);
    tftShowWaiting();

  } else if (cmd.startsWith("ENROLL:")) {
    // Format: "ENROLL:userId:userName"
    int colon1 = cmd.indexOf(':', 7);
    if (colon1 > 0) {
      String eUserId   = cmd.substring(7, colon1);
      String eUserName = cmd.substring(colon1 + 1);
      runEnrollmentSequence(eUserId, eUserName);
    }
  }
}

// ==================== MAIN AUTH FLOW ====================

void runAccessFlow(int fingerId) {
  Serial.printf("\n🔐 ACCESS FLOW — Finger ID: %d\n", fingerId);

  // 1. Lookup userId from backend
  tftShowFullScreen("FINGER MATCHED", "Looking up user...", COLOR_CYAN);
  tftShowStatus("Querying server...", "", COLOR_CYAN);

  String userId = "";
  String userName = "";

  if (!getUserByFingerId(fingerId, userId, userName)) {
    Serial.println("❌ Unknown fingerprint — not registered");
    tftShowFullScreen("UNKNOWN FINGER", "Not registered in system", COLOR_RED);
    tftShowStatus("Contact admin to enroll", "", COLOR_RED);
    delay(3000);
    tftShowWaiting();
    return;
  }

  Serial.printf("✅ User identified: %s (%s)\n", userName.c_str(), userId.c_str());

  // 2. Notify backend fingerprint verified
  tftShowFullScreen("HELLO " + userName, "Verifying identity...", COLOR_GREEN);
  notifyFingerprintVerified(userId, fingerId);

  // 3. Start camera for live preview
  tftShowStatus("Starting camera...", "", COLOR_CYAN);
  if (cameraBaseUrl.length() == 0) resolveCamera();
  if (!sendCameraCmd("/start")) {
    cameraBaseUrl = "";
    resolveCamera();
    sendCameraCmd("/start");
  }

  // 4. Display live preview + capture best frame for face verify
  awaitingFaceAuth = true;
  faceAuthStartTime = millis();
  bool faceVerified = false;
  uint8_t captureAttempt = 0;

  tft.fillScreen(COLOR_BG);
  // Header
  tft.fillRect(0, 0, 320, 20, COLOR_CYAN);
  tft.setTextColor(COLOR_BG, COLOR_CYAN);
  tft.setTextSize(1);
  tft.setCursor(5, 6);
  tft.print("FACE VERIFICATION — " + userName);

  unsigned long previewStart = millis();

  while (millis() - previewStart < LIVE_VIEW_TIME_MS && !faceVerified) {
    // Fetch JPEG frame
    size_t jpegLen = fetchJpegFrame(jpegBuffer, MAX_JPEG_BYTES);

    if (jpegLen > 0) {
      // Show on TFT (draw below header)
      displayJpegOnTFT(jpegBuffer, jpegLen);
      tftShowStatus("Look at camera — verifying...", "", COLOR_CYAN);

      // Every 3rd frame, try face verification
      captureAttempt++;
      if (captureAttempt % 3 == 0 && jpegLen > 5000) {
        Serial.printf("🔍 Attempting face verify (frame %d, %u bytes)...\n",
                      captureAttempt, jpegLen);
        faceVerified = postFaceVerify(userId, String(ROOM_ID), jpegBuffer, jpegLen);

        if (faceVerified) {
          Serial.println("✅ Face verification successful!");
          break;
        }
      }
    }

    delay(100);
  }

  // Stop camera
  sendCameraCmd("/stop");
  awaitingFaceAuth = false;

  if (faceVerified) {
    // 5a. Face matched — open door
    tftShowFullScreen("✅ VERIFIED", "Access Granted!", COLOR_GREEN);
    tftShowStatus("Opening door...", "", COLOR_GREEN);
    openDoor();
    tftShowFullScreen("WELCOME", userName, COLOR_GREEN);
    tftShowStatus("Access logged", "", COLOR_GREEN);
    delay(3000);
  } else {
    // 5b. Face didn't match — access denied
    Serial.println("❌ Face verification failed or timed out");
    tftShowFullScreen("❌ DENIED", "Face not matched", COLOR_RED);
    tftShowStatus("Try again or contact admin", "", COLOR_RED);
    delay(3000);
  }

  tftShowWaiting();
}

// ==================== SETUP ====================

void setup() {
  Serial.begin(115200);
  delay(300);

  // Init relay
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);

  // Init TFT
  SPI.begin(TFT_SCLK, TFT_MISO, TFT_MOSI, TFT_CS);
  tft.begin(40000000);
  tft.setRotation(1); // landscape
  tft.fillScreen(COLOR_BG);

  // JPEG decoder
  TJpgDec.setSwapBytes(false);
  TJpgDec.setJpgScale(1);
  TJpgDec.setCallback(tftJpegOutput);

  // JPEG buffer
  jpegBuffer = (uint8_t*)malloc(MAX_JPEG_BYTES);
  if (!jpegBuffer) {
    Serial.println("FATAL: JPEG buffer malloc failed");
    while (true) delay(1000);
  }

  // Show splash
  tftSplashScreen();
  delay(1000);

  // WiFi
  connectWiFi();

  // mDNS client
  if (!MDNS.begin("labsync-client")) {
    Serial.println("mDNS start failed");
  }

  // Fingerprint sensor
  initFingerprint();

  // Resolve camera
  if (!resolveCamera()) {
    tftShowStatus("ESP32-CAM not found", "Retrying on access", COLOR_YELLOW);
  }

  // Ready
  tftShowWaiting();
  Serial.println("\n✅ LabSync ESP32 ready — waiting for finger...\n");
}

// ==================== LOOP ====================

void loop() {
  // Reconnect WiFi if dropped
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    cameraBaseUrl = "";
    resolveCamera();
    return;
  }

  // Heartbeat
  sendHeartbeat();

  // Check for admin commands (enrollment / remote unlock)
  checkForAdminCommands();

  // Skip fingerprint check if in face auth flow
  if (awaitingFaceAuth) {
    delay(100);
    return;
  }

  // Poll fingerprint sensor
  if (!fingerprintOK) {
    delay(500);
    return;
  }

  uint8_t img = finger.getImage();
  if (img != FINGERPRINT_OK) {
    delay(60);
    return;
  }

  // Finger is on sensor — process it
  Serial.println("👆 Finger detected!");
  tftShowStatus("Finger detected...", "Processing...", COLOR_CYAN);

  // Convert to template
  if (finger.image2Tz(1) != FINGERPRINT_OK) {
    Serial.println("❌ image2Tz failed");
    delay(300);
    return;
  }

  // Search database
  if (finger.fingerSearch() != FINGERPRINT_OK) {
    Serial.println("❌ fingerSearch() — no match found");
    tftShowFullScreen("NO MATCH", "Finger not registered", COLOR_RED);
    tftShowStatus("Contact admin to enroll", "", COLOR_RED);
    delay(2000);
    tftShowWaiting();

    // Wait for finger removal
    while (finger.getImage() != FINGERPRINT_NOFINGER) delay(75);
    return;
  }

  // Match found!
  int fingerId   = finger.fingerID;
  int confidence = finger.confidence;
  Serial.printf("✅ Match: ID=%d  Confidence=%d\n", fingerId, confidence);

  if (confidence < 50) {
    Serial.println("❌ Confidence too low — rejected");
    tftShowFullScreen("LOW CONFIDENCE", "Try again", COLOR_YELLOW);
    delay(2000);
    tftShowWaiting();
    while (finger.getImage() != FINGERPRINT_NOFINGER) delay(75);
    return;
  }

  // Wait for finger removal before camera phase
  while (finger.getImage() != FINGERPRINT_NOFINGER) delay(75);

  // Run the full access flow
  runAccessFlow(fingerId);

  delay(60);
}
