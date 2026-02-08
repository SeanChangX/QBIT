// ==========================================================================
//  QBIT -- Firmware main
// ==========================================================================

// --- Standard / third-party libraries ---
#include <Arduino.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <NetWizard.h>
#include <ElegantOTA.h>
#include <ESPmDNS.h>
#include <NonBlockingRtttl.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <PubSubClient.h>

// --- Project-local headers ---
#include "gif_types.h"
#include "sys_scx.h"
#include "gif_player.h"
#include "web_dashboard.h"

// ==========================================================================
//  Hardware pin definitions
// ==========================================================================

#define PIN_TOUCH   1  // TTP223 touch sensor (momentary HIGH on touch)
#define PIN_BUZZER  2  // Passive buzzer

// ==========================================================================
//  Display
// ==========================================================================
// Hardware I2C for fast buffer transfer; U8G2_R0 as base orientation.
// 180-degree rotation is applied in software (rotateBuffer180) to avoid
// column-offset artifacts that some SSD1306 clones exhibit with U8G2_R2.
//   SDA = GPIO20, SCL = GPIO21

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(
    U8G2_R0, /* reset= */ U8X8_PIN_NONE,
    /* clock= */ 21, /* data= */ 20);

// ==========================================================================
//  Boot animation / melody
// ==========================================================================

// Playback speed divisor for the built-in boot animation.
#define BOOT_GIF_SPEED 10

// RTTTL melody played simultaneously with the boot animation.
// Adjust b= for tempo (higher = faster).
// Reference: https://en.wikipedia.org/wiki/Ring_Tone_Transfer_Language
static const char BOOT_MELODY[] =
    "tronboot:d=16,o=5,b=160:"
    "c,16p,g,16p,c6,16p,b,8a";

// ==========================================================================
//  Backend WebSocket connection
// ==========================================================================
// The QBIT connects to the backend server via WebSocket (wss://).
// The backend handles MQTT bridging internally.  This avoids requiring
// the ESP-IDF MQTT WebSocket sdkconfig and works reliably through
// Cloudflare Tunnel (which only supports HTTP/HTTPS/WebSocket).

// These defaults are overridden by GitHub Actions at build time
// via secrets QBIT_WS_HOST and QBIT_WS_API_KEY.
// For local development, change them here or use build flags.
#ifndef WS_HOST
#define WS_HOST         "localhost"
#endif
#ifndef WS_PORT
#define WS_PORT         3001
#endif
#define WS_PATH         "/device"
#ifndef WS_API_KEY
#define WS_API_KEY      ""
#endif
#define WS_RECONNECT_MS 5000

static WebSocketsClient _wsClient;
static bool             _wsConnected = false;

// ==========================================================================
//  Device identity
// ==========================================================================

static String _deviceId;
static String _deviceName;

String getDeviceId() {
    if (_deviceId.length() == 0) {
        uint64_t mac = ESP.getEfuseMac();
        char id[13];
        snprintf(id, sizeof(id), "%04X%08X",
                 (uint16_t)(mac >> 32), (uint32_t)mac);
        _deviceId = String(id);
    }
    return _deviceId;
}

String getDeviceName() {
    return _deviceName;
}

// Forward declaration -- defined after WebSocket helpers.
static void wsSendDeviceInfo();

void setDeviceName(const String &name) {
    _deviceName = name;
    wsSendDeviceInfo();  // notify backend of name change
}

// ==========================================================================
//  Local MQTT client (user-configurable via web dashboard)
// ==========================================================================
// Connects to a local MQTT broker (e.g. Home Assistant / Mosquitto)
// for home automation integration.  Configuration is stored in NVS
// and editable from the QBIT web dashboard.

static WiFiClient  _mqttWifi;
static PubSubClient _mqttClient(_mqttWifi);

static String  _mqttHost;
static uint16_t _mqttPort   = 1883;
static String  _mqttUser;
static String  _mqttPass;
static String  _mqttPrefix;       // topic prefix, e.g. "qbit"
static bool    _mqttEnabled = false;

static unsigned long _mqttLastReconnect = 0;
#define MQTT_RECONNECT_MS 5000

String getMqttHost()   { return _mqttHost; }
uint16_t getMqttPort() { return _mqttPort; }
String getMqttUser()   { return _mqttUser; }
String getMqttPass()   { return _mqttPass; }
String getMqttPrefix() { return _mqttPrefix; }
bool   getMqttEnabled(){ return _mqttEnabled; }

