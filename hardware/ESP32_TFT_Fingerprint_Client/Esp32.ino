/*

LabSync Main ESP32 Client v3.10 - Cooling Fan + Timed Push Button Door OR Logic

Hardware:
ESP32 DevKit / WROOM
R307 / AS608 fingerprint sensor
ILI9341 TFT
Door relay on GPIO 26
Cooling fan relay on GPIO 27
Normally-open push button between GPIO 25 and GND
ESP32-CAM on same WiFi

Door control:
- A debounced button press starts or restarts a 5-second unlock timer.
- Releasing the button does not cancel that timer. Holding the button
  still keeps the door unlocked, preserving the original held-button logic.
- Access grants from biometrics or admin unlock remain active for 5 seconds.
- buttonUnlockRequest = buttonPressed || buttonUnlockActive.
- doorUnlocked = buttonUnlockRequest || accessGranted.
- The door locks only when BOTH inputs are 0.
- INPUT_PULLDOWN wiring: GPIO 25 -- normally-open button -- 3.3 V.
  A physical HIGH is converted to logical pressed = true.
- A separate task checks the button during camera, enrollment, and HTTP waits.
- Backend door-closed reporting follows the relay's lock command, not a
  physical door-position sensor. Reports are sent by the main task when idle.

Cooling fan:
- OFF at startup. First scheduled ON cycle after 15 minutes.
- Scheduled ON every 15 minutes, for 3 minutes.
- Fingerprint activity, enrollment, camera start/stop, and door opening
  also start or restart the 3-minute ON period. Button presses do too.
- Activity does not move the independent 15-minute schedule.
- A separate FreeRTOS task handles fan timing during blocking operations.
- Fan relay defaults to active-HIGH. Set FAN_RELAY_ACTIVE_HIGH to false
  for an active-LOW relay module. Use a 3.3 V-compatible relay input;
  GPIO 27 controls the module input, not the fan or bare relay coil.

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
#include <WiFiUdp.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include "mbedtls/md.h"
#include "esp_random.h"
#include <time.h>
#include <sys/time.h>

// ============================================================
// ⚠️  CHANGE THESE — WiFi and lab configuration
// ============================================================

const char *WIFI_SSID = "Arun";         // ← Change to your WiFi name
const char *WIFI_PASSWORD = "4064097a"; // ← Change to your WiFi password

// Default Server URL (Can be changed dynamically via Preferences / Serial
// without reflashing)
const char *DEFAULT_SERVER_URL = "https://labsync-460952407297.asia-south1.run.app";
String activeServerUrl = DEFAULT_SERVER_URL;

const char *CAMERA_MDNS_NAME = "esp32cam";

/*
CAMERA_IP_FALLBACK:
Used only if mDNS, Backend Registry, and NVS Cache all fail.
*/
// Manual fallback requires a numeric IP, e.g. "192.168.1.100".
// The existing "esp32cam" value is retained; mDNS uses CAMERA_MDNS_NAME.
const char *CAMERA_IP_FALLBACK = "esp32cam";

const char *ROOM_ID = "ROOM-001";

// ============================================================
// DEVICE HMAC AUTHENTICATION
// Must match backend .env: DEVICE_ID / DEVICE_SECRET.
// Regenerate with: node scripts/generate_device_secret.js
// ============================================================
const char *DEVICE_ID = "test-esp32-01";          // ← must match .env DEVICE_ID
const char *DEVICE_SECRET = "test-device-secret"; // ← must match .env DEVICE_SECRET

// Authentication requires wall-clock epoch milliseconds. Wait for NTP rather
// than signing requests with uptime. gettimeofday keeps seconds and fractions
// from the same clock, unlike time(nullptr) + millis() % 1000.
unsigned long long epochMs() {
  struct timeval now = {};
  if (gettimeofday(&now, nullptr) != 0 || now.tv_sec <= 1600000000) {
    return 0;
  }
  return static_cast<unsigned long long>(now.tv_sec) * 1000ULL +
         static_cast<unsigned long long>(now.tv_usec) / 1000ULL;
}

void ensureDeviceTimeSync() {
  static bool configured = false;
  if (!configured && WiFi.status() == WL_CONNECTED) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    configured = true;
    Serial.println("NTP sync requested (pool.ntp.org)");
  }
}

// Command idempotency: an ACKed command re-delivered by the backend must not
// run a second time (that used to re-run enrollments).
String lastExecutedCommandId = "";
bool lastExecutedCommandOk = false;

// ============================================================
// ESP32-CAM UDP DISCOVERY - RETAINED FROM esp32v2
// ============================================================
// ESP32-CAM broadcasts:  espcam_ip=192.168.x.x
// Main ESP32 listens on: UDP port 4210
// ============================================================

constexpr uint16_t CAMERA_DISCOVERY_PORT = 4210;
constexpr uint32_t CAMERA_UDP_WAIT_MS = 1300;
constexpr uint16_t CAMERA_CONNECT_TIMEOUT_MS = 2500;
constexpr uint16_t CAMERA_WAKE_TIMEOUT_MS = 15000;
constexpr uint16_t CAMERA_COMMAND_TIMEOUT_MS = 5000;

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
// Connect TFT LED/BL to GPIO 21, or directly to 3.3 V for always-on.
constexpr int TFT_LED = 21;

// Portrait 240 x 320 (180-degree portrait orientation).
constexpr uint8_t TFT_ROTATION = 2;

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
constexpr bool DOOR_RELAY_ACTIVE_HIGH = true;
constexpr int DOOR_RELAY_ON_LEVEL = DOOR_RELAY_ACTIVE_HIGH ? HIGH : LOW;
constexpr int DOOR_RELAY_OFF_LEVEL = DOOR_RELAY_ACTIVE_HIGH ? LOW : HIGH;

// Normally-open button between GPIO 25 and GND. Pressed is logical 1.
constexpr int DOOR_BUTTON_PIN = 25;
constexpr uint32_t DOOR_BUTTON_DEBOUNCE_MS = 30;
constexpr uint32_t DOOR_BUTTON_UNLOCK_MS = 5000;
constexpr uint32_t DOOR_TASK_POLL_MS = 10;

// Cooling fan relay. Independent of the existing door relay above.
constexpr int FAN_RELAY_PIN = 27;
constexpr bool FAN_RELAY_ACTIVE_HIGH = true;
constexpr int FAN_RELAY_ON_LEVEL = FAN_RELAY_ACTIVE_HIGH ? HIGH : LOW;
constexpr int FAN_RELAY_OFF_LEVEL = FAN_RELAY_ACTIVE_HIGH ? LOW : HIGH;
constexpr uint32_t FAN_RUN_MS = 3UL * 60UL * 1000UL;
constexpr uint32_t FAN_INTERVAL_MS = 15UL * 60UL * 1000UL;
constexpr uint32_t FAN_TASK_POLL_MS = 50;

static_assert(FAN_RELAY_PIN != RELAY_PIN, "Fan and door require separate GPIOs");
static_assert(DOOR_BUTTON_PIN != RELAY_PIN && DOOR_BUTTON_PIN != FAN_RELAY_PIN, "Button and relays require separate GPIOs");
static_assert(FAN_RUN_MS < FAN_INTERVAL_MS, "Fan run must be shorter than interval");

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

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

HardwareSerial fpSerial(2);

Adafruit_Fingerprint finger(static_cast<Stream *>(&fpSerial));

// ============================================================
// SYSTEM STATE
// ============================================================

enum SystemState { STATE_IDLE, STATE_ACTIVE };

SystemState systemState = STATE_ACTIVE;

// ============================================================
// GLOBALS
// ============================================================

uint8_t *jpegBuffer = nullptr;
size_t jpegBufferCapacity = 0;

String cameraBaseUrl = "";

bool fingerprintReady = false;
bool cameraStreaming = false;
int cameraLastHttpCode = 0;
String cameraLastResponse = "";
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
// COOLING FAN CONTROL
// ============================================================

TaskHandle_t coolingFanTaskHandle = nullptr;

// Only this worker writes the fan output after initialization. Notifications
// let activity restart its timer without sharing mutable timing variables.
void coolingFanWorker(void *parameter) {
  (void)parameter;

  uint32_t lastPeriodicAt = millis();
  uint32_t lastTriggeredAt = 0;
  bool fanOn = false;

  for (;;) {
    bool trigger = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(FAN_TASK_POLL_MS)) > 0;
    const uint32_t now = millis();
    const uint32_t periodicElapsed = now - lastPeriodicAt;

    if (periodicElapsed >= FAN_INTERVAL_MS) {
      // Retain the original cadence, even if this task was scheduled late.
      lastPeriodicAt += (periodicElapsed / FAN_INTERVAL_MS) * FAN_INTERVAL_MS;
      trigger = true;
    }

    if (trigger) {
      lastTriggeredAt = now;
      if (!fanOn) {
        digitalWrite(FAN_RELAY_PIN, FAN_RELAY_ON_LEVEL);
        fanOn = true;
      }
    }

    // Unsigned subtraction also handles the millis() counter wrapping.
    if (fanOn && static_cast<uint32_t>(now - lastTriggeredAt) >= FAN_RUN_MS) {
      digitalWrite(FAN_RELAY_PIN, FAN_RELAY_OFF_LEVEL);
      fanOn = false;
    }
  }
}

bool initCoolingFan() {
  if (coolingFanTaskHandle != nullptr) {
    return true;
  }

  // Preload OFF before enabling the output to reduce switching glitches.
  digitalWrite(FAN_RELAY_PIN, FAN_RELAY_OFF_LEVEL);
  pinMode(FAN_RELAY_PIN, OUTPUT);
  digitalWrite(FAN_RELAY_PIN, FAN_RELAY_OFF_LEVEL);

  const BaseType_t created =
      xTaskCreate(coolingFanWorker, "coolingFan", 2048, nullptr, 1, &coolingFanTaskHandle);
  if (created != pdPASS) {
    coolingFanTaskHandle = nullptr;
    digitalWrite(FAN_RELAY_PIN, FAN_RELAY_OFF_LEVEL);
    Serial.println("ERROR: Cooling fan task creation failed; fan remains OFF.");
    return false;
  }

  Serial.println("Cooling fan ready: GPIO 27, 3 minutes ON, 15-minute schedule.");
  return true;
}

void requestCoolingFan() {
  if (coolingFanTaskHandle != nullptr) {
    xTaskNotifyGive(coolingFanTaskHandle);
  }
}

// ============================================================
// DOOR BUTTON / ACCESS OR CONTROLLER
// ============================================================

TaskHandle_t doorControlTaskHandle = nullptr;
portMUX_TYPE doorStateMux = portMUX_INITIALIZER_UNLOCKED;
bool doorRelayUnlocked = false;
bool doorClosedReportPending = false;

// The worker owns the door output. Only these status flags cross tasks.
void publishDoorRelayState(bool unlocked) {
  portENTER_CRITICAL(&doorStateMux);
  doorRelayUnlocked = unlocked;
  // A new opening cancels an obsolete, unsent closed-state report.
  doorClosedReportPending = !unlocked;
  portEXIT_CRITICAL(&doorStateMux);
}

bool takeDoorClosedReport() {
  portENTER_CRITICAL(&doorStateMux);
  const bool pending = doorClosedReportPending && !doorRelayUnlocked;
  if (pending) {
    doorClosedReportPending = false;
  }
  portEXIT_CRITICAL(&doorStateMux);
  return pending;
}

