/*

LabSync Main ESP32 Client v3.5 - Responsive Portrait + Async Face Processing

Hardware:
ESP32 DevKit / WROOM
R307 / AS608 fingerprint sensor
ILI9341 TFT
Relay
ESP32-CAM on same WiFi

*/

#include <Adafruit_Fingerprint.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <NetworkClient.h>
#include <Preferences.h>
#include <SPI.h>
#include <TJpg_Decoder.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WiFiClientSecure.h>

// ============================================================
// ⚠️  CHANGE THESE — WiFi and lab configuration
// ============================================================

const char *WIFI_SSID = "Arun"; // ← Change to your WiFi name
const char *WIFI_PASSWORD = "4064097a"; // ← Change to your WiFi password

// Default Server URL (Can be changed dynamically via Preferences / Serial without reflashing)
const char *DEFAULT_SERVER_URL = "https://labsync-pnr8.onrender.com";
String activeServerUrl = DEFAULT_SERVER_URL;

const char *CAMERA_MDNS_NAME = "esp32cam";

/*
CAMERA_IP_FALLBACK:
Used only if mDNS, Backend Registry, and NVS Cache all fail.
*/
const char *CAMERA_IP_FALLBACK = ""; // ← Set to CAM IP if mDNS fails (e.g. "192.168.1.100")

const char *ROOM_ID = "ROOM-001";

// ============================================================
// ESP32-CAM UDP DISCOVERY - RETAINED FROM esp32v2
// ============================================================
// ESP32-CAM broadcasts:  espcam_ip=192.168.x.x
// Main ESP32 listens on: UDP port 4210
// ============================================================

constexpr uint16_t CAMERA_DISCOVERY_PORT = 4210;
constexpr uint32_t CAMERA_UDP_WAIT_MS = 1300;

WiFiUDP cameraDiscoveryUdp;
bool cameraUdpStarted = false;

// ============================================================
// TFT
// ============================================================

constexpr int TFT_CS = 15;
constexpr int TFT_RST = 4;
constexpr int TFT_DC = 2;

constexpr int TFT_MOSI = 23;
constexpr int TFT_SCLK = 18;
constexpr int TFT_MISO = 19;

constexpr uint8_t TFT_ROTATION = 2; // Portrait 240 x 320 (180-degree portrait orientation)

// ============================================================
// FINGERPRINT
// ============================================================

constexpr int FINGERPRINT_RX = 16;
constexpr int FINGERPRINT_TX = 17;

constexpr uint32_t FP_BAUD = 57600;

// ============================================================
// RELAY
// ============================================================

constexpr int RELAY_PIN = 26;

constexpr unsigned long RELAY_OPEN_MS = 5000;

// ============================================================
// TIMING
// ============================================================

constexpr uint32_t LIVE_VIEW_TIME_MS = 35000;
constexpr uint32_t FACE_REQUEST_INTERVAL_MS = 900;
constexpr uint32_t FACE_UPLOAD_TIMEOUT_MS = 30000;
constexpr uint32_t COMMAND_POLL_INTERVAL_MS = 3000;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 30000;
constexpr uint32_t FP_RETRY_INTERVAL_MS = 5000;
constexpr uint32_t IDLE_ANIMATION_INTERVAL_MS = 700;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 5000;

// ============================================================
// JPEG
// ============================================================

// QVGA JPEGs do not need a 120 KB contiguous buffer.
// Try a sensible primary size first, with smaller fallbacks for ESP32-WROOM.
constexpr size_t JPEG_BUFFER_PRIMARY_BYTES = 45000;
constexpr size_t JPEG_BUFFER_FALLBACK_1_BYTES = 38000;
constexpr size_t JPEG_BUFFER_FALLBACK_2_BYTES = 32000;
constexpr size_t MIN_FACE_JPEG_BYTES = 1500;

// ============================================================
// TFT LAYOUT
// ============================================================

constexpr int16_t HEADER_HEIGHT = 24;
constexpr int16_t CAMERA_NAME_HEIGHT = 14;
constexpr int16_t STATUS_HEIGHT = 40;

// ============================================================
// COLORS
// ============================================================

#define COLOR_BG ILI9341_BLACK
#define COLOR_CYAN 0x07FF
#define COLOR_GREEN ILI9341_GREEN
#define COLOR_RED ILI9341_RED
#define COLOR_YELLOW ILI9341_YELLOW
#define COLOR_WHITE ILI9341_WHITE
#define COLOR_GRAY 0x8410

// ============================================================
// HARDWARE OBJECTS
// ============================================================

Adafruit_ILI9341 tft( TFT_CS, TFT_DC, TFT_RST );

HardwareSerial fpSerial(2);

Adafruit_Fingerprint finger( static_cast<Stream *>(&fpSerial) );

// ============================================================
// SYSTEM STATE
// ============================================================

enum SystemState {
  STATE_IDLE, STATE_ACTIVE };

SystemState systemState = STATE_ACTIVE;

// ============================================================
// GLOBALS
// ============================================================

uint8_t *jpegBuffer = nullptr;
size_t jpegBufferCapacity = 0;

String cameraBaseUrl = "";

bool fingerprintReady = false;
bool cameraStreaming = false;
bool mdnsStarted = false;

unsigned long lastHeartbeat = 0;
unsigned long lastCommandPoll = 0;
unsigned long lastFingerprintRetry = 0;
unsigned long lastWiFiReconnectAttempt = 0;

// ============================================================
// IDLE DISPLAY
// ============================================================

unsigned long lastIdleAnimation = 0;

int16_t idleX = 15;
int16_t idleY = 120;

int8_t idleDX = 5;
int8_t idleDY = 4;

int16_t previousIdleX = -1;
int16_t previousIdleY = -1;

// ============================================================
// JPEG BUFFER ALLOCATION
// ============================================================

bool allocateJpegBuffer()
{
  const size_t candidates[] = {
      JPEG_BUFFER_PRIMARY_BYTES,
      JPEG_BUFFER_FALLBACK_1_BYTES,
      JPEG_BUFFER_FALLBACK_2_BYTES};

  Serial.println();
  Serial.println("Allocating JPEG buffer...");
  Serial.printf("Free heap before JPEG buffer: %u bytes\n",
                (unsigned int)ESP.getFreeHeap());
  Serial.printf("Largest allocatable heap block: %u bytes\n",
                (unsigned int)ESP.getMaxAllocHeap());

  for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++)
  {
    const size_t requested = candidates[i];

    Serial.printf("Trying JPEG buffer: %u bytes\n",
                  (unsigned int)requested);

    jpegBuffer = static_cast<uint8_t *>(malloc(requested));

    if (jpegBuffer != nullptr)
    {
      jpegBufferCapacity = requested;

      Serial.printf("JPEG buffer allocated: %u bytes\n",
                    (unsigned int)jpegBufferCapacity);
      Serial.printf("Free heap after JPEG buffer: %u bytes\n",
                    (unsigned int)ESP.getFreeHeap());

      return true;
    }
  }

  jpegBufferCapacity = 0;

  Serial.println("ERROR: Unable to allocate JPEG buffer.");
  Serial.printf("Free heap: %u bytes\n",
                (unsigned int)ESP.getFreeHeap());
  Serial.printf("Largest allocatable heap block: %u bytes\n",
                (unsigned int)ESP.getMaxAllocHeap());

  return false;
}

// ============================================================
// TFT STATUS
// ============================================================

void tftShowStatus( const String &line1, const String &line2, uint16_t color = COLOR_WHITE) {
  int16_t y = tft.height() - STATUS_HEIGHT;

  tft.fillRect( 0, y, tft.width(), STATUS_HEIGHT, COLOR_BG );

  tft.drawFastHLine( 0, y, tft.width(), COLOR_GRAY );

  tft.setTextSize(1);

  tft.setTextColor( color, COLOR_BG );

  tft.setCursor( 8, y + 9 );

  tft.println(line1);

  if (line2.length() > 0) {
    tft.setCursor( 8, y + 26 );

    tft.println(line2);

  }
}

// ============================================================
// TFT FULL SCREEN
// ============================================================

void tftShowFullScreen( const String &title, const String &subtitle, uint16_t titleColor) {
  tft.fillScreen(COLOR_BG);

  tft.fillRect( 0, 0, tft.width(), 32, titleColor );

  tft.setTextColor( COLOR_BG, titleColor );

  tft.setTextSize(2);

  tft.setCursor(8, 8);

  tft.print("LABSYNC");

  tft.setTextColor( titleColor, COLOR_BG );

  tft.setTextSize(2);

  tft.setCursor(8, 55);

  tft.println(title);

  tft.setTextColor( COLOR_WHITE, COLOR_BG );

  tft.setTextSize(1);

  tft.setCursor(8, 92);

  tft.println(subtitle);
}

// ============================================================
// SPLASH
// ============================================================

void tftSplashScreen() {
  tft.fillScreen(COLOR_BG);

  tft.fillRect( 0, 0, tft.width(), 46, COLOR_CYAN );

  tft.setTextColor( COLOR_BG, COLOR_CYAN );

  tft.setTextSize(3);

  int16_t titleWidth = 7 * 18;

  int16_t titleX = (tft.width() - titleWidth) / 2;

  if (titleX < 0) titleX = 5;

  tft.setCursor( titleX, 12 );

  tft.print("LABSYNC");

  tft.setTextSize(1);

  tft.setTextColor( COLOR_CYAN, COLOR_BG );

  tft.setCursor( 12, 75 );

  tft.println( "Smart Lab Access System" );

  tft.setCursor( 12, 95 );

  tft.print("Room: ");
  tft.println(ROOM_ID);

  tft.setTextColor( COLOR_WHITE, COLOR_BG );

  tft.setCursor( 12, 130 );

  tft.println( "Starting fingerprint..." );
}

// ============================================================
// IDLE SCREEN
// ============================================================

void resetIdleAnimation() {
  idleX = 15;
  idleY = 120;

  idleDX = 5;
  idleDY = 4;

  previousIdleX = -1;
  previousIdleY = -1;

  lastIdleAnimation = 0;
}

