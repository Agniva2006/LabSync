/*
  ============================================================
  LabSync Main ESP32 Client v3.2

  Hardware:
    ESP32 DevKit / WROOM
    R307 / AS608 fingerprint sensor
    ILI9341 TFT
    Relay
    ESP32-CAM on same WiFi

  Main ESP32:
    - Fingerprint sensor always active
    - WiFi always active
    - Portrait TFT rotated 180 degrees
    - Idle animation
    - Dynamic ESP32-CAM discovery using mDNS
    - No hardcoded ESP32-CAM IP
    - /start wakes camera
    - /capture gets JPEG
    - /stop puts camera back into low-power standby
  ============================================================
*/

#include <Adafruit_Fingerprint.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <NetworkClient.h>
#include <Preferences.h>
#include <SPI.h>
#include <TJpg_Decoder.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

// ============================================================
// ⚠️  CHANGE THESE — WiFi and lab configuration
// ============================================================

const char *WIFI_SSID = "Galaxy";           // ← Change to your WiFi name
const char *WIFI_PASSWORD = "password2006"; // ← Change to your WiFi password

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
// TFT
// ============================================================

constexpr int TFT_CS = 15;
constexpr int TFT_RST = 4;
constexpr int TFT_DC = 2;

constexpr int TFT_MOSI = 23;
constexpr int TFT_SCLK = 18;
constexpr int TFT_MISO = 19;

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

constexpr uint32_t LIVE_VIEW_TIME_MS = 10000;
constexpr uint32_t COMMAND_POLL_INTERVAL_MS = 3000;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 30000;
constexpr uint32_t FP_RETRY_INTERVAL_MS = 5000;
constexpr uint32_t IDLE_ANIMATION_INTERVAL_MS = 700;

// ============================================================
// JPEG
// ============================================================

constexpr size_t MAX_JPEG_BYTES = 65000;
constexpr size_t MIN_FACE_JPEG_BYTES = 5000;

// ============================================================
// TFT LAYOUT
// ============================================================

constexpr int16_t HEADER_HEIGHT = 26;
constexpr int16_t STATUS_HEIGHT = 46;

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

Adafruit_ILI9341 tft(
    TFT_CS,
    TFT_DC,
    TFT_RST
);

HardwareSerial fpSerial(2);

Adafruit_Fingerprint finger(
    static_cast<Stream *>(&fpSerial)
);

// ============================================================
// SYSTEM STATE
// ============================================================

enum SystemState
{
  STATE_IDLE,
  STATE_ACTIVE
};

SystemState systemState = STATE_ACTIVE;

// ============================================================
// GLOBALS
// ============================================================

uint8_t *jpegBuffer = nullptr;

String cameraBaseUrl = "";

bool fingerprintReady = false;
bool cameraStreaming = false;
bool mdnsStarted = false;

unsigned long lastHeartbeat = 0;
unsigned long lastCommandPoll = 0;
unsigned long lastFingerprintRetry = 0;

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
// TFT STATUS
// ============================================================

void tftShowStatus(
    const String &line1,
    const String &line2,
    uint16_t color = COLOR_WHITE)
{
  int16_t y =
      tft.height() -
      STATUS_HEIGHT;

  tft.fillRect(
      0,
      y,
      tft.width(),
      STATUS_HEIGHT,
      COLOR_BG
  );

  tft.drawFastHLine(
      0,
      y,
      tft.width(),
      COLOR_GRAY
  );

  tft.setTextSize(1);

  tft.setTextColor(
      color,
      COLOR_BG
  );

  tft.setCursor(
      8,
      y + 9
  );

  tft.println(line1);

  if (line2.length() > 0)
  {
    tft.setCursor(
        8,
        y + 26
    );

    tft.println(line2);
  }
}

// ============================================================
// TFT FULL SCREEN
// ============================================================

void tftShowFullScreen(
    const String &title,
    const String &subtitle,
    uint16_t titleColor)
{
  tft.fillScreen(COLOR_BG);

  tft.fillRect(
      0,
      0,
      tft.width(),
      32,
      titleColor
  );

  tft.setTextColor(
      COLOR_BG,
      titleColor
  );

  tft.setTextSize(2);

  tft.setCursor(8, 8);

  tft.print("LABSYNC");

  tft.setTextColor(
      titleColor,
      COLOR_BG
  );

  tft.setTextSize(2);

  tft.setCursor(8, 55);

  tft.println(title);

  tft.setTextColor(
      COLOR_WHITE,
      COLOR_BG
  );

  tft.setTextSize(1);

  tft.setCursor(8, 92);

  tft.println(subtitle);
}

// ============================================================
// SPLASH
// ============================================================

void tftSplashScreen()
{
  tft.fillScreen(COLOR_BG);

  tft.fillRect(
      0,
      0,
      tft.width(),
      46,
      COLOR_CYAN
  );

  tft.setTextColor(
      COLOR_BG,
      COLOR_CYAN
  );

  tft.setTextSize(3);

  int16_t titleWidth = 7 * 18;

  int16_t titleX =
      (tft.width() -
       titleWidth) /
      2;

  if (titleX < 0)
    titleX = 5;

  tft.setCursor(
      titleX,
      12
  );

  tft.print("LABSYNC");

  tft.setTextSize(1);

  tft.setTextColor(
      COLOR_CYAN,
      COLOR_BG
  );

  tft.setCursor(
      12,
      75
  );

  tft.println(
      "Smart Lab Access System"
  );

  tft.setCursor(
      12,
      95
  );

  tft.print("Room: ");
  tft.println(ROOM_ID);

  tft.setTextColor(
      COLOR_WHITE,
      COLOR_BG
  );

  tft.setCursor(
      12,
      130
  );

  tft.println(
      "Starting fingerprint..."
  );
}

// ============================================================
// IDLE SCREEN
// ============================================================

void resetIdleAnimation()
{
  idleX = 15;
  idleY = 120;

  idleDX = 5;
  idleDY = 4;

  previousIdleX = -1;
  previousIdleY = -1;

  lastIdleAnimation = 0;
}

void updateIdleScreen()
{
  if (systemState != STATE_IDLE)
    return;

  unsigned long now =
      millis();

  if (
      now -
          lastIdleAnimation <
      IDLE_ANIMATION_INTERVAL_MS)
  {
    return;
  }

  lastIdleAnimation =
      now;

  constexpr int16_t textWidth = 100;
  constexpr int16_t textHeight = 28;

  if (
      previousIdleX >= 0 &&
      previousIdleY >= 0)
  {
    tft.fillRect(
        previousIdleX,
        previousIdleY,
        textWidth,
        textHeight,
        COLOR_BG
    );
  }

  idleX += idleDX;
  idleY += idleDY;

  if (idleX <= 5)
  {
    idleX = 5;
    idleDX = abs(idleDX);
  }

  if (
      idleX +
          textWidth >=
      tft.width() - 5)
  {
    idleX =
        tft.width() -
        textWidth -
        5;

    idleDX =
        -abs(idleDX);
  }

  if (idleY <= 40)
  {
    idleY = 40;
    idleDY = abs(idleDY);
  }

  if (
      idleY +
          textHeight >=
      tft.height() - 20)
  {
    idleY =
        tft.height() -
        textHeight -
        20;

    idleDY =
        -abs(idleDY);
  }

  tft.setTextSize(1);

  tft.setTextColor(
      COLOR_CYAN,
      COLOR_BG
  );

  tft.setCursor(
      idleX,
      idleY
  );

  tft.print("LABSYNC");

  tft.setTextColor(
      COLOR_GRAY,
      COLOR_BG
  );

  tft.setCursor(
      idleX,
      idleY + 14
  );

  tft.print(
      "Touch sensor"
  );

  previousIdleX =
      idleX;

  previousIdleY =
      idleY;
}

// ============================================================
// ENTER IDLE
// ============================================================