// Forward declaration
static void mqttReconnect();

void setMqttConfig(const String &host, uint16_t port,
                   const String &user, const String &pass,
                   const String &prefix, bool enabled) {
    _mqttHost    = host;
    _mqttPort    = port;
    _mqttUser    = user;
    _mqttPass    = pass;
    _mqttPrefix  = prefix;
    _mqttEnabled = enabled;

    // Disconnect from current broker so next loop() picks up new config
    if (_mqttClient.connected()) {
        _mqttClient.disconnect();
    }
    _mqttLastReconnect = 0;  // trigger immediate reconnect attempt
}

// Forward declaration for poke handler (defined further below)
static void handlePoke(const char *sender, const char *text);

// MQTT message callback (subscribed topics arrive here)
static void mqttCallback(char *topic, byte *payload, unsigned int length) {
    // Parse JSON payload for poke-like commands from home automation
    JsonDocument doc;
    if (deserializeJson(doc, payload, length)) return;

    const char *cmd = doc["command"];
    if (!cmd) return;

    if (strcmp(cmd, "poke") == 0) {
        const char *sender = doc["sender"] | "MQTT";
        const char *text   = doc["text"]   | "Poke!";
        handlePoke(sender, text);
        Serial.printf("[MQTT] Poke from %s: %s\n", sender, text);
    }
}

static void mqttReconnect() {
    if (!_mqttEnabled || _mqttHost.length() == 0) return;
    if (_mqttClient.connected()) return;

    unsigned long now = millis();
    if (now - _mqttLastReconnect < MQTT_RECONNECT_MS) return;
    _mqttLastReconnect = now;

    _mqttClient.setServer(_mqttHost.c_str(), _mqttPort);
    _mqttClient.setCallback(mqttCallback);

    String clientId = "qbit-" + getDeviceId();
    bool ok;
    if (_mqttUser.length() > 0) {
        ok = _mqttClient.connect(clientId.c_str(),
                                 _mqttUser.c_str(), _mqttPass.c_str(),
                                 (_mqttPrefix + "/" + getDeviceId() + "/status").c_str(),
                                 0, true, "offline");
    } else {
        ok = _mqttClient.connect(clientId.c_str(),
                                 (_mqttPrefix + "/" + getDeviceId() + "/status").c_str(),
                                 0, true, "offline");
    }

    if (ok) {
        Serial.printf("[MQTT] Connected to %s:%u\n", _mqttHost.c_str(), _mqttPort);

        // Publish online status
        String statusTopic = _mqttPrefix + "/" + getDeviceId() + "/status";
        _mqttClient.publish(statusTopic.c_str(), "online", true);

        // Publish device info
        String infoTopic = _mqttPrefix + "/" + getDeviceId() + "/info";
        JsonDocument info;
        info["id"]   = getDeviceId();
        info["name"] = _deviceName;
        info["ip"]   = WiFi.localIP().toString();
        String infoStr;
        serializeJson(info, infoStr);
        _mqttClient.publish(infoTopic.c_str(), infoStr.c_str(), true);

        // Subscribe to command topic
        String cmdTopic = _mqttPrefix + "/" + getDeviceId() + "/command";
        _mqttClient.subscribe(cmdTopic.c_str());
    } else {
        Serial.printf("[MQTT] Connection failed (rc=%d), retrying...\n",
                      _mqttClient.state());
    }
}

// ==========================================================================
//  Persistent settings (NVS via Preferences)
// ==========================================================================

static Preferences _prefs;
static bool        _prefsReady = false;

// ==========================================================================
//  Playback speed wrapper (applies immediately, NVS only via saveSettings)
// ==========================================================================

void setPlaybackSpeed(uint16_t val) {
    gifPlayerSetSpeed(val);
}

uint16_t getPlaybackSpeed() {
    return gifPlayerGetSpeed();
}

// ==========================================================================
//  Buzzer volume (0 = mute, >0 = on)
// ==========================================================================
// True analogue volume control is not feasible with a passive buzzer
// driven by the ESP32 LEDC peripheral: overriding the PWM duty cycle
// after tone() disrupts the LEDC channel state on Core v3.x.
// Instead, volume is treated as a mute flag (0 = silent, 1-100 = on).

static uint8_t _buzzerVolume = 100;

void setBuzzerVolume(uint8_t pct) {
    _buzzerVolume = pct > 100 ? 100 : pct;
    // If muted while a melody is playing, silence immediately
    if (_buzzerVolume == 0) {
        rtttl::stop();
        noTone(PIN_BUZZER);
    }
}