void updateIdleScreen() {
  if (systemState != STATE_IDLE) return;

  unsigned long now = millis();

  if ( now - lastIdleAnimation < IDLE_ANIMATION_INTERVAL_MS) {
    return;
  }

  lastIdleAnimation = now;

  constexpr int16_t textWidth = 100;
  constexpr int16_t textHeight = 28;

  if ( previousIdleX >= 0 && previousIdleY >= 0) {
    tft.fillRect( previousIdleX, previousIdleY, textWidth, textHeight, COLOR_BG );
  }

  idleX += idleDX;
  idleY += idleDY;

  if (idleX <= 5) {
    idleX = 5;
    idleDX = abs(idleDX);
  }

  if ( idleX + textWidth >= tft.width() - 5) {
    idleX = tft.width() - textWidth - 5;

    idleDX = -abs(idleDX);

  }

  if (idleY <= 40) {
    idleY = 40;
    idleDY = abs(idleDY);
  }

  if ( idleY + textHeight >= tft.height() - 20) {
    idleY = tft.height() - textHeight - 20;

    idleDY = -abs(idleDY);

  }

  tft.setTextSize(1);

  tft.setTextColor( COLOR_CYAN, COLOR_BG );

  tft.setCursor( idleX, idleY );

  tft.print("LABSYNC");

  tft.setTextColor( COLOR_GRAY, COLOR_BG );

  tft.setCursor( idleX, idleY + 14 );

  tft.print( "Touch sensor" );

  previousIdleX = idleX;

  previousIdleY = idleY;
}

// ============================================================
// ENTER IDLE
// ============================================================

void enterIdleMode() {
  systemState = STATE_IDLE;

  tft.fillScreen( COLOR_BG );

  resetIdleAnimation();

  updateIdleScreen();

  Serial.println();
  Serial.println( "==============================" );
  Serial.println( "MAIN ESP32 IDLE" );
  Serial.println( "Fingerprint : ACTIVE" );
  Serial.println( "WiFi        : ACTIVE" );
  Serial.println( "Camera      : STANDBY" );
  Serial.println( "==============================" );
}

// ============================================================
// WAKE UI
// ============================================================

void wakeToActive( const String &reason) {
  systemState = STATE_ACTIVE;

  tft.fillScreen( COLOR_BG );

  for (int i = 0; i < 4; i++) {
    int margin = 25 - (i * 5);

    tft.drawRect( margin, margin, tft.width() - (margin * 2), tft.height() - (margin * 2), COLOR_CYAN );

    delay(45);

  }

  tftShowFullScreen( "ACTIVE", reason, COLOR_CYAN );
}

// ============================================================
// WIFI
// ============================================================

void connectWiFi(bool showOnDisplay = true) {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  WiFi.begin(
      WIFI_SSID,
      WIFI_PASSWORD);

  if (showOnDisplay) {
    tftShowFullScreen(
        "CONNECTING",
        WIFI_SSID,
        COLOR_YELLOW);
  }

  Serial.print("Connecting WiFi");

  // Keep startup bounded. If WiFi is slow or unavailable,
  // normal loop() retries without blocking the UI.
  const int maxAttempts = showOnDisplay ? 12 : 1;
  int attempts = 0;

  while (
      WiFi.status() != WL_CONNECTED &&
      attempts < maxAttempts) {
    delay(500);
    Serial.print('.');
    attempts++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected");
    Serial.println(
        "Main ESP32 IP: " +
        WiFi.localIP().toString());

    if (showOnDisplay) {
      tftShowStatus(
          "WiFi connected",
          WiFi.localIP().toString(),
          COLOR_GREEN);

      delay(250);
    }
  }
  else {
    Serial.println(
        "WiFi not ready yet; background reconnect enabled");

    if (showOnDisplay) {
      tftShowStatus(
          "WiFi connecting",
          "Continuing startup...",
          COLOR_YELLOW);

      delay(250);
    }
  }
}

// ============================================================
// MAIN ESP32 MDNS
// ============================================================

bool startMainMDNS() {
  if ( WiFi.status() != WL_CONNECTED) {
    return false;
  }

  if (mdnsStarted) return true;

  if (!MDNS.begin( "labsync-client")) {
    Serial.println( "Main mDNS failed" );

    mdnsStarted = false;

    return false;

  }

  mdnsStarted = true;

  Serial.println( "Main mDNS started" );

  return true;
}

// ============================================================
// FINGERPRINT INITIALIZATION
// ============================================================

bool verifyFingerprintSensor() {
  if (!finger.verifyPassword()) return false;

  finger.getParameters();

  Serial.println( "Fingerprint detected" );

  Serial.printf( "Capacity: %d\n", finger.capacity );

  Serial.printf( "Security: %d\n", finger.security_level );

  return true;
}

void initFingerprint() {
  Serial.println("Starting fingerprint UART...");

  fpSerial.begin(
      FP_BAUD,
      SERIAL_8N1,
      FINGERPRINT_RX,
      FINGERPRINT_TX);

  // Do not hold the entire boot sequence for several seconds.
  // Two quick attempts are enough; retryFingerprintIfNeeded()
  // continues recovery in the normal loop.
  for (int attempt = 1; attempt <= 2; attempt++) {
    Serial.printf("Fingerprint init %d/2\n", attempt);

    if (verifyFingerprintSensor()) {
      fingerprintReady = true;

      tftShowStatus(
          "Fingerprint READY",
          String(finger.capacity) + " slots",
          COLOR_GREEN);

      return;
    }

    delay(250);
  }

  fingerprintReady = false;

  tftShowStatus(
      "Fingerprint unavailable",
      "Background retry active",
      COLOR_YELLOW);

  Serial.println(
      "Fingerprint not ready at boot; background retry enabled");
}

void retryFingerprintIfNeeded() {
  if (fingerprintReady) return;

  unsigned long now = millis();

  if ( now - lastFingerprintRetry < FP_RETRY_INTERVAL_MS) {
    return;
  }

  lastFingerprintRetry = now;

  if (verifyFingerprintSensor()) {
    fingerprintReady = true;

    Serial.println( "Fingerprint recovered" );

  }
}

// ============================================================
// CAMERA DISCOVERY
// ============================================================

bool ipIsZero( const IPAddress &ip) {
  return ip[0] == 0 && ip[1] == 0 && ip[2] == 0 && ip[3] == 0;
}

// Forward declaration for dynamic camera resolution via backend
String httpGet(const String &path);

void cacheCameraIp(const String &ip) {
  if (ip.length() == 0) return;

  Preferences prefs;
  prefs.begin("labsync", false);
  String existing = prefs.getString("cam_ip", "");
  if (existing != ip) {
    prefs.putString("cam_ip", ip);
  }
  prefs.end();
}

void setCameraIp(const String &ip, const char *source, bool cacheIp = true) {
  if (ip.length() == 0) return;

  String newBaseUrl = "http://" + ip;
  bool changed = (cameraBaseUrl != newBaseUrl);
  cameraBaseUrl = newBaseUrl;

  if (changed) {
    Serial.print("ESP32-CAM resolved via ");
    Serial.print(source);
    Serial.print(": ");
    Serial.println(cameraBaseUrl);
  }

  if (cacheIp) {
    cacheCameraIp(ip);
  }
}

bool startCameraDiscoveryUDP() {
  if (WiFi.status() != WL_CONNECTED) return false;

  if (cameraUdpStarted) {
    cameraDiscoveryUdp.stop();
    cameraUdpStarted = false;
  }

  if (!cameraDiscoveryUdp.begin(CAMERA_DISCOVERY_PORT)) {
    Serial.println("Camera UDP discovery failed to start");
    return false;
  }

  cameraUdpStarted = true;
  Serial.print("Camera UDP discovery listening on port ");
  Serial.println(CAMERA_DISCOVERY_PORT);
  return true;
}

bool processCameraUdpAnnouncement(uint32_t waitMs = 0) {
  if (WiFi.status() != WL_CONNECTED) return false;

  if (!cameraUdpStarted && !startCameraDiscoveryUDP()) return false;

  unsigned long start = millis();

  do {
    int packetSize = cameraDiscoveryUdp.parsePacket();
    if (packetSize > 0) {
      char packet[160];
      int len = cameraDiscoveryUdp.read(packet, sizeof(packet) - 1);
      if (len > 0) {
        packet[len] = '\0';
        String msg(packet);
        msg.trim();

        const String prefix = "espcam_ip=";
        if (msg.startsWith(prefix)) {
          String ip = msg.substring(prefix.length());
          ip.trim();

          IPAddress parsed;
          if (parsed.fromString(ip)) {
            setCameraIp(ip, "UDP", true);
            return true;
          }
        }
      }
    }

    if (waitMs == 0) break;

    delay(10);
  }
  while (millis() - start < waitMs);

  return false;
}

bool resolveCamera() {
  if (WiFi.status() != WL_CONNECTED) {
    cameraBaseUrl = "";
    return false;
  }

  // =========================================================
  // TIER 1: UDP CAMERA ANNOUNCEMENT
  // Usually cameraBaseUrl is already populated in loop().
  // Keep the on-demand wait short so access flow stays responsive.
  // =========================================================
  Serial.println("Trying ESP32-CAM UDP discovery...");

  if (processCameraUdpAnnouncement(450)) {
    return true;
  }

  // =========================================================
  // TIER 2: mDNS - esp32cam.local
  // =========================================================
  if (!mdnsStarted) {
    startMainMDNS();
  }

  if (mdnsStarted) {
    Serial.println("Trying mDNS discovery: esp32cam.local...");

    IPAddress camIp =
        MDNS.queryHost(
            CAMERA_MDNS_NAME,
            900);

    if (!ipIsZero(camIp)) {
      setCameraIp(
          camIp.toString(),
          "mDNS",
          true);

      return true;
    }
  }

  // =========================================================
  // TIER 3: LAST KNOWN CAMERA IP FROM NVS
  // Fast local fallback. startCamera() will reject it and
  // rediscover if the cached DHCP address is stale.
  // =========================================================
  Preferences prefs;
  prefs.begin("labsync", true);
  String cachedIp =
      prefs.getString(
          "cam_ip",
          "");
  prefs.end();

  if (cachedIp.length() > 0) {
    IPAddress parsed;

    if (parsed.fromString(cachedIp)) {
      setCameraIp(
          cachedIp,
          "NVS cache",
          false);

      return true;
    }
  }

  // =========================================================
  // TIER 4: BACKEND DYNAMIC CAMERA REGISTRY
  // =========================================================
  Serial.println(
      "Querying backend registry for camera IP...");

  String response =
      httpGet(
          "/api/esp32/camera-ip/" +
          String(ROOM_ID));

  if (response.length() > 0) {
    StaticJsonDocument<256> doc;

    DeserializationError err =
        deserializeJson(
            doc,
            response);

    if (
        !err &&
        (doc["success"] | false)) {
      const char *dynIp =
          doc["ip"] | "";

      IPAddress parsed;

      if (
          strlen(dynIp) > 0 &&
          parsed.fromString(dynIp)) {
        setCameraIp(
            String(dynIp),
            "backend registry",
            true);

        return true;
      }
    }
  }

  // =========================================================
  // TIER 5: MANUAL FALLBACK
  // =========================================================
  if (strlen(CAMERA_IP_FALLBACK) > 0) {
    String fallback =
        CAMERA_IP_FALLBACK;

    IPAddress parsed;

    if (parsed.fromString(fallback)) {
      setCameraIp(
          fallback,
          "manual fallback",
          false);

      return true;
    }
  }

  cameraBaseUrl = "";

  Serial.println(
      "All camera discovery methods failed");

  return false;
}