void enterIdleMode()
{
  systemState =
      STATE_IDLE;

  tft.fillScreen(
      COLOR_BG
  );

  resetIdleAnimation();

  updateIdleScreen();

  Serial.println();
  Serial.println(
      "=============================="
  );
  Serial.println(
      "MAIN ESP32 IDLE"
  );
  Serial.println(
      "Fingerprint : ACTIVE"
  );
  Serial.println(
      "WiFi        : ACTIVE"
  );
  Serial.println(
      "Camera      : STANDBY"
  );
  Serial.println(
      "=============================="
  );
}

// ============================================================
// WAKE UI
// ============================================================

void wakeToActive(
    const String &reason)
{
  systemState =
      STATE_ACTIVE;

  tft.fillScreen(
      COLOR_BG
  );

  for (int i = 0;
       i < 4;
       i++)
  {
    int margin =
        25 -
        (i * 5);

    tft.drawRect(
        margin,
        margin,
        tft.width() -
            (margin * 2),
        tft.height() -
            (margin * 2),
        COLOR_CYAN
    );

    delay(45);
  }

  tftShowFullScreen(
      "ACTIVE",
      reason,
      COLOR_CYAN
  );
}

// ============================================================
// WIFI
// ============================================================

void connectWiFi(
    bool showOnDisplay = true)
{
  if (
      WiFi.status() ==
      WL_CONNECTED)
  {
    return;
  }

  WiFi.mode(WIFI_STA);

  // Main ESP32 remains fully responsive.
  WiFi.setSleep(false);

  WiFi.begin(
      WIFI_SSID,
      WIFI_PASSWORD
  );

  if (showOnDisplay)
  {
    tftShowFullScreen(
        "CONNECTING",
        WIFI_SSID,
        COLOR_YELLOW
    );
  }

  Serial.print(
      "Connecting WiFi"
  );

  int attempts = 0;

  while (
      WiFi.status() !=
          WL_CONNECTED &&
      attempts < 40)
  {
    delay(500);

    Serial.print('.');

    attempts++;
  }

  Serial.println();

  if (
      WiFi.status() ==
      WL_CONNECTED)
  {
    Serial.println(
        "WiFi connected"
    );

    Serial.println(
        "Main ESP32 IP: " +
        WiFi.localIP().toString()
    );

    if (showOnDisplay)
    {
      tftShowStatus(
          "WiFi connected",
          WiFi.localIP().toString(),
          COLOR_GREEN
      );

      delay(700);
    }
  }
  else
  {
    Serial.println(
        "WiFi failed"
    );

    if (showOnDisplay)
    {
      tftShowStatus(
          "WiFi failed",
          "Will retry",
          COLOR_RED
      );
    }
  }
}

// ============================================================
// MAIN ESP32 MDNS
// ============================================================

bool startMainMDNS()
{
  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    return false;
  }

  if (mdnsStarted)
    return true;

  if (!MDNS.begin(
          "labsync-client"))
  {
    Serial.println(
        "Main mDNS failed"
    );

    mdnsStarted =
        false;

    return false;
  }

  mdnsStarted =
      true;

  Serial.println(
      "Main mDNS started"
  );

  return true;
}

// ============================================================
// FINGERPRINT INITIALIZATION
// ============================================================

bool verifyFingerprintSensor()
{
  if (!finger.verifyPassword())
    return false;

  finger.getParameters();

  Serial.println(
      "Fingerprint detected"
  );

  Serial.printf(
      "Capacity: %d\n",
      finger.capacity
  );

  Serial.printf(
      "Security: %d\n",
      finger.security_level
  );

  return true;
}

void initFingerprint()
{
  Serial.println(
      "Starting fingerprint UART..."
  );

  fpSerial.begin(
      FP_BAUD,
      SERIAL_8N1,
      FINGERPRINT_RX,
      FINGERPRINT_TX
  );

  for (int attempt = 1;
       attempt <= 10;
       attempt++)
  {
    Serial.printf(
        "Fingerprint init %d/10\n",
        attempt
    );

    if (verifyFingerprintSensor())
    {
      fingerprintReady =
          true;

      tftShowStatus(
          "Fingerprint READY",
          String(finger.capacity) +
              " slots",
          COLOR_GREEN
      );

      return;
    }

    delay(500);
  }

  fingerprintReady =
      false;

  tftShowStatus(
      "Fingerprint unavailable",
      "Will retry",
      COLOR_RED
  );
}

void retryFingerprintIfNeeded()
{
  if (fingerprintReady)
    return;

  unsigned long now =
      millis();

  if (
      now -
          lastFingerprintRetry <
      FP_RETRY_INTERVAL_MS)
  {
    return;
  }

  lastFingerprintRetry =
      now;

  if (verifyFingerprintSensor())
  {
    fingerprintReady =
        true;

    Serial.println(
        "Fingerprint recovered"
    );
  }
}

// ============================================================
// CAMERA DISCOVERY
// ============================================================

bool ipIsZero(
    const IPAddress &ip)
{
  return
      ip[0] == 0 &&
      ip[1] == 0 &&
      ip[2] == 0 &&
      ip[3] == 0;
}

// Forward declaration for dynamic camera resolution via backend
String httpGet(const String &path);

bool resolveCamera()
{
  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    cameraBaseUrl = "";

    return false;
  }

  // =========================================================
  // TIER 1: DYNAMIC mDNS QUERY
  // =========================================================
  if (!mdnsStarted)
  {
    startMainMDNS();
  }

  if (mdnsStarted)
  {
    Serial.println(
        "Attempting dynamic mDNS discovery (esp32cam.local)..."
    );

    for (int attempt = 1;
         attempt <= 2;
         attempt++)
    {
      IPAddress camIp =
          MDNS.queryHost(
              CAMERA_MDNS_NAME,
              2000
          );

      if (!ipIsZero(camIp))
      {
        cameraBaseUrl =
            "http://" +
            camIp.toString();

        Serial.println(
            "✅ ESP32-CAM dynamic IP resolved via mDNS: " +
            cameraBaseUrl
        );

        // Cache working IP in NVS
        Preferences prefs;
        prefs.begin("labsync", false);
        prefs.putString("cam_ip", camIp.toString());
        prefs.end();

        return true;
      }

      delay(150);
    }
  }

  // =========================================================
  // TIER 2: QUERY CLOUD/BACKEND DYNAMIC CAMERA REGISTRY
  // Solves mobile hotspot / isolated subnet mDNS blockage!
  // =========================================================
  Serial.println(
      "Querying backend registry for dynamic camera IP..."
  );

  String response =
      httpGet(
          "/api/esp32/camera-ip/" +
          String(ROOM_ID)
      );

  if (response.length() > 0)
  {
    StaticJsonDocument<256> doc;
    DeserializationError err =
        deserializeJson(doc, response);

    if (!err && doc["success"] == true)
    {
      const char *dynIp = doc["ip"];
      if (dynIp && strlen(dynIp) > 0)
      {
        cameraBaseUrl =
            "http://" +
            String(dynIp);

        Serial.println(
            "✅ ESP32-CAM dynamic IP resolved via Backend Registry: " +
            cameraBaseUrl
        );

        // Cache working IP in NVS
        Preferences prefs;
        prefs.begin("labsync", false);
        prefs.putString("cam_ip", String(dynIp));
        prefs.end();

        return true;
      }
    }
  }

  // =========================================================
  // TIER 3: CHECK CACHED DYNAMIC IP FROM NVS
  // =========================================================
  Preferences prefs;
  prefs.begin("labsync", true);
  String cachedIp = prefs.getString("cam_ip", "");
  prefs.end();

  if (cachedIp.length() > 0)
  {
    cameraBaseUrl =
        "http://" +
        cachedIp;

    Serial.println(
        "Using cached dynamic Camera IP from NVS: " +
        cameraBaseUrl
    );

    return true;
  }

  // =========================================================
  // TIER 4: MANUAL FALLBACK IP
  // =========================================================
  if (
      strlen(CAMERA_IP_FALLBACK) > 0)
  {
    cameraBaseUrl =
        "http://" +
        String(CAMERA_IP_FALLBACK);

    Serial.println(
        "Using manual fallback IP: " +
        cameraBaseUrl
    );

    return true;
  }

  cameraBaseUrl = "";

  Serial.println(
      "❌ All dynamic camera discovery methods exhausted"
  );

  return false;
}