uint8_t getBuzzerVolume() {
    return _buzzerVolume;
}

// Forward declaration (defined further down, after display helpers).
uint8_t getDisplayBrightness();

// Write all current settings to NVS.  Called only when the user
// explicitly presses "Save" on the web dashboard.
void saveSettings() {
    if (!_prefsReady) return;
    _prefs.putUShort("speed",   gifPlayerGetSpeed());
    _prefs.putUChar("bright",   getDisplayBrightness());
    _prefs.putUChar("volume",   getBuzzerVolume());
    _prefs.putString("devname", _deviceName);
    // MQTT settings
    _prefs.putString("mqttHost", _mqttHost);
    _prefs.putUShort("mqttPort", _mqttPort);
    _prefs.putString("mqttUser", _mqttUser);
    _prefs.putString("mqttPass", _mqttPass);
    _prefs.putString("mqttPfx",  _mqttPrefix);
    _prefs.putBool("mqttOn",     _mqttEnabled);
    Serial.println("Settings saved to NVS");
}

// ==========================================================================
//  Touch sensor (debounced, cycles to next GIF)
// ==========================================================================

// Classic Mario coin sound -- played on each GIF switch.
static const char TOUCH_MELODY[] =
    "coin:d=16,o=5,b=600:b5,e6";

static unsigned long _lastTouchMs = 0;
#define TOUCH_DEBOUNCE_MS 300

void handleTouch() {
    if (digitalRead(PIN_TOUCH) == HIGH) {
        unsigned long now = millis();
        if (now - _lastTouchMs > TOUCH_DEBOUNCE_MS) {
            _lastTouchMs = now;
            String next = gifPlayerNextShuffle();
            if (next.length() > 0) {
                gifPlayerSetFile(next);
                if (_buzzerVolume > 0) {
                    noTone(PIN_BUZZER);  // detach LEDC before re-attach
                    rtttl::begin(PIN_BUZZER, TOUCH_MELODY);
                }
                Serial.println("Touch -> switch to: " + next);
            }
        }
    }
}

// ==========================================================================
//  Web server (shared by NetWizard, ElegantOTA, and web dashboard)
// ==========================================================================

AsyncWebServer server(80);
NetWizard      NW(&server);

// ==========================================================================
//  Display helper: clear full GDDRAM via raw I2C
// ==========================================================================
// Many cheap "SSD1306" modules actually carry an SH1106-compatible controller
// whose GDDRAM is 132 columns wide.  U8g2's SSD1306 driver only writes
// columns 0-127, so columns 128-131 can retain power-on garbage.  Writing
// 132 zero-bytes per page in page-addressing mode clears everything; on a
// genuine 128-column SSD1306 the extra writes are silently ignored.

void clearFullGDDRAM() {
    const uint8_t ADDR       = 0x3C;
    const uint8_t TOTAL_COLS = 132;
    const uint8_t CHUNK      = 16;

    // Enter page-addressing mode
    Wire.beginTransmission(ADDR);
    Wire.write(0x00);  // command stream
    Wire.write(0x20);  // Set Memory Addressing Mode
    Wire.write(0x02);  // page mode
    Wire.endTransmission();

    // Zero every page (8 pages x 132 columns)
    for (uint8_t page = 0; page < 8; page++) {
        Wire.beginTransmission(ADDR);
        Wire.write(0x00);          // command stream
        Wire.write(0xB0 | page);   // page address
        Wire.write(0x00);          // column lower nibble  = 0
        Wire.write(0x10);          // column upper nibble  = 0
        Wire.endTransmission();

        for (uint8_t off = 0; off < TOTAL_COLS; off += CHUNK) {
            uint8_t len = TOTAL_COLS - off;
            if (len > CHUNK) len = CHUNK;
            Wire.beginTransmission(ADDR);
            Wire.write(0x40);  // data stream
            for (uint8_t i = 0; i < len; i++) Wire.write((uint8_t)0x00);
            Wire.endTransmission();
        }
    }

    // Restore horizontal-addressing mode for U8g2 sendBuffer()
    Wire.beginTransmission(ADDR);
    Wire.write(0x00);   // command stream
    Wire.write(0x20);   Wire.write(0x00);                     // horizontal mode
    Wire.write(0x21);   Wire.write(0x00);  Wire.write(0x7F);  // col  0-127
    Wire.write(0x22);   Wire.write(0x00);  Wire.write(0x07);  // page 0-7
    Wire.endTransmission();
}

