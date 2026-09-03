/*
  ============================================================
  LabSync ESP32-CAM Low-Power Server v3.0

  Board:
    AI Thinker ESP32-CAM

  Camera:
    OV2640

  Network:
    Dynamic DHCP
    mDNS: esp32cam.local

  Endpoints:

    GET /start
        Wake OV2640
        Initialize camera
        Enable captures

    GET /capture
        Return one JPEG
        ONLY if camera is active

    GET /stop
        Deinitialize camera
        PWDN HIGH
        Enable WiFi modem sleep

    GET /status
        ACTIVE or SLEEP

  IDLE:
    WiFi       = connected with modem sleep
    mDNS       = active
    HTTP       = active
    OV2640     = powered down
    Camera XCLK= stopped
    Framebuffer= released
  ============================================================
*/

#include "esp_camera.h"
#include "esp_http_server.h"

#include <Arduino.h>
#include <ESPmDNS.h>
#include <WiFi.h>

// ============================================================
// ⚠️  CHANGE THESE — WiFi credentials for your lab network
// ============================================================

const char *WIFI_SSID =
    "Galaxy";                   // ← Change to your WiFi name

const char *WIFI_PASSWORD =
    "password2006";             // ← Change to your WiFi password

/*
   IMPORTANT:
   Use the SAME WiFi network as the main ESP32 DevKit.
   Both devices MUST be on the same local network for
   mDNS camera discovery to work.
*/

// ============================================================
// MDNS
// ============================================================

const char *MDNS_HOSTNAME =
    "esp32cam";

// ============================================================
// CAMERA
// ============================================================

#define CAMERA_RESOLUTION FRAMESIZE_VGA

#define CAMERA_JPEG_QUALITY 10

// ============================================================
// AI THINKER PINS
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
// STATE
// ============================================================

volatile bool cameraEnabled =
    false;

bool cameraInitialized =
    false;

bool mdnsRunning =
    false;

httpd_handle_t cameraServer =
    nullptr;

// ============================================================
// HTTP URI OBJECTS
// ============================================================

httpd_uri_t rootUri = {};
httpd_uri_t startUri = {};
httpd_uri_t stopUri = {};
httpd_uri_t statusUri = {};
httpd_uri_t captureUri = {};

// ============================================================
// SEND TEXT
// ============================================================

esp_err_t sendText(
    httpd_req_t *req,
    const char *text)
{
  httpd_resp_set_type(
      req,
      "text/plain"
  );

  httpd_resp_set_hdr(
      req,
      "Cache-Control",
      "no-store"
  );

  httpd_resp_set_hdr(
      req,
      "Access-Control-Allow-Origin",
      "*"
  );

  return
      httpd_resp_sendstr(
          req,
          text
      );
}

// ============================================================
// CAMERA CONFIGURATION
// ============================================================