// ============================================================
// CAMERA COMMAND
// ============================================================

bool sendCameraCmd(
    const char *path)
{
  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    connectWiFi(
        systemState ==
        STATE_ACTIVE
    );
  }

  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    return false;
  }

  if (
      cameraBaseUrl.length() ==
      0)
  {
    if (!resolveCamera())
      return false;
  }

  NetworkClient client;

  HTTPClient http;

  /*
     /start initializes the OV2640, so allow
     enough time for camera wake-up.
  */

  http.setConnectTimeout(3000);
  http.setTimeout(8000);
  http.useHTTP10(true);

  String url =
      cameraBaseUrl +
      path;

  Serial.println(
      "Camera request: " +
      url
  );

  if (!http.begin(
          client,
          url))
  {
    cameraBaseUrl = "";
    return false;
  }

  int code =
      http.GET();

  String response = "";

  if (code > 0)
  {
    response =
        http.getString();
  }

  http.end();

  if (
      code ==
      HTTP_CODE_OK)
  {
    Serial.println(
        "Camera response: " +
        response
    );

    return true;
  }

  Serial.printf(
      "Camera HTTP error: %d\n",
      code
  );

  cameraBaseUrl = "";

  return false;
}

// ============================================================
// START CAMERA
// ============================================================

bool startCamera()
{
  Serial.println(
      "Waking ESP32-CAM camera..."
  );

  if (
      cameraBaseUrl.length() ==
      0)
  {
    if (!resolveCamera())
    {
      cameraStreaming =
          false;

      return false;
    }
  }

  if (sendCameraCmd("/start"))
  {
    cameraStreaming =
        true;

    Serial.println(
        "Camera ACTIVE"
    );

    return true;
  }

  // IP may have changed.
  cameraBaseUrl = "";

  if (!resolveCamera())
  {
    cameraStreaming =
        false;

    return false;
  }

  if (sendCameraCmd("/start"))
  {
    cameraStreaming =
        true;

    return true;
  }

  cameraStreaming =
      false;

  return false;
}

// ============================================================
// STOP CAMERA / RETURN CAMERA TO STANDBY
// ============================================================

void stopCamera()
{
  if (!cameraStreaming)
    return;

  Serial.println(
      "Putting camera into standby..."
  );

  sendCameraCmd(
      "/stop"
  );

  cameraStreaming =
      false;

  Serial.println(
      "ESP32-CAM camera now sleeping"
  );
}

// ============================================================
// JPEG CALLBACK
// ============================================================

bool tftJpegOutput(
    int16_t x,
    int16_t y,
    uint16_t w,
    uint16_t h,
    uint16_t *bitmap)
{
  if (
      x >= tft.width() ||
      y >= tft.height())
  {
    return false;
  }

  tft.drawRGBBitmap(
      x,
      y,
      bitmap,
      w,
      h
  );

  return true;
}

// ============================================================
// FETCH JPEG
// ============================================================

size_t fetchJpegFrame(
    uint8_t *buf,
    size_t maxLen)
{
  if (!cameraStreaming)
  {
    Serial.println(
        "Capture blocked: camera not started"
    );

    return 0;
  }

  if (
      cameraBaseUrl.length() ==
      0)
  {
    if (!resolveCamera())
      return 0;
  }

  NetworkClient client;
  HTTPClient http;

  http.setConnectTimeout(3000);
  http.setTimeout(6000);
  http.useHTTP10(true);

  String url =
      cameraBaseUrl +
      "/capture";

  if (!http.begin(
          client,
          url))
  {
    cameraBaseUrl = "";

    return 0;
  }

  int code =
      http.GET();

  if (
      code !=
      HTTP_CODE_OK)
  {
    Serial.printf(
        "Capture HTTP error: %d\n",
        code
    );

    http.end();

    return 0;
  }

  int len =
      http.getSize();

  if (len <= 0)
  {
    http.end();

    return 0;
  }

  if (
      (size_t)len >
      maxLen)
  {
    Serial.printf(
        "JPEG too large: %d bytes\n",
        len
    );

    http.end();

    return 0;
  }

  NetworkClient *stream =
      http.getStreamPtr();

  size_t received = 0;

  unsigned long lastData =
      millis();

  while (
      received <
      (size_t)len)
  {
    int available =
        stream->available();

    if (available > 0)
    {
      size_t remaining =
          (size_t)len -
          received;

      size_t toRead =
          (size_t)available;

      if (toRead > remaining)
        toRead = remaining;

      if (toRead > 4096)
        toRead = 4096;

      int got =
          stream->read(
              buf + received,
              toRead
          );

      if (got > 0)
      {
        received += got;

        lastData =
            millis();
      }
    }
    else
    {
      if (
          millis() -
              lastData >
          2500)
      {
        break;
      }

      delay(1);
    }
  }

  http.end();

  return received;
}

// ============================================================
// CAMERA TFT SCREEN
// ============================================================