// ============================================================
// CAMERA COMMAND
// ============================================================

bool sendCameraCmd(const char *path) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(
        "Camera command skipped: WiFi disconnected");

    return false;
  }

  if (cameraBaseUrl.length() == 0) {
    if (!resolveCamera()) {
      return false;
    }
  }

  NetworkClient client;
  HTTPClient http;

  // /start includes OV2640 initialization, but it normally
  // completes well below these limits.
  http.setConnectTimeout(1500);
  http.setTimeout(4000);
  http.useHTTP10(true);

  String url =
      cameraBaseUrl +
      path;

  Serial.println(
      "Camera request: " +
      url);

  if (!http.begin(
          client,
          url)) {
    cameraBaseUrl = "";
    return false;
  }

  int code =
      http.GET();

  String response = "";

  if (code > 0) {
    response =
        http.getString();
  }

  http.end();

  if (code == HTTP_CODE_OK) {
    Serial.println(
        "Camera response: " +
        response);

    return true;
  }

  Serial.printf(
      "Camera HTTP error: %d\n",
      code);

  cameraBaseUrl = "";

  return false;
}

// ============================================================
// START CAMERA
// ============================================================

bool startCamera() {
  Serial.println( "Waking ESP32-CAM camera..." );

  if ( cameraBaseUrl.length() == 0) {
    if (!resolveCamera()) {
      cameraStreaming = false;

      return false;
    }

  }

  if (sendCameraCmd("/start")) {
    cameraStreaming = true;

    Serial.println( "Camera ACTIVE" );

    return true;

  }

  // IP may have changed.
  cameraBaseUrl = "";

  if (!resolveCamera()) {
    cameraStreaming = false;

    return false;

  }

  if (sendCameraCmd("/start")) {
    cameraStreaming = true;

    return true;

  }

  cameraStreaming = false;

  return false;
}

// ============================================================
// STOP CAMERA / RETURN CAMERA TO STANDBY
// ============================================================

void stopCamera() {
  if (!cameraStreaming) return;

  Serial.println( "Putting camera into standby..." );

  sendCameraCmd( "/stop" );

  cameraStreaming = false;

  Serial.println( "ESP32-CAM camera now sleeping" );
}

// ============================================================
// JPEG CALLBACK
// ============================================================

bool tftJpegOutput(
    int16_t x,
    int16_t y,
    uint16_t w,
    uint16_t h,
    uint16_t *bitmap) {
  // In portrait mode the QVGA image is intentionally center-cropped
  // from 320 px wide to the 240 px TFT width. Blocks completely
  // outside the screen are ignored WITHOUT stopping JPEG decoding.
  if (
      x >= tft.width() ||
      y >= tft.height() ||
      x + (int16_t)w <= 0 ||
      y + (int16_t)h <= 0) {
    return true;
  }

  tft.drawRGBBitmap(
      x,
      y,
      bitmap,
      w,
      h);

  return true;
}

// ============================================================
// FETCH JPEG
// ============================================================

size_t fetchJpegFrame(
    uint8_t *buf,
    size_t maxLen) {
  if (!cameraStreaming) {
    return 0;
  }

  if (cameraBaseUrl.length() == 0) {
    if (!resolveCamera()) {
      return 0;
    }
  }

  NetworkClient client;
  HTTPClient http;

  // Local camera traffic should be fast. Short bounds prevent
  // a broken camera/network connection from freezing the UI.
  http.setConnectTimeout(1200);
  http.setTimeout(2500);
  http.useHTTP10(true);

  String url =
      cameraBaseUrl +
      "/capture";

  if (!http.begin(
          client,
          url)) {
    cameraBaseUrl = "";
    return 0;
  }

  int code =
      http.GET();

  if (code != HTTP_CODE_OK) {
    Serial.printf(
        "Capture HTTP error: %d\n",
        code);

    http.end();

    return 0;
  }

  int len =
      http.getSize();

  if (len <= 0) {
    http.end();
    return 0;
  }

  if ((size_t)len > maxLen) {
    Serial.printf(
        "JPEG too large: %d bytes (buffer %u)\n",
        len,
        (unsigned int)maxLen);

    http.end();

    return 0;
  }

  NetworkClient *stream =
      http.getStreamPtr();

  size_t received = 0;
  unsigned long lastData =
      millis();

  while (received < (size_t)len) {
    int available =
        stream->available();

    if (available > 0) {
      size_t remaining =
          (size_t)len -
          received;

      size_t toRead =
          (size_t)available;

      if (toRead > remaining) {
        toRead = remaining;
      }

      if (toRead > 4096) {
        toRead = 4096;
      }

      int got =
          stream->read(
              buf + received,
              toRead);

      if (got > 0) {
        received +=
            (size_t)got;

        lastData =
            millis();
      }
    }
    else {
      if (
          millis() -
              lastData >
          1200) {
        break;
      }

      delay(1);
    }
  }

  http.end();

  if (received != (size_t)len) {
    Serial.printf(
        "Incomplete JPEG: %u/%d bytes\n",
        (unsigned int)received,
        len);

    return 0;
  }

  return received;
}

// ============================================================
// CAMERA TFT SCREEN
// ============================================================

void prepareCameraScreen(
    const String &mode,
    const String &name) {
  tft.fillScreen(COLOR_BG);

  tft.fillRect(
      0,
      0,
      tft.width(),
      HEADER_HEIGHT,
      COLOR_CYAN);

  tft.setTextColor(
      COLOR_BG,
      COLOR_CYAN);

  tft.setTextSize(1);

  tft.setCursor(
      5,
      8);

  tft.print(mode);

  // Dedicated one-line name area above the 240 x 240 camera crop.
  tft.fillRect(
      0,
      HEADER_HEIGHT,
      tft.width(),
      CAMERA_NAME_HEIGHT,
      COLOR_BG);

  if (name.length() > 0) {
    tft.setTextColor(
        COLOR_WHITE,
        COLOR_BG);

    tft.setCursor(
        5,
        HEADER_HEIGHT + 3);

    tft.print(name);
  }
}

// ============================================================
// FACE BOUNDING BOX & TFT PROJECTION
// ============================================================

struct FaceBox {
  int x;
  int y;
  int w;
  int h;
  bool valid;
};

// Explicit prototypes are required in an Arduino .ino when functions use
// user-defined types. They prevent the Arduino preprocessor from creating
// invalid auto-prototypes before FaceBox is declared.
void drawDynamicFaceBox(
    int x,
    int y,
    int w,
    int h,
    uint16_t color);

bool postFaceVerify(
    const String &userId,
    const String &roomId,
    uint8_t *jpegBuf,
    size_t jpegLen,
    FaceBox *outBox);

bool postFaceEnroll(
    const String &userId,
    uint8_t *jpegBuf,
    size_t jpegLen,
    FaceBox *outBox);

void drawCameraFaceBox(
    const FaceBox &box,
    uint16_t color);

static int16_t lastJpegDrawX = 0;
static int16_t lastJpegDrawY = 0;
static uint8_t lastJpegScale = 1;

void drawDynamicFaceBox(
    int x,
    int y,
    int w,
    int h,
    uint16_t color) {
  const int16_t minY =
      HEADER_HEIGHT +
      CAMERA_NAME_HEIGHT;

  const int16_t maxY =
      tft.height() -
      STATUS_HEIGHT -
      2;

  const int16_t minX = 0;
  const int16_t maxX =
      tft.width();

  if (x < minX) {
    w -= (minX - x);
    x = minX;
  }

  if (y < minY) {
    h -= (minY - y);
    y = minY;
  }

  if (x + w > maxX) {
    w = maxX - x;
  }

  if (y + h > maxY) {
    h = maxY - y;
  }

  if (w <= 10 || h <= 10) {
    return;
  }

  // Thin two-pixel box.
  tft.drawRect(
      x,
      y,
      w,
      h,
      color);

  if (w > 4 && h > 4) {
    tft.drawRect(
        x + 1,
        y + 1,
        w - 2,
        h - 2,
        color);
  }

  int k =
      min(
          14,
          min(
              w / 3,
              h / 3));

  if (k > 3) {
    tft.drawFastHLine(
        x,
        y,
        k,
        color);

    tft.drawFastVLine(
        x,
        y,
        k,
        color);

    tft.drawFastHLine(
        x + w - k,
        y,
        k,
        color);

    tft.drawFastVLine(
        x + w - 1,
        y,
        k,
        color);

    tft.drawFastHLine(
        x,
        y + h - 1,
        k,
        color);

    tft.drawFastVLine(
        x,
        y + h - k,
        k,
        color);

    tft.drawFastHLine(
        x + w - k,
        y + h - 1,
        k,
        color);

    tft.drawFastVLine(
        x + w - 1,
        y + h - k,
        k,
        color);
  }
}

// ============================================================
// DISPLAY JPEG
// ============================================================

bool displayJpegOnTFT(
    uint8_t *buf,
    size_t len) {
  uint16_t jpegWidth = 0;
  uint16_t jpegHeight = 0;

  if (
      TJpgDec.getJpgSize(
          &jpegWidth,
          &jpegHeight,
          buf,
          len) != JDR_OK) {
    return false;
  }

  const int16_t cameraTop =
      HEADER_HEIGHT +
      CAMERA_NAME_HEIGHT;

  const int16_t cameraBottom =
      tft.height() -
      STATUS_HEIGHT -
      2;

  const int16_t availableWidth =
      tft.width();

  const int16_t availableHeight =
      cameraBottom -
      cameraTop;

  uint8_t scale = 1;

  // Portrait mode:
  // A 320 x 240 QVGA frame is kept at full vertical resolution and
  // center-cropped horizontally to the 240 px-wide portrait TFT.
  // This makes the face much larger than using TJpgDec scale=2.
  bool usePortraitCenterCrop =
      (tft.height() > tft.width()) &&
      (jpegHeight <= (uint16_t)availableHeight) &&
      (jpegWidth > (uint16_t)availableWidth);

  if (!usePortraitCenterCrop) {
    while (
        ((jpegWidth / scale) >
             availableWidth ||
         (jpegHeight / scale) >
             availableHeight) &&
        scale < 8) {
      scale *= 2;
    }
  }

  TJpgDec.setJpgScale(scale);

  int16_t drawWidth =
      jpegWidth /
      scale;

  int16_t drawHeight =
      jpegHeight /
      scale;

  int16_t x =
      (availableWidth -
       drawWidth) /
      2;

  int16_t y =
      cameraTop +
      ((availableHeight -
        drawHeight) /
       2);

  lastJpegDrawX = x;
  lastJpegDrawY = y;
  lastJpegScale = scale;

  return
      TJpgDec.drawJpg(
          x,
          y,
          buf,
          len) == JDR_OK;
}

