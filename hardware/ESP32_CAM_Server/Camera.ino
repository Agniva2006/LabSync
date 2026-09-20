/*
  ============================================================
  LabSync ESP32-CAM Low-Power Server + UDP Discovery

  Board:
    AI Thinker ESP32-CAM

  Camera:
    OV2640
    Resolution: QVGA 320 x 240

  Network:
    Dynamic DHCP
    Original UDP discovery retained
    mDNS: esp32cam.local
    Optional backend IP registration

  Original UDP discovery retained:
    Sends: espcam_ip=192.168.x.x
    Destination port: 4210
    Local UDP port: 4211
    Interval: 1 second

  HTTP endpoints:

    GET /start
        Wake OV2640
        Initialize camera
        Enable captures

    GET /capture
        Return one JPEG
        If camera is asleep, automatically wake it first

    GET /stop
        Deinitialize camera
        PWDN HIGH
        Enable WiFi modem sleep

    GET /status
        ACTIVE or SLEEP

  IDLE:
    WiFi        = connected with modem sleep
    UDP         = active
    mDNS        = active
    HTTP        = active
    OV2640      = powered down
    Camera XCLK = stopped
    Framebuffer = released
  ============================================================
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

#include "esp_camera.h"
#include "esp_http_server.h"

// ============================================================
// WIFI SETTINGS
// ============================================================

const char *WIFI_SSID = "Arun"; // REQUIRED: must match Main ESP32
const char *WIFI_PASSWORD = "4064097a"; // REQUIRED: must match Main ESP32

// ============================================================
// OPTIONAL BACKEND REGISTRATION
// ============================================================
// Replace SERVER_URL later with your actual backend URL.
// The camera will POST its current DHCP IP to the backend.
// ============================================================

const char *SERVER_URL = "https://labsync-pnr8.onrender.com";
const char *ROOM_ID = "ROOM-001";

// RECOMMENDED while SERVER_URL is only a placeholder.
// UDP + mDNS continue to work with this disabled.
constexpr bool ENABLE_BACKEND_REGISTRATION = true;

unsigned long lastDynamicIpRegister = 0;
constexpr unsigned long DYNAMIC_IP_REFRESH_INTERVAL_MS = 60000;

// ============================================================
// ORIGINAL UDP DISCOVERY - RETAINED
// ============================================================

#define DISCOVERY_PORT 4210
#define CAMERA_UDP_LOCAL_PORT 4211

WiFiUDP udp;
bool udpStarted = false;

String espcam_ip = "";

unsigned long lastBroadcast = 0;
constexpr unsigned long BROADCAST_INTERVAL = 1000;

// ============================================================
// MDNS
// ============================================================

const char *MDNS_HOSTNAME = "esp32cam";
bool mdnsRunning = false;

// ============================================================
// CAMERA SETTINGS
// ============================================================

#define CAMERA_RESOLUTION FRAMESIZE_QVGA
#define CAMERA_JPEG_QUALITY 12

// ============================================================
// AI THINKER ESP32-CAM PIN DEFINITIONS
// ============================================================

#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1

#define XCLK_GPIO_NUM 0

#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27

#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5

#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// ============================================================
// CAMERA / HTTP STATE
// ============================================================

volatile bool cameraEnabled = false;
bool cameraInitialized = false;

httpd_handle_t cameraServer = nullptr;

httpd_uri_t rootUri = {};
httpd_uri_t startUri = {};
httpd_uri_t stopUri = {};
httpd_uri_t statusUri = {};
httpd_uri_t captureUri = {};

// ============================================================
// FUNCTION PROTOTYPES
// ============================================================

esp_err_t sendText(httpd_req_t *req, const char *text);

bool initializeCamera();
void sleepCamera();

esp_err_t rootHandler(httpd_req_t *req);
esp_err_t startHandler(httpd_req_t *req);
esp_err_t stopHandler(httpd_req_t *req);
esp_err_t statusHandler(httpd_req_t *req);
esp_err_t captureHandler(httpd_req_t *req);

bool startHttpServer();

IPAddress getBroadcastIP();
void startUDP();
void broadcastCameraIP();

void connectWiFi();
void registerCameraWithBackend();

bool startMDNS();

// ============================================================
// SEND TEXT RESPONSE
// ============================================================

esp_err_t sendText(httpd_req_t *req, const char *text)
{
  httpd_resp_set_type(req, "text/plain");

  httpd_resp_set_hdr(
      req,
      "Cache-Control",
      "no-store");

  httpd_resp_set_hdr(
      req,
      "Access-Control-Allow-Origin",
      "*");

  return httpd_resp_sendstr(req, text);
}

// ============================================================
// CALCULATE NETWORK BROADCAST IP
// ============================================================

IPAddress getBroadcastIP()
{
  IPAddress localIP = WiFi.localIP();
  IPAddress subnet = WiFi.subnetMask();

  IPAddress broadcast;

  for (int i = 0; i < 4; i++)
  {
    broadcast[i] =
        (localIP[i] & subnet[i]) |
        ((~subnet[i]) & 0xFF);
  }

  return broadcast;
}

// ============================================================
// START / RESTART UDP DISCOVERY
// ============================================================

void startUDP()
{
  if (WiFi.status() != WL_CONNECTED)
  {
    return;
  }

  if (udpStarted)
  {
    udp.stop();
    udpStarted = false;
  }

  if (udp.begin(CAMERA_UDP_LOCAL_PORT))
  {
    udpStarted = true;

    Serial.print("UDP discovery started on local port ");
    Serial.println(CAMERA_UDP_LOCAL_PORT);
  }
  else
  {
    Serial.println("UDP discovery failed to start");
  }
}

// ============================================================
// BROADCAST ESP32-CAM IP
// ============================================================

void broadcastCameraIP()
{
  if (WiFi.status() != WL_CONNECTED)
  {
    return;
  }

  if (!udpStarted)
  {
    startUDP();
  }

  if (!udpStarted)
  {
    return;
  }

  IPAddress broadcastIP = getBroadcastIP();

  String message =
      "espcam_ip=" + WiFi.localIP().toString();

  if (udp.beginPacket(broadcastIP, DISCOVERY_PORT))
  {
    udp.print(message);
    udp.endPacket();

    Serial.print("Broadcast: ");
    Serial.println(message);
  }
  else
  {
    Serial.println("UDP broadcast packet failed to start");
  }
}

// ============================================================
// CAMERA INITIALIZATION
// ============================================================

bool initializeCamera()
{
  if (cameraInitialized)
  {
    return true;
  }

  Serial.println("Waking OV2640...");

  // Disable WiFi modem sleep while capturing for faster JPEG transfer.
  WiFi.setSleep(false);

  // AI Thinker PWDN is active HIGH.
  // LOW = camera awake.
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, LOW);

  delay(150);

  camera_config_t config = {};

  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;

  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;

  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;

  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  // Keep original uploaded-code resolution: 320 x 240.
  config.frame_size = CAMERA_RESOLUTION;

  // ==========================================================
  // PSRAM CONFIGURATION
  // ==========================================================

  if (psramFound())
  {
    Serial.println("PSRAM detected");

    config.jpeg_quality = CAMERA_JPEG_QUALITY;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;
  }
  else
  {
    Serial.println("PSRAM NOT detected");

    config.jpeg_quality = 15;
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }

  // ==========================================================
  // CAMERA INIT
  // ==========================================================

  esp_err_t error = esp_camera_init(&config);

  if (error != ESP_OK)
  {
    Serial.printf(
        "Camera init failed: 0x%X\n",
        error);

    digitalWrite(PWDN_GPIO_NUM, HIGH);

    cameraInitialized = false;
    cameraEnabled = false;

    // Camera is sleeping again, so WiFi modem sleep can resume.
    WiFi.setSleep(true);

    return false;
  }

  // ==========================================================
  // SENSOR SETTINGS
  // ==========================================================

  sensor_t *sensor = esp_camera_sensor_get();

  if (sensor != nullptr)
  {
    sensor->set_framesize(
        sensor,
        CAMERA_RESOLUTION);

    sensor->set_contrast(
        sensor,
        1);

    sensor->set_brightness(
        sensor,
        1);

    sensor->set_saturation(
        sensor,
        0);

    sensor->set_whitebal(
        sensor,
        1);

    sensor->set_exposure_ctrl(
        sensor,
        1);

    sensor->set_aec2(
        sensor,
        1);

    // Physical camera orientation.
    sensor->set_vflip(
        sensor,
        1);

    sensor->set_hmirror(
        sensor,
        0);
  }

  cameraInitialized = true;

  Serial.println("OV2640 initialized at 320 x 240");

  return true;
}

// ============================================================
// CAMERA POWER DOWN
// ============================================================

void sleepCamera()
{
  Serial.println("Putting OV2640 into low-power standby...");

  cameraEnabled = false;

  if (cameraInitialized)
  {
    // Release camera driver, XCLK, DMA and frame buffers.
    esp_camera_deinit();

    cameraInitialized = false;

    delay(30);
  }

  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);

  // Keep WiFi connected so /start, UDP and mDNS remain available.
  WiFi.setSleep(true);

  Serial.println("Camera state: SLEEP");
}

// ============================================================
// ROOT HANDLER
// ============================================================

esp_err_t rootHandler(httpd_req_t *req)
{
  return sendText(
      req,
      "LabSync ESP32-CAM\n"
      "\n"
      "Resolution: 320x240\n"
      "mDNS: esp32cam.local\n"
      "UDP discovery: espcam_ip=<DHCP_IP>\n"
      "\n"
      "GET /start\n"
      "GET /capture\n"
      "GET /stop\n"
      "GET /status\n");
}

// ============================================================
// START HANDLER
// ============================================================

esp_err_t startHandler(httpd_req_t *req)
{
  Serial.println();
  Serial.println("Received /start");

  if (!cameraInitialized)
  {
    if (!initializeCamera())
    {
      httpd_resp_set_status(
          req,
          "500 Internal Server Error");

      return sendText(
          req,
          "CAMERA_INIT_FAILED");
    }
  }

  cameraEnabled = true;

  // Flush two initial frames so exposure / white balance can settle.
  for (int f = 0; f < 2; f++)
  {
    camera_fb_t *oldFrame = esp_camera_fb_get();

    if (oldFrame != nullptr)
    {
      esp_camera_fb_return(oldFrame);
    }

    delay(20);
  }

  Serial.println("Camera ACTIVE and exposure stabilized");

  return sendText(
      req,
      "CAMERA_ON");
}

// ============================================================
// STOP HANDLER
// ============================================================

esp_err_t stopHandler(httpd_req_t *req)
{
  Serial.println();
  Serial.println("Received /stop");

  esp_err_t result = sendText(
      req,
      "CAMERA_SLEEP");

  // Let the response leave before deinitializing the camera.
  delay(20);

  sleepCamera();

  return result;
}

// ============================================================
// STATUS HANDLER
// ============================================================

esp_err_t statusHandler(httpd_req_t *req)
{
  if (cameraEnabled && cameraInitialized)
  {
    return sendText(
        req,
        "ACTIVE");
  }

  return sendText(
      req,
      "SLEEP");
}

// ============================================================
// CAPTURE HANDLER
// ============================================================

esp_err_t captureHandler(httpd_req_t *req)
{
  // Auto-wake if /capture arrives while camera is sleeping.
  if (!cameraInitialized || !cameraEnabled)
  {
    Serial.println("Auto-waking OV2640 for capture...");

    if (!initializeCamera())
    {
      httpd_resp_set_status(
          req,
          "500 Internal Server Error");

      return sendText(
          req,
          "CAMERA_INIT_FAILED");
    }

    cameraEnabled = true;

    // Flush two initial frames after wake-up.
    for (int f = 0; f < 2; f++)
    {
      camera_fb_t *oldFrame = esp_camera_fb_get();

      if (oldFrame != nullptr)
      {
        esp_camera_fb_return(oldFrame);
      }

      delay(20);
    }
  }

  camera_fb_t *frame = esp_camera_fb_get();

  if (frame == nullptr)
  {
    Serial.println("Camera capture failed - retrying once...");

    delay(30);

    frame = esp_camera_fb_get();
  }

  if (frame == nullptr)
  {
    Serial.println("Camera frame acquisition failed");

    httpd_resp_send_500(req);

    return ESP_FAIL;
  }

  Serial.printf(
      "JPEG captured: %u bytes\n",
      static_cast<unsigned int>(frame->len));

  httpd_resp_set_type(
      req,
      "image/jpeg");

  // Retained from the original uploaded code.
  httpd_resp_set_hdr(
      req,
      "Content-Disposition",
      "inline; filename=capture.jpg");

  httpd_resp_set_hdr(
      req,
      "Cache-Control",
      "no-store, no-cache, must-revalidate");

  httpd_resp_set_hdr(
      req,
      "Pragma",
      "no-cache");

  httpd_resp_set_hdr(
      req,
      "Access-Control-Allow-Origin",
      "*");

  esp_err_t result = httpd_resp_send(
      req,
      reinterpret_cast<const char *>(frame->buf),
      frame->len);

  esp_camera_fb_return(frame);

  return result;
}

// ============================================================
// HTTP SERVER
// ============================================================

bool startHttpServer()
{
  if (cameraServer != nullptr)
  {
    return true;
  }

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();

  config.server_port = 80;
  config.max_uri_handlers = 8;
  config.lru_purge_enable = true;

  if (httpd_start(&cameraServer, &config) != ESP_OK)
  {
    Serial.println("HTTP server failed");

    cameraServer = nullptr;

    return false;
  }

  rootUri.uri = "/";
  rootUri.method = HTTP_GET;
  rootUri.handler = rootHandler;
  rootUri.user_ctx = nullptr;

  startUri.uri = "/start";
  startUri.method = HTTP_GET;
  startUri.handler = startHandler;
  startUri.user_ctx = nullptr;

  stopUri.uri = "/stop";
  stopUri.method = HTTP_GET;
  stopUri.handler = stopHandler;
  stopUri.user_ctx = nullptr;

  statusUri.uri = "/status";
  statusUri.method = HTTP_GET;
  statusUri.handler = statusHandler;
  statusUri.user_ctx = nullptr;

  captureUri.uri = "/capture";
  captureUri.method = HTTP_GET;
  captureUri.handler = captureHandler;
  captureUri.user_ctx = nullptr;

  httpd_register_uri_handler(
      cameraServer,
      &rootUri);

  httpd_register_uri_handler(
      cameraServer,
      &startUri);

  httpd_register_uri_handler(
      cameraServer,
      &stopUri);

  httpd_register_uri_handler(
      cameraServer,
      &statusUri);

  httpd_register_uri_handler(
      cameraServer,
      &captureUri);

  Serial.println("HTTP server started");

  return true;
}

// ============================================================
// BACKEND DYNAMIC IP REGISTRATION
// ============================================================

void registerCameraWithBackend()
{
  if (!ENABLE_BACKEND_REGISTRATION)
  {
    return;
  }

  if (WiFi.status() != WL_CONNECTED)
  {
    return;
  }

  String localIp = WiFi.localIP().toString();

  Serial.print("Announcing dynamic camera IP (");
  Serial.print(localIp);
  Serial.println(") to backend...");

  String registerUrl =
      String(SERVER_URL) + "/api/esp32/register-camera";

  String payload =
      "{\"roomId\":\"" + String(ROOM_ID) +
      "\",\"ip\":\"" + localIp + "\"}";

  int httpCode = -1;

  HTTPClient http;
  http.setTimeout(6000);

  if (registerUrl.startsWith("https://"))
  {
    WiFiClientSecure secureClient;

    // Temporary development mode: TLS certificate is not verified.
    secureClient.setInsecure();

    if (http.begin(secureClient, registerUrl))
    {
      http.addHeader(
          "Content-Type",
          "application/json");

      httpCode = http.POST(payload);

      http.end();
    }
  }
  else
  {
    WiFiClient client;

    if (http.begin(client, registerUrl))
    {
      http.addHeader(
          "Content-Type",
          "application/json");

      httpCode = http.POST(payload);

      http.end();
    }
  }

  if (httpCode > 0)
  {
    Serial.printf(
        "Dynamic camera IP registered to backend (HTTP %d): %s\n",
        httpCode,
        localIp.c_str());
  }
  else
  {
    Serial.printf(
        "Backend IP registration failed (HTTP code %d)\n",
        httpCode);
  }
}

// ============================================================
// MDNS
// ============================================================

bool startMDNS()
{
  if (WiFi.status() != WL_CONNECTED)
  {
    return false;
  }

  if (mdnsRunning)
  {
    return true;
  }

  if (!MDNS.begin(MDNS_HOSTNAME))
  {
    Serial.println("mDNS failed");

    mdnsRunning = false;

    return false;
  }

  MDNS.addService(
      "http",
      "tcp",
      80);

  mdnsRunning = true;

  Serial.println("mDNS ready:");
  Serial.println("http://esp32cam.local");

  return true;
}

// ============================================================
// WIFI
// ============================================================

void connectWiFi()
{
  if (WiFi.status() == WL_CONNECTED)
  {
    return;
  }

  WiFi.mode(WIFI_STA);

  // Full WiFi during connection.
  WiFi.setSleep(false);

  WiFi.begin(
      WIFI_SSID,
      WIFI_PASSWORD);

  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);
  Serial.print("Connecting");

  int attempts = 0;

  while (
      WiFi.status() != WL_CONNECTED &&
      attempts < 60)
  {
    delay(500);
    Serial.print('.');
    attempts++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED)
  {
    espcam_ip = WiFi.localIP().toString();

    Serial.println("WiFi connected");
    Serial.print("Current DHCP IP: ");
    Serial.println(espcam_ip);

    Serial.print("Capture URL: http://");
    Serial.print(espcam_ip);
    Serial.println("/capture");

    // Restart UDP socket for the current network connection.
    startUDP();

    // Original discovery announcement immediately after connection.
    broadcastCameraIP();

    // Additional backend DHCP-IP registration.
    registerCameraWithBackend();
    lastDynamicIpRegister = millis();

    // Camera normally sleeps while idle.
    if (!cameraEnabled)
    {
      WiFi.setSleep(true);
    }
  }
  else
  {
    Serial.println("WiFi connection failed");
  }
}

// ============================================================
// SETUP
// ============================================================

void setup()
{
  Serial.begin(115200);

  delay(500);

  Serial.println();
  Serial.println("===================================");
  Serial.println("LabSync ESP32-CAM LOW POWER");
  Serial.println("320 x 240 + UDP + mDNS + Backend");
  Serial.println("===================================");

  // ==========================================================
  // CAMERA STARTS POWERED DOWN
  // ==========================================================

  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);

  cameraEnabled = false;
  cameraInitialized = false;

  // Camera is intentionally NOT initialized during setup.

  // ==========================================================
  // WIFI
  // ==========================================================

  connectWiFi();

  // ==========================================================
  // MDNS
  // ==========================================================

  if (WiFi.status() == WL_CONNECTED)
  {
    startMDNS();
  }

  // ==========================================================
  // HTTP SERVER
  // ==========================================================

  if (!startHttpServer())
  {
    Serial.println("FATAL: HTTP server failed");

    while (true)
    {
      delay(1000);
    }
  }

  // Camera is asleep, so allow WiFi modem sleep.
  if (WiFi.status() == WL_CONNECTED)
  {
    WiFi.setSleep(true);
  }

  Serial.println();
  Serial.println("ESP32-CAM READY");
  Serial.println("Camera sensor: SLEEP");
  Serial.println("Resolution: 320 x 240");
  Serial.println("WiFi: ACTIVE with modem sleep while camera sleeps");
  Serial.println("UDP discovery: ACTIVE");
  Serial.println("HTTP server: ACTIVE");
  Serial.println("mDNS: esp32cam.local");
}

// ============================================================
// LOOP
// ============================================================

void loop()
{
  // ==========================================================
  // WIFI RECONNECT
  // ==========================================================

  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("WiFi disconnected");

    if (udpStarted)
    {
      udp.stop();
      udpStarted = false;
    }

    if (mdnsRunning)
    {
      MDNS.end();
      mdnsRunning = false;
    }

    WiFi.disconnect();

    connectWiFi();

    if (WiFi.status() == WL_CONNECTED)
    {
      startMDNS();

      espcam_ip = WiFi.localIP().toString();

      Serial.print("Reconnected IP: ");
      Serial.println(espcam_ip);

      // Re-announce through original UDP discovery.
      broadcastCameraIP();

      // Re-register current IP with backend.
      registerCameraWithBackend();
      lastDynamicIpRegister = millis();
    }
  }
  else
  {
    // ========================================================
    // ORIGINAL UDP BROADCAST EVERY SECOND
    // ========================================================

    if (millis() - lastBroadcast >= BROADCAST_INTERVAL)
    {
      lastBroadcast = millis();

      broadcastCameraIP();
    }

    // ========================================================
    // BACKEND IP REFRESH EVERY 60 SECONDS
    // ========================================================

    if (
        millis() - lastDynamicIpRegister >=
        DYNAMIC_IP_REFRESH_INTERVAL_MS)
    {
      lastDynamicIpRegister = millis();

      registerCameraWithBackend();
    }
  }

  // Nothing continuously captures here.
  // Camera hardware remains powered down until /start or /capture.

  delay(100);
}