void prepareCameraScreen(
    const String &mode,
    const String &name)
{
  tft.fillScreen(
      COLOR_BG
  );

  tft.fillRect(
      0,
      0,
      tft.width(),
      HEADER_HEIGHT,
      COLOR_CYAN
  );

  tft.setTextColor(
      COLOR_BG,
      COLOR_CYAN
  );

  tft.setTextSize(1);

  tft.setCursor(
      5,
      8
  );

  tft.print(mode);

  if (name.length() > 0)
  {
    tft.setCursor(
        5,
        HEADER_HEIGHT + 4
    );

    tft.setTextColor(
        COLOR_WHITE,
        COLOR_BG
    );

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

static int16_t lastJpegDrawX = 0;
static int16_t lastJpegDrawY = 0;
static uint8_t lastJpegScale = 1;

void drawDynamicFaceBox(int x, int y, int w, int h, uint16_t color)
{
  int16_t minY = HEADER_HEIGHT + 20;
  int16_t maxY = tft.height() - STATUS_HEIGHT - 4;
  int16_t minX = 0;
  int16_t maxX = tft.width();

  if (x < minX) { w -= (minX - x); x = minX; }
  if (y < minY) { h -= (minY - y); y = minY; }
  if (x + w > maxX) w = maxX - x;
  if (y + h > maxY) h = maxY - y;
  if (w <= 10 || h <= 10) return;

  // Outer high-tech bounding rectangle
  tft.drawRect(x, y, w, h, color);
  tft.drawRect(x + 1, y + 1, w - 2, h - 2, color);

  // Corner HUD brackets for visual punch
  int k = min(16, min(w / 3, h / 3));
  if (k > 3) {
    // Top-Left corner
    tft.drawFastHLine(x, y - 1, k, color);
    tft.drawFastVLine(x - 1, y, k, color);
    // Top-Right corner
    tft.drawFastHLine(x + w - k, y - 1, k, color);
    tft.drawFastVLine(x + w, y, k, color);
    // Bottom-Left corner
    tft.drawFastHLine(x, y + h, k, color);
    tft.drawFastVLine(x - 1, y + h - k, k, color);
    // Bottom-Right corner
    tft.drawFastHLine(x + w - k, y + h, k, color);
    tft.drawFastVLine(x + w, y + h - k, k, color);
  }
}

// ============================================================
// DISPLAY JPEG
// ============================================================

bool displayJpegOnTFT(
    uint8_t *buf,
    size_t len)
{
  uint16_t jpegWidth = 0;
  uint16_t jpegHeight = 0;

  if (
      TJpgDec.getJpgSize(
          &jpegWidth,
          &jpegHeight,
          buf,
          len
      ) != JDR_OK)
  {
    return false;
  }

  int16_t cameraTop =
      HEADER_HEIGHT +
      20;

  int16_t cameraBottom =
      tft.height() -
      STATUS_HEIGHT -
      4;

  int16_t availableWidth =
      tft.width();

  int16_t availableHeight =
      cameraBottom -
      cameraTop;

  uint8_t scale = 1;

  while (
      ((jpegWidth / scale) >
           availableWidth ||
       (jpegHeight / scale) >
           availableHeight) &&
      scale < 8)
  {
    scale *= 2;
  }

  TJpgDec.setJpgScale(
      scale
  );

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
          len
      ) == JDR_OK;
}

// ============================================================
// FACE RETICLE VIEWFINDER
// ============================================================

void drawFaceReticle(uint16_t color)
{
  int16_t cx = tft.width() / 2;
  int16_t cy = (HEADER_HEIGHT + 20 + tft.height() - STATUS_HEIGHT - 4) / 2;
  int16_t w = 110;
  int16_t h = 130;
  int16_t x0 = cx - w / 2;
  int16_t y0 = cy - h / 2;
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
  tft.drawFastVLine(x0, y0 + h - k, color);
  tft.drawFastVLine(x0 + 1, y0 + h - k, color);

  // Bottom-Right
  tft.drawFastHLine(x0 + w - k, y0 + h, k, color);
  tft.drawFastHLine(x0 + w - k, y0 + h - 1, k, color);
  tft.drawFastVLine(x0 + w, y0 + h - k, color);
  tft.drawFastVLine(x0 + w - 1, y0 + h - k, color);
}

// ============================================================
// HTTP GET
// ============================================================

String httpGet(
    const String &path)
{
  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    connectWiFi(
        systemState ==
        STATE_ACTIVE
    );
  }

  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    return "";
  }

  String url =
      activeServerUrl +
      path;

  HTTPClient http;

  http.setFollowRedirects(
      HTTPC_STRICT_FOLLOW_REDIRECTS
  );

  http.setConnectTimeout(
      10000
  );

  http.setTimeout(
      15000
  );

  String body = "";

  if (
      url.startsWith(
          "https://"))
  {
    WiFiClientSecure client;

    client.setInsecure();

    client.setHandshakeTimeout(
        10
    );

    if (!http.begin(
            client,
            url))
    {
      return "";
    }

    int code =
        http.GET();

    if (
        code ==
        HTTP_CODE_OK)
    {
      body =
          http.getString();
    }

    http.end();
  }
  else
  {
    NetworkClient client;

    if (!http.begin(
            client,
            url))
    {
      return "";
    }

    int code =
        http.GET();

    if (
        code ==
        HTTP_CODE_OK)
    {
      body =
          http.getString();
    }

    http.end();
  }

  return body;
}

// ============================================================
// HTTP POST JSON
// ============================================================

String httpPostJson(
    const String &path,
    const String &jsonBody)
{
  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    connectWiFi(
        systemState ==
        STATE_ACTIVE
    );
  }

  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    return "";
  }

  String url =
      activeServerUrl +
      path;

  HTTPClient http;

  http.setFollowRedirects(
      HTTPC_STRICT_FOLLOW_REDIRECTS
  );

  http.setConnectTimeout(
      10000
  );

  http.setTimeout(
      15000
  );

  String body = "";

  if (
      url.startsWith(
          "https://"))
  {
    WiFiClientSecure client;

    client.setInsecure();

    client.setHandshakeTimeout(
        10
    );

    if (!http.begin(
            client,
            url))
    {
      return "";
    }

    http.addHeader(
        "Content-Type",
        "application/json"
    );

    int code =
        http.POST(
            jsonBody
        );

    if (code > 0)
    {
      body =
          http.getString();
    }

    http.end();
  }
  else
  {
    NetworkClient client;

    if (!http.begin(
            client,
            url))
    {
      return "";
    }

    http.addHeader(
        "Content-Type",
        "application/json"
    );

    int code =
        http.POST(
            jsonBody
        );

    if (code > 0)
    {
      body =
          http.getString();
    }

    http.end();
  }

  return body;
}

// ============================================================
// MULTIPART UPLOAD
// ============================================================

bool postMultipartStreaming(
    const String &path,
    const String &part1,
    uint8_t *jpegBuf,
    size_t jpegLen,
    const String &part3,
    String &outResp)
{
  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    connectWiFi(true);
  }

  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    return false;
  }

  String server =
      activeServerUrl;

  bool https =
      server.startsWith(
          "https://"
      );

  int protocolPos =
      server.indexOf(
          "://"
      );

  String hostPort =
      protocolPos >= 0
          ? server.substring(
                protocolPos + 3)
          : server;

  while (
      hostPort.endsWith("/"))
  {
    hostPort.remove(
        hostPort.length() - 1
    );
  }

  String host =
      hostPort;

  int port =
      https ? 443 : 80;

  int colon =
      hostPort.indexOf(':');

  if (colon >= 0)
  {
    host =
        hostPort.substring(
            0,
            colon
        );

    port =
        hostPort.substring(
            colon + 1
        ).toInt();
  }

  const String boundary =
      "----LabSyncBoundary7344";

  size_t totalLength =
      part1.length() +
      jpegLen +
      part3.length();

  String response = "";

  if (https)
  {
    WiFiClientSecure client;

    client.setInsecure();
    client.setTimeout(45000);

    if (!client.connect(
            host.c_str(),
            port))
    {
      return false;
    }

    client.printf(
        "POST %s HTTP/1.1\r\n",
        path.c_str()
    );

    client.printf(
        "Host: %s\r\n",
        host.c_str()
    );

    client.printf(
        "Content-Type: multipart/form-data; boundary=%s\r\n",
        boundary.c_str()
    );

    client.printf(
        "Content-Length: %u\r\n",
        (unsigned int)totalLength
    );

    client.print(
        "Connection: close\r\n\r\n"
    );

    client.print(part1);

    size_t sent = 0;

    while (
        sent < jpegLen &&
        client.connected())
    {
      size_t remaining =
          jpegLen - sent;

      size_t chunk =
          remaining > 1024
              ? 1024
              : remaining;

      size_t written =
          client.write(
              jpegBuf + sent,
              chunk
          );

      if (written == 0)
        break;

      sent += written;
    }

    client.print(part3);

    client.flush();

    unsigned long start =
        millis();

    while (
        !client.available() &&
        client.connected() &&
        millis() - start <
            45000)
    {
      delay(5);
    }

    unsigned long lastData =
        millis();

    while (
        client.connected() ||
        client.available())
    {
      while (
          client.available())
      {
        response +=
            (char)client.read();

        lastData =
            millis();
      }

      if (
          millis() -
              lastData >
          45000)
      {
        break;
      }

      delay(1);
    }

    client.stop();
  }
  else
  {
    NetworkClient client;

    client.setTimeout(45000);

    if (!client.connect(
            host.c_str(),
            port))
    {
      return false;
    }

    client.printf(
        "POST %s HTTP/1.1\r\n",
        path.c_str()
    );

    client.printf(
        "Host: %s:%d\r\n",
        host.c_str(),
        port
    );

    client.printf(
        "Content-Type: multipart/form-data; boundary=%s\r\n",
        boundary.c_str()
    );

    client.printf(
        "Content-Length: %u\r\n",
        (unsigned int)totalLength
    );

    client.print(
        "Connection: close\r\n\r\n"
    );

    client.print(part1);

    size_t sent = 0;

    while (
        sent < jpegLen &&
        client.connected())
    {
      size_t remaining =
          jpegLen - sent;

      size_t chunk =
          remaining > 1024
              ? 1024
              : remaining;

      size_t written =
          client.write(
              jpegBuf + sent,
              chunk
          );

      if (written == 0)
        break;

      sent += written;
    }

    client.print(part3);

    client.flush();

    unsigned long start =
        millis();

    while (
        !client.available() &&
        client.connected() &&
        millis() - start <
            45000)
    {
      delay(5);
    }

    unsigned long lastData =
        millis();

    while (
        client.connected() ||
        client.available())
    {
      while (
          client.available())
      {
        response +=
            (char)client.read();

        lastData =
            millis();
      }

      if (
          millis() -
              lastData >
          45000)
      {
        break;
      }

      delay(1);
    }

    client.stop();
  }

  outResp =
      response;

  int bodyStart =
      response.indexOf(
          "\r\n\r\n"
      );

  if (bodyStart >= 0)
  {
    outResp =
        response.substring(
            bodyStart + 4
        );
  }

  bool httpSuccess =
      response.indexOf(
          "200 OK"
      ) >= 0;

  bool jsonSuccess =
      outResp.indexOf(
          "\"success\":true"
      ) >= 0;

  return
      httpSuccess ||
      jsonSuccess;
}