// ============================================================
// FACE RETICLE VIEWFINDER
// ============================================================

void drawFaceReticle(uint16_t color) {
  const int16_t cameraTop =
      HEADER_HEIGHT +
      CAMERA_NAME_HEIGHT;

  const int16_t cameraBottom =
      tft.height() -
      STATUS_HEIGHT -
      2;

  int16_t cx =
      tft.width() /
      2;

  int16_t cy =
      cameraTop +
      ((cameraBottom -
        cameraTop) /
       2);

  int16_t w = 105;
  int16_t h = 145;

  int16_t x0 =
      cx -
      w / 2;

  int16_t y0 =
      cy -
      h / 2;

  int16_t k = 14;

  // Top-Left
  tft.drawFastHLine(x0, y0, k, color);
  tft.drawFastHLine(x0, y0 + 1, k, color);
  tft.drawFastVLine(x0, y0, k, color);
  tft.drawFastVLine(x0 + 1, y0, k, color);

  // Top-Right
  tft.drawFastHLine(x0 + w - k, y0, k, color);
  tft.drawFastHLine(x0 + w - k, y0 + 1, k, color);
  tft.drawFastVLine(x0 + w, y0, k, color);
  tft.drawFastVLine(x0 + w - 1, y0, k, color);

  // Bottom-Left
  tft.drawFastHLine(x0, y0 + h, k, color);
  tft.drawFastHLine(x0, y0 + h - 1, k, color);
  tft.drawFastVLine(x0, y0 + h - k, k, color);
  tft.drawFastVLine(x0 + 1, y0 + h - k, k, color);

  // Bottom-Right
  tft.drawFastHLine(x0 + w - k, y0 + h, k, color);
  tft.drawFastHLine(x0 + w - k, y0 + h - 1, k, color);
  tft.drawFastVLine(x0 + w, y0 + h - k, k, color);
  tft.drawFastVLine(x0 + w - 1, y0 + h - k, k, color);
}

// ============================================================
// HTTP GET
// ============================================================

String httpGet( const String &path) {
  if ( WiFi.status() != WL_CONNECTED) {
    connectWiFi( systemState == STATE_ACTIVE );
  }

  if ( WiFi.status() != WL_CONNECTED) {
    return "";
  }

  String url = activeServerUrl + path;

  HTTPClient http;

  http.setFollowRedirects( HTTPC_STRICT_FOLLOW_REDIRECTS );

  http.setConnectTimeout( 10000 );

  http.setTimeout( 15000 );

  String body = "";

  if ( url.startsWith( "https://")) {
    WiFiClientSecure client;

    client.setInsecure();

    client.setHandshakeTimeout( 10 );

    if (!http.begin( client, url)) {
      return "";
    }

    int code = http.GET();

    if ( code == HTTP_CODE_OK) {
      body = http.getString();
    }

    http.end();

  }
  else {
    NetworkClient client;

    if (!http.begin( client, url)) {
      return "";
    }

    int code = http.GET();

    if ( code == HTTP_CODE_OK) {
      body = http.getString();
    }

    http.end();

  }

  return body;
}

// ============================================================
// HTTP POST JSON
// ============================================================

String httpPostJson( const String &path, const String &jsonBody) {
  if ( WiFi.status() != WL_CONNECTED) {
    connectWiFi( systemState == STATE_ACTIVE );
  }

  if ( WiFi.status() != WL_CONNECTED) {
    return "";
  }

  String url = activeServerUrl + path;

  HTTPClient http;

  http.setFollowRedirects( HTTPC_STRICT_FOLLOW_REDIRECTS );

  http.setConnectTimeout( 10000 );

  http.setTimeout( 15000 );

  String body = "";

  if ( url.startsWith( "https://")) {
    WiFiClientSecure client;

    client.setInsecure();

    client.setHandshakeTimeout( 10 );

    if (!http.begin( client, url)) {
      return "";
    }

    http.addHeader( "Content-Type", "application/json" );

    int code = http.POST( jsonBody );

    if (code > 0) {
      body = http.getString();
    }

    http.end();

  }
  else {
    NetworkClient client;

    if (!http.begin( client, url)) {
      return "";
    }

    http.addHeader( "Content-Type", "application/json" );

    int code = http.POST( jsonBody );

    if (code > 0) {
      body = http.getString();
    }

    http.end();

  }

  return body;
}

// ============================================================
// MULTIPART UPLOAD
// ============================================================

bool postMultipartStreaming( const String &path, const String &part1, uint8_t *jpegBuf, size_t jpegLen, const String &part3, String &outResp) {
  if ( WiFi.status() != WL_CONNECTED) {
    connectWiFi(false);
  }

  if ( WiFi.status() != WL_CONNECTED) {
    return false;
  }

  String server = activeServerUrl;

  bool https = server.startsWith( "https://" );

  int protocolPos = server.indexOf( "://" );

  String hostPort = protocolPos >= 0 ? server.substring( protocolPos + 3) : server;

  while ( hostPort.endsWith("/")) {
    hostPort.remove( hostPort.length() - 1 );
  }

  String host = hostPort;

  int port = https ? 443 : 80;

  int colon = hostPort.indexOf(':');

  if (colon >= 0) {
    host = hostPort.substring( 0, colon );

    port = hostPort.substring( colon + 1 ).toInt();

  }

  const String boundary = "----LabSyncBoundary7344";

  size_t totalLength = part1.length() + jpegLen + part3.length();

  String response = "";

  if (https) {
    WiFiClientSecure client;

    client.setInsecure();
    client.setHandshakeTimeout(15);
    client.setTimeout(FACE_UPLOAD_TIMEOUT_MS);

    Serial.printf("[HTTPS] Connecting to %s:%d...\n", host.c_str(), port);

    if (!client.connect( host.c_str(), port)) {
      Serial.printf("[HTTPS] Connection to %s failed!\n", host.c_str());
      return false;
    }

    Serial.printf("[HTTPS] Uploading %s (%u bytes)...\n", path.c_str(), (unsigned int)totalLength);

    client.printf( "POST %s HTTP/1.1\r\n", path.c_str() );

    client.printf( "Host: %s\r\n", host.c_str() );

    client.printf( "Content-Type: multipart/form-data; boundary=%s\r\n", boundary.c_str() );

    client.printf( "Content-Length: %u\r\n", (unsigned int)totalLength );

    client.print( "Connection: close\r\n\r\n" );

    client.print(part1);

    size_t sent = 0;

    while ( sent < jpegLen && client.connected()) {
      size_t remaining = jpegLen - sent;

      size_t chunk = remaining > 1024 ? 1024 : remaining;

      size_t written = client.write( jpegBuf + sent, chunk );

      if (written == 0) break;

      sent += written;
    }

    client.print(part3);

    client.flush();

    unsigned long start = millis();

    while ( !client.available() && client.connected() && millis() - start < FACE_UPLOAD_TIMEOUT_MS) {
      delay(5);
    }

    unsigned long lastData = millis();

    while ( client.connected() || client.available()) {
      while ( client.available()) {
        response += (char)client.read();

        lastData = millis();
      }

      if ( millis() - lastData > FACE_UPLOAD_TIMEOUT_MS) {
        break;
      }

      delay(1);
    }

    client.stop();

    Serial.printf("[HTTPS] Response (%d bytes): %s\n", response.length(), response.substring(0, 100).c_str());

  }
  else {
    NetworkClient client;

    client.setTimeout(FACE_UPLOAD_TIMEOUT_MS);

    if (!client.connect( host.c_str(), port)) {
      return false;
    }

    client.printf( "POST %s HTTP/1.1\r\n", path.c_str() );

    client.printf( "Host: %s:%d\r\n", host.c_str(), port );

    client.printf( "Content-Type: multipart/form-data; boundary=%s\r\n", boundary.c_str() );

    client.printf( "Content-Length: %u\r\n", (unsigned int)totalLength );

    client.print( "Connection: close\r\n\r\n" );

    client.print(part1);

    size_t sent = 0;

    while ( sent < jpegLen && client.connected()) {
      size_t remaining = jpegLen - sent;

      size_t chunk = remaining > 1024 ? 1024 : remaining;

      size_t written = client.write( jpegBuf + sent, chunk );

      if (written == 0) break;

      sent += written;
    }

    client.print(part3);

    client.flush();

    unsigned long start = millis();

    while ( !client.available() && client.connected() && millis() - start < FACE_UPLOAD_TIMEOUT_MS) {
      delay(5);
    }

    unsigned long lastData = millis();

    while ( client.connected() || client.available()) {
      while ( client.available()) {
        response += (char)client.read();

        lastData = millis();
      }

      if ( millis() - lastData > FACE_UPLOAD_TIMEOUT_MS) {
        break;
      }

      delay(1);
    }

    client.stop();

  }

  outResp = response;

  int bodyStart = response.indexOf( "\r\n\r\n" );

  if (bodyStart >= 0) {
    outResp = response.substring( bodyStart + 4 );
  }

  bool httpSuccess = response.startsWith("HTTP/1.1 2") || response.startsWith("HTTP/1.0 2");

  return httpSuccess;
}

// ============================================================
// FACE VERIFY
// ============================================================

bool postFaceVerify( const String &userId, const String &roomId, uint8_t *jpegBuf, size_t jpegLen, FaceBox *outBox) {
  const String boundary = "----LabSyncBoundary7344";

  const String CRLF = "\r\n";

  String part1 = "--" + boundary + CRLF +

  "Content-Disposition: form-data; name=\"userId\"" + CRLF + CRLF + userId + CRLF +

  "--" + boundary + CRLF +

  "Content-Disposition: form-data; name=\"roomId\"" + CRLF + CRLF + roomId + CRLF +

  "--" + boundary + CRLF +

  "Content-Disposition: form-data; name=\"faceImage\"; filename=\"face.jpg\"" + CRLF +

  "Content-Type: image/jpeg" + CRLF + CRLF;

  String part3 = CRLF + "--" + boundary + "--" + CRLF;

  String response;

  bool ok = postMultipartStreaming( "/api/face/verify", part1, jpegBuf, jpegLen, part3, response );

  if (!ok && response.indexOf("\"success\"") < 0) return false;

  DynamicJsonDocument doc(1024);

  // Clean JSON boundary extraction
  int jsonStart = response.indexOf('{');
  int jsonEnd = response.lastIndexOf('}');
  String jsonBody = (jsonStart >= 0 && jsonEnd > jsonStart) ? response.substring(jsonStart, jsonEnd + 1) : response;

  if ( deserializeJson( doc, jsonBody ) != DeserializationError::Ok) {
    Serial.println( "JSON parse note: falling back to string match" );
    return false;
  }

  bool success = doc["success"] | false;

  float confidence = doc["confidence"] | 0.0f;

  if (outBox != nullptr) {
    if (doc.containsKey("box") && !doc["box"].isNull()) {
      outBox->x = doc["box"]["x"] | 0;
      outBox->y = doc["box"]["y"] | 0;
      outBox->w = doc["box"]["w"] | 0;
      outBox->h = doc["box"]["h"] | 0;
      outBox->valid = (outBox->w > 0 && outBox->h > 0);
    }
    else {
      outBox->valid = false;
    }
  }

  Serial.printf( "Face: %s Confidence %.1f%%\n", success ? "MATCH" : "NO MATCH", confidence * 100.0f );

  return success;
}