// ==========================================================================
//  Display helper: set SSD1306 contrast (brightness 0-255)
// ==========================================================================

static uint8_t _brightness = 0xCF;  // SSD1306 default contrast

void setDisplayBrightness(uint8_t val) {
    _brightness = val;
    Wire.beginTransmission(0x3C);
    Wire.write(0x00);   // command stream
    Wire.write(0x81);   // Set Contrast Control
    Wire.write(val);
    Wire.endTransmission();
}

uint8_t getDisplayBrightness() {
    return _brightness;
}

// ==========================================================================
//  Display helper: hardware inversion toggle
// ==========================================================================

void setDisplayInvert(bool invert) {
    Wire.beginTransmission(0x3C);
    Wire.write(0x00);
    Wire.write(invert ? 0xA7 : 0xA6);
    Wire.endTransmission();
}

// ==========================================================================
//  Display helper: rotate U8G2 frame buffer 180 degrees in-place
// ==========================================================================
// The SSD1306 page buffer is 1024 bytes (8 pages x 128 columns).
// A 180-degree rotation == reversing the byte array + reversing bits in
// each byte.

void rotateBuffer180() {
    uint8_t *buf = u8g2.getBufferPtr();
    const uint16_t len = 1024;  // 128 x 64 / 8

    // Reverse byte order
    for (uint16_t i = 0; i < len / 2; i++) {
        uint8_t tmp       = buf[i];
        buf[i]            = buf[len - 1 - i];
        buf[len - 1 - i]  = tmp;
    }

    // Reverse bits within each byte
    for (uint16_t i = 0; i < len; i++) {
        uint8_t b = buf[i];
        b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
        b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
        b = ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
        buf[i] = b;
    }
}

// ==========================================================================
//  Display helper: show up to 4 lines of text (rotated 180 deg)
// ==========================================================================
// Text starts at x=4 with 2px margin to avoid edge clipping.

void showText(const char *l1, const char *l2 = nullptr,
              const char *l3 = nullptr, const char *l4 = nullptr) {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);
    if (l1) u8g2.drawStr(4, 13, l1);
    if (l2) u8g2.drawStr(4, 28, l2);
    if (l3) u8g2.drawStr(4, 43, l3);
    if (l4) u8g2.drawStr(4, 58, l4);
    rotateBuffer180();
    u8g2.sendBuffer();
}

// ==========================================================================
//  Boot animation playback (animation + melody simultaneously)
// ==========================================================================
// Uses NonBlockingRTTTL to parse and play the RTTTL string while rendering
// animation frames.  rtttl::play() is called each iteration to advance
// notes without blocking.

void playBootAnimation() {
    uint8_t frameBuf[QGIF_FRAME_SIZE];

    if (_buzzerVolume > 0) {
        rtttl::begin(PIN_BUZZER, BOOT_MELODY);
    }

    for (uint8_t f = 0; f < sys_scx_gif.frame_count; f++) {
        if (_buzzerVolume > 0 && rtttl::isPlaying()) {
            rtttl::play();
        }

        memcpy_P(frameBuf, sys_scx_gif.frames[f], QGIF_FRAME_SIZE);
        gifRenderFrame(&u8g2, frameBuf, sys_scx_gif.width, sys_scx_gif.height);

        uint16_t d = sys_scx_gif.delays[f] / BOOT_GIF_SPEED;
        delay(d > 0 ? d : 1);
    }

    rtttl::stop();
    noTone(PIN_BUZZER);
}

// ==========================================================================
//  Load persisted settings from NVS
// ==========================================================================