// ============================================================
// FACE VERIFY
// ============================================================

bool postFaceVerify(
    const String &userId,
    const String &roomId,
    uint8_t *jpegBuf,
    size_t jpegLen,
    FaceBox *outBox = nullptr)
{
  const String boundary =
      "----LabSyncBoundary7344";

  const String CRLF =
      "\r\n";

  String part1 =
      "--" +
      boundary +
      CRLF +

      "Content-Disposition: form-data; name=\"userId\"" +
      CRLF +
      CRLF +
      userId +
      CRLF +

      "--" +
      boundary +
      CRLF +

      "Content-Disposition: form-data; name=\"roomId\"" +
      CRLF +
      CRLF +
      roomId +
      CRLF +

      "--" +
      boundary +
      CRLF +

      "Content-Disposition: form-data; name=\"faceImage\"; filename=\"face.jpg\"" +
      CRLF +

      "Content-Type: image/jpeg" +
      CRLF +
      CRLF;

  String part3 =
      CRLF +
      "--" +
      boundary +
      "--" +
      CRLF;

  String response;

  bool ok =
      postMultipartStreaming(
          "/api/face/verify",
          part1,
          jpegBuf,
          jpegLen,
          part3,
          response
      );

  if (!ok && response.indexOf("\"success\":true") < 0)
    return false;

  DynamicJsonDocument doc(1024);

  // Clean JSON boundary extraction
  int jsonStart = response.indexOf('{');
  int jsonEnd = response.lastIndexOf('}');
  String jsonBody = (jsonStart >= 0 && jsonEnd > jsonStart)
      ? response.substring(jsonStart, jsonEnd + 1)
      : response;

  if (
      deserializeJson(
          doc,
          jsonBody
      ) !=
      DeserializationError::Ok)
  {
    Serial.println(
        "JSON parse note: falling back to string match"
    );
    return response.indexOf("\"success\":true") >= 0;
  }

  bool success =
      doc["success"] |
      false;

  float confidence =
      doc["confidence"] |
      0.0f;

  if (outBox != nullptr)
  {
    if (doc.containsKey("box") && !doc["box"].isNull())
    {
      outBox->x = doc["box"]["x"] | 0;
      outBox->y = doc["box"]["y"] | 0;
      outBox->w = doc["box"]["w"] | 0;
      outBox->h = doc["box"]["h"] | 0;
      outBox->valid = (outBox->w > 0 && outBox->h > 0);
    }
    else
    {
      outBox->valid = false;
    }
  }

  Serial.printf(
      "Face: %s Confidence %.1f%%\n",
      success
          ? "MATCH"
          : "NO MATCH",
      confidence * 100.0f
  );

  return success;
}

// ============================================================
// FACE ENROLL
// ============================================================

bool postFaceEnroll(
    const String &userId,
    uint8_t *jpegBuf,
    size_t jpegLen,
    FaceBox *outBox = nullptr)
{
  const String boundary =
      "----LabSyncBoundary7344";

  const String CRLF =
      "\r\n";

  String part1 =
      "--" +
      boundary +
      CRLF +

      "Content-Disposition: form-data; name=\"userId\"" +
      CRLF +
      CRLF +
      userId +
      CRLF +

      "--" +
      boundary +
      CRLF +

      "Content-Disposition: form-data; name=\"faceImage\"; filename=\"face.jpg\"" +
      CRLF +

      "Content-Type: image/jpeg" +
      CRLF +
      CRLF;

  String part3 =
      CRLF +
      "--" +
      boundary +
      "--" +
      CRLF;

  String response;

  bool ok =
      postMultipartStreaming(
          "/api/face/enroll-hardware",
          part1,
          jpegBuf,
          jpegLen,
          part3,
          response
      );

  if (!ok && response.indexOf("\"success\":true") < 0)
    return false;

  int jsonStart = response.indexOf('{');
  int jsonEnd = response.lastIndexOf('}');
  String jsonBody = (jsonStart >= 0 && jsonEnd > jsonStart)
      ? response.substring(jsonStart, jsonEnd + 1)
      : response;

  DynamicJsonDocument doc(1024);

  if (
      deserializeJson(
          doc,
          jsonBody
      ) !=
      DeserializationError::Ok)
  {
    return response.indexOf("\"success\":true") >= 0;
  }

  bool success = doc["success"] | false;

  if (outBox != nullptr)
  {
    if (doc.containsKey("box") && !doc["box"].isNull())
    {
      outBox->x = doc["box"]["x"] | 0;
      outBox->y = doc["box"]["y"] | 0;
      outBox->w = doc["box"]["w"] | 0;
      outBox->h = doc["box"]["h"] | 0;
      outBox->valid = (outBox->w > 0 && outBox->h > 0);
    }
    else
    {
      outBox->valid = false;
    }
  }

  return success;
}

// ============================================================
// USER LOOKUP
// ============================================================

bool getUserByFingerId(
    int fingerId,
    String &outUserId,
    String &outUserName,
    String &outRole)
{
  String response =
      httpGet(
          "/api/esp32/user-by-finger/" +
          String(fingerId)
      );

  if (
      response.length() ==
      0)
  {
    return false;
  }

  DynamicJsonDocument doc(512);

  if (
      deserializeJson(
          doc,
          response
      ) !=
      DeserializationError::Ok)
  {
    return false;
  }

  if (
      !(doc["found"] |
        false))
  {
    return false;
  }

  outUserId =
      doc["userId"] | "";

  outUserName =
      doc["userName"] | "";

  outRole =
      doc["role"] | "user";

  return
      outUserId.length() >
      0;
}

// Overload for backward compatibility
bool getUserByFingerId(
    int fingerId,
    String &outUserId,
    String &outUserName)
{
  String dummyRole = "user";
  return getUserByFingerId(fingerId, outUserId, outUserName, dummyRole);
}

// ============================================================
// NEXT AVAILABLE USER FOR HARDWARE ENROLLMENT
// ============================================================

bool getNextAvailableUser(
    String &outUserId,
    String &outUserName,
    String &outRole,
    const String &requestedRole = "")
{
  String path = "/api/esp32/next-available-user";
  if (requestedRole.length() > 0)
  {
    path += "?role=" + requestedRole;
  }

  String response =
      httpGet(path);

  if (
      response.length() ==
      0)
  {
    return false;
  }

  DynamicJsonDocument doc(512);

  if (
      deserializeJson(
          doc,
          response
      ) !=
      DeserializationError::Ok)
  {
    return false;
  }

  if (
      !(doc["found"] |
        false))
  {
    return false;
  }

  outUserId =
      doc["userId"] | "";

  outUserName =
      doc["userName"] | "";

  outRole =
      doc["role"] | "user";

  return
      outUserId.length() >
      0;
}

// ============================================================
// FINGERPRINT VERIFIED
// ============================================================