// ============================================================
// FACE ENROLL
// ============================================================

bool postFaceEnroll( const String &userId, uint8_t *jpegBuf, size_t jpegLen, FaceBox *outBox) {
  const String boundary = "----LabSyncBoundary7344";

  const String CRLF = "\r\n";

  String part1 = "--" + boundary + CRLF +

  "Content-Disposition: form-data; name=\"userId\"" + CRLF + CRLF + userId + CRLF +

  "--" + boundary + CRLF +

  "Content-Disposition: form-data; name=\"faceImage\"; filename=\"face.jpg\"" + CRLF +

  "Content-Type: image/jpeg" + CRLF + CRLF;

  String part3 = CRLF + "--" + boundary + "--" + CRLF;

  String response;

  bool ok = postMultipartStreaming( "/api/face/enroll-hardware", part1, jpegBuf, jpegLen, part3, response );

  if (!ok && response.indexOf("\"success\"") < 0) {
    Serial.printf("[FACE-ENROLL] Network/HTTP error. Response len: %d\n", response.length());
    return false;
  }

  int jsonStart = response.indexOf('{');
  int jsonEnd = response.lastIndexOf('}');
  String jsonBody = (jsonStart >= 0 && jsonEnd > jsonStart) ? response.substring(jsonStart, jsonEnd + 1) : response;

  DynamicJsonDocument doc(1024);

  if ( deserializeJson( doc, jsonBody ) != DeserializationError::Ok) {
    Serial.printf("[FACE-ENROLL] JSON parse error: %s\n", jsonBody.substring(0, 100).c_str());
    return false;
  }

  bool success = (doc["success"] | false) || (doc["finalized"] | false);
  const char* serverMsg = doc["message"] | "";
  Serial.printf("[FACE-ENROLL] Server Result: success=%s, finalized=%s, msg=\"%s\"\n", 
    (doc["success"] | false) ? "true" : "false",
    (doc["finalized"] | false) ? "true" : "false",
    serverMsg);

  if (outBox != nullptr) {
    if (doc.containsKey("box") && !doc["box"].isNull()) {
      outBox->x = doc["box"]["x"] | 0;
      outBox->y = doc["box"]["y"] | 0;
      outBox->w = doc["box"]["w"] | 0;
      outBox->h = doc["box"]["h"] | 0;
      outBox->valid = (outBox->w > 0 && outBox->h > 0);
    }
    else {
      outBox->valid = false;
    }
  }

  return success;
}

// ============================================================
// ASYNCHRONOUS FACE SERVER REQUEST
// ============================================================
// Camera preview and TFT drawing stay on the normal execution path.
// HTTPS face verification/enrollment runs in a separate FreeRTOS task
// using a copy of the selected QVGA JPEG. This prevents the live screen
// from waiting for the backend response.
// ============================================================

enum FaceRequestMode {
  FACE_REQUEST_NONE,
  FACE_REQUEST_VERIFY,
  FACE_REQUEST_ENROLL
};

// Explicit prototypes for functions that use FaceRequestMode.
// This avoids Arduino's auto-prototype generator placing declarations
// before the enum definition.
uint32_t beginFaceSession();
void faceRequestWorker(void *parameter);

bool startFaceRequestAsync(
    FaceRequestMode mode,
    uint32_t session,
    const String &userId,
    const String &roomId,
    const uint8_t *jpeg,
    size_t jpegLen);

bool takeFaceResult(
    uint32_t session,
    FaceRequestMode expectedMode,
    bool &success,
    FaceBox &box);

volatile bool faceRequestBusy = false;
volatile bool faceResultReady = false;

FaceRequestMode faceRequestMode = FACE_REQUEST_NONE;
FaceRequestMode faceResultMode = FACE_REQUEST_NONE;

String faceRequestUserId = "";
String faceRequestRoomId = "";

uint8_t *faceRequestJpeg = nullptr;
size_t faceRequestJpegLen = 0;

uint32_t faceSessionCounter = 0;
uint32_t faceRequestSession = 0;
uint32_t faceResultSession = 0;

bool faceResultSuccess = false;
FaceBox faceResultBox = {0, 0, 0, 0, false};

TaskHandle_t faceRequestTaskHandle = nullptr;

uint32_t beginFaceSession()
{
  faceSessionCounter++;

  if (faceSessionCounter == 0) {
    faceSessionCounter = 1;
  }

  // Any result from an older session is no longer relevant.
  faceResultReady = false;

  return faceSessionCounter;
}

void faceRequestWorker(void *parameter)
{
  (void)parameter;

  FaceBox box = {0, 0, 0, 0, false};
  bool success = false;

  FaceRequestMode mode =
      faceRequestMode;

  uint32_t session =
      faceRequestSession;

  if (
      faceRequestJpeg != nullptr &&
      faceRequestJpegLen > 0) {
    if (mode == FACE_REQUEST_VERIFY) {
      success =
          postFaceVerify(
              faceRequestUserId,
              faceRequestRoomId,
              faceRequestJpeg,
              faceRequestJpegLen,
              &box);
    }
    else if (mode == FACE_REQUEST_ENROLL) {
      success =
          postFaceEnroll(
              faceRequestUserId,
              faceRequestJpeg,
              faceRequestJpegLen,
              &box);
    }
  }

  if (faceRequestJpeg != nullptr) {
    free(faceRequestJpeg);
    faceRequestJpeg = nullptr;
  }

  faceRequestJpegLen = 0;

  faceResultSuccess = success;
  faceResultBox = box;
  faceResultMode = mode;
  faceResultSession = session;

  // Publish the result only after all fields above are complete.
  faceResultReady = true;
  faceRequestBusy = false;
  faceRequestTaskHandle = nullptr;

  vTaskDelete(nullptr);
}

bool startFaceRequestAsync(
    FaceRequestMode mode,
    uint32_t session,
    const String &userId,
    const String &roomId,
    const uint8_t *jpeg,
    size_t jpegLen)
{
  if (
      faceRequestBusy ||
      faceResultReady ||
      jpeg == nullptr ||
      jpegLen <= MIN_FACE_JPEG_BYTES) {
    return false;
  }

  uint8_t *copy =
      static_cast<uint8_t *>(
          malloc(jpegLen));

  if (copy == nullptr) {
    Serial.printf(
        "Face request skipped: cannot allocate %u-byte JPEG copy\n",
        (unsigned int)jpegLen);

    return false;
  }

  memcpy(
      copy,
      jpeg,
      jpegLen);

  faceRequestMode = mode;
  faceRequestSession = session;
  faceRequestUserId = userId;
  faceRequestRoomId = roomId;
  faceRequestJpeg = copy;
  faceRequestJpegLen = jpegLen;
  faceRequestBusy = true;

  BaseType_t created =
      xTaskCreate(
          faceRequestWorker,
          "faceHttp",
          16384,
          nullptr,
          1,
          &faceRequestTaskHandle);

  if (created != pdPASS) {
    free(faceRequestJpeg);
    faceRequestJpeg = nullptr;
    faceRequestJpegLen = 0;
    faceRequestBusy = false;
    faceRequestTaskHandle = nullptr;

    Serial.println(
        "Face request task creation failed");

    return false;
  }

  return true;
}

bool takeFaceResult(
    uint32_t session,
    FaceRequestMode expectedMode,
    bool &success,
    FaceBox &box)
{
  if (!faceResultReady) {
    return false;
  }

  uint32_t resultSession =
      faceResultSession;

  FaceRequestMode resultMode =
      faceResultMode;

  success =
      faceResultSuccess;

  box =
      faceResultBox;

  faceResultReady = false;

  if (
      resultSession != session ||
      resultMode != expectedMode) {
    return false;
  }

  return true;
}

void drawCameraFaceBox(
    const FaceBox &box,
    uint16_t color)
{
  if (!box.valid) {
    return;
  }

  int bx =
      lastJpegDrawX +
      (box.x /
       lastJpegScale);

  int by =
      lastJpegDrawY +
      (box.y /
       lastJpegScale);

  int bw =
      box.w /
      lastJpegScale;

  int bh =
      box.h /
      lastJpegScale;

  drawDynamicFaceBox(
      bx,
      by,
      bw,
      bh,
      color);
}


// ============================================================
// USER LOOKUP
// ============================================================

bool getUserByFingerId( int fingerId, String &outUserId, String &outUserName, String &outRole, bool &outFaceEnrolled) {
  String response = httpGet( "/api/esp32/user-by-finger/" + String(fingerId) );

  if ( response.length() == 0) {
    return false;
  }

  DynamicJsonDocument doc(512);

  if ( deserializeJson( doc, response ) != DeserializationError::Ok) {
    return false;
  }

  if ( !(doc["found"] | false)) {
    return false;
  }

  outUserId = doc["userId"] | "";

  outUserName = doc["userName"] | "";

  outRole = doc["role"] | "user";

  outFaceEnrolled = doc["faceEnrolled"] | false;

  return outUserId.length() > 0;
}

// Overload for backward compatibility
bool getUserByFingerId( int fingerId, String &outUserId, String &outUserName, String &outRole) {
  bool dummyFace = false;
  return getUserByFingerId(fingerId, outUserId, outUserName, outRole, dummyFace);
}

bool getUserByFingerId( int fingerId, String &outUserId, String &outUserName) {
  String dummyRole = "user";
  bool dummyFace = false;
  return getUserByFingerId(fingerId, outUserId, outUserName, dummyRole, dummyFace);
}

// ============================================================
// NEXT AVAILABLE USER FOR HARDWARE ENROLLMENT
// ============================================================