void loadSettings() {
    _prefs.begin("qbit", false);   // namespace "qbit", read-write
    _prefsReady = true;

    // Read stored values (with sensible defaults for first boot)
    uint8_t  bright = _prefs.getUChar("bright", 0x80);
    uint8_t  vol    = _prefs.getUChar("volume", 90);
    uint16_t speed  = _prefs.getUShort("speed", 4);

    // Device name (default: QBIT- + last 4 hex chars of MAC)
    String defaultName = "QBIT-" + getDeviceId().substring(8);
    _deviceName = _prefs.getString("devname", defaultName);

    // MQTT settings
    _mqttHost    = _prefs.getString("mqttHost", "");
    _mqttPort    = _prefs.getUShort("mqttPort", 1883);
    _mqttUser    = _prefs.getString("mqttUser", "");
    _mqttPass    = _prefs.getString("mqttPass", "");
    _mqttPrefix  = _prefs.getString("mqttPfx",  "qbit");
    _mqttEnabled = _prefs.getBool("mqttOn", false);

    // Apply to hardware + RAM state (setters will no-op re-save the
    // same value on first boot -- harmless and keeps code simple)
    _brightness   = bright;
    _buzzerVolume = vol;
    gifPlayerSetSpeed(speed);

    Serial.printf("Settings loaded: bright=%u vol=%u speed=%u\n",
                  bright, vol, speed);
    Serial.printf("Device ID: %s  Name: %s\n",
                  getDeviceId().c_str(), _deviceName.c_str());
    if (_mqttEnabled && _mqttHost.length() > 0) {
        Serial.printf("MQTT: %s:%u (prefix: %s)\n",
                      _mqttHost.c_str(), _mqttPort, _mqttPrefix.c_str());
    }
}

// ==========================================================================
//  Poke handling
// ==========================================================================
// When a poke arrives via WebSocket, the OLED shows the sender + text for
// POKE_DISPLAY_MS milliseconds, then resumes normal GIF playback.

static bool          _pokeActive  = false;
static unsigned long _pokeStartMs = 0;
#define POKE_DISPLAY_MS 5000

// Ascending chime -- distinct from boot and touch melodies.
static const char POKE_MELODY[] =
    "poke:d=16,o=5,b=200:c6,e6,g6,c7";

static void handlePoke(const char *sender, const char *text) {
    _pokeActive  = true;
    _pokeStartMs = millis();

    // Show poke message on OLED
    showText(">> Poke! <<", "", sender, text);

    // Play notification sound
    if (_buzzerVolume > 0) {
        noTone(PIN_BUZZER);
        rtttl::begin(PIN_BUZZER, POKE_MELODY);
    }

    Serial.printf("Poke from %s: %s\n", sender, text);
}

// ==========================================================================
//  WebSocket helpers
// ==========================================================================

// Send (or re-send) device info to the backend.
// Called on connect and whenever the device name changes.
static void wsSendDeviceInfo() {
    if (!_wsConnected) return;

    JsonDocument doc;
    doc["type"]    = "hello";
    doc["id"]      = getDeviceId();
    doc["name"]    = _deviceName;
    doc["ip"]      = WiFi.localIP().toString();
    doc["version"] = "1.0.0";

    String msg;
    serializeJson(doc, msg);
    _wsClient.sendTXT(msg);
}

// WebSocket event handler (called by the WebSockets library).
static void wsEvent(WStype_t type, uint8_t *payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            _wsConnected = false;
            Serial.println("[WS] Disconnected from backend");
            break;

        case WStype_CONNECTED:
            _wsConnected = true;
            Serial.println("[WS] Connected to backend");
            wsSendDeviceInfo();
            break;

        case WStype_TEXT:
        {
            JsonDocument doc;
            if (deserializeJson(doc, payload, length)) break;

            const char *msgType = doc["type"];
            if (!msgType) break;

            if (strcmp(msgType, "poke") == 0) {
                const char *sender = doc["sender"] | "Someone";
                const char *text   = doc["text"]   | "Poke!";
                handlePoke(sender, text);
            }
            break;
        }

        default:
            break;
    }
}

// ==========================================================================
//  Arduino setup()
// ==========================================================================