void notifyFingerprintVerified(
    const String &userId,
    int fingerId)
{
  String body =
      "{\"roomId\":\"" +
      String(ROOM_ID) +
      "\",\"userId\":\"" +
      userId +
      "\",\"fingerId\":" +
      String(fingerId) +
      "}";

  httpPostJson(
      "/api/esp32/fingerprint-verified",
      body
  );
}

// ============================================================
// DOOR
// ============================================================

void openDoor()
{
  tftShowFullScreen(
      "ACCESS GRANTED",
      "Door opening",
      COLOR_GREEN
  );

  tftShowStatus(
      "Door unlocked",
      "5 seconds",
      COLOR_GREEN
  );

  digitalWrite(
      RELAY_PIN,
      HIGH
  );

  delay(
      RELAY_OPEN_MS
  );

  digitalWrite(
      RELAY_PIN,
      LOW
  );

  String body =
      "{\"roomId\":\"" +
      String(ROOM_ID) +
      "\"}";

  httpPostJson(
      "/api/esp32/door-closed",
      body
  );
}

// ============================================================
// HEARTBEAT
// ============================================================

void sendHeartbeat()
{
  unsigned long now =
      millis();

  if (
      now -
          lastHeartbeat <
      HEARTBEAT_INTERVAL_MS)
  {
    return;
  }

  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    return;
  }

  lastHeartbeat =
      now;

  String body =
      "{\"roomId\":\"" +
      String(ROOM_ID) +
      "\",\"deviceId\":\"ESP32-" +
      String(ROOM_ID) +
      "\",\"rssi\":" +
      String(WiFi.RSSI()) +
      ",\"freeHeap\":" +
      String(ESP.getFreeHeap()) +
      ",\"uptime\":" +
      String(millis() / 1000) +
      "}";

  httpPostJson(
      "/api/esp32/heartbeat",
      body
  );
}

// ============================================================
// ENROLLMENT ERRORS
// ============================================================

String getFingerprintErrorString(
    int p)
{
  switch (p)
  {
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
      return
          "Unknown (" +
          String(p) +
          ")";
  }
}

void reportEnrollmentFailure(
    const String &userId,
    const String &userName,
    int errorCode,
    const String &stage)
{
  String body =
      "{\"userId\":\"" +
      userId +
      "\",\"userName\":\"" +
      userName +
      "\",\"error\":\"" +
      getFingerprintErrorString(
          errorCode
      ) +
      "\",\"details\":\"Code " +
      String(errorCode) +
      " at " +
      stage +
      "\"}";

  httpPostJson(
      "/api/esp32/enrollment-failed",
      body
  );
}

// ============================================================
// ENROLLMENT SEQUENCE (STEP 1: FINGERPRINT, STEP 2: FACE)
// ============================================================

bool runEnrollmentSequence(
    const String &userId,
    const String &userName,
    const String &role = "user")
{
  if (!fingerprintReady)
    return false;

  // ------------------------------------------------------------
  // STEP 1/2: FINGERPRINT SCAN & MERGE
  // ------------------------------------------------------------

  tftShowFullScreen(
      "ENROLL STEP 1/2",
      userName,
      COLOR_YELLOW
  );

  tftShowStatus(
      "Place finger on sensor",
      "Scan 1 of 2",
      COLOR_YELLOW
  );

  int p = -1;

  while (
      p !=
      FINGERPRINT_OK)
  {
    p =
        finger.getImage();

    delay(100);
  }

  p =
      finger.image2Tz(1);

  if (
      p !=
      FINGERPRINT_OK)
  {
    reportEnrollmentFailure(
        userId,
        userName,
        p,
        "First image"
    );

    return false;
  }

  tftShowStatus(
      "Lift finger...",
      "Done scan 1",
      COLOR_CYAN
  );

  while (
      finger.getImage() !=
      FINGERPRINT_NOFINGER)
  {
    delay(100);
  }

  delay(500);

  bool modelCreated =
      false;

  for (int attempt = 1;
       attempt <= 4;
       attempt++)
  {
    tftShowStatus(
        "Place SAME finger",
        "Scan 2/2 (Att " + String(attempt) + "/4)",
        COLOR_YELLOW
    );

    p = -1;

    while (
        p !=
        FINGERPRINT_OK)
    {
      p =
          finger.getImage();

      delay(100);
    }

    p =
        finger.image2Tz(2);

    if (
        p !=
        FINGERPRINT_OK)
    {
      while (
          finger.getImage() !=
          FINGERPRINT_NOFINGER)
      {
        delay(100);
      }

      continue;
    }

    p =
        finger.createModel();

    if (
        p ==
        FINGERPRINT_OK)
    {
      modelCreated =
          true;

      break;
    }

    while (
        finger.getImage() !=
        FINGERPRINT_NOFINGER)
    {
      delay(100);
    }

    delay(500);
  }

  if (!modelCreated)
  {
    reportEnrollmentFailure(
        userId,
        userName,
        p,
        "Model creation"
    );

    return false;
  }

  int nextId = -1;

  for (int id = 1;
       id <= finger.capacity;
       id++)
  {
    int result =
        finger.loadModel(id);

    if (
        result !=
        FINGERPRINT_OK)
    {
      nextId = id;
      break;
    }
  }

  if (nextId < 1)
  {
    tftShowFullScreen(
        "ENROLL FAILED",
        "No free sensor slots",
        COLOR_RED
    );

    delay(2000);

    return false;
  }

  p =
      finger.storeModel(
          nextId
      );

  if (
      p !=
      FINGERPRINT_OK)
  {
    reportEnrollmentFailure(
        userId,
        userName,
        p,
        "Storage"
    );

    return false;
  }

  String body =
      "{\"fingerId\":" +
      String(nextId) +
      ",\"userId\":\"" +
      userId +
      "\",\"userName\":\"" +
      userName +
      "\",\"role\":\"" +
      role +
      "\",\"roomId\":\"" +
      String(ROOM_ID) +
      "\"}";

  httpPostJson(
      "/api/esp32/enrollment-complete",
      body
  );

  tftShowStatus(
      "Fingerprint Saved!",
      "Slot #" + String(nextId),
      COLOR_GREEN
  );

  delay(1200);

  // ------------------------------------------------------------
  // STEP 2/2: FACE REGISTRATION (LIVE TFT PREVIEW)
  // ------------------------------------------------------------

  tftShowFullScreen(
      "ENROLL STEP 2/2",
      "Waking camera...",
      COLOR_CYAN
  );

  if (!startCamera())
  {
    tftShowFullScreen(
        "CAMERA ERROR",
        "Unable to wake camera",
        COLOR_RED
    );

    delay(2000);

    return false;
  }

  prepareCameraScreen(
      "FACE REGISTRATION",
      userName
  );

  bool faceEnrolled =
      false;

  uint8_t frameCounter =
      0;

  unsigned long start =
      millis();

  while (
      millis() - start <
          LIVE_VIEW_TIME_MS &&
      !faceEnrolled)
  {
    size_t jpegLen =
        fetchJpegFrame(
            jpegBuffer,
            MAX_JPEG_BYTES
        );

    if (jpegLen > 0)
    {
      displayJpegOnTFT(
          jpegBuffer,
          jpegLen
      );

      // Overlay targeting reticle on live stream
      drawFaceReticle(COLOR_YELLOW);

      tftShowStatus(
          "Align face in frame",
          "Capturing biometrics...",
          COLOR_CYAN
      );

      frameCounter++;

      if (
          frameCounter % 3 ==
              0 &&
          jpegLen >
              MIN_FACE_JPEG_BYTES)
      {
        FaceBox enrolledBox;
        faceEnrolled =
            postFaceEnroll(
                userId,
                jpegBuffer,
                jpegLen,
                &enrolledBox
            );

        if (enrolledBox.valid)
        {
          int bx = lastJpegDrawX + (enrolledBox.x / lastJpegScale);
          int by = lastJpegDrawY + (enrolledBox.y / lastJpegScale);
          int bw = enrolledBox.w / lastJpegScale;
          int bh = enrolledBox.h / lastJpegScale;
          drawDynamicFaceBox(bx, by, bw, bh, faceEnrolled ? COLOR_GREEN : COLOR_YELLOW);
          if (faceEnrolled)
          {
            tftShowStatus("Face Captured!", "Biometrics Locked", COLOR_GREEN);
            delay(800);
          }
        }
      }
    }

    delay(100);
  }

  // Always put camera back into standby
  stopCamera();

  if (faceEnrolled)
  {
    tftShowFullScreen(
        role.equalsIgnoreCase("admin") ? "ADMIN ENROLLED" : "USER ENROLLED",
        userName,
        COLOR_GREEN
    );
    tftShowStatus(
        "Biometrics Active",
        "Google Sheets Synced",
        COLOR_GREEN
    );
  }
  else
  {
    tftShowFullScreen(
        "FACE INCOMPLETE",
        "Retry from admin menu",
        COLOR_RED
    );
  }

  delay(2500);

  return faceEnrolled;
}