bool initializeCamera()
{
  if (cameraInitialized)
  {
    return true;
  }

  Serial.println(
      "Waking OV2640..."
  );

  /*
     Disable WiFi modem sleep while capturing.
     This gives faster JPEG transfer.
  */

  WiFi.setSleep(false);

  /*
     AI Thinker PWDN is active HIGH.

     LOW = camera powered/awake.
  */

  pinMode(
      PWDN_GPIO_NUM,
      OUTPUT
  );

  digitalWrite(
      PWDN_GPIO_NUM,
      LOW
  );

  delay(150);

  camera_config_t config = {};

  config.ledc_channel =
      LEDC_CHANNEL_0;

  config.ledc_timer =
      LEDC_TIMER_0;

  config.pin_d0 =
      Y2_GPIO_NUM;

  config.pin_d1 =
      Y3_GPIO_NUM;

  config.pin_d2 =
      Y4_GPIO_NUM;

  config.pin_d3 =
      Y5_GPIO_NUM;

  config.pin_d4 =
      Y6_GPIO_NUM;

  config.pin_d5 =
      Y7_GPIO_NUM;

  config.pin_d6 =
      Y8_GPIO_NUM;

  config.pin_d7 =
      Y9_GPIO_NUM;

  config.pin_xclk =
      XCLK_GPIO_NUM;

  config.pin_pclk =
      PCLK_GPIO_NUM;

  config.pin_vsync =
      VSYNC_GPIO_NUM;

  config.pin_href =
      HREF_GPIO_NUM;

  config.pin_sccb_sda =
      SIOD_GPIO_NUM;

  config.pin_sccb_scl =
      SIOC_GPIO_NUM;

  config.pin_pwdn =
      PWDN_GPIO_NUM;

  config.pin_reset =
      RESET_GPIO_NUM;

  config.xclk_freq_hz =
      20000000;

  config.pixel_format =
      PIXFORMAT_JPEG;

  config.frame_size =
      CAMERA_RESOLUTION;

  // =========================================================
  // PSRAM CONFIGURATION
  // =========================================================

  if (psramFound())
  {
    Serial.println(
        "PSRAM detected"
    );

    config.jpeg_quality =
        CAMERA_JPEG_QUALITY;

    config.fb_count =
        2;

    config.fb_location =
        CAMERA_FB_IN_PSRAM;

    config.grab_mode =
        CAMERA_GRAB_LATEST;
  }
  else
  {
    Serial.println(
        "PSRAM NOT detected"
    );

    config.jpeg_quality =
        15;

    config.fb_count =
        1;

    config.fb_location =
        CAMERA_FB_IN_DRAM;

    config.grab_mode =
        CAMERA_GRAB_WHEN_EMPTY;
  }

  // =========================================================
  // CAMERA INIT
  // =========================================================

  esp_err_t error =
      esp_camera_init(
          &config
      );

  if (
      error !=
      ESP_OK)
  {
    Serial.printf(
        "Camera init failed: 0x%X\n",
        error
    );

    /*
       Return camera to power-down if initialization fails.
    */

    digitalWrite(
        PWDN_GPIO_NUM,
        HIGH
    );

    WiFi.setSleep(true);

    cameraInitialized =
        false;

    cameraEnabled =
        false;

    return false;
  }

  // =========================================================
  // SENSOR SETTINGS
  // =========================================================

  sensor_t *sensor =
      esp_camera_sensor_get();

  if (sensor != nullptr)
  {
    sensor->set_framesize(
        sensor,
        CAMERA_RESOLUTION
    );

    sensor->set_contrast(
        sensor,
        1
    );

    sensor->set_brightness(
        sensor,
        1
    );

    sensor->set_saturation(
        sensor,
        0
    );

    sensor->set_whitebal(
        sensor,
        1
    );

    sensor->set_exposure_ctrl(
        sensor,
        1
    );

    sensor->set_aec2(
        sensor,
        1
    );

    // Physical camera orientation
    sensor->set_vflip(
        sensor,
        1
    );

    sensor->set_hmirror(
        sensor,
        0
    );
  }

  cameraInitialized =
      true;

  Serial.println(
      "OV2640 initialized"
  );

  return true;
}

// ============================================================
// CAMERA POWER DOWN
// ============================================================

void sleepCamera()
{
  Serial.println(
      "Putting OV2640 into low-power standby..."
  );

  cameraEnabled =
      false;

  if (cameraInitialized)
  {
    /*
       Release camera driver,
       XCLK, DMA and frame buffers.
    */

    esp_camera_deinit();

    cameraInitialized =
        false;

    delay(30);
  }

  /*
     AI Thinker camera power-down.
  */

  pinMode(
      PWDN_GPIO_NUM,
      OUTPUT
  );

  digitalWrite(
      PWDN_GPIO_NUM,
      HIGH
  );

  /*
     WiFi is NOT switched off.

     Modem sleep saves power while still allowing
     /start to be received.
  */

  WiFi.setSleep(true);

  Serial.println(
      "Camera state: SLEEP"
  );
}

// ============================================================
// ROOT HANDLER
// ============================================================

esp_err_t rootHandler(
    httpd_req_t *req)
{
  return sendText(
      req,

      "LabSync ESP32-CAM\n"
      "\n"
      "mDNS: esp32cam.local\n"
      "\n"
      "GET /start\n"
      "GET /capture\n"
      "GET /stop\n"
      "GET /status\n"
  );
}

// ============================================================
// START HANDLER
// ============================================================

esp_err_t startHandler(
    httpd_req_t *req)
{
  Serial.println();
  Serial.println(
      "Received /start"
  );

  if (
      !cameraInitialized)
  {
    if (!initializeCamera())
    {
      httpd_resp_set_status(
          req,
          "500 Internal Server Error"
      );

      return sendText(
          req,
          "CAMERA_INIT_FAILED"
      );
    }
  }

  cameraEnabled =
      true;

  /*
     Throw away first frame.

     The first frame immediately after power-up may
     have incorrect exposure/white balance.
  */

  camera_fb_t *oldFrame =
      esp_camera_fb_get();

  if (oldFrame != nullptr)
  {
    esp_camera_fb_return(
        oldFrame
    );
  }

  Serial.println(
      "Camera ACTIVE"
  );

  return sendText(
      req,
      "CAMERA_ON"
  );
}