bool getNextAvailableUser( String &outUserId, String &outUserName, String &outRole, const String &requestedRole = "") {
  String path = "/api/esp32/next-available-user";
  if (requestedRole.length() > 0) {
    path += "?role=" + requestedRole;
  }

  String response = httpGet(path);

  if ( response.length() == 0) {
    return false;
  }

  DynamicJsonDocument doc(512);

  if ( deserializeJson( doc, response ) != DeserializationError::Ok) {
    return false;
  }

  if ( !(doc["found"] | false)) {
    return false;
  }

  outUserId = doc["userId"] | "";

  outUserName = doc["userName"] | "";

  outRole = doc["role"] | "user";

  return outUserId.length() > 0;
}

// ============================================================
// FINGERPRINT VERIFIED
// ============================================================

void notifyFingerprintVerified(const String &userId, int fingerId) {
  StaticJsonDocument<256> doc;
  doc["roomId"] = ROOM_ID;
  doc["userId"] = userId;
  doc["fingerId"] = fingerId;

  String body;
  serializeJson(doc, body);
  httpPostJson("/api/esp32/fingerprint-verified", body);
}

// ============================================================
// DOOR
// ============================================================

void openDoor() {
  tftShowFullScreen("ACCESS GRANTED", "Door opening", COLOR_GREEN);
  tftShowStatus("Door unlocked", "5 seconds", COLOR_GREEN);

  digitalWrite(RELAY_PIN, HIGH);
  delay(RELAY_OPEN_MS);
  digitalWrite(RELAY_PIN, LOW);

  StaticJsonDocument<128> doc;
  doc["roomId"] = ROOM_ID;

  String body;
  serializeJson(doc, body);
  httpPostJson("/api/esp32/door-closed", body);
}

// ============================================================
// HEARTBEAT
// ============================================================