// ============================================================
// AUTONOMOUS HARDWARE ENROLLMENT (100% STANDALONE)
// ============================================================

bool runAutonomousHardwareEnrollment(const String &requestedRole = "user")
{
  wakeToActive("Hardware Enrollment");

  tftShowFullScreen(
      "NEW ENROLLMENT",
      "Fetching " + requestedRole + " slot...",
      COLOR_CYAN
  );

  String userId = "";
  String userName = "";
  String role = requestedRole;

  if (!getNextAvailableUser(userId, userName, role, requestedRole))
  {
    tftShowFullScreen(
        "FETCH ERROR",
        "Could not load " + requestedRole,
        COLOR_RED
    );
    delay(2000);
    return false;
  }

  tftShowFullScreen(
      role.equalsIgnoreCase("admin") ? "ENROLLING ADMIN" : "ENROLLING USER",
      userName + " (" + userId + ")",
      COLOR_YELLOW
  );
  delay(1200);

  bool success = runEnrollmentSequence(userId, userName, role);
  return success;
}

// ============================================================
// ADMIN HARDWARE MENU (TRIGGERED ON ADMIN LONG-PRESS)
// ============================================================

void showAdminHardwareMenu(const String &adminName)
{
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

  while (millis() - startWait < 7000 && !actionTaken)
  {
    uint8_t r = finger.getImage();
    if (r == FINGERPRINT_OK)
    {
      unsigned long touchStart = millis();
      while (finger.getImage() == FINGERPRINT_OK && (millis() - touchStart < 2500))
      {
        delay(50);
      }
      unsigned long touchDuration = millis() - touchStart;

      while (finger.getImage() != FINGERPRINT_NOFINGER)
      {
        delay(50);
      }

      actionTaken = true;

      if (touchDuration >= 1500)
      {
        tftShowFullScreen("ADMIN UNLOCK", adminName, COLOR_GREEN);
        openDoor();
      }
      else if (touchDuration >= 600)
      {
        runAutonomousHardwareEnrollment("admin");
      }
      else
      {
        runAutonomousHardwareEnrollment("user");
      }
      break;
    }
    delay(50);
  }

  if (!actionTaken)
  {
    tftShowStatus("Menu timed out", "Returning to standby", COLOR_GRAY);
    delay(1000);
  }
}

// ============================================================
// ADMIN COMMANDS (CLOUD / POLLING FALLBACK)
// ============================================================

void checkForAdminCommands()
{
  if (
      systemState !=
      STATE_IDLE)
  {
    return;
  }

  unsigned long now =
      millis();

  if (
      now -
          lastCommandPoll <
      COMMAND_POLL_INTERVAL_MS)
  {
    return;
  }

  lastCommandPoll =
      now;

  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    return;
  }

  String response =
      httpGet(
          "/api/esp32/get-commands/" +
          String(ROOM_ID)
      );

  if (
      response.length() ==
      0)
  {
    return;
  }

  DynamicJsonDocument doc(512);

  if (
      deserializeJson(
          doc,
          response
      ) !=
      DeserializationError::Ok)
  {
    return;
  }

  if (
      !(doc["hasCommand"] |
        false))
  {
    return;
  }

  String command =
      doc["command"] | "";

  String commandUserName =
      doc["userName"] | "";

  if (
      command ==
      "unlock")
  {
    wakeToActive(
        "Remote unlock"
    );

    tftShowFullScreen(
        "ADMIN UNLOCK",
        commandUserName,
        COLOR_CYAN
    );

    openDoor();

    delay(1000);

    enterIdleMode();

    return;
  }

  if (
      command.startsWith(
          "ENROLL:"
      ))
  {
    int separator =
        command.indexOf(
            ':',
            7
        );

    if (separator <= 0)
      return;

    String userId =
        command.substring(
            7,
            separator
        );

    String rem =
        command.substring(
            separator + 1
        );

    String userName = rem;
    String role = "user";

    int sep2 = rem.indexOf(':');
    if (sep2 > 0)
    {
      userName = rem.substring(0, sep2);
      role = rem.substring(sep2 + 1);
      role.trim();
    }

    wakeToActive(
        "Enrollment"
    );

    runEnrollmentSequence(
        userId,
        userName,
        role
    );

    enterIdleMode();

    return;
  }
}

// ============================================================
// ACCESS FLOW (DUAL BIOMETRIC VERIFICATION)
// ============================================================

void runAccessFlow(
    int fingerId)
{
  String userId = "";
  String userName = "";
  String userRole = "user";

  tftShowFullScreen(
      "FINGER MATCHED",
      "Checking account...",
      COLOR_CYAN
  );

  if (
      !getUserByFingerId(
          fingerId,
          userId,
          userName,
          userRole
      ))
  {
    tftShowFullScreen(
        "USER NOT FOUND",
        "Fingerprint not linked",
        COLOR_RED
    );

    delay(2500);

    return;
  }

  // ------------------------------------------------------------
  // ADMIN LONG-PRESS CHECK FOR HARDWARE MENU
  // ------------------------------------------------------------
  if (userRole.equalsIgnoreCase("admin"))
  {
    // Check if admin is holding finger on sensor to open hardware menu
    unsigned long pressStart = millis();
    bool isLongPress = false;

    while (millis() - pressStart < 1800)
    {
      if (finger.getImage() == FINGERPRINT_OK)
      {
        if (millis() - pressStart > 1200)
        {
          isLongPress = true;
          break;
        }
      }
      else
      {
        break;
      }
      delay(50);
    }

    if (isLongPress)
    {
      while (finger.getImage() != FINGERPRINT_NOFINGER)
      {
        delay(50);
      }
      showAdminHardwareMenu(userName);
      return;
    }
  }

  tftShowFullScreen(
      "IDENTIFIED",
      userName,
      COLOR_GREEN
  );

  notifyFingerprintVerified(
      userId,
      fingerId
  );

  // =========================================================
  // WAKE ESP32-CAM FOR LIVE FACE VERIFICATION
  // =========================================================

  tftShowStatus(
      "Waking camera...",
      "",
      COLOR_CYAN
  );

  if (!startCamera())
  {
    tftShowFullScreen(
        "CAMERA ERROR",
        "Camera unavailable",
        COLOR_RED
    );

    delay(2500);

    return;
  }

  prepareCameraScreen(
      "FACE VERIFICATION",
      userName
  );

  bool faceVerified =
      false;

  uint8_t frameCounter =
      0;

  unsigned long start =
      millis();

  while (
      millis() - start <
          LIVE_VIEW_TIME_MS &&
      !faceVerified)
  {
    size_t jpegLen =
        fetchJpegFrame(
            jpegBuffer,
            MAX_JPEG_BYTES
        );

    if (jpegLen > 0)
    {
      displayJpegOnTFT(
          jpegBuffer,
          jpegLen
      );

      // Draw centering reticle on top of live camera stream
      drawFaceReticle(COLOR_CYAN);

      tftShowStatus(
          "Look at camera",
          "Verifying identity...",
          COLOR_CYAN
      );

      frameCounter++;

      if (
          frameCounter % 3 ==
              0 &&
          jpegLen >
              MIN_FACE_JPEG_BYTES)
      {
        FaceBox verifyBox;
        faceVerified =
            postFaceVerify(
                userId,
                String(ROOM_ID),
                jpegBuffer,
                jpegLen,
                &verifyBox
            );

        if (verifyBox.valid)
        {
          int bx = lastJpegDrawX + (verifyBox.x / lastJpegScale);
          int by = lastJpegDrawY + (verifyBox.y / lastJpegScale);
          int bw = verifyBox.w / lastJpegScale;
          int bh = verifyBox.h / lastJpegScale;
          drawDynamicFaceBox(bx, by, bw, bh, faceVerified ? COLOR_GREEN : COLOR_YELLOW);
          if (faceVerified)
          {
            tftShowStatus("Identity Confirmed!", "Face Matched", COLOR_GREEN);
            delay(900);
          }
        }
      }
    }

    delay(100);
  }

  // Put camera into standby immediately
  stopCamera();

  // =========================================================
  // OUTCOME
  // =========================================================

  if (faceVerified)
  {
    tftShowFullScreen(
        "VERIFIED",
        userName,
        COLOR_GREEN
    );

    openDoor();

    tftShowFullScreen(
        "WELCOME",
        userName,
        COLOR_GREEN
    );

    delay(2500);

    return;
  }

  tftShowFullScreen(
      "ACCESS DENIED",
      "Face not matched",
      COLOR_RED
  );

  delay(2500);
}