void doorControlWorker(void *parameter) {
  (void)parameter;

  // Start with a released logical button; even a button held at boot must
  // remain stable for the debounce period before it can unlock the door.
  bool lastRawPressed = false;
  bool buttonPressed = false;
  uint32_t rawChangedAt = millis();
  bool buttonUnlockActive = false;
  uint32_t buttonUnlockStartedAt = 0;
  bool accessGranted = false;
  uint32_t accessGrantedAt = 0;
  bool unlocked = false;

  for (;;) {
    const bool newAccessGrant = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(DOOR_TASK_POLL_MS)) > 0;
    const uint32_t now = millis();
    const bool rawPressed = digitalRead(DOOR_BUTTON_PIN) == HIGH;

    if (rawPressed != lastRawPressed) {
      lastRawPressed = rawPressed;
      rawChangedAt = now;
    }

    if (buttonPressed != lastRawPressed &&
        static_cast<uint32_t>(now - rawChangedAt) >= DOOR_BUTTON_DEBOUNCE_MS) {
      buttonPressed = lastRawPressed;
      if (buttonPressed) {
        buttonUnlockActive = true;
        buttonUnlockStartedAt = now;
        requestCoolingFan();
      }
    }

    if (newAccessGrant) {
      accessGranted = true;
      accessGrantedAt = now;
      requestCoolingFan();
    }

    if (buttonUnlockActive &&
        static_cast<uint32_t>(now - buttonUnlockStartedAt) >= DOOR_BUTTON_UNLOCK_MS) {
      buttonUnlockActive = false;
    }

    if (accessGranted && static_cast<uint32_t>(now - accessGrantedAt) >= RELAY_OPEN_MS) {
      accessGranted = false;
    }

    // A quick tap remains active for 5 seconds. A held button remains active
    // until released, even if its timer has already expired.
    const bool buttonUnlockRequest = buttonPressed || buttonUnlockActive;
    const bool shouldUnlock = buttonUnlockRequest || accessGranted;
    if (shouldUnlock != unlocked) {
      digitalWrite(RELAY_PIN, shouldUnlock ? DOOR_RELAY_ON_LEVEL : DOOR_RELAY_OFF_LEVEL);
      unlocked = shouldUnlock;
      publishDoorRelayState(unlocked);
    }
  }
}

bool initDoorControl() {
  if (doorControlTaskHandle != nullptr) {
    return true;
  }

  digitalWrite(RELAY_PIN, DOOR_RELAY_OFF_LEVEL);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, DOOR_RELAY_OFF_LEVEL);
  pinMode(DOOR_BUTTON_PIN, INPUT_PULLDOWN);

  portENTER_CRITICAL(&doorStateMux);
  doorRelayUnlocked = false;
  doorClosedReportPending = false;
  portEXIT_CRITICAL(&doorStateMux);

  const BaseType_t created =
      xTaskCreate(doorControlWorker, "doorControl", 2048, nullptr, 1, &doorControlTaskHandle);
  if (created != pdPASS) {
    doorControlTaskHandle = nullptr;
    digitalWrite(RELAY_PIN, DOOR_RELAY_OFF_LEVEL);
    Serial.println("ERROR: Door control task creation failed; door output remains locked.");
    return false;
  }

  Serial.println("Door ready: GPIO 25 button OR 5-second access grant; relay GPIO 26.");
  return true;
}

bool requestDoorAccess() {
  if (doorControlTaskHandle == nullptr) {
    return false;
  }

  // Notifications restart the worker's access timer, independent of the UI.
  xTaskNotifyGive(doorControlTaskHandle);
  return true;
}

// ============================================================
// JPEG BUFFER ALLOCATION
// ============================================================

bool allocateJpegBuffer() {
  const size_t candidates[] = {JPEG_BUFFER_PRIMARY_BYTES, JPEG_BUFFER_FALLBACK_1_BYTES,
                               JPEG_BUFFER_FALLBACK_2_BYTES};

  Serial.println();
  Serial.println("Allocating JPEG buffer...");
  Serial.printf("Free heap before JPEG buffer: %u bytes\n", (unsigned int)ESP.getFreeHeap());
  Serial.printf("Largest allocatable heap block: %u bytes\n", (unsigned int)ESP.getMaxAllocHeap());

  for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
    const size_t requested = candidates[i];

    Serial.printf("Trying JPEG buffer: %u bytes\n", (unsigned int)requested);

    jpegBuffer = static_cast<uint8_t *>(malloc(requested));

    if (jpegBuffer != nullptr) {
      jpegBufferCapacity = requested;

      Serial.printf("JPEG buffer allocated: %u bytes\n", (unsigned int)jpegBufferCapacity);
      Serial.printf("Free heap after JPEG buffer: %u bytes\n", (unsigned int)ESP.getFreeHeap());

      return true;
    }
  }

  jpegBufferCapacity = 0;

  Serial.println("ERROR: Unable to allocate JPEG buffer.");
  Serial.printf("Free heap: %u bytes\n", (unsigned int)ESP.getFreeHeap());
  Serial.printf("Largest allocatable heap block: %u bytes\n", (unsigned int)ESP.getMaxAllocHeap());

  return false;
}

// ============================================================
// TFT STATUS
// ============================================================

void tftShowStatus(const String &line1, const String &line2, uint16_t color = COLOR_WHITE) {
  int16_t y = tft.height() - STATUS_HEIGHT;

  tft.fillRect(0, y, tft.width(), STATUS_HEIGHT, COLOR_BG);

  tft.drawFastHLine(0, y, tft.width(), COLOR_GRAY);

  tft.setTextSize(1);

  tft.setTextColor(color, COLOR_BG);

  tft.setCursor(8, y + 9);

  tft.println(line1);

  if (line2.length() > 0) {
    tft.setCursor(8, y + 26);

    tft.println(line2);
  }
}

// ============================================================
// TFT FULL SCREEN
// ============================================================

void tftShowFullScreen(const String &title, const String &subtitle, uint16_t titleColor) {
  tft.fillScreen(COLOR_BG);

  tft.fillRect(0, 0, tft.width(), 32, titleColor);

  tft.setTextColor(COLOR_BG, titleColor);

  tft.setTextSize(2);

  tft.setCursor(8, 8);

  tft.print("LABSYNC");

  tft.setTextColor(titleColor, COLOR_BG);

  tft.setTextSize(2);

  tft.setCursor(8, 55);

  tft.println(title);

  tft.setTextColor(COLOR_WHITE, COLOR_BG);

  tft.setTextSize(1);

  tft.setCursor(8, 92);

  tft.println(subtitle);
}

// ============================================================
// SPLASH
// ============================================================

void tftSplashScreen() {
  tft.fillScreen(COLOR_BG);

  tft.fillRect(0, 0, tft.width(), 46, COLOR_CYAN);

  tft.setTextColor(COLOR_BG, COLOR_CYAN);

  tft.setTextSize(3);

  int16_t titleWidth = 7 * 18;

  int16_t titleX = (tft.width() - titleWidth) / 2;

  if (titleX < 0)
    titleX = 5;

  tft.setCursor(titleX, 12);

  tft.print("LABSYNC");

  tft.setTextSize(1);

  tft.setTextColor(COLOR_CYAN, COLOR_BG);

  tft.setCursor(12, 75);

  tft.println("Smart Lab Access System");

  tft.setCursor(12, 95);

  tft.print("Room: ");
  tft.println(ROOM_ID);

  tft.setTextColor(COLOR_WHITE, COLOR_BG);

  tft.setCursor(12, 130);

  tft.println("Starting fingerprint...");
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
  if (systemState != STATE_IDLE)
    return;

  unsigned long now = millis();

  if (now - lastIdleAnimation < IDLE_ANIMATION_INTERVAL_MS) {
    return;
  }

  lastIdleAnimation = now;

  constexpr int16_t textWidth = 100;
  constexpr int16_t textHeight = 28;

  if (previousIdleX >= 0 && previousIdleY >= 0) {
    tft.fillRect(previousIdleX, previousIdleY, textWidth, textHeight, COLOR_BG);
  }

  idleX += idleDX;
  idleY += idleDY;

  if (idleX <= 5) {
    idleX = 5;
    idleDX = abs(idleDX);
  }

  if (idleX + textWidth >= tft.width() - 5) {
    idleX = tft.width() - textWidth - 5;

    idleDX = -abs(idleDX);
  }

  if (idleY <= 40) {
    idleY = 40;
    idleDY = abs(idleDY);
  }

  if (idleY + textHeight >= tft.height() - 20) {
    idleY = tft.height() - textHeight - 20;

    idleDY = -abs(idleDY);
  }

  tft.setTextSize(1);

  tft.setTextColor(COLOR_CYAN, COLOR_BG);

  tft.setCursor(idleX, idleY);

  tft.print("LABSYNC");

  tft.setTextColor(COLOR_GRAY, COLOR_BG);

  tft.setCursor(idleX, idleY + 14);

  tft.print("Touch sensor");

  previousIdleX = idleX;

  previousIdleY = idleY;
}

// ============================================================
// ENTER IDLE
// ============================================================

void enterIdleMode() {
  systemState = STATE_IDLE;

  // Keep fingerprint sensor optical backlight LED illuminated
  finger.LEDcontrol(FINGERPRINT_LED_ON);

  tft.fillScreen(COLOR_BG);

  resetIdleAnimation();

  updateIdleScreen();

  Serial.println();
  Serial.println("==============================");
  Serial.println("MAIN ESP32 IDLE");
  Serial.println("Fingerprint : ACTIVE");
  Serial.println("WiFi        : ACTIVE");
  Serial.println("Camera      : STANDBY");
  Serial.println("==============================");
}

// ============================================================
// WAKE UI
// ============================================================

void wakeToActive(const String &reason) {
  requestCoolingFan();

  systemState = STATE_ACTIVE;

  tft.fillScreen(COLOR_BG);

  for (int i = 0; i < 4; i++) {
    int margin = 25 - (i * 5);

    tft.drawRect(margin, margin, tft.width() - (margin * 2), tft.height() - (margin * 2),
                 COLOR_CYAN);

    delay(45);
  }

  tftShowFullScreen("ACTIVE", reason, COLOR_CYAN);
}

// ============================================================
// WIFI
// ============================================================

void connectWiFi(bool showOnDisplay = true) {
  if (WiFi.status() == WL_CONNECTED) {
    ensureDeviceTimeSync();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  if (showOnDisplay) {
    tftShowFullScreen("CONNECTING", WIFI_SSID, COLOR_YELLOW);
  }

  Serial.print("Connecting WiFi");

  // Keep startup bounded. If WiFi is slow or unavailable,
  // normal loop() retries without blocking the UI.
  const int maxAttempts = showOnDisplay ? 12 : 1;
  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && attempts < maxAttempts) {
    delay(500);
    Serial.print('.');
    attempts++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected");
    Serial.println("Main ESP32 IP: " + WiFi.localIP().toString());

    ensureDeviceTimeSync();

    if (showOnDisplay) {
      tftShowStatus("WiFi connected", WiFi.localIP().toString(), COLOR_GREEN);

      delay(250);
    }
  } else {
    Serial.println("WiFi not ready yet; background reconnect enabled");

    if (showOnDisplay) {
      tftShowStatus("WiFi connecting", "Continuing startup...", COLOR_YELLOW);

      delay(250);
    }
  }
}

// ============================================================
// MAIN ESP32 MDNS
// ============================================================

bool startMainMDNS() {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  if (mdnsStarted)
    return true;

  if (!MDNS.begin("labsync-client")) {
    Serial.println("Main mDNS failed");

    mdnsStarted = false;

    return false;
  }

  mdnsStarted = true;

  Serial.println("Main mDNS started");

  return true;
}

// ============================================================
// FINGERPRINT INITIALIZATION
// ============================================================

bool verifyFingerprintSensor() {
  if (!finger.verifyPassword())
    return false;

  finger.getParameters();

  Serial.println("Fingerprint detected");

  Serial.printf("Capacity: %d\n", finger.capacity);

  Serial.printf("Security: %d\n", finger.security_level);

  // Keep optical sensor prism backlight LED always ON
  finger.LEDcontrol(FINGERPRINT_LED_ON);

  return true;
}