// ============================================================
// STOP HANDLER
// ============================================================

esp_err_t stopHandler(
    httpd_req_t *req)
{
  Serial.println();
  Serial.println(
      "Received /stop"
  );

  /*
     Tell requester first that operation is accepted.
     Camera is then returned to low-power state.
  */

  esp_err_t result =
      sendText(
          req,
          "CAMERA_SLEEP"
      );

  /*
     Small delay allows HTTP response to leave before
     camera deinitialization and WiFi modem sleep.
  */

  delay(20);

  sleepCamera();

  return result;
}

// ============================================================
// STATUS
// ============================================================

esp_err_t statusHandler(
    httpd_req_t *req)
{
  if (
      cameraEnabled &&
      cameraInitialized)
  {
    return sendText(
        req,
        "ACTIVE"
    );
  }

  return sendText(
      req,
      "SLEEP"
  );
}

// ============================================================
// CAPTURE
// ============================================================

esp_err_t captureHandler(
    httpd_req_t *req)
{
  /*
     IMPORTANT:

     /capture will NOT wake the camera automatically.

     Main ESP32 must first send /start.
  */

  if (
      !cameraEnabled ||
      !cameraInitialized)
  {
    Serial.println(
        "Capture rejected: camera sleeping"
    );

    httpd_resp_set_status(
        req,
        "503 Service Unavailable"
    );

    return sendText(
        req,
        "CAMERA_SLEEPING"
    );
  }

  camera_fb_t *frame =
      esp_camera_fb_get();

  if (frame == nullptr)
  {
    Serial.println(
        "Camera capture failed"
    );

    httpd_resp_send_500(
        req
    );

    return ESP_FAIL;
  }

  Serial.printf(
      "JPEG captured: %u bytes\n",
      (unsigned int)frame->len
  );

  httpd_resp_set_type(
      req,
      "image/jpeg"
  );

  httpd_resp_set_hdr(
      req,
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
  );

  httpd_resp_set_hdr(
      req,
      "Pragma",
      "no-cache"
  );

  httpd_resp_set_hdr(
      req,
      "Access-Control-Allow-Origin",
      "*"
  );

  esp_err_t result =
      httpd_resp_send(
          req,
          reinterpret_cast<const char *>(
              frame->buf
          ),
          frame->len
      );

  esp_camera_fb_return(
      frame
  );

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

  httpd_config_t config =
      HTTPD_DEFAULT_CONFIG();

  config.server_port =
      80;

  config.max_uri_handlers =
      8;

  config.lru_purge_enable =
      true;

  if (
      httpd_start(
          &cameraServer,
          &config
      ) != ESP_OK)
  {
    Serial.println(
        "HTTP server failed"
    );

    cameraServer =
        nullptr;

    return false;
  }

  // =========================================================
  // ROOT
  // =========================================================

  rootUri.uri = "/";
  rootUri.method = HTTP_GET;
  rootUri.handler = rootHandler;
  rootUri.user_ctx = nullptr;

  // =========================================================
  // START
  // =========================================================

  startUri.uri = "/start";
  startUri.method = HTTP_GET;
  startUri.handler = startHandler;
  startUri.user_ctx = nullptr;

  // =========================================================
  // STOP
  // =========================================================

  stopUri.uri = "/stop";
  stopUri.method = HTTP_GET;
  stopUri.handler = stopHandler;
  stopUri.user_ctx = nullptr;

  // =========================================================
  // STATUS
  // =========================================================

  statusUri.uri = "/status";
  statusUri.method = HTTP_GET;
  statusUri.handler = statusHandler;
  statusUri.user_ctx = nullptr;

  // =========================================================
  // CAPTURE
  // =========================================================

  captureUri.uri = "/capture";
  captureUri.method = HTTP_GET;
  captureUri.handler = captureHandler;
  captureUri.user_ctx = nullptr;

  // =========================================================
  // REGISTER
  // =========================================================

  httpd_register_uri_handler(
      cameraServer,
      &rootUri
  );

  httpd_register_uri_handler(
      cameraServer,
      &startUri
  );

  httpd_register_uri_handler(
      cameraServer,
      &stopUri
  );

  httpd_register_uri_handler(
      cameraServer,
      &statusUri
  );

  httpd_register_uri_handler(
      cameraServer,
      &captureUri
  );

  Serial.println(
      "HTTP server started"
  );

  return true;
}