// ============================================================
// FINGERPRINT POLLING
// ============================================================

bool processFingerprintIfPresent()
{
  if (
      systemState !=
          STATE_IDLE ||
      !fingerprintReady)
  {
    return false;
  }

  uint8_t result =
      finger.getImage();

  if (
      result !=
      FINGERPRINT_OK)
  {
    return false;
  }

  Serial.println(
      "Finger detected"
  );

  wakeToActive(
      "Finger detected"
  );

  tftShowStatus(
      "Reading fingerprint...",
      "",
      COLOR_CYAN
  );

  if (
      finger.image2Tz(1) !=
      FINGERPRINT_OK)
  {
    tftShowFullScreen(
        "SCAN ERROR",
        "Try again",
        COLOR_YELLOW
    );

    while (
        finger.getImage() !=
        FINGERPRINT_NOFINGER)
    {
      delay(75);
    }

    delay(1000);

    enterIdleMode();

    return true;
  }

  if (
      finger.fingerSearch() !=
      FINGERPRINT_OK)
  {
    tftShowFullScreen(
        "NO MATCH",
        "Not registered",
        COLOR_RED
    );

    while (
        finger.getImage() !=
        FINGERPRINT_NOFINGER)
    {
      delay(75);
    }

    delay(1500);

    enterIdleMode();

    return true;
  }

  int fingerId =
      finger.fingerID;

  int confidence =
      finger.confidence;

  Serial.printf(
      "Fingerprint ID=%d Confidence=%d\n",
      fingerId,
      confidence
  );

  if (confidence < 50)
  {
    tftShowFullScreen(
        "LOW CONFIDENCE",
        "Try again",
        COLOR_YELLOW
    );

    while (
        finger.getImage() !=
        FINGERPRINT_NOFINGER)
    {
      delay(75);
    }

    delay(1000);

    enterIdleMode();

    return true;
  }

  runAccessFlow(
      fingerId
  );

  enterIdleMode();

  return true;
}

// ============================================================
// SETUP
// ============================================================

void setup()
{
  Serial.begin(
      115200
  );

  delay(300);

  // =========================================================
  // LOAD DYNAMIC SERVER URL FROM NVS
  // =========================================================
  Preferences prefs;
  prefs.begin("labsync", true);
  String savedServer = prefs.getString("server_url", "");
  prefs.end();

  if (savedServer.length() > 0)
  {
    activeServerUrl = savedServer;
    Serial.println(
        "🌐 Dynamic Server URL loaded from NVS: " +
        activeServerUrl
    );
  }
  else
  {
    Serial.println(
        "🌐 Using default Server URL: " +
        activeServerUrl
    );
  }

  // =========================================================
  // RELAY
  // =========================================================

  pinMode(
      RELAY_PIN,
      OUTPUT
  );

  digitalWrite(
      RELAY_PIN,
      LOW
  );

  // =========================================================
  // TFT
  // =========================================================

  SPI.begin(
      TFT_SCLK,
      TFT_MISO,
      TFT_MOSI,
      TFT_CS
  );

  tft.begin(
      40000000
  );

  /*
      Portrait rotated 180 degrees.
  */

  tft.setRotation(2);

  tft.fillScreen(
      COLOR_BG
  );

  // =========================================================
  // JPEG DECODER
  // =========================================================

  TJpgDec.setSwapBytes(false);
  TJpgDec.setJpgScale(1);
  TJpgDec.setCallback(
      tftJpegOutput
  );

  jpegBuffer =
      (uint8_t *)malloc(
          MAX_JPEG_BYTES
      );

  if (!jpegBuffer)
  {
    tft.fillScreen(
        COLOR_RED
    );

    tft.setTextColor(
        COLOR_WHITE,
        COLOR_RED
    );

    tft.setTextSize(2);

    tft.setCursor(
        10,
        100
    );

    tft.println(
        "MEMORY ERROR"
    );

    while (true)
    {
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

  if (
      WiFi.status() ==
      WL_CONNECTED)
  {
    startMainMDNS();

    /*
       Camera IP is discovered dynamically.
       This does NOT wake the camera sensor.
    */

    resolveCamera();
  }

  cameraStreaming =
      false;

  enterIdleMode();

  Serial.println(
      "LabSync ready"
  );
}

// ============================================================
// LOOP
// ============================================================

void loop()
{
  retryFingerprintIfNeeded();

  // =========================================================
  // LIVE RUNTIME SERIAL COMMANDS FOR DYNAMIC IP CONTROL
  // =========================================================
  if (Serial.available())
  {
    String line = Serial.readStringUntil('\n');
    line.trim();

    if (line.startsWith("SET_SERVER "))
    {
      String newUrl = line.substring(11);
      newUrl.trim();
      if (newUrl.length() > 0)
      {
        activeServerUrl = newUrl;
        Preferences p;
        p.begin("labsync", false);
        p.putString("server_url", activeServerUrl);
        p.end();
        Serial.println("✅ Dynamic Server URL updated and saved: " + activeServerUrl);
      }
    }
    else if (line == "RESET_SERVER")
    {
      activeServerUrl = DEFAULT_SERVER_URL;
      Preferences p;
      p.begin("labsync", false);
      p.remove("server_url");
      p.end();
      Serial.println("✅ Server URL reset to Render cloud: " + activeServerUrl);
    }
    else if (line == "IP_STATUS")
    {
      Serial.println("=== LABSYNC DYNAMIC IP STATUS ===");
      Serial.println("ESP32 Local IP: " + WiFi.localIP().toString());
      Serial.println("Camera Base URL: " + (cameraBaseUrl.length() > 0 ? cameraBaseUrl : "NOT RESOLVED"));
      Serial.println("Server URL:      " + activeServerUrl);
      Serial.println("================================");
    }
  }

  // Fingerprint has highest priority.
  if (
      processFingerprintIfPresent())
  {
    return;
  }

  // =========================================================
  // WIFI RECONNECT
  // =========================================================

  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    mdnsStarted = false;

    cameraBaseUrl = "";

    connectWiFi(false);

    if (
        WiFi.status() ==
        WL_CONNECTED)
    {
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

  if (
      systemState ==
      STATE_IDLE)
  {
    sendHeartbeat();

    checkForAdminCommands();
  }

  delay(40);
}