void sendHeartbeat() {
  unsigned long now = millis();

  if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;

  if (WiFi.status() != WL_CONNECTED) return;

  lastHeartbeat = now;

  StaticJsonDocument<320> doc;
  doc["roomId"] = ROOM_ID;
  doc["deviceId"] = "ESP32-" + String(ROOM_ID);
  doc["rssi"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["uptime"] = millis() / 1000;

  String body;
  serializeJson(doc, body);
  httpPostJson("/api/esp32/heartbeat", body);
}

// ============================================================
// ENROLLMENT ERRORS
// ============================================================

String getFingerprintErrorString( int p) {
  switch (p) {
  case 0x01:
    return "Communication error";

  case 0x02:
    return "Imaging error";

  case 0x03:
    return "Bad image packet";

  case 0x06:
    return "Image too messy";

  case 0x07:
    return "Features not found";

  case 0x08:
    return "Invalid image";

  case 0x0A:
    return "Fingerprints mismatch";

  case 0x0B:
    return "Invalid storage";

  case 0x18:
    return "Flash error";

  case 0x1F:
    return "Conversion failed";

  default:
    return "Unknown (" + String(p) + ")";

  }
}

void reportEnrollmentFailure( const String &userId, const String &userName, int errorCode, const String &stage) {
  StaticJsonDocument<512> doc;
  doc["userId"] = userId;
  doc["userName"] = userName;
  doc["error"] = getFingerprintErrorString(errorCode);
  doc["details"] = "Code " + String(errorCode) + " at " + stage;

  String body;
  serializeJson(doc, body);
  httpPostJson("/api/esp32/enrollment-failed", body);
}

// ============================================================
// STEP 2: FACE REGISTRATION (STANDALONE & DUAL RE-ENROLLMENT)
// ============================================================

bool runFaceRegistrationOnly(const String &userId, const String &userName, const String &role = "user") {
  tftShowFullScreen( "ENROLL STEP 2/2", "Waking camera...", COLOR_CYAN );

  if (!startCamera()) {
    tftShowFullScreen( "CAMERA ERROR", "Unable to wake camera", COLOR_RED );
    delay(2000);
    return false;
  }

  prepareCameraScreen( "FACE REGISTRATION", userName );

  bool faceEnrolled = false;
  uint32_t faceSession = beginFaceSession();
  unsigned long start = millis();
  unsigned long lastFaceRequest = 0;
  FaceBox overlayBox = {0, 0, 0, 0, false};
  uint16_t overlayColor = COLOR_YELLOW;
  uint16_t reticleColor = COLOR_YELLOW;

  while (millis() - start < LIVE_VIEW_TIME_MS && !faceEnrolled) {
    bool resultSuccess = false;
    FaceBox resultBox = {0, 0, 0, 0, false};

    if (takeFaceResult(faceSession, FACE_REQUEST_ENROLL, resultSuccess, resultBox)) {
      overlayBox = resultBox;
      faceEnrolled = resultSuccess;
      overlayColor = faceEnrolled ? COLOR_GREEN : COLOR_RED;
      reticleColor = faceEnrolled ? COLOR_GREEN : COLOR_RED;
    }

    size_t jpegLen = fetchJpegFrame(jpegBuffer, jpegBufferCapacity);
    if (jpegLen > 0) {
      displayJpegOnTFT(jpegBuffer, jpegLen);
      drawFaceReticle(reticleColor);

      if (overlayBox.valid) {
        drawCameraFaceBox(overlayBox, overlayColor);
      }

      if (faceEnrolled) {
        tftShowStatus("Face Captured!", "Biometrics locked", COLOR_GREEN);
        delay(500);
        break;
      }

      if (faceRequestBusy) {
        tftShowStatus("Align face in frame", "Checking image...", COLOR_CYAN);
      }
      else {
        tftShowStatus("Align face in frame", "Live preview", COLOR_CYAN);
      }

      unsigned long now = millis();
      if (!faceRequestBusy && !faceResultReady && jpegLen > MIN_FACE_JPEG_BYTES && now - lastFaceRequest >= FACE_REQUEST_INTERVAL_MS) {
        if (startFaceRequestAsync(FACE_REQUEST_ENROLL, faceSession, userId, "", jpegBuffer, jpegLen)) {
          lastFaceRequest = now;
          reticleColor = COLOR_YELLOW;
        }
      }
    }
    delay(10);
  }

  // Grace period while candidate is being evaluated on server (up to 15s)
  unsigned long enrollGraceStart = millis();
  while (!faceEnrolled && faceRequestBusy && millis() - enrollGraceStart < 15000) {
    size_t jpegLen = fetchJpegFrame(jpegBuffer, jpegBufferCapacity);
    if (jpegLen > 0) {
      displayJpegOnTFT(jpegBuffer, jpegLen);
      drawFaceReticle(COLOR_YELLOW);
      if (overlayBox.valid) {
        drawCameraFaceBox(overlayBox, overlayColor);
      }
      tftShowStatus("Align face in frame", "Finishing capture...", COLOR_CYAN);
    }

    bool resultSuccess = false;
    FaceBox resultBox = {0, 0, 0, 0, false};
    if (takeFaceResult(faceSession, FACE_REQUEST_ENROLL, resultSuccess, resultBox)) {
      faceEnrolled = resultSuccess;
      overlayBox = resultBox;
      overlayColor = faceEnrolled ? COLOR_GREEN : COLOR_RED;
      break;
    }
    delay(10);
  }

  stopCamera();

  if (faceEnrolled) {
    tftShowFullScreen( role.equalsIgnoreCase("admin") ? "ADMIN ENROLLED" : "USER ENROLLED", userName, COLOR_GREEN );
    tftShowStatus( "Biometrics Active", "Google Sheets Synced", COLOR_GREEN );
  }
  else {
    tftShowFullScreen( "FACE INCOMPLETE", "Retry from admin menu", COLOR_RED );
  }

  delay(2000);
  return faceEnrolled;
}

// ============================================================
// ENROLLMENT SEQUENCE (STEP 1: FINGERPRINT, STEP 2: FACE)
// ============================================================

bool runEnrollmentSequence( const String &userId, const String &userName, const String &role = "user") {
  if (!fingerprintReady) return false;

  // ------------------------------------------------------------
  // STEP 0: LOCATE NEXT AVAILABLE SENSOR SLOT BEFORE SCANNING
  // (CRITICAL: Prevents loadModel from clobbering CharBuffer 1 after createModel)
  // ------------------------------------------------------------
  int nextId = -1;
  for (int id = 1; id <= finger.capacity; id++) {
    int result = finger.loadModel(id);
    if ( result != FINGERPRINT_OK) {
      nextId = id;
      break;
    }
  }

  if (nextId < 1) {
    tftShowFullScreen( "ENROLL FAILED", "No free sensor slots", COLOR_RED );
    delay(2000);
    return false;
  }

  // ------------------------------------------------------------
  // STEP 1/2: FINGERPRINT SCAN & MERGE
  // ------------------------------------------------------------

  tftShowFullScreen( "ENROLL STEP 1/2", userName, COLOR_YELLOW );

  tftShowStatus( "Place finger on sensor", "Scan 1 of 2", COLOR_YELLOW );

  int p = -1;

  while ( p != FINGERPRINT_OK) {
    p = finger.getImage();

    delay(100);

  }

  p = finger.image2Tz(1);

  if ( p != FINGERPRINT_OK) {
    reportEnrollmentFailure( userId, userName, p, "First image" );

    return false;

  }

  tftShowStatus( "Lift finger...", "Done scan 1", COLOR_CYAN );

  while ( finger.getImage() != FINGERPRINT_NOFINGER) {
    delay(100);
  }

  delay(500);

  bool modelCreated = false;

  for (int attempt = 1; attempt <= 4; attempt++) {
    tftShowStatus( "Place SAME finger", "Scan 2/2 (Att " + String(attempt) + "/4)", COLOR_YELLOW );

    p = -1;

    while ( p != FINGERPRINT_OK) {
      p = finger.getImage();

      delay(100);
    }

    p = finger.image2Tz(2);

    if ( p != FINGERPRINT_OK) {
      while ( finger.getImage() != FINGERPRINT_NOFINGER) {
        delay(100);
      }

      continue;
    }

    p = finger.createModel();

    if ( p == FINGERPRINT_OK) {
      modelCreated = true;

      break;
    }

    while ( finger.getImage() != FINGERPRINT_NOFINGER) {
      delay(100);
    }

    delay(500);

  }

  if (!modelCreated) {
    reportEnrollmentFailure( userId, userName, p, "Model creation" );

    return false;

  }

  // Store newly created model (safely in CharBuffer 1) directly into nextId!
  p = finger.storeModel( nextId );

  if ( p != FINGERPRINT_OK) {
    reportEnrollmentFailure( userId, userName, p, "Storage" );

    return false;

  }

  StaticJsonDocument<384> enrollDoc;
  enrollDoc["fingerId"] = nextId;
  enrollDoc["userId"] = userId;
  enrollDoc["userName"] = userName;
  enrollDoc["role"] = role;
  enrollDoc["roomId"] = ROOM_ID;

  String body;
  serializeJson(enrollDoc, body);
  httpPostJson("/api/esp32/enrollment-complete", body);

  tftShowStatus( "Fingerprint Saved!", "Slot #" + String(nextId), COLOR_GREEN );

  delay(1200);

  // ------------------------------------------------------------
  // STEP 2/2: FACE REGISTRATION (LIVE TFT PREVIEW)
  // ------------------------------------------------------------
  return runFaceRegistrationOnly(userId, userName, role);
}

// ============================================================
// AUTONOMOUS HARDWARE ENROLLMENT (100% STANDALONE)
// ============================================================

bool runAutonomousHardwareEnrollment(const String &requestedRole = "user") {
  wakeToActive("Hardware Enrollment");

  tftShowFullScreen( "NEW ENROLLMENT", "Fetching " + requestedRole + " slot...", COLOR_CYAN );

  String userId = "";
  String userName = "";
  String role = requestedRole;

  if (!getNextAvailableUser(userId, userName, role, requestedRole)) {
    tftShowFullScreen( "FETCH ERROR", "Could not load " + requestedRole, COLOR_RED );
    delay(2000);
    return false;
  }

  tftShowFullScreen( role.equalsIgnoreCase("admin") ? "ENROLLING ADMIN" : "ENROLLING USER", userName + " (" + userId + ")", COLOR_YELLOW );
  delay(1200);

  bool success = runEnrollmentSequence(userId, userName, role);
  return success;
}

// ============================================================
// ADMIN HARDWARE MENU (TRIGGERED ON ADMIN LONG-PRESS)
// ============================================================

void showAdminHardwareMenu(const String &adminName) {
  wakeToActive("Admin Terminal Menu");

  tft.fillScreen(COLOR_BG);

  // Header Banner
  tft.fillRect(0, 0, tft.width(), 30, COLOR_YELLOW);
  tft.setTextColor(COLOR_BG, COLOR_YELLOW);
  tft.setTextSize(2);
  tft.setCursor(8, 7);
  tft.print("ADMIN TERMINAL");

  // Admin greeting
  tft.setTextColor(COLOR_WHITE, COLOR_BG);
  tft.setTextSize(1);
  tft.setCursor(8, 36);
  tft.print("Admin: " + adminName);

  // Option 1: Enroll User Box
  tft.drawRoundRect(6, 50, tft.width() - 12, 38, 4, COLOR_CYAN);
  tft.setTextColor(COLOR_CYAN, COLOR_BG);
  tft.setTextSize(2);
  tft.setCursor(14, 56);
  tft.print("1. ENROLL USER");
  tft.setTextSize(1);
  tft.setTextColor(COLOR_WHITE, COLOR_BG);
  tft.setCursor(14, 74);
  tft.print("Tap sensor briefly (< 0.6s)");

  // Option 2: Enroll Admin Box
  tft.drawRoundRect(6, 94, tft.width() - 12, 38, 4, COLOR_YELLOW);
  tft.setTextColor(COLOR_YELLOW, COLOR_BG);
  tft.setTextSize(2);
  tft.setCursor(14, 100);
  tft.print("2. ENROLL ADMIN");
  tft.setTextSize(1);
  tft.setTextColor(COLOR_WHITE, COLOR_BG);
  tft.setCursor(14, 118);
  tft.print("Hold sensor 0.6s - 1.5s");

  // Option 3: Unlock Door Box
  tft.drawRoundRect(6, 138, tft.width() - 12, 38, 4, COLOR_GREEN);
  tft.setTextColor(COLOR_GREEN, COLOR_BG);
  tft.setTextSize(2);
  tft.setCursor(14, 144);
  tft.print("3. UNLOCK DOOR");
  tft.setTextSize(1);
  tft.setTextColor(COLOR_WHITE, COLOR_BG);
  tft.setCursor(14, 162);
  tft.print("Hold sensor > 1.5s");

  // Footer status
  tftShowStatus("Touch sensor to choose", "Timeout in 7 seconds", COLOR_YELLOW);

  // Wait for admin selection
  unsigned long startWait = millis();
  bool actionTaken = false;

  while (millis() - startWait < 7000 && !actionTaken) {
    uint8_t r = finger.getImage();
    if (r == FINGERPRINT_OK) {
      unsigned long touchStart = millis();
      while (finger.getImage() == FINGERPRINT_OK && (millis() - touchStart < 2500)) {
        delay(50);
      }
      unsigned long touchDuration = millis() - touchStart;

      while (finger.getImage() != FINGERPRINT_NOFINGER) {
        delay(50);
      }

      actionTaken = true;

      if (touchDuration >= 1500) {
        tftShowFullScreen("ADMIN UNLOCK", adminName, COLOR_GREEN);
        openDoor();
      }
      else if (touchDuration >= 600) {
        runAutonomousHardwareEnrollment("admin");
      }
      else {
        runAutonomousHardwareEnrollment("user");
      }
      break;
    }
    delay(50);

  }

  if (!actionTaken) {
    tftShowStatus("Menu timed out", "Returning to standby", COLOR_GRAY);
    delay(1000);
  }
}

// ============================================================
// ADMIN COMMANDS (CLOUD / POLLING FALLBACK)
// ============================================================

void checkForAdminCommands() {
  if ( systemState != STATE_IDLE) {
    return;
  }

  unsigned long now = millis();

  if ( now - lastCommandPoll < COMMAND_POLL_INTERVAL_MS) {
    return;
  }

  lastCommandPoll = now;

  if ( WiFi.status() != WL_CONNECTED) {
    return;
  }

  String response = httpGet( "/api/esp32/get-commands/" + String(ROOM_ID) );

  if ( response.length() == 0) {
    return;
  }

  DynamicJsonDocument doc(512);

  if ( deserializeJson( doc, response ) != DeserializationError::Ok) {
    return;
  }

  if ( !(doc["hasCommand"] | false)) {
    return;
  }

  String command = doc["command"] | "";

  String commandUserName = doc["userName"] | "";

  if ( command == "unlock") {
    wakeToActive( "Remote unlock" );

    tftShowFullScreen( "ADMIN UNLOCK", commandUserName, COLOR_CYAN );

    openDoor();

    delay(1000);

    enterIdleMode();

    return;

  }

  if ( command.startsWith( "ENROLL:" )) {
    int separator = command.indexOf( ':', 7 );

    if (separator <= 0) return;

    String userId = command.substring( 7, separator );

    String rem = command.substring( separator + 1 );

    String userName = rem;
    String role = "user";

    int sep2 = rem.indexOf(':');
    if (sep2 > 0) {
      userName = rem.substring(0, sep2);
      role = rem.substring(sep2 + 1);
      role.trim();
    }

    wakeToActive( "Enrollment" );

    runEnrollmentSequence( userId, userName, role );

    enterIdleMode();

    return;

  }
}

// ============================================================
// ACCESS FLOW (DUAL BIOMETRIC VERIFICATION)
// ============================================================

void runAccessFlow(int fingerId) {
  String userId = "";
  String userName = "";
  String userRole = "user";
  bool faceEnrolled = false;

  tftShowFullScreen(
      "FINGER MATCHED",
      "Checking account...",
      COLOR_CYAN);

  if (
      !getUserByFingerId(
          fingerId,
          userId,
          userName,
          userRole,
          faceEnrolled)) {
    tftShowFullScreen(
        "USER NOT FOUND",
        "Fingerprint not linked",
        COLOR_RED);

    delay(1500);
    return;
  }

  // ------------------------------------------------------------
  // ADMIN LONG-PRESS CHECK FOR HARDWARE MENU
  // ------------------------------------------------------------
  if (userRole.equalsIgnoreCase("admin")) {
    unsigned long pressStart =
        millis();

    bool isLongPress =
        false;

    while (
        millis() -
            pressStart <
        1800) {
      if (
          finger.getImage() ==
          FINGERPRINT_OK) {
        if (
            millis() -
                pressStart >
            1200) {
          isLongPress =
              true;

          break;
        }
      }
      else {
        break;
      }

      delay(50);
    }

    if (isLongPress) {
      while (
          finger.getImage() !=
          FINGERPRINT_NOFINGER) {
        delay(50);
      }

      showAdminHardwareMenu(
          userName);

      return;
    }
  }

  tftShowFullScreen(
      "IDENTIFIED",
      userName,
      COLOR_GREEN);

  notifyFingerprintVerified(
      userId,
      fingerId);

  // If user has not completed face enrollment yet, smoothly transition to Step 2/2
  if (!faceEnrolled) {
    tftShowFullScreen(
        "ENROLL FACE",
        "Step 2: Register Face",
        COLOR_CYAN);
    delay(1200);

    if (runFaceRegistrationOnly(userId, userName, userRole)) {
      openDoor();
      tftShowFullScreen(
          "WELCOME",
          userName,
          COLOR_GREEN);
      delay(1800);
    }
    return;
  }

  // =========================================================
  // WAKE ESP32-CAM
  // =========================================================

  tftShowStatus(
      "Waking camera...",
      "",
      COLOR_CYAN);

  if (!startCamera()) {
    tftShowFullScreen(
        "CAMERA ERROR",
        "Camera unavailable",
        COLOR_RED);

    delay(1500);
    return;
  }

  prepareCameraScreen(
      "FACE VERIFICATION",
      userName);

  bool faceVerified =
      false;

  uint32_t faceSession =
      beginFaceSession();

  unsigned long start =
      millis();

  unsigned long lastFaceRequest =
      0;

  FaceBox overlayBox =
      {0, 0, 0, 0, false};

  uint16_t overlayColor =
      COLOR_CYAN;

  uint16_t reticleColor =
      COLOR_CYAN;

  while (
      millis() - start <
          LIVE_VIEW_TIME_MS &&
      !faceVerified) {
    // Read completed server work first. The server request itself
    // runs in faceRequestWorker(), not in this live-preview loop.
    bool resultSuccess = false;

    FaceBox resultBox =
        {0, 0, 0, 0, false};

    if (
        takeFaceResult(
            faceSession,
            FACE_REQUEST_VERIFY,
            resultSuccess,
            resultBox)) {
      overlayBox =
          resultBox;

      faceVerified =
          resultSuccess;

      overlayColor =
          faceVerified
              ? COLOR_GREEN
              : COLOR_RED;

      reticleColor =
          faceVerified
              ? COLOR_GREEN
              : COLOR_RED;
    }

    size_t jpegLen =
        fetchJpegFrame(
            jpegBuffer,
            jpegBufferCapacity);

    if (jpegLen > 0) {
      displayJpegOnTFT(
          jpegBuffer,
          jpegLen);

      drawFaceReticle(
          reticleColor);

      if (overlayBox.valid) {
        drawCameraFaceBox(
            overlayBox,
            overlayColor);
      }

      if (faceVerified) {
        tftShowStatus(
            "Identity Confirmed!",
            "Face matched",
            COLOR_GREEN);

        delay(500);
        break;
      }

      if (faceRequestBusy) {
        tftShowStatus(
            "Look at camera",
            "Checking face...",
            COLOR_CYAN);
      }
      else {
        tftShowStatus(
            "Look at camera",
            "Live preview",
            COLOR_CYAN);
      }

      unsigned long now =
          millis();

      // IMAGE-SELECTION RULE:
      // /capture is used continuously for the TFT preview.
      // A frame is copied and sent to the face server only when:
      //   - JPEG size is above the minimum,
      //   - no face request is already active, and
      //   - at least FACE_REQUEST_INTERVAL_MS has elapsed.
      if (
          !faceRequestBusy &&
          !faceResultReady &&
          jpegLen >
              MIN_FACE_JPEG_BYTES &&
          now -
                  lastFaceRequest >=
              FACE_REQUEST_INTERVAL_MS) {
        if (
            startFaceRequestAsync(
                FACE_REQUEST_VERIFY,
                faceSession,
                userId,
                String(ROOM_ID),
                jpegBuffer,
                jpegLen)) {
          lastFaceRequest =
              now;

          // Neutral while the new candidate is being evaluated.
          reticleColor =
              COLOR_CYAN;
        }
      }
    }

    delay(10);
  }

  // If the last candidate is still being processed, allow a small
  // grace period while CONTINUING the preview instead of freezing.
  unsigned long graceStart =
      millis();

  while (
      !faceVerified &&
      faceRequestBusy &&
      millis() -
              graceStart <
          15000) {
    size_t jpegLen =
        fetchJpegFrame(
            jpegBuffer,
            jpegBufferCapacity);

    if (jpegLen > 0) {
      displayJpegOnTFT(
          jpegBuffer,
          jpegLen);

      drawFaceReticle(
          COLOR_CYAN);

      if (overlayBox.valid) {
        drawCameraFaceBox(
            overlayBox,
            overlayColor);
      }

      tftShowStatus(
          "Look at camera",
          "Finishing check...",
          COLOR_CYAN);
    }

    bool resultSuccess = false;

    FaceBox resultBox =
        {0, 0, 0, 0, false};

    if (
        takeFaceResult(
            faceSession,
            FACE_REQUEST_VERIFY,
            resultSuccess,
            resultBox)) {
      faceVerified =
          resultSuccess;

      overlayBox =
          resultBox;

      overlayColor =
          faceVerified
              ? COLOR_GREEN
              : COLOR_RED;

      break;
    }

    delay(10);
  }

  stopCamera();

  if (faceVerified) {
    tftShowFullScreen(
        "VERIFIED",
        userName,
        COLOR_GREEN);

    openDoor();

    tftShowFullScreen(
        "WELCOME",
        userName,
        COLOR_GREEN);

    delay(1800);
    return;
  }

  tftShowFullScreen(
      "ACCESS DENIED",
      "Face not matched",
      COLOR_RED);

  delay(1800);
}

// ============================================================
// FINGERPRINT POLLING
// ============================================================

bool processFingerprintIfPresent() {
  if ( systemState != STATE_IDLE || !fingerprintReady) {
    return false;
  }

  uint8_t result = finger.getImage();

  if ( result != FINGERPRINT_OK) {
    return false;
  }

  Serial.println( "Finger detected" );

  wakeToActive( "Finger detected" );

  tftShowStatus( "Reading fingerprint...", "", COLOR_CYAN );

  if ( finger.image2Tz(1) != FINGERPRINT_OK) {
    tftShowFullScreen( "SCAN ERROR", "Try again", COLOR_YELLOW );

    while ( finger.getImage() != FINGERPRINT_NOFINGER) {
      delay(75);
    }

    delay(1000);

    enterIdleMode();

    return true;

  }

  if ( finger.fingerSearch() != FINGERPRINT_OK) {
    tftShowFullScreen( "NO MATCH", "Not registered", COLOR_RED );

    while ( finger.getImage() != FINGERPRINT_NOFINGER) {
      delay(75);
    }

    delay(1500);

    enterIdleMode();

    return true;

  }

  int fingerId = finger.fingerID;

  int confidence = finger.confidence;

  Serial.printf( "Fingerprint ID=%d Confidence=%d\n", fingerId, confidence );

  if (confidence < 50) {
    tftShowFullScreen( "LOW CONFIDENCE", "Try again", COLOR_YELLOW );

    while ( finger.getImage() != FINGERPRINT_NOFINGER) {
      delay(75);
    }

    delay(1000);

    enterIdleMode();

    return true;

  }

  runAccessFlow( fingerId );

  enterIdleMode();

  return true;
}

// ============================================================
// SETUP
// ============================================================

void setup() {
  Serial.begin( 115200 );

  delay(300);

  // =========================================================
  // LOAD DYNAMIC SERVER URL FROM NVS
  // =========================================================
  Preferences prefs;
  prefs.begin("labsync", true);
  String savedServer = prefs.getString("server_url", "");
  prefs.end();

  if (savedServer.length() > 0) {
    activeServerUrl = savedServer;
    Serial.println( "🌐 Dynamic Server URL loaded from NVS: " + activeServerUrl );
  }
  else {
    Serial.println( "🌐 Using default Server URL: " + activeServerUrl );
  }

  // =========================================================
  // RELAY
  // =========================================================

  pinMode( RELAY_PIN, OUTPUT );

  digitalWrite( RELAY_PIN, LOW );

  // =========================================================
  // TFT
  // =========================================================

  SPI.begin( TFT_SCLK, TFT_MISO, TFT_MOSI, TFT_CS );

  tft.begin( 40000000 );

  /*
  Portrait 240 x 320.
  The ESP32-CAM remains QVGA 320 x 240; during face view,
  the image is center-cropped horizontally to 240 x 240.
  */

  tft.setRotation(TFT_ROTATION);

  tft.fillScreen( COLOR_BG );

  // =========================================================
  // JPEG DECODER
  // =========================================================

  TJpgDec.setSwapBytes(false);
  TJpgDec.setJpgScale(1);
  TJpgDec.setCallback( tftJpegOutput );

  if (!allocateJpegBuffer()) {
    tft.fillScreen( COLOR_RED );

    tft.setTextColor( COLOR_WHITE, COLOR_RED );

    tft.setTextSize(2);

    tft.setCursor( 10, 88 );

    tft.println( "MEMORY ERROR" );

    tft.setTextSize(1);

    tft.setCursor( 10, 118 );

    tft.println( "JPEG buffer failed" );

    tft.setCursor( 10, 134 );

    tft.println( "Check Serial Monitor" );

    while (true) {
      delay(1000);
    }
  }

  // =========================================================
  // START
  // =========================================================

  tftSplashScreen();

  /*
  Fingerprint starts BEFORE WiFi.
  */

  initFingerprint();

  connectWiFi(true);

  if (WiFi.status() == WL_CONNECTED) {
    startCameraDiscoveryUDP();
    startMainMDNS();

    /*
    Do NOT run the full camera-resolution chain during boot.
    The ESP32-CAM broadcasts its IP every second and loop()
    receives that announcement non-blockingly.
    */
    processCameraUdpAnnouncement(0);
  }

  cameraStreaming = false;

  enterIdleMode();

  Serial.println( "LabSync ready" );
}

// ============================================================
// LOOP
// ============================================================

void loop() {
  retryFingerprintIfNeeded();

  // =========================================================
  // LIVE RUNTIME SERIAL COMMANDS FOR DYNAMIC IP CONTROL
  // =========================================================
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();

    if (line.startsWith("SET_SERVER ")) {
      String newUrl = line.substring(11);
      newUrl.trim();
      if (newUrl.length() > 0) {
        activeServerUrl = newUrl;
        Preferences p;
        p.begin("labsync", false);
        p.putString("server_url", activeServerUrl);
        p.end();
        Serial.println("✅ Dynamic Server URL updated and saved: " + activeServerUrl);
      }
    }
    else if (line == "RESET_SERVER") {
      activeServerUrl = DEFAULT_SERVER_URL;
      Preferences p;
      p.begin("labsync", false);
      p.remove("server_url");
      p.end();
      Serial.println("✅ Server URL reset to Render cloud: " + activeServerUrl);
    }
    else if (line == "IP_STATUS") {
      Serial.println("=== LABSYNC DYNAMIC IP STATUS ===");
      Serial.println("ESP32 Local IP: " + WiFi.localIP().toString());
      Serial.println("Camera Base URL: " + (cameraBaseUrl.length() > 0 ? cameraBaseUrl : "NOT RESOLVED"));
      Serial.println("Camera UDP:      " + String(cameraUdpStarted ? "LISTENING" : "STOPPED"));
      Serial.println("Server URL:      " + activeServerUrl);
      Serial.println("================================");
    }

  }

  // Keep camera IP fresh from the ESP32-CAM's 1-second UDP announcement.
  // This is non-blocking and does not wake the camera sensor.
  if (WiFi.status() == WL_CONNECTED) {
    processCameraUdpAnnouncement(0);
  }

  // Fingerprint has highest priority.
  if ( processFingerprintIfPresent()) {
    return;
  }

  // =========================================================
  // WIFI RECONNECT
  // =========================================================

  if (WiFi.status() != WL_CONNECTED) {
    if (cameraUdpStarted) {
      cameraDiscoveryUdp.stop();
      cameraUdpStarted = false;
    }

    if (mdnsStarted) {
      MDNS.end();
      mdnsStarted = false;
    }

    cameraBaseUrl = "";

    unsigned long now =
        millis();

    if (
        now -
            lastWiFiReconnectAttempt >=
        WIFI_RECONNECT_INTERVAL_MS) {
      lastWiFiReconnectAttempt =
          now;

      Serial.println(
          "Background WiFi reconnect...");

      WiFi.mode(WIFI_STA);
      WiFi.setSleep(false);
      WiFi.begin(
          WIFI_SSID,
          WIFI_PASSWORD);
    }
  }
  else {
    if (!cameraUdpStarted) {
      startCameraDiscoveryUDP();
    }

    if (!mdnsStarted) {
      startMainMDNS();
    }
  }

  // =========================================================
  // IDLE UI
  // =========================================================

  updateIdleScreen();

  // =========================================================
  // BACKEND MAINTENANCE
  // =========================================================

  if ( systemState == STATE_IDLE) {
    sendHeartbeat();

    checkForAdminCommands();

  }

  delay(40);
}