void initFingerprint() {
  Serial.println("Starting fingerprint UART...");

  fpSerial.begin(FP_BAUD, SERIAL_8N1, FINGERPRINT_RX, FINGERPRINT_TX);

  // Do not hold the entire boot sequence for several seconds.
  // Two quick attempts are enough; retryFingerprintIfNeeded()
  // continues recovery in the normal loop.
  for (int attempt = 1; attempt <= 2; attempt++) {
    Serial.printf("Fingerprint init %d/2\n", attempt);

    if (verifyFingerprintSensor()) {
      fingerprintReady = true;

      tftShowStatus("Fingerprint READY", String(finger.capacity) + " slots", COLOR_GREEN);

      return;
    }

    delay(250);
  }

  fingerprintReady = false;

  tftShowStatus("Fingerprint unavailable", "Background retry active", COLOR_YELLOW);

  Serial.println("Fingerprint not ready at boot; background retry enabled");
}

void retryFingerprintIfNeeded() {
  if (fingerprintReady)
    return;

  unsigned long now = millis();

  if (now - lastFingerprintRetry < FP_RETRY_INTERVAL_MS) {
    return;
  }

  lastFingerprintRetry = now;

  if (verifyFingerprintSensor()) {
    fingerprintReady = true;

    Serial.println("Fingerprint recovered");
  }
}

// ============================================================
// CAMERA DISCOVERY
// ============================================================

bool ipIsZero(const IPAddress &ip) {
  return ip[0] == 0 && ip[1] == 0 && ip[2] == 0 && ip[3] == 0;
}

// Forward declaration for dynamic camera resolution via backend
String httpGet(const String &path);

void cacheCameraIp(const String &ip) {
  if (ip.length() == 0)
    return;

  Preferences prefs;
  prefs.begin("labsync", false);
  String existing = prefs.getString("cam_ip", "");
  if (existing != ip) {
    prefs.putString("cam_ip", ip);
  }
  prefs.end();
}

void setCameraIp(const String &ip, const char *source, bool cacheIp = true) {
  if (ip.length() == 0)
    return;

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
  if (WiFi.status() != WL_CONNECTED)
    return false;

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
  if (WiFi.status() != WL_CONNECTED)
    return false;

  if (!cameraUdpStarted && !startCameraDiscoveryUDP())
    return false;

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

    if (waitMs == 0)
      break;

    delay(10);
  } while (millis() - start < waitMs);

  return false;
}

bool resolveCamera(const String &excludedBaseUrl = "") {
  if (WiFi.status() != WL_CONNECTED) {
    cameraBaseUrl = "";
    return false;
  }

  // =========================================================
  // TIER 1: UDP CAMERA ANNOUNCEMENT
  // Usually cameraBaseUrl is already populated in loop().
  // Wait longer than the camera's one-second announcement interval.
  // =========================================================
  Serial.println("Trying ESP32-CAM UDP discovery...");

  if (processCameraUdpAnnouncement(CAMERA_UDP_WAIT_MS) && cameraBaseUrl != excludedBaseUrl) {
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

    IPAddress camIp = MDNS.queryHost(CAMERA_MDNS_NAME, 900);

    if (!ipIsZero(camIp) && "http://" + camIp.toString() != excludedBaseUrl) {
      setCameraIp(camIp.toString(), "mDNS", true);

      return true;
    }
  }

  // =========================================================
  // TIER 3: LAST KNOWN CAMERA IP FROM NVS
  // Fast local fallback. startCamera() will reject it and
  // rediscover while excluding a failed DHCP address.
  // =========================================================
  Preferences prefs;
  prefs.begin("labsync", true);
  String cachedIp = prefs.getString("cam_ip", "");
  prefs.end();

  if (cachedIp.length() > 0) {
    IPAddress parsed;

    if (parsed.fromString(cachedIp) && "http://" + cachedIp != excludedBaseUrl) {
      setCameraIp(cachedIp, "NVS cache", false);

      return true;
    }
  }

  // =========================================================
  // TIER 4: BACKEND DYNAMIC CAMERA REGISTRY
  // =========================================================
  Serial.println("Querying backend registry for camera IP...");

  String response = httpGet("/api/esp32/camera-ip/" + String(ROOM_ID));

  if (response.length() > 0) {
    StaticJsonDocument<256> doc;

    DeserializationError err = deserializeJson(doc, response);

    if (!err && (doc["success"] | false)) {
      const char *dynIp = doc["ip"] | "";

      IPAddress parsed;

      if (strlen(dynIp) > 0 && parsed.fromString(dynIp) &&
          "http://" + String(dynIp) != excludedBaseUrl) {
        setCameraIp(String(dynIp), "backend registry", true);

        return true;
      }
    }
  }

  // =========================================================
  // TIER 5: MANUAL FALLBACK
  // =========================================================
  if (strlen(CAMERA_IP_FALLBACK) > 0) {
    String fallback = CAMERA_IP_FALLBACK;

    IPAddress parsed;

    if (parsed.fromString(fallback) && "http://" + fallback != excludedBaseUrl) {
      setCameraIp(fallback, "manual fallback", false);

      return true;
    }
  }

  cameraBaseUrl = "";

  Serial.println("All camera discovery methods failed");

  return false;
}

// ============================================================
// CAMERA COMMAND
// ============================================================

bool sendCameraCmd(const char *path) {
  cameraLastHttpCode = 0;
  cameraLastResponse = "";
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Camera command skipped: WiFi disconnected");
    return false;
  }

  if (cameraBaseUrl.length() == 0 && !resolveCamera()) {
    Serial.println("Camera command failed: no camera address");
    return false;
  }

  NetworkClient client;
  HTTPClient http;
  const bool waking = strcmp(path, "/start") == 0;
  http.setConnectTimeout(CAMERA_CONNECT_TIMEOUT_MS);
  http.setTimeout(waking ? CAMERA_WAKE_TIMEOUT_MS : CAMERA_COMMAND_TIMEOUT_MS);
  http.useHTTP10(true);
  http.setReuse(false);

  String url = cameraBaseUrl + path;
  Serial.println("Camera request: " + url);
  const unsigned long startedAt = millis();
  if (!http.begin(client, url)) {
    cameraLastResponse = "HTTP_BEGIN_FAILED";
    Serial.println(cameraLastResponse);
    return false;
  }

  cameraLastHttpCode = http.GET();
  if (cameraLastHttpCode > 0) {
    cameraLastResponse = http.getString();
    cameraLastResponse.trim();
  } else {
    cameraLastResponse = HTTPClient::errorToString(cameraLastHttpCode);
  }
  http.end();

  Serial.printf("Camera HTTP %d after %lu ms: %s\n", cameraLastHttpCode, millis() - startedAt,
                cameraLastResponse.c_str());
  if (cameraLastHttpCode != HTTP_CODE_OK) {
    // Keep the address. An HTTP 500 is a reachable camera with an error.
    return false;
  }

  // Reject another device or a stale IP that happens to return HTTP 200.
  const char *expected = nullptr;
  if (waking)
    expected = "CAMERA_ON";
  else if (strcmp(path, "/status") == 0)
    expected = "ACTIVE";
  else if (strcmp(path, "/stop") == 0)
    expected = "CAMERA_SLEEP";

  if (expected != nullptr && cameraLastResponse != expected) {
    Serial.println("Unexpected camera reply; command not confirmed");
    return false;
  }
  return true;
}

// ============================================================
// START CAMERA
// ============================================================

bool startCamera() {
  requestCoolingFan();

  Serial.println("Waking ESP32-CAM camera...");
  cameraStreaming = false;
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cannot wake camera: main ESP32 WiFi disconnected");
    return false;
  }
  WiFi.setSleep(false);

  String rejectedBaseUrl = "";
  // Try the current address, then one newly discovered address.
  for (int candidate = 0; candidate < 2; candidate++) {
    if (cameraBaseUrl.length() == 0 && !resolveCamera(rejectedBaseUrl)) {
      break;
    }
    const String attemptedBaseUrl = cameraBaseUrl;
    // A lost reply does not mean DHCP changed. Retry the same camera first.
    for (int attempt = 0; attempt < 2; attempt++) {
      if (sendCameraCmd("/start") && sendCameraCmd("/status")) {
        cameraStreaming = true;
        Serial.println("Camera ACTIVE confirmed");
        return true;
      }

      if (cameraLastHttpCode >= 500 && (cameraLastResponse == "CAMERA_INIT_FAILED" ||
                                        cameraLastResponse == "CAMERA_FRAME_FAILED")) {
        Serial.println("Camera reached, but sensor failed. Check camera Serial log.");
        return false;
      }
      if (cameraLastHttpCode == HTTP_CODE_OK || cameraLastHttpCode == 404) {
        // Wrong device/reply, or status did not confirm ACTIVE. Rediscover.
        break;
      }
      if (attempt == 0) {
        Serial.println("Retrying wake at the same address...");
        delay(250);
      }
    }
    rejectedBaseUrl = attemptedBaseUrl;
    cameraBaseUrl = "";
  }

  Serial.println("Camera wake failed; see HTTP code and reply above");
  return false;
}

// ============================================================
// STOP CAMERA / RETURN CAMERA TO STANDBY
// ============================================================

void stopCamera() {
  if (!cameraStreaming)
    return;
  requestCoolingFan(); // Continue cooling for 3 minutes after camera use.
  Serial.println("Putting camera into standby...");
  const bool confirmed = sendCameraCmd("/stop");
  cameraStreaming = false;
  Serial.println(confirmed ? "ESP32-CAM standby confirmed"
                           : "Camera stop not confirmed; sensor state unknown");
}

// ============================================================
// JPEG CALLBACK
// ============================================================

bool tftJpegOutput(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t *bitmap) {
  // In portrait mode the QVGA image is intentionally center-cropped
  // from 320 px wide to the 240 px TFT width. Blocks completely
  // outside the screen are ignored WITHOUT stopping JPEG decoding.
  if (x >= tft.width() || y >= tft.height() || x + (int16_t)w <= 0 || y + (int16_t)h <= 0) {
    return true;
  }

  tft.drawRGBBitmap(x, y, bitmap, w, h);

  return true;
}

// ============================================================
// FETCH JPEG
// ============================================================

size_t fetchJpegFrame(uint8_t *buf, size_t maxLen) {
  if (!cameraStreaming) {
    return 0;
  }

  // Camera HTTP can briefly drop a connection while the OV2640/frame buffer
  // wakes. Retry once and allow slow Wi-Fi transfers more than the old 1.2s
  // inter-chunk gap before treating a JPEG as truncated.
  for (int attempt = 0; attempt < 2; attempt++) {
    if (cameraBaseUrl.length() == 0 && !resolveCamera()) {
      delay(150);
      continue;
    }

    NetworkClient client;
    HTTPClient http;
    http.setConnectTimeout(CAMERA_CONNECT_TIMEOUT_MS);
    http.setTimeout(CAMERA_COMMAND_TIMEOUT_MS);
    http.useHTTP10(true);
    http.setReuse(false);

    String url = cameraBaseUrl + "/capture";
    if (!http.begin(client, url)) {
      cameraBaseUrl = "";
      delay(150);
      continue;
    }

    int code = http.GET();
    if (code != HTTP_CODE_OK) {
      String detail = code > 0 ? http.getString() : HTTPClient::errorToString(code);
      Serial.printf("Capture HTTP error: %d: %s (attempt %d/2)\n", code, detail.c_str(), attempt + 1);
      http.end();
      if (code < 0) cameraBaseUrl = ""; // rediscover if the camera IP/server changed
      delay(150);
      continue;
    }

    int len = http.getSize();
    if (len <= 0 || (size_t)len > maxLen) {
      if (len > 0) Serial.printf("JPEG too large: %d bytes (buffer %u)\n", len, (unsigned int)maxLen);
      http.end();
      return 0;
    }

    NetworkClient *stream = http.getStreamPtr();
    size_t received = 0;
    unsigned long lastData = millis();
    while (received < (size_t)len) {
      int available = stream->available();
      if (available > 0) {
        size_t toRead = min((size_t)available, (size_t)len - received);
        toRead = min(toRead, (size_t)4096);
        int got = stream->read(buf + received, toRead);
        if (got > 0) {
          received += (size_t)got;
          lastData = millis();
        }
      } else if (!stream->connected() || millis() - lastData > CAMERA_COMMAND_TIMEOUT_MS) {
        break;
      } else {
        delay(1);
      }
    }
    http.end();

    if (received == (size_t)len) return received;

    Serial.printf("Incomplete JPEG: %u/%d bytes (attempt %d/2)\n",
                  (unsigned int)received, len, attempt + 1);
    delay(150);
  }

  return 0;
}