// ============================================================
// WIFI
// ============================================================

void connectWiFi()
{
  if (
      WiFi.status() ==
      WL_CONNECTED)
  {
    return;
  }

  WiFi.mode(
      WIFI_STA
  );

  /*
     During connection use normal/full WiFi.
  */

  WiFi.setSleep(false);

  WiFi.begin(
      WIFI_SSID,
      WIFI_PASSWORD
  );

  Serial.print(
      "Connecting WiFi"
  );

  int attempts =
      0;

  while (
      WiFi.status() !=
          WL_CONNECTED &&
      attempts < 60)
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

    Serial.print(
        "Current DHCP IP: "
    );

    Serial.println(
        WiFi.localIP()
    );

    /*
       Camera is normally asleep, so enable
       modem sleep once connected.
    */

    if (!cameraEnabled)
    {
      WiFi.setSleep(true);
    }
  }
  else
  {
    Serial.println(
        "WiFi connection failed"
    );
  }
}

// ============================================================
// MDNS
// ============================================================

bool startMDNS()
{
  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    return false;
  }

  if (mdnsRunning)
    return true;

  if (
      !MDNS.begin(
          MDNS_HOSTNAME
      ))
  {
    Serial.println(
        "mDNS failed"
    );

    mdnsRunning =
        false;

    return false;
  }

  MDNS.addService(
      "http",
      "tcp",
      80
  );

  mdnsRunning =
      true;

  Serial.println(
      "mDNS ready:"
  );

  Serial.println(
      "http://esp32cam.local"
  );

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

  delay(500);

  Serial.println();
  Serial.println(
      "==================================="
  );
  Serial.println(
      "LabSync ESP32-CAM LOW POWER"
  );
  Serial.println(
      "==================================="
  );

  // =========================================================
  // CAMERA STARTS POWERED DOWN
  // =========================================================

  pinMode(
      PWDN_GPIO_NUM,
      OUTPUT
  );

  digitalWrite(
      PWDN_GPIO_NUM,
      HIGH
  );

  cameraEnabled =
      false;

  cameraInitialized =
      false;

  /*
     IMPORTANT:

     We intentionally DO NOT call esp_camera_init()
     during setup.

     The camera remains off until /start.
  */

  // =========================================================
  // WIFI
  // =========================================================

  connectWiFi();

  // =========================================================
  // MDNS
  // =========================================================

  if (
      WiFi.status() ==
      WL_CONNECTED)
  {
    startMDNS();
  }

  // =========================================================
  // HTTP SERVER
  // =========================================================

  if (!startHttpServer())
  {
    Serial.println(
        "FATAL: HTTP server failed"
    );

    while (true)
    {
      delay(1000);
    }
  }

  /*
     Ensure low-power state after setup.
  */

  WiFi.setSleep(true);

  Serial.println();
  Serial.println(
      "ESP32-CAM READY"
  );

  Serial.println(
      "Camera sensor: SLEEP"
  );

  Serial.println(
      "WiFi: ACTIVE with modem sleep"
  );

  Serial.println(
      "HTTP server: ACTIVE"
  );

  Serial.println(
      "mDNS: esp32cam.local"
  );
}

// ============================================================
// LOOP
// ============================================================

void loop()
{
  // =========================================================
  // WIFI RECONNECT
  // =========================================================

  if (
      WiFi.status() !=
      WL_CONNECTED)
  {
    Serial.println(
        "WiFi disconnected"
    );

    mdnsRunning =
        false;

    connectWiFi();

    if (
        WiFi.status() ==
        WL_CONNECTED)
    {
      /*
         DHCP address may have changed.
         Restart mDNS advertisement.
      */

      MDNS.end();

      mdnsRunning =
          false;

      startMDNS();

      Serial.println(
          "Reconnected IP: " +
          WiFi.localIP().toString()
      );
    }
  }

  /*
     Nothing continuously captures here.

     The camera hardware remains powered down until
     HTTP /start is received.
  */

  delay(500);
}