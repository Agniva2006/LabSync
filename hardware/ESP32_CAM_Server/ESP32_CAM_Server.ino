//   ESP32-CAM HTTP camera server
//   Board: AI Thinker ESP32-CAM
//   Camera: OV2640
//   Endpoints:
//     GET /start    - enable frame capture
//     GET /stop     - disable frame capture
//     GET /capture  - return one QVGA JPEG frame
//     GET /status   - return ON or OFF

//   The camera remains initialized. /stop prevents frames from being sent;
//   it does not electrically remove power from the camera.

#include "esp_camera.h"
#include "esp_http_server.h"
#include <Arduino.h>
#include <ESPmDNS.h>
#include <WiFi.h>

// -------------------- CHANGE THESE --------------------
const char *WIFI_SSID = "Galaxy";
const char *WIFI_PASSWORD = "password2006";
// CAMERA_RESOLUTION: FRAMESIZE_VGA (640x480) — optimal detail for face recognition
#define CAMERA_RESOLUTION FRAMESIZE_VGA
#define CAMERA_JPEG_QUALITY 10   // High quality 25-50KB frames
// ------------------------------------------------------

// AI-Thinker ESP32-CAM pin map
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

volatile bool cameraEnabled = false;
httpd_handle_t cameraServer = nullptr;

httpd_uri_t rootUri = {};
httpd_uri_t startUri = {};
httpd_uri_t stopUri = {};
httpd_uri_t statusUri = {};
httpd_uri_t captureUri = {};

esp_err_t sendText(httpd_req_t *req, const char *text) {
  httpd_resp_set_type(req, "text/plain");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  return httpd_resp_sendstr(req, text);
}

esp_err_t rootHandler(httpd_req_t *req) {
  return sendText(req, "ESP32-CAM ready\n"
                       "GET /start\n"
                       "GET /stop\n"
                       "GET /status\n"
                       "GET /capture\n");
}

esp_err_t startHandler(httpd_req_t *req) {
  cameraEnabled = true;

  // Discard one potentially old frame.
  camera_fb_t *oldFrame = esp_camera_fb_get();
  if (oldFrame != nullptr) {
    esp_camera_fb_return(oldFrame);
  }

  Serial.println("Camera feed enabled");
  return sendText(req, "CAMERA_ON");
}

esp_err_t stopHandler(httpd_req_t *req) {
  cameraEnabled = false;
  Serial.println("Camera feed disabled");
  return sendText(req, "CAMERA_OFF");
}

esp_err_t statusHandler(httpd_req_t *req) {
  return sendText(req, cameraEnabled ? "ON" : "OFF");
}

esp_err_t captureHandler(httpd_req_t *req) {
  if (!cameraEnabled) {
    cameraEnabled = true;
    Serial.println("Auto-enabled camera for capture request");
  }

  camera_fb_t *frame = esp_camera_fb_get();
  if (frame == nullptr) {
    Serial.println("Camera capture failed");
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }

  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Cache-Control",
                     "no-store, no-cache, must-revalidate");
  httpd_resp_set_hdr(req, "Pragma", "no-cache");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  esp_err_t result = httpd_resp_send(
      req, reinterpret_cast<const char *>(frame->buf), frame->len);

  esp_camera_fb_return(frame);
  return result;
}

bool startHttpServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.max_uri_handlers = 8;
  config.lru_purge_enable = true;

  if (httpd_start(&cameraServer, &config) != ESP_OK) {
    Serial.println("Failed to start HTTP server");
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

  httpd_register_uri_handler(cameraServer, &rootUri);
  httpd_register_uri_handler(cameraServer, &startUri);
  httpd_register_uri_handler(cameraServer, &stopUri);
  httpd_register_uri_handler(cameraServer, &statusUri);
  httpd_register_uri_handler(cameraServer, &captureUri);

  return true;
}

bool initializeCamera() {
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
  config.frame_size = CAMERA_RESOLUTION; // VGA 640x480

  if (psramFound()) {
    config.jpeg_quality = CAMERA_JPEG_QUALITY;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    config.jpeg_quality = 15; // slightly lower quality without PSRAM
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }

  esp_err_t error = esp_camera_init(&config);
  if (error != ESP_OK) {
    Serial.printf("Camera initialization failed: 0x%X\n", error);
    return false;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor != nullptr) {
    sensor->set_framesize(sensor, CAMERA_RESOLUTION);
    sensor->set_contrast(sensor, 1);      // -2 to 2: slightly higher contrast
    sensor->set_brightness(sensor, 1);    // -2 to 2: slightly higher brightness for facial features
    sensor->set_saturation(sensor, 0);    // 0 = default
    sensor->set_whitebal(sensor, 1);      // 0 = disable, 1 = enable
    sensor->set_exposure_ctrl(sensor, 1); // 0 = disable, 1 = enable
    sensor->set_aec2(sensor, 1);          // 0 = disable, 1 = enable (automatic exposure DSP)

    // Hardware vflip / hmirror controls (if physically inverted)
    sensor->set_vflip(sensor, 1);
    sensor->set_hmirror(sensor, 0);
  }

  return true;
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }

  Serial.println();
  Serial.println("Wi-Fi connected");
  Serial.print("ESP32-CAM IP address: ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  delay(500);

  if (!initializeCamera()) {
    while (true) {
      delay(1000);
    }
  }

  connectWiFi();

  if (MDNS.begin("esp32cam")) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("mDNS name: esp32cam.local");
  } else {
    Serial.println("mDNS failed; use the printed IP address instead");
  }

  if (!startHttpServer()) {
    while (true) {
      delay(1000);
    }
  }

  Serial.println("Camera server ready");
  Serial.println("The TFT ESP32 can now use /start, /capture and /stop");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi disconnected; reconnecting");
    connectWiFi();
  }

  delay(1000);
}