// ============================================================
// CAMERA TFT SCREEN
// ============================================================

void prepareCameraScreen(const String &mode, const String &name) {
  tft.fillScreen(COLOR_BG);

  tft.fillRect(0, 0, tft.width(), HEADER_HEIGHT, COLOR_CYAN);

  tft.setTextColor(COLOR_BG, COLOR_CYAN);

  tft.setTextSize(1);

  tft.setCursor(5, 8);

  tft.print(mode);

  // Dedicated one-line name area above the 240 x 240 camera crop.
  tft.fillRect(0, HEADER_HEIGHT, tft.width(), CAMERA_NAME_HEIGHT, COLOR_BG);

  if (name.length() > 0) {
    tft.setTextColor(COLOR_WHITE, COLOR_BG);

    tft.setCursor(5, HEADER_HEIGHT + 3);

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
void drawDynamicFaceBox(int x, int y, int w, int h, uint16_t color);

bool postFaceVerify(const String &userId, const String &roomId, uint8_t *jpegBuf, size_t jpegLen,
                    FaceBox *outBox);

bool postFaceEnroll(const String &userId, uint8_t *jpegBuf, size_t jpegLen, FaceBox *outBox);

void drawCameraFaceBox(const FaceBox &box, uint16_t color);

static int16_t lastJpegDrawX = 0;
static int16_t lastJpegDrawY = 0;
static uint8_t lastJpegScale = 1;

void drawDynamicFaceBox(int x, int y, int w, int h, uint16_t color) {
  const int16_t minY = HEADER_HEIGHT + CAMERA_NAME_HEIGHT;

  const int16_t maxY = tft.height() - STATUS_HEIGHT - 2;

  const int16_t minX = 0;
  const int16_t maxX = tft.width();

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
  tft.drawRect(x, y, w, h, color);

  if (w > 4 && h > 4) {
    tft.drawRect(x + 1, y + 1, w - 2, h - 2, color);
  }

  int k = min(14, min(w / 3, h / 3));

  if (k > 3) {
    tft.drawFastHLine(x, y, k, color);

    tft.drawFastVLine(x, y, k, color);

    tft.drawFastHLine(x + w - k, y, k, color);

    tft.drawFastVLine(x + w - 1, y, k, color);

    tft.drawFastHLine(x, y + h - 1, k, color);

    tft.drawFastVLine(x, y + h - k, k, color);

    tft.drawFastHLine(x + w - k, y + h - 1, k, color);

    tft.drawFastVLine(x + w - 1, y + h - k, k, color);
  }
}

// ============================================================
// DISPLAY JPEG
// ============================================================

bool displayJpegOnTFT(uint8_t *buf, size_t len) {
  uint16_t jpegWidth = 0;
  uint16_t jpegHeight = 0;

  if (TJpgDec.getJpgSize(&jpegWidth, &jpegHeight, buf, len) != JDR_OK) {
    return false;
  }

  const int16_t cameraTop = HEADER_HEIGHT + CAMERA_NAME_HEIGHT;

  const int16_t cameraBottom = tft.height() - STATUS_HEIGHT - 2;

  const int16_t availableWidth = tft.width();

  const int16_t availableHeight = cameraBottom - cameraTop;

  uint8_t scale = 1;

  // Portrait mode:
  // A 320 x 240 QVGA frame is kept at full vertical resolution and
  // center-cropped horizontally to the 240 px-wide portrait TFT.
  // This makes the face much larger than using TJpgDec scale=2.
  bool usePortraitCenterCrop = (tft.height() > tft.width()) &&
                               (jpegHeight <= (uint16_t)availableHeight) &&
                               (jpegWidth > (uint16_t)availableWidth);

  if (!usePortraitCenterCrop) {
    while (((jpegWidth / scale) > availableWidth || (jpegHeight / scale) > availableHeight) &&
           scale < 8) {
      scale *= 2;
    }
  }

  TJpgDec.setJpgScale(scale);

  int16_t drawWidth = jpegWidth / scale;

  int16_t drawHeight = jpegHeight / scale;

  int16_t x = (availableWidth - drawWidth) / 2;

  int16_t y = cameraTop + ((availableHeight - drawHeight) / 2);

  lastJpegDrawX = x;
  lastJpegDrawY = y;
  lastJpegScale = scale;

  return TJpgDec.drawJpg(x, y, buf, len) == JDR_OK;
}

// ============================================================
// FACE RETICLE VIEWFINDER
// ============================================================

void drawFaceReticle(uint16_t color) {
  const int16_t cameraTop = HEADER_HEIGHT + CAMERA_NAME_HEIGHT;

  const int16_t cameraBottom = tft.height() - STATUS_HEIGHT - 2;

  int16_t cx = tft.width() / 2;

  int16_t cy = cameraTop + ((cameraBottom - cameraTop) / 2);

  int16_t w = 105;
  int16_t h = 145;

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
  tft.drawFastVLine(x0, y0 + h - k, k, color);
  tft.drawFastVLine(x0 + 1, y0 + h - k, k, color);

  // Bottom-Right
  tft.drawFastHLine(x0 + w - k, y0 + h, k, color);
  tft.drawFastHLine(x0 + w - k, y0 + h - 1, k, color);
  tft.drawFastVLine(x0 + w, y0 + h - k, k, color);
  tft.drawFastVLine(x0 + w - 1, y0 + h - k, k, color);
}

// ============================================================
// SERVER URL NORMALIZATION
// ============================================================
// Firmware paths already start with "/api/...". If the stored server URL
// also ends with "/api" (easy mistake when copying the Flutter base URL),
// requests would hit /api/api/... and 404 forever. Strip any trailing
// "/api" so both URL styles work.
String normalizeServerUrl(String url) {
  url.trim();
  while (url.endsWith("/")) {
    url = url.substring(0, url.length() - 1);
  }
  if (url.endsWith("/api")) {
    url = url.substring(0, url.length() - 4);
  }
  while (url.endsWith("/")) {
    url = url.substring(0, url.length() - 1);
  }
  return url;
}

// ============================================================
// DEVICE HMAC SIGNATURE HELPERS
// Canonical: METHOD\npath\nts\nnonce\nsha256(body)
// Matches backend deviceAuth.computeSignature() exactly.
// ============================================================

String deviceSha256Hex(const String &data) {
  uint8_t hash[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  String hex = "";
  if (info && mbedtls_md_setup(&ctx, info, 0) == 0 &&
      mbedtls_md_starts(&ctx) == 0 &&
      mbedtls_md_update(&ctx, (const unsigned char *)data.c_str(), data.length()) == 0 &&
      mbedtls_md_finish(&ctx, hash) == 0) {
    char buf[3];
    for (int i = 0; i < 32; i++) {
      sprintf(buf, "%02x", hash[i]);
      hex += buf;
    }
  }
  mbedtls_md_free(&ctx);
  return hex;
}

String deviceHmacHex(const String &canonical) {
  uint8_t hash[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  String hex = "";
  if (info && mbedtls_md_setup(&ctx, info, 1) == 0 &&
      mbedtls_md_hmac_starts(&ctx, (const unsigned char *)DEVICE_SECRET,
                             strlen(DEVICE_SECRET)) == 0 &&
      mbedtls_md_hmac_update(&ctx, (const unsigned char *)canonical.c_str(),
                             canonical.length()) == 0 &&
      mbedtls_md_hmac_finish(&ctx, hash) == 0) {
    char buf[3];
    for (int i = 0; i < 32; i++) {
      sprintf(buf, "%02x", hash[i]);
      hex += buf;
    }
  }
  mbedtls_md_free(&ctx);
  return hex;
}

void deviceSignature(const String &method, const String &path, const String &body,
                     String &ts, String &nonce, String &signature) {
  unsigned long long tsMs = epochMs();
  char tsBuf[24];
  snprintf(tsBuf, sizeof(tsBuf), "%llu", tsMs);
  ts = String(tsBuf);
  nonce = String((unsigned long)esp_random(), 16);
  String bodyHash = deviceSha256Hex(body);
  String canonical = method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + bodyHash;
  signature = deviceHmacHex(canonical);
}

void applyDeviceHeaders(HTTPClient &http, const String &method, const String &path,
                        const String &body) {
  // Keep each request's signature local: face uploads run in another task.
  String ts, nonce, signature;
  deviceSignature(method, path, body, ts, nonce, signature);
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Device-Ts", ts);
  http.addHeader("X-Device-Nonce", nonce);
  http.addHeader("X-Device-Sig", signature);
}

// ============================================================
// HTTP GET
// ============================================================

String httpGet(const String &path) {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi(systemState == STATE_ACTIVE);
  }

  if (WiFi.status() != WL_CONNECTED) {
    return "";
  }

  ensureDeviceTimeSync();
  if (epochMs() == 0) {
    Serial.println("[AUTH] Waiting for NTP time before GET.");
    return "";
  }

  String url = normalizeServerUrl(activeServerUrl) + path;

  HTTPClient http;

  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  http.setConnectTimeout(10000);

  http.setTimeout(15000);

  String body = "";

  if (url.startsWith("https://")) {
    WiFiClientSecure client;

    client.setInsecure();

    client.setHandshakeTimeout(10);

    if (!http.begin(client, url)) {
      return "";
    }

    applyDeviceHeaders(http, "GET", path, "");

    int code = http.GET();

    if (code == HTTP_CODE_OK) {
      body = http.getString();
    }

    http.end();

  } else {
    NetworkClient client;

    if (!http.begin(client, url)) {
      return "";
    }

    applyDeviceHeaders(http, "GET", path, "");

    int code = http.GET();

    if (code == HTTP_CODE_OK) {
      body = http.getString();
    }

    http.end();
  }

  return body;
}

// ============================================================
// HTTP POST JSON
// ============================================================

String httpPostJson(const String &path, const String &jsonBody, int *outStatus = nullptr) {
  if (outStatus != nullptr) {
    *outStatus = 0;
  }
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi(systemState == STATE_ACTIVE);
  }

  if (WiFi.status() != WL_CONNECTED) {
    return "";
  }

  ensureDeviceTimeSync();
  if (epochMs() == 0) {
    Serial.println("[AUTH] Waiting for NTP time before POST.");
    return "";
  }

  String url = normalizeServerUrl(activeServerUrl) + path;

  HTTPClient http;

  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  http.setConnectTimeout(10000);

  http.setTimeout(15000);

  String body = "";

  if (url.startsWith("https://")) {
    WiFiClientSecure client;

    client.setInsecure();

    client.setHandshakeTimeout(10);

    if (!http.begin(client, url)) {
      return "";
    }

    http.addHeader("Content-Type", "application/json");

    applyDeviceHeaders(http, "POST", path, jsonBody);

    int code = http.POST(jsonBody);
    if (outStatus != nullptr) {
      *outStatus = code;
    }

    if (code > 0) {
      body = http.getString();
    }

    http.end();

  } else {
    NetworkClient client;

    if (!http.begin(client, url)) {
      return "";
    }

    http.addHeader("Content-Type", "application/json");

    applyDeviceHeaders(http, "POST", path, jsonBody);

    int code = http.POST(jsonBody);
    if (outStatus != nullptr) {
      *outStatus = code;
    }

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

bool postMultipartStreaming(const String &path, const String &part1, uint8_t *jpegBuf,
                            size_t jpegLen, const String &part3, String &outResp) {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi(false);
  }

  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  ensureDeviceTimeSync();
  if (epochMs() == 0) {
    Serial.println("[AUTH] Waiting for NTP time before face upload.");
    return false;
  }

  String server = normalizeServerUrl(activeServerUrl);

  bool https = server.startsWith("https://");

  int protocolPos = server.indexOf("://");

  String hostPort = protocolPos >= 0 ? server.substring(protocolPos + 3) : server;

  while (hostPort.endsWith("/")) {
    hostPort.remove(hostPort.length() - 1);
  }

  String host = hostPort;

  int port = https ? 443 : 80;

  int colon = hostPort.indexOf(':');

  if (colon >= 0) {
    host = hostPort.substring(0, colon);

    port = hostPort.substring(colon + 1).toInt();
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

    if (!client.connect(host.c_str(), port)) {
      Serial.printf("[HTTPS] Connection to %s failed!\n", host.c_str());
      return false;
    }

    Serial.printf("[HTTPS] Uploading %s (%u bytes)...\n", path.c_str(), (unsigned int)totalLength);

    String ts, nonce, signature;
    deviceSignature("POST", path, "", ts, nonce, signature);

    client.printf("POST %s HTTP/1.1\r\n", path.c_str());

    client.printf("Host: %s\r\n", host.c_str());

    client.printf("X-Device-Id: %s\r\n", DEVICE_ID);

    client.printf("X-Device-Ts: %s\r\n", ts.c_str());

    client.printf("X-Device-Nonce: %s\r\n", nonce.c_str());

    client.printf("X-Device-Sig: %s\r\n", signature.c_str());

    client.printf("Content-Type: multipart/form-data; boundary=%s\r\n", boundary.c_str());

    client.printf("Content-Length: %u\r\n", (unsigned int)totalLength);

    client.print("Connection: close\r\n\r\n");

    client.print(part1);

    size_t sent = 0;

    while (sent < jpegLen && client.connected()) {
      size_t remaining = jpegLen - sent;

      size_t chunk = remaining > 1024 ? 1024 : remaining;

      size_t written = client.write(jpegBuf + sent, chunk);

      if (written == 0)
        break;

      sent += written;
    }

    client.print(part3);

    client.flush();

    unsigned long start = millis();

    while (!client.available() && client.connected() && millis() - start < FACE_UPLOAD_TIMEOUT_MS) {
      delay(5);
    }

    unsigned long lastData = millis();

    while (client.connected() || client.available()) {
      while (client.available()) {
        response += (char)client.read();

        lastData = millis();
      }

      if (millis() - lastData > FACE_UPLOAD_TIMEOUT_MS) {
        break;
      }

      delay(1);
    }

    client.stop();

    Serial.printf("[HTTPS] Response (%d bytes): %s\n", response.length(),
                  response.substring(0, 100).c_str());

  } else {
    NetworkClient client;

    client.setTimeout(FACE_UPLOAD_TIMEOUT_MS);

    if (!client.connect(host.c_str(), port)) {
      return false;
    }

    String ts, nonce, signature;
    deviceSignature("POST", path, "", ts, nonce, signature);

    client.printf("POST %s HTTP/1.1\r\n", path.c_str());

    client.printf("Host: %s:%d\r\n", host.c_str(), port);

    client.printf("X-Device-Id: %s\r\n", DEVICE_ID);

    client.printf("X-Device-Ts: %s\r\n", ts.c_str());

    client.printf("X-Device-Nonce: %s\r\n", nonce.c_str());

    client.printf("X-Device-Sig: %s\r\n", signature.c_str());

    client.printf("Content-Type: multipart/form-data; boundary=%s\r\n", boundary.c_str());

    client.printf("Content-Length: %u\r\n", (unsigned int)totalLength);

    client.print("Connection: close\r\n\r\n");

    client.print(part1);

    size_t sent = 0;

    while (sent < jpegLen && client.connected()) {
      size_t remaining = jpegLen - sent;

      size_t chunk = remaining > 1024 ? 1024 : remaining;

      size_t written = client.write(jpegBuf + sent, chunk);

      if (written == 0)
        break;

      sent += written;
    }

    client.print(part3);

    client.flush();

    unsigned long start = millis();

    while (!client.available() && client.connected() && millis() - start < FACE_UPLOAD_TIMEOUT_MS) {
      delay(5);
    }

    unsigned long lastData = millis();

    while (client.connected() || client.available()) {
      while (client.available()) {
        response += (char)client.read();

        lastData = millis();
      }

      if (millis() - lastData > FACE_UPLOAD_TIMEOUT_MS) {
        break;
      }

      delay(1);
    }

    client.stop();
  }

  outResp = response;

  int bodyStart = response.indexOf("\r\n\r\n");

  if (bodyStart >= 0) {
    outResp = response.substring(bodyStart + 4);
  }

  bool httpSuccess = response.startsWith("HTTP/1.1 2") || response.startsWith("HTTP/1.0 2");

  return httpSuccess;
}

// ============================================================
// FACE VERIFY
// ============================================================

bool postFaceVerify(const String &userId, const String &roomId, uint8_t *jpegBuf, size_t jpegLen,
                    FaceBox *outBox) {
  const String boundary = "----LabSyncBoundary7344";

  const String CRLF = "\r\n";

  String part1 = "--" + boundary + CRLF +

                 "Content-Disposition: form-data; name=\"userId\"" + CRLF + CRLF + userId + CRLF +

                 "--" + boundary + CRLF +

                 "Content-Disposition: form-data; name=\"roomId\"" + CRLF + CRLF + roomId + CRLF +

                 "--" + boundary + CRLF +

                 "Content-Disposition: form-data; name=\"faceImage\"; "
                 "filename=\"face.jpg\"" +
                 CRLF +

                 "Content-Type: image/jpeg" + CRLF + CRLF;

  String part3 = CRLF + "--" + boundary + "--" + CRLF;

  String response;

  bool ok = postMultipartStreaming("/api/face/verify", part1, jpegBuf, jpegLen, part3, response);

  if (!ok)
    return false;

  DynamicJsonDocument doc(1024);

  // Clean JSON boundary extraction
  int jsonStart = response.indexOf('{');
  int jsonEnd = response.lastIndexOf('}');
  String jsonBody = (jsonStart >= 0 && jsonEnd > jsonStart)
                        ? response.substring(jsonStart, jsonEnd + 1)
                        : response;

  if (deserializeJson(doc, jsonBody) != DeserializationError::Ok) {
    Serial.println("JSON parse note: falling back to string match");
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
    } else {
      outBox->valid = false;
    }
  }

  Serial.printf("Face: %s Confidence %.1f%%\n", success ? "MATCH" : "NO MATCH",
                confidence * 100.0f);

  return success;
}

// ============================================================
// FACE ENROLL
// ============================================================

bool postFaceEnroll(const String &userId, uint8_t *jpegBuf, size_t jpegLen, FaceBox *outBox) {
  const String boundary = "----LabSyncBoundary7344";

  const String CRLF = "\r\n";

  String part1 = "--" + boundary + CRLF +

                 "Content-Disposition: form-data; name=\"userId\"" + CRLF + CRLF + userId + CRLF +

                 "--" + boundary + CRLF +

                 "Content-Disposition: form-data; name=\"faceImage\"; "
                 "filename=\"face.jpg\"" +
                 CRLF +

                 "Content-Type: image/jpeg" + CRLF + CRLF;

  String part3 = CRLF + "--" + boundary + "--" + CRLF;

  String response;

  bool ok =
      postMultipartStreaming("/api/face/enroll-hardware", part1, jpegBuf, jpegLen, part3, response);

  if (!ok) {
    Serial.printf("[FACE-ENROLL] Network/HTTP error. Response len: %d\n", response.length());
    return false;
  }

  int jsonStart = response.indexOf('{');
  int jsonEnd = response.lastIndexOf('}');
  String jsonBody = (jsonStart >= 0 && jsonEnd > jsonStart)
                        ? response.substring(jsonStart, jsonEnd + 1)
                        : response;

  DynamicJsonDocument doc(1024);

  if (deserializeJson(doc, jsonBody) != DeserializationError::Ok) {
    Serial.printf("[FACE-ENROLL] JSON parse error: %s\n", jsonBody.substring(0, 100).c_str());
    return false;
  }

  bool success = (doc["success"] | false) || (doc["finalized"] | false);
  const char *serverMsg = doc["message"] | "";
  Serial.printf("[FACE-ENROLL] Server Result: success=%s, finalized=%s, msg=\"%s\"\n",
                (doc["success"] | false) ? "true" : "false",
                (doc["finalized"] | false) ? "true" : "false", serverMsg);

  if (outBox != nullptr) {
    if (doc.containsKey("box") && !doc["box"].isNull()) {
      outBox->x = doc["box"]["x"] | 0;
      outBox->y = doc["box"]["y"] | 0;
      outBox->w = doc["box"]["w"] | 0;
      outBox->h = doc["box"]["h"] | 0;
      outBox->valid = (outBox->w > 0 && outBox->h > 0);
    } else {
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

enum FaceRequestMode { FACE_REQUEST_NONE, FACE_REQUEST_VERIFY, FACE_REQUEST_ENROLL };

// Explicit prototypes for functions that use FaceRequestMode.
// This avoids Arduino's auto-prototype generator placing declarations
// before the enum definition.
uint32_t beginFaceSession();
void faceRequestWorker(void *parameter);

bool startFaceRequestAsync(FaceRequestMode mode, uint32_t session, const String &userId,
                           const String &roomId, const uint8_t *jpeg, size_t jpegLen);

bool takeFaceResult(uint32_t session, FaceRequestMode expectedMode, bool &success, FaceBox &box);

bool finishPendingFaceRequest(uint32_t session, FaceRequestMode mode, bool &success, FaceBox &box,
                              uint16_t reticleColor);

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

uint32_t beginFaceSession() {
  faceSessionCounter++;

  if (faceSessionCounter == 0) {
    faceSessionCounter = 1;
  }

  // Any result from an older session is no longer relevant.
  faceResultReady = false;

  return faceSessionCounter;
}

void faceRequestWorker(void *parameter) {
  (void)parameter;

  FaceBox box = {0, 0, 0, 0, false};
  bool success = false;

  FaceRequestMode mode = faceRequestMode;

  uint32_t session = faceRequestSession;

  if (faceRequestJpeg != nullptr && faceRequestJpegLen > 0) {
    if (mode == FACE_REQUEST_VERIFY) {
      success = postFaceVerify(faceRequestUserId, faceRequestRoomId, faceRequestJpeg,
                               faceRequestJpegLen, &box);
    } else if (mode == FACE_REQUEST_ENROLL) {
      success = postFaceEnroll(faceRequestUserId, faceRequestJpeg, faceRequestJpegLen, &box);
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

// Check JPEG boundary markers only. The backend decodes and detects faces.
bool hasJpegMarkers(const uint8_t *jpeg, size_t jpegLen) {
  return jpeg != nullptr && jpegLen >= 4 && jpeg[0] == 0xFF && jpeg[1] == 0xD8 &&
         jpeg[jpegLen - 2] == 0xFF && jpeg[jpegLen - 1] == 0xD9;
}

bool startFaceRequestAsync(FaceRequestMode mode, uint32_t session, const String &userId,
                           const String &roomId, const uint8_t *jpeg, size_t jpegLen) {
  if (faceRequestBusy || faceResultReady || !hasJpegMarkers(jpeg, jpegLen)) {
    return false;
  }

  uint8_t *copy = static_cast<uint8_t *>(malloc(jpegLen));

  if (copy == nullptr) {
    Serial.printf("Face request skipped: cannot allocate %u-byte JPEG copy\n",
                  (unsigned int)jpegLen);

    return false;
  }

  memcpy(copy, jpeg, jpegLen);

  faceRequestMode = mode;
  faceRequestSession = session;
  faceRequestUserId = userId;
  faceRequestRoomId = roomId;
  faceRequestJpeg = copy;
  faceRequestJpegLen = jpegLen;
  faceRequestBusy = true;

  BaseType_t created =
      xTaskCreate(faceRequestWorker, "faceHttp", 16384, nullptr, 1, &faceRequestTaskHandle);

  if (created != pdPASS) {
    free(faceRequestJpeg);
    faceRequestJpeg = nullptr;
    faceRequestJpegLen = 0;
    faceRequestBusy = false;
    faceRequestTaskHandle = nullptr;

    Serial.println("Face request task creation failed");

    return false;
  }

  return true;
}

bool takeFaceResult(uint32_t session, FaceRequestMode expectedMode, bool &success, FaceBox &box) {
  if (!faceResultReady) {
    return false;
  }

  uint32_t resultSession = faceResultSession;

  FaceRequestMode resultMode = faceResultMode;

  success = faceResultSuccess;

  box = faceResultBox;

  faceResultReady = false;

  if (resultSession != session || resultMode != expectedMode) {
    return false;
  }

  return true;
}

// Drain pending work before ending either face session. A ready result must
// be consumed even when the worker has already cleared faceRequestBusy.
bool finishPendingFaceRequest(uint32_t session, FaceRequestMode mode, bool &success, FaceBox &box,
                              uint16_t reticleColor) {
  const unsigned long waitingSince = millis();

  while (true) {
    bool resultSuccess = false;
    FaceBox resultBox = {0, 0, 0, 0, false};
    if (takeFaceResult(session, mode, resultSuccess, resultBox)) {
      success = resultSuccess;
      box = resultBox;
      return true;
    }

    // Use the existing upload timeout, replacing the separate 15-second cap.
    if (!faceRequestBusy || millis() - waitingSince >= FACE_UPLOAD_TIMEOUT_MS) {
      break;
    }

    // Keep the preview moving while the request finishes. No new uploads here.
    size_t jpegLen = fetchJpegFrame(jpegBuffer, jpegBufferCapacity);
    if (jpegLen > 0) {
      displayJpegOnTFT(jpegBuffer, jpegLen);
      drawFaceReticle(reticleColor);
      if (box.valid) {
        drawCameraFaceBox(box, COLOR_YELLOW);
      }
    }
    tftShowStatus("Look at camera", "Waiting for server...", COLOR_CYAN);
    delay(10);
  }

  // The worker may have published between the first result check and the
  // busy/deadline check. Always consume once more before reporting failure.
  bool resultSuccess = false;
  FaceBox resultBox = {0, 0, 0, 0, false};
  if (takeFaceResult(session, mode, resultSuccess, resultBox)) {
    success = resultSuccess;
    box = resultBox;
    return true;
  }

  if (faceRequestBusy) {
    Serial.println("Face request still pending after completion wait timed out");
  }
  return false;
}

void drawCameraFaceBox(const FaceBox &box, uint16_t color) {
  if (!box.valid) {
    return;
  }

  int bx = lastJpegDrawX + (box.x / lastJpegScale);

  int by = lastJpegDrawY + (box.y / lastJpegScale);

  int bw = box.w / lastJpegScale;

  int bh = box.h / lastJpegScale;

  drawDynamicFaceBox(bx, by, bw, bh, color);
}

// ============================================================
// COMPLETED ENROLLMENTS (PERSISTENT, ONE RECORD PER SENSOR SLOT)
// ============================================================
// Save only after face enrollment succeeds. Scope records to the server,
// room and user, so another account cannot inherit a completed enrollment.
// These records suppress enrollment prompts; face verification still runs.
String completedEnrollmentIdentity(const String &userId) {
  return normalizeServerUrl(activeServerUrl) + "\n" + String(ROOM_ID) + "\n" + userId;
}

bool hasCompletedEnrollment(const String &userId, int fingerId = 0) {
  if (!fingerprintReady || userId.length() == 0 || fingerId < 0 ||
      fingerId > finger.capacity) {
    return false;
  }

  Preferences prefs;
  if (!prefs.begin("ls_enroll", true)) {
    return false;
  }

  const String identity = completedEnrollmentIdentity(userId);
  const int firstId = fingerId > 0 ? fingerId : 1;
  const int lastId = fingerId > 0 ? fingerId : finger.capacity;
  bool completed = false;
  for (int id = firstId; id <= lastId; id++) {
    const String key = "f" + String(id);
    if (prefs.getString(key.c_str(), "") == identity &&
        finger.loadModel(id) == FINGERPRINT_OK) {
      completed = true;
      break;
    }
  }
  prefs.end();
  return completed;
}

void clearCompletedEnrollment(int fingerId) {
  Preferences prefs;
  if (!prefs.begin("ls_enroll", false)) {
    Serial.println("ERROR: Cannot clear previous enrollment record.");
    return;
  }
  const String key = "f" + String(fingerId);
  prefs.putString(key.c_str(), "");
  prefs.end();
}

void rememberCompletedEnrollment(const String &userId, int fingerId) {
  if (fingerId < 1 || fingerId > finger.capacity || userId.length() == 0) {
    return;
  }

  Preferences prefs;
  if (!prefs.begin("ls_enroll", false)) {
    Serial.println("ERROR: Cannot save completed enrollment record.");
    return;
  }
  const String key = "f" + String(fingerId);
  const String identity = completedEnrollmentIdentity(userId);
  const size_t written = prefs.putString(key.c_str(), identity);
  prefs.end();
  if (written != identity.length()) {
    Serial.println("ERROR: Enrollment completed, but completion record was not saved.");
  }
}

// ============================================================
// USER LOOKUP
// ============================================================

bool getUserByFingerId(int fingerId, String &outUserId, String &outUserName, String &outRole,
                       bool &outFaceEnrolled) {
  String response = httpGet("/api/esp32/user-by-finger/" + String(fingerId));

  if (response.length() == 0) {
    return false;
  }

  DynamicJsonDocument doc(512);

  if (deserializeJson(doc, response) != DeserializationError::Ok) {
    return false;
  }

  if (!(doc["found"] | false)) {
    return false;
  }

  outUserId = doc["userId"] | "";

  outUserName = doc["userName"] | "";

  outRole = doc["role"] | "user";

  outFaceEnrolled = doc["faceEnrolled"] | false;

  // A delayed backend flag must not restart a successfully completed task.
  if (!outFaceEnrolled && hasCompletedEnrollment(outUserId, fingerId)) {
    outFaceEnrolled = true;
  }

  return outUserId.length() > 0;
}

// Overload for backward compatibility
bool getUserByFingerId(int fingerId, String &outUserId, String &outUserName, String &outRole) {
  bool dummyFace = false;
  return getUserByFingerId(fingerId, outUserId, outUserName, outRole, dummyFace);
}

bool getUserByFingerId(int fingerId, String &outUserId, String &outUserName) {
  String dummyRole = "user";
  bool dummyFace = false;
  return getUserByFingerId(fingerId, outUserId, outUserName, dummyRole, dummyFace);
}

// ============================================================
// NEXT AVAILABLE USER FOR HARDWARE ENROLLMENT
// ============================================================

bool getNextAvailableUser(String &outUserId, String &outUserName, String &outRole,
                          const String &requestedRole = "") {
  String path = "/api/esp32/next-available-user";
  if (requestedRole.length() > 0) {
    path += "?role=" + requestedRole;
  }

  String response = httpGet(path);

  if (response.length() == 0) {
    return false;
  }

  DynamicJsonDocument doc(512);

  if (deserializeJson(doc, response) != DeserializationError::Ok) {
    return false;
  }

  if (!(doc["found"] | false)) {
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
  if (!requestDoorAccess()) {
    tftShowFullScreen("DOOR ERROR", "Controller unavailable", COLOR_RED);
    return;
  }

  tftShowFullScreen("ACCESS GRANTED", "Door opening", COLOR_GREEN);
  tftShowStatus("Door unlocked", "Access grant: 5 seconds", COLOR_GREEN);

  // Keep the existing display pause. Door OR logic and fan timing continue
  // in their own tasks, so this delay does not block the push button.
  delay(RELAY_OPEN_MS);
}

void reportDoorClosedIfPending() {
  // Network work stays out of the door task so a slow server cannot delay
  // button response or locking. There is no physical door-position sensor.
  if (WiFi.status() != WL_CONNECTED || !takeDoorClosedReport()) {
    return;
  }

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

  if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS)
    return;

  if (WiFi.status() != WL_CONNECTED)
    return;

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

String getFingerprintErrorString(int p) {
  switch (p) {
  case FINGERPRINT_OK:
    return "OK";

  case FINGERPRINT_PACKETRECIEVEERR:
    return "Communication error";

  case FINGERPRINT_NOFINGER:
    return "No finger detected";

  case FINGERPRINT_IMAGEFAIL:
    return "Fingerprint imaging failed";

  case FINGERPRINT_IMAGEMESS:
    return "Image too messy";

  case FINGERPRINT_FEATUREFAIL:
    return "Fingerprint features not found";

  case FINGERPRINT_NOMATCH:
    return "Fingerprint does not match";

  case FINGERPRINT_NOTFOUND:
    return "Fingerprint not found";

  case FINGERPRINT_ENROLLMISMATCH:
    return "Fingerprints mismatch";

  case FINGERPRINT_BADLOCATION:
    return "Invalid storage location";

  case FINGERPRINT_INVALIDIMAGE:
    return "Invalid fingerprint image";

  case FINGERPRINT_FLASHERR:
    return "Fingerprint flash error";

  default:
    return "Fingerprint error 0x" + String(p, HEX);
  }
}

void reportEnrollmentFailure(const String &userId, const String &userName, int errorCode,
                             const String &stage) {
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

bool runFaceRegistrationOnly(const String &userId, const String &userName,
                             const String &role = "user", int fingerId = 0) {
  tftShowFullScreen("ENROLL STEP 2/2", "Waking camera...", COLOR_CYAN);

  if (!startCamera()) {
    tftShowFullScreen("CAMERA ERROR", "Unable to wake camera", COLOR_RED);
    delay(2000);
    return false;
  }

  prepareCameraScreen("FACE REGISTRATION", userName);

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
      } else {
        tftShowStatus("Align face in frame", "Live preview", COLOR_CYAN);
      }

      unsigned long now = millis();
      bool validJpeg = hasJpegMarkers(jpegBuffer, jpegLen);

      if (faceRequestBusy) {
        tftShowStatus("Enrolling face...", "Extracting template", COLOR_CYAN);
      } else if (!validJpeg) {
        tftShowStatus("Camera image error", "Waiting for JPEG...", COLOR_YELLOW);
      } else {
        tftShowStatus("Look at camera", "Hold still for capture", COLOR_CYAN);
      }

      uint32_t adaptiveInterval = overlayBox.valid ? 700 : 1200;

      if (!faceRequestBusy && !faceResultReady && validJpeg &&
          now - lastFaceRequest >= adaptiveInterval) {
        if (startFaceRequestAsync(FACE_REQUEST_ENROLL, faceSession, userId, "", jpegBuffer,
                                  jpegLen)) {
          lastFaceRequest = now;
          reticleColor = COLOR_YELLOW;
        }
      }
    }
    delay(10);
  }

  if (!faceEnrolled) {
    finishPendingFaceRequest(faceSession, FACE_REQUEST_ENROLL, faceEnrolled, overlayBox,
                             COLOR_YELLOW);
  }

  stopCamera();

  if (faceEnrolled) {
    rememberCompletedEnrollment(userId, fingerId);
    tftShowFullScreen(role.equalsIgnoreCase("admin") ? "ADMIN ENROLLED" : "USER ENROLLED", userName,
                      COLOR_GREEN);
    tftShowStatus("Biometrics Active", "Google Sheets Synced", COLOR_GREEN);
  } else {
    tftShowFullScreen("FACE INCOMPLETE", "Retry from admin menu", COLOR_RED);
  }

  delay(2000);
  return faceEnrolled;
}

// ============================================================
// ENROLLMENT SEQUENCE (STEP 1: FINGERPRINT, STEP 2: FACE)
// ============================================================

bool runEnrollmentSequence(const String &userId, const String &userName,
                           const String &role = "user") {
  if (!fingerprintReady)
    return false;

  requestCoolingFan();

  // ------------------------------------------------------------
  // STEP 0: LOCATE NEXT AVAILABLE SENSOR SLOT BEFORE SCANNING
  // (CRITICAL: Prevents loadModel from clobbering CharBuffer 1 after
  // createModel)
  // ------------------------------------------------------------
  int nextId = -1;
  for (int id = 1; id <= finger.capacity; id++) {
    int result = finger.loadModel(id);
    if (result != FINGERPRINT_OK) {
      nextId = id;
      break;
    }
  }

  if (nextId < 1) {
    tftShowFullScreen("ENROLL FAILED", "No free sensor slots", COLOR_RED);
    delay(2000);
    return false;
  }

  // ------------------------------------------------------------
  // STEP 1/2: FINGERPRINT SCAN & MERGE
  // ------------------------------------------------------------

  tftShowFullScreen("ENROLL STEP 1/2", userName, COLOR_YELLOW);

  tftShowStatus("Place finger on sensor", "Scan 1 of 2", COLOR_YELLOW);

  int p = -1;
  bool firstScanOk = false;

  for (int attempt = 1; attempt <= 4; attempt++) {
    tftShowStatus("Place finger on sensor", "Scan 1/2 (Att " + String(attempt) + "/4)",
                  COLOR_YELLOW);

    p = -1;
    while (p != FINGERPRINT_OK) {
      p = finger.getImage();
      delay(100);
    }

    delay(120);          // allow finger contact pressure to stabilize on prism
    finger.getImage();   // refresh image with firm contact pressure
    requestCoolingFan(); // A new enrollment scan restarts cooling.
    p = finger.image2Tz(1);

    if (p == FINGERPRINT_OK) {
      firstScanOk = true;
      break;
    }

    Serial.printf("Enrollment Scan 1 attempt %d failed: %s (0x%02X)\n", attempt,
                  getFingerprintErrorString(p).c_str(), p);
    tftShowStatus("Press firmly & hold", "Retrying...", COLOR_YELLOW);

    while (finger.getImage() != FINGERPRINT_NOFINGER) {
      delay(100);
    }
    delay(400);
  }

  if (!firstScanOk) {
    reportEnrollmentFailure(userId, userName, p, "First image");
    tftShowFullScreen("SCAN ERROR", getFingerprintErrorString(p), COLOR_RED);
    delay(1500);
    return false;
  }

  tftShowStatus("Lift finger...", "Done scan 1", COLOR_CYAN);

  while (finger.getImage() != FINGERPRINT_NOFINGER) {
    delay(100);
  }

  delay(500);

  bool modelCreated = false;

  for (int attempt = 1; attempt <= 4; attempt++) {
    tftShowStatus("Place SAME finger", "Scan 2/2 (Att " + String(attempt) + "/4)", COLOR_YELLOW);

    p = -1;

    while (p != FINGERPRINT_OK) {
      p = finger.getImage();

      delay(100);
    }

    delay(120);          // allow finger contact pressure to stabilize on prism
    finger.getImage();   // refresh image with firm contact pressure
    requestCoolingFan(); // A new enrollment scan restarts cooling.
    p = finger.image2Tz(2);

    if (p != FINGERPRINT_OK) {
      Serial.printf("Enrollment Scan 2 attempt %d failed: %s (0x%02X)\n", attempt,
                    getFingerprintErrorString(p).c_str(), p);
      tftShowStatus("Press firmly & hold", "Retrying...", COLOR_YELLOW);
      while (finger.getImage() != FINGERPRINT_NOFINGER) {
        delay(100);
      }

      continue;
    }

    p = finger.createModel();

    if (p == FINGERPRINT_OK) {
      modelCreated = true;

      break;
    }

    while (finger.getImage() != FINGERPRINT_NOFINGER) {
      delay(100);
    }

    delay(500);
  }

  if (!modelCreated) {
    reportEnrollmentFailure(userId, userName, p, "Model creation");

    return false;
  }

  // Store newly created model (safely in CharBuffer 1) directly into nextId!
  // A reused sensor slot must not retain the previous user's completion.
  clearCompletedEnrollment(nextId);
  p = finger.storeModel(nextId);

  if (p != FINGERPRINT_OK) {
    reportEnrollmentFailure(userId, userName, p, "Storage");

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

  tftShowStatus("Fingerprint Saved!", "Slot #" + String(nextId), COLOR_GREEN);

  delay(1200);

  // ------------------------------------------------------------
  // STEP 2/2: FACE REGISTRATION (LIVE TFT PREVIEW)
  // ------------------------------------------------------------
  return runFaceRegistrationOnly(userId, userName, role, nextId);
}

// ============================================================
// AUTONOMOUS HARDWARE ENROLLMENT (100% STANDALONE)
// ============================================================

bool runAutonomousHardwareEnrollment(const String &requestedRole = "user") {
  wakeToActive("Hardware Enrollment");

  tftShowFullScreen("NEW ENROLLMENT", "Fetching " + requestedRole + " slot...", COLOR_CYAN);

  String userId = "";
  String userName = "";
  String role = requestedRole;

  if (!getNextAvailableUser(userId, userName, role, requestedRole)) {
    tftShowFullScreen("FETCH ERROR", "Could not load " + requestedRole, COLOR_RED);
    delay(2000);
    return false;
  }

  if (hasCompletedEnrollment(userId)) {
    Serial.println("Skipping already completed hardware enrollment.");
    return true;
  }

  tftShowFullScreen(role.equalsIgnoreCase("admin") ? "ENROLLING ADMIN" : "ENROLLING USER",
                    userName + " (" + userId + ")", COLOR_YELLOW);
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
      } else if (touchDuration >= 600) {
        runAutonomousHardwareEnrollment("admin");
      } else {
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

// Tell the backend a command has been executed. Without this the command
// stays queued until its TTL expires, and gets re-delivered/re-executed.
void acknowledgeCommand(const String &commandId, bool ok, const String &detail) {
  if (commandId.length() == 0) {
    Serial.println("[COMMAND-ACK] No commandId supplied; cannot acknowledge.");
    return;
  }
  StaticJsonDocument<256> doc;
  doc["roomId"] = ROOM_ID;
  doc["commandId"] = commandId;
  doc["ok"] = ok;
  doc["detail"] = detail;

  String body;
  serializeJson(doc, body);

  int status = 0;
  httpPostJson("/api/esp32/command-ack", body, &status);
  if (status >= 200 && status < 300) {
    Serial.println("[COMMAND-ACK] Backend acknowledged command execution");
  } else {
    Serial.printf("[COMMAND-ACK] Not confirmed; HTTP status: %d\n", status);
  }
}

void checkForAdminCommands() {
  if (systemState != STATE_IDLE) {
    return;
  }

  unsigned long now = millis();

  if (now - lastCommandPoll < COMMAND_POLL_INTERVAL_MS) {
    return;
  }

  lastCommandPoll = now;

  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  String response = httpGet("/api/esp32/get-commands/" + String(ROOM_ID));

  if (response.length() == 0) {
    return;
  }

  DynamicJsonDocument doc(512);

  if (deserializeJson(doc, response) != DeserializationError::Ok) {
    return;
  }

  if (!(doc["hasCommand"] | false)) {
    return;
  }

  String command = doc["command"] | "";

  String commandId = doc["commandId"] | "";

  // Idempotency guard: if this exact commandId already ran (e.g. the ACK was
  // lost and the backend re-delivered it), do NOT execute it again — just ACK
  // it so it is dequeued. This is the hard fix for "enrollment ran twice".
  if (commandId.length() > 0 && commandId == lastExecutedCommandId) {
    Serial.println("[COMMAND] Duplicate commandId received - ACKing without re-executing");
    acknowledgeCommand(commandId, lastExecutedCommandOk, "duplicate - already executed");
    return;
  }

  String commandUserName = doc["userName"] | "";

  if (command == "unlock") {
    wakeToActive("Remote unlock");

    tftShowFullScreen("ADMIN UNLOCK", commandUserName, COLOR_CYAN);

    openDoor();

    delay(1000);

    lastExecutedCommandId = commandId;
    lastExecutedCommandOk = true;
    acknowledgeCommand(commandId, true, "Door unlocked");

    enterIdleMode();

    return;
  }

  if (command.startsWith("DELETE_FP:")) {
    // Free the DSP slot of a deleted user so the finger stops matching.
    int slot = command.substring(10).toInt();

    wakeToActive("Sensor cleanup");

    bool ok = false;
    if (fingerprintReady && slot >= 1 && slot <= (int)finger.capacity) {
      uint8_t delResult = finger.deleteModel(slot);
      ok = (delResult == FINGERPRINT_OK);
      Serial.printf("[FP-DELETE] Slot %d delete result: 0x%02X (%s)\n", slot, delResult,
                    ok ? "freed" : "failed");
      if (ok) {
        clearCompletedEnrollment(slot);
      }
    } else {
      Serial.printf("[FP-DELETE] Invalid slot %d requested\n", slot);
    }

    tftShowFullScreen(ok ? "SENSOR CLEANED" : "CLEANUP FAILED", "Slot #" + String(slot),
                      ok ? COLOR_GREEN : COLOR_RED);
    delay(1200);

    lastExecutedCommandId = commandId;
    lastExecutedCommandOk = ok;
    acknowledgeCommand(commandId, ok,
                       ok ? "Fingerprint slot freed" : "Slot delete failed");

    enterIdleMode();
    return;
  }

  if (command.startsWith("ENROLL:")) {
    int separator = command.indexOf(':', 7);

    if (separator <= 0)
      return;

    String userId = command.substring(7, separator);

    String rem = command.substring(separator + 1);

    String userName = rem;
    String role = "user";

    int sep2 = rem.indexOf(':');
    if (sep2 > 0) {
      userName = rem.substring(0, sep2);
      role = rem.substring(sep2 + 1);
      role.trim();
    }

    // Ignore a stale/repeated backend task BEFORE waking the display.
    if (hasCompletedEnrollment(userId)) {
      Serial.println("Ignoring already completed enrollment command.");
      lastExecutedCommandId = commandId;
      lastExecutedCommandOk = true;
      acknowledgeCommand(commandId, true, "Enrollment already completed");
      return;
    }

    wakeToActive("Enrollment");

    bool enrollOk = runEnrollmentSequence(userId, userName, role);

    // ACK only after execution so this command is NEVER delivered a second
    // time (it used to stay queued and re-run the whole enrollment).
    lastExecutedCommandId = commandId;
    lastExecutedCommandOk = enrollOk;
    acknowledgeCommand(commandId, enrollOk,
                       enrollOk ? "Enrollment completed" : "Enrollment failed on device");

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

  tftShowFullScreen("FINGER MATCHED", "Checking account...", COLOR_CYAN);

  if (!getUserByFingerId(fingerId, userId, userName, userRole, faceEnrolled)) {
    tftShowFullScreen("USER NOT FOUND", "Fingerprint not linked", COLOR_RED);

    delay(1500);
    return;
  }

  // ------------------------------------------------------------
  // ADMIN LONG-PRESS CHECK FOR HARDWARE MENU
  // ------------------------------------------------------------
  if (userRole.equalsIgnoreCase("admin")) {
    unsigned long pressStart = millis();

    bool isLongPress = false;

    while (millis() - pressStart < 1800) {
      if (finger.getImage() == FINGERPRINT_OK) {
        if (millis() - pressStart > 1200) {
          isLongPress = true;

          break;
        }
      } else {
        break;
      }

      delay(50);
    }

    if (isLongPress) {
      while (finger.getImage() != FINGERPRINT_NOFINGER) {
        delay(50);
      }

      showAdminHardwareMenu(userName);

      return;
    }
  }

  tftShowFullScreen("IDENTIFIED", userName, COLOR_GREEN);

  notifyFingerprintVerified(userId, fingerId);

  // If user has not completed face enrollment yet, smoothly transition to Step
  // 2/2
  if (!faceEnrolled) {
    tftShowFullScreen("ENROLL FACE", "Step 2: Register Face", COLOR_CYAN);
    delay(1200);

    if (runFaceRegistrationOnly(userId, userName, userRole, fingerId)) {
      openDoor();
      tftShowFullScreen("WELCOME", userName, COLOR_GREEN);
      delay(1800);
    }
    return;
  }

  // =========================================================
  // WAKE ESP32-CAM
  // =========================================================

  tftShowStatus("Waking camera...", "", COLOR_CYAN);

  if (!startCamera()) {
    tftShowFullScreen("CAMERA ERROR", "Camera unavailable", COLOR_RED);

    delay(1500);
    return;
  }

  prepareCameraScreen("FACE VERIFICATION", userName);

  bool faceVerified = false;

  uint32_t faceSession = beginFaceSession();

  unsigned long start = millis();

  unsigned long lastFaceRequest = 0;

  FaceBox overlayBox = {0, 0, 0, 0, false};

  uint16_t overlayColor = COLOR_CYAN;

  uint16_t reticleColor = COLOR_CYAN;

  size_t prevVerifyJpegLen = 0;
  int verifyAttempts = 0;
  constexpr int MAX_VERIFY_ATTEMPTS = 8;

  while (millis() - start < LIVE_VIEW_TIME_MS && !faceVerified) {
    // Read completed server work first from async worker
    bool resultSuccess = false;
    FaceBox resultBox = {0, 0, 0, 0, false};

    if (takeFaceResult(faceSession, FACE_REQUEST_VERIFY, resultSuccess, resultBox)) {
      overlayBox = resultBox;
      faceVerified = resultSuccess;
      overlayColor = faceVerified ? COLOR_GREEN : COLOR_RED;
      reticleColor = faceVerified ? COLOR_GREEN : COLOR_RED;
    }

    size_t jpegLen = fetchJpegFrame(jpegBuffer, jpegBufferCapacity);

    if (jpegLen > 0) {
      displayJpegOnTFT(jpegBuffer, jpegLen);
      drawFaceReticle(reticleColor);

      if (overlayBox.valid) {
        drawCameraFaceBox(overlayBox, overlayColor);
      }

      if (faceVerified) {
        tftShowStatus("Identity Confirmed!", "Face matched", COLOR_GREEN);
        delay(500);
        break;
      }

      // Send valid JPEGs; the backend decides whether a face is present.
      bool validJpeg = hasJpegMarkers(jpegBuffer, jpegLen);

      if (faceRequestBusy) {
        tftShowStatus("Verifying face...", "AI matching in cloud", COLOR_CYAN);
      } else if (!validJpeg) {
        tftShowStatus("Camera image error", "Waiting for JPEG...", COLOR_YELLOW);
      } else {
        tftShowStatus("Look at camera", "Hold still...", COLOR_CYAN);
      }

      unsigned long now = millis();
      // Adaptive timing: fast 600ms when face candidate was found, calm 1200ms when waiting
      uint32_t adaptiveInterval = overlayBox.valid ? 600 : 1200;

      // Dispatch valid images at the existing interval while attempts remain
      if (!faceRequestBusy && !faceResultReady && validJpeg &&
          verifyAttempts < MAX_VERIFY_ATTEMPTS && now - lastFaceRequest >= adaptiveInterval) {
        if (startFaceRequestAsync(FACE_REQUEST_VERIFY, faceSession, userId, String(ROOM_ID),
                                  jpegBuffer, jpegLen)) {
          lastFaceRequest = now;
          verifyAttempts++;
          reticleColor = COLOR_CYAN;
        }
      }
    }

    delay(10);
  }

  if (!faceVerified) {
    finishPendingFaceRequest(faceSession, FACE_REQUEST_VERIFY, faceVerified, overlayBox,
                             COLOR_CYAN);
  }

  stopCamera();

  if (faceVerified) {
    tftShowFullScreen("VERIFIED", userName, COLOR_GREEN);

    openDoor();

    tftShowFullScreen("WELCOME", userName, COLOR_GREEN);

    delay(1800);
    return;
  }

  tftShowFullScreen("ACCESS DENIED", "Face not matched", COLOR_RED);

  delay(1800);
}

// ============================================================
// FINGERPRINT POLLING
// ============================================================

bool processFingerprintIfPresent() {
  if (systemState != STATE_IDLE || !fingerprintReady) {
    return false;
  }

  uint8_t result = finger.getImage();

  if (result != FINGERPRINT_OK) {
    return false;
  }

  Serial.println("Finger detected");

  wakeToActive("Finger detected");

  tftShowStatus("Reading fingerprint...", "Hold finger steady", COLOR_CYAN);

  // Stabilize finger contact pressure and retry image2Tz up to 3 times
  int tzResult = -1;
  for (int attempt = 1; attempt <= 3; attempt++) {
    delay(100); // Allow finger pressure to stabilize on the glass prism
    int imgStatus = finger.getImage();
    if (imgStatus == FINGERPRINT_OK) {
      tzResult = finger.image2Tz(1);
      if (tzResult == FINGERPRINT_OK) {
        break; // Successfully captured clear fingerprint template!
      }
      Serial.printf("image2Tz attempt %d failed: %s (0x%02X)\n", attempt,
                    getFingerprintErrorString(tzResult).c_str(), tzResult);
    }
  }

  if (tzResult != FINGERPRINT_OK) {
    String errDesc = getFingerprintErrorString(tzResult);
    Serial.printf("Fingerprint capture failed: %s (0x%02X)\n", errDesc.c_str(), tzResult);
    tftShowFullScreen("SCAN ERROR", errDesc.length() > 0 ? errDesc : "Press firmly", COLOR_YELLOW);

    while (finger.getImage() != FINGERPRINT_NOFINGER) {
      delay(75);
    }

    delay(1000);

    enterIdleMode();

    return true;
  }

  int searchResult = finger.fingerSearch();
  if (searchResult != FINGERPRINT_OK) {
    Serial.printf("fingerSearch failed: %s (0x%02X)\n",
                  getFingerprintErrorString(searchResult).c_str(), searchResult);
    tftShowFullScreen("NO MATCH", "Not registered", COLOR_RED);

    while (finger.getImage() != FINGERPRINT_NOFINGER) {
      delay(75);
    }

    delay(1500);

    enterIdleMode();

    return true;
  }

  int fingerId = finger.fingerID;

  int confidence = finger.confidence;

  Serial.printf("Fingerprint ID=%d Confidence=%d\n", fingerId, confidence);

  if (confidence < 40) {
    tftShowFullScreen("LOW CONFIDENCE", "Press firmly", COLOR_YELLOW);

    while (finger.getImage() != FINGERPRINT_NOFINGER) {
      delay(75);
    }

    delay(1000);

    enterIdleMode();

    return true;
  }

  runAccessFlow(fingerId);

  enterIdleMode();

  return true;
}

// ============================================================
// SETUP
// ============================================================

void setup() {
  Serial.begin(115200);

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
    Serial.println("[BOOT] Dynamic Server URL loaded from NVS: " + activeServerUrl);
  } else {
    Serial.println("[BOOT] Using default Server URL: " + activeServerUrl);
  }

  // Sanitize against /api double-prefix and trailing slashes
  activeServerUrl = normalizeServerUrl(activeServerUrl);

  // =========================================================
  // RELAY
  // =========================================================

  // Establish the locked command before starting either controller task.
  digitalWrite(RELAY_PIN, DOOR_RELAY_OFF_LEVEL);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, DOOR_RELAY_OFF_LEVEL);

  if (!initCoolingFan()) {
    // Do not silently run the access system without its fan controller.
    Serial.println("Startup halted. Restart ESP32 and check available memory.");
    while (true) {
      delay(1000);
    }
  }

  if (!initDoorControl()) {
    Serial.println("Startup halted. Restart ESP32 and check available memory.");
    while (true) {
      delay(1000);
    }
  }

  // =========================================================
  // TFT BACKLIGHT (ALWAYS ON)
  // =========================================================

  if (TFT_LED >= 0) {
    pinMode(TFT_LED, OUTPUT);
    digitalWrite(TFT_LED, HIGH);
  }

  // =========================================================
  // TFT
  // =========================================================

  SPI.begin(TFT_SCLK, TFT_MISO, TFT_MOSI, TFT_CS);

  tft.begin(40000000);

  /*
  Portrait 240 x 320.
  The ESP32-CAM remains QVGA 320 x 240; during face view,
  the image is center-cropped horizontally to 240 x 240.
  */

  tft.setRotation(TFT_ROTATION);

  tft.fillScreen(COLOR_BG);

  // =========================================================
  // JPEG DECODER
  // =========================================================

  TJpgDec.setSwapBytes(false);
  TJpgDec.setJpgScale(1);
  TJpgDec.setCallback(tftJpegOutput);

  if (!allocateJpegBuffer()) {
    tft.fillScreen(COLOR_RED);

    tft.setTextColor(COLOR_WHITE, COLOR_RED);

    tft.setTextSize(2);

    tft.setCursor(10, 88);

    tft.println("MEMORY ERROR");

    tft.setTextSize(1);

    tft.setCursor(10, 118);

    tft.println("JPEG buffer failed");

    tft.setCursor(10, 134);

    tft.println("Check Serial Monitor");

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

  Serial.println("LabSync ready");
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
        activeServerUrl = normalizeServerUrl(newUrl);
        Preferences p;
        p.begin("labsync", false);
        p.putString("server_url", activeServerUrl);
        p.end();
        Serial.println("[OK] Dynamic Server URL updated and saved: " + activeServerUrl);
      }
    } else if (line == "RESET_SERVER") {
      activeServerUrl = DEFAULT_SERVER_URL;
      Preferences p;
      p.begin("labsync", false);
      p.remove("server_url");
      p.end();
      Serial.println("[OK] Server URL reset to GCP Cloud Run: " + activeServerUrl);
    } else if (line == "IP_STATUS") {
      Serial.println("=== LABSYNC DYNAMIC IP STATUS ===");
      Serial.println("ESP32 Local IP: " + WiFi.localIP().toString());
      Serial.println("Camera Base URL: " +
                     (cameraBaseUrl.length() > 0 ? cameraBaseUrl : "NOT RESOLVED"));
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
  if (processFingerprintIfPresent()) {
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

    unsigned long now = millis();

    if (now - lastWiFiReconnectAttempt >= WIFI_RECONNECT_INTERVAL_MS) {
      lastWiFiReconnectAttempt = now;

      Serial.println("Background WiFi reconnect...");

      WiFi.mode(WIFI_STA);
      WiFi.setSleep(false);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  } else {
    ensureDeviceTimeSync();
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

  if (systemState == STATE_IDLE) {
    reportDoorClosedIfPending();

    sendHeartbeat();

    checkForAdminCommands();
  }

  delay(40);
}