void setup() {
    Serial.begin(115200);
    Serial.setDebugOutput(false);  // Suppress WiFi credentials in ESP-IDF logs

    // -- GPIO --
    pinMode(PIN_TOUCH, INPUT);
    pinMode(PIN_BUZZER, OUTPUT);

    // -- Display --
    u8g2.setBusClock(400000);
    u8g2.begin();
    clearFullGDDRAM();
    setDisplayInvert(false);

    // -- Load saved settings (brightness, volume, speed, device name) --
    loadSettings();
    setDisplayBrightness(_brightness);  // apply contrast to hardware

    // -- Boot animation + melody --
    playBootAnimation();

    // -- LittleFS / GIF player --
    gifPlayerInit(&u8g2);

    // -- WiFi via NetWizard (NON_BLOCKING) --
    // On first boot (or if saved network is unavailable), NetWizard opens
    // a captive portal AP named "QBIT".  After 10 seconds of waiting,
    // GIF animation begins while the AP stays open.
    showText("[ Wi-Fi Setup ]",
             "",
             "Connect to 'QBIT'",
             "AP to set Wi-Fi.");

    volatile bool wifiConnected = false;
    NW.onConnectionStatus([&wifiConnected](NetWizardConnectionStatus status) {
        if (status == NetWizardConnectionStatus::CONNECTED) {
            wifiConnected = true;
        }
    });

    NW.setStrategy(NetWizardStrategy::NON_BLOCKING);
    NW.autoConnect("QBIT", "");

    unsigned long wifiStartMs = millis();
    bool animStarted = false;

    while (!wifiConnected) {
        NW.loop();

        // After 10 seconds, start GIF animation while AP stays open
        if (!animStarted && (millis() - wifiStartMs > 10000)) {
            animStarted = true;
            if (gifPlayerHasFiles()) {
                gifPlayerBuildShuffleBag();
                gifPlayerSetAutoAdvance(1);
                gifPlayerSetFile(gifPlayerNextShuffle());
            }
        }

        if (animStarted) {
            gifPlayerTick();
            handleTouch();
        }

        yield();
    }

    // -- mDNS: http://qbit.local --
    if (MDNS.begin("qbit")) {
        MDNS.addService("http", "tcp", 80);
        Serial.println("mDNS: http://qbit.local");
    }

    // -- Show connection info --
    String ip = WiFi.localIP().toString();
    showText("[ Wi-Fi Connected ]",
             ip.c_str(),
             "http://qbit.local",
             "OTA: /update");
    delay(3000);

    // -- Start web services --
    ElegantOTA.begin(&server);
    webDashboardInit(server);
    server.begin();

    Serial.println("Web server started: http://qbit.local (" + ip + ")");

    // -- Connect to backend via WebSocket --
    // API key is sent as a query parameter for device authentication.
    String wsPath = String(WS_PATH) + "?key=" + WS_API_KEY;
#if WS_PORT == 443
    _wsClient.beginSSL(WS_HOST, WS_PORT, wsPath.c_str());
#else
    _wsClient.begin(WS_HOST, WS_PORT, wsPath.c_str());
#endif
    _wsClient.onEvent(wsEvent);
    _wsClient.setReconnectInterval(WS_RECONNECT_MS);

    // -- Local MQTT (if configured) --
    if (_mqttEnabled && _mqttHost.length() > 0) {
        mqttReconnect();
    }

    // -- Auto-play: shuffle bag + auto-advance every loop --
    // If animation was already started during WiFi wait, skip re-init.
    if (!animStarted && gifPlayerHasFiles()) {
        gifPlayerBuildShuffleBag();
        gifPlayerSetAutoAdvance(1);
        gifPlayerSetFile(gifPlayerNextShuffle());
    }
}

// ==========================================================================
//  Arduino loop()
// ==========================================================================

// Tracks whether the idle info screen has been shown (avoids redrawing).
static bool infoScreenShown = false;

void loop() {
    ElegantOTA.loop();
    NW.loop();
    _wsClient.loop();

    // Local MQTT maintenance
    if (_mqttEnabled) {
        if (!_mqttClient.connected()) {
            mqttReconnect();
        }
        _mqttClient.loop();
    }

    // Advance any non-blocking melody in progress (touch coin sound, etc.)
    // When the melody ends, call noTone() to detach the LEDC channel so the
    // next tone() / rtttl::begin() can re-attach cleanly (ESP32 Core v3.x).
    static bool _melodyWasPlaying = false;
    if (rtttl::isPlaying()) {
        rtttl::play();
        _melodyWasPlaying = true;
    } else if (_melodyWasPlaying) {
        noTone(PIN_BUZZER);
        _melodyWasPlaying = false;
    }

    // Poke timeout -- return to normal playback after POKE_DISPLAY_MS.
    if (_pokeActive && (millis() - _pokeStartMs > POKE_DISPLAY_MS)) {
        _pokeActive = false;
        infoScreenShown = false;  // force redraw on next iteration
    }

    // While poke message is on screen, skip touch and GIF rendering.
    if (_pokeActive) return;

    // Touch sensor -- cycle to next GIF
    handleTouch();

    // Always tick the player -- it handles pending file-change requests
    // (from Play button or auto-play after upload) even when idle.
    gifPlayerTick();

    if (gifPlayerGetCurrentFile().length() > 0) {
        infoScreenShown = false;
    } else if (!infoScreenShown) {
        // No GIF playing -- show upload instructions once
        showText("Upload GIF at:",
                 "http://qbit.local",
                 "",
                 "OTA: /update");
        infoScreenShown = true;
    }
}
