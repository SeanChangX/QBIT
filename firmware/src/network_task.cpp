// ==========================================================================
//  QBIT -- Network task
// ==========================================================================
#include "network_task.h"
#include "app_state.h"
#include "settings.h"
#include "time_manager.h"
#include "mqtt_ha.h"
#include "poke_handler.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <NetWizard.h>
#include <ESPmDNS.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <PubSubClient.h>

// ==========================================================================
//  Configuration
// ==========================================================================

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
#define WIFI_RECONNECT_TIMEOUT_MS 30000

// Bitmap poke: 1bpp row-major, size = (height_pages) * width, height_pages <= 8
#define POKE_BMP_MAX_WIDTH  512
#define POKE_BMP_MAX_PAGES 8

// Validate decoded bitmap size matches claimed width (no integer overflow / OOB).
static bool isValidBitmapSize(uint16_t width, size_t decodedLen) {
    if (width == 0 || width > POKE_BMP_MAX_WIDTH) return false;
    if (decodedLen == 0) return false;
    if (decodedLen % width != 0) return false;
    size_t pages = decodedLen / width;
    return pages <= POKE_BMP_MAX_PAGES;
}

// ==========================================================================
//  External objects (created in main.cpp)
// ==========================================================================

extern AsyncWebServer server;
extern NetWizard      NW;

// ==========================================================================
//  Internal state
// ==========================================================================

using namespace websockets;
static WebsocketsClient _wsClient;
static bool             _wsConnected = false;
static unsigned long    _wsLastReconnect = 0;

static WiFiClient   _mqttWifi;
static PubSubClient _mqttClient(_mqttWifi);
static unsigned long _mqttLastReconnect = 0;
#define MQTT_RECONNECT_MS 5000

static bool          _wifiConnected = false;
static unsigned long _wifiLostMs    = 0;
static bool          _portalRestartedForReconnect = false;
static unsigned long _versionCheckAfterMs = 0;  // run version check after this time
static unsigned long _tzCheckAfterMs     = 0;  // run timezone detection after this time

// ==========================================================================
//  WebSocket helpers
// ==========================================================================

static bool wsConnect() {
    if (_wsClient.available()) {
        _wsClient.close();
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    bool ok;
    if (WS_PORT == 443) {
        ok = _wsClient.connectSecure(WS_HOST, WS_PORT, WS_PATH);
    } else {
        ok = _wsClient.connect(WS_HOST, WS_PORT, WS_PATH);
    }
    if (!ok) {
        Serial.println("[WS] Connection failed");
    }
    return ok;
}

static void wsSendDeviceInfo() {
    if (!_wsConnected) return;
    StaticJsonDocument<384> doc;
    doc["type"]    = "device.register";
    doc["id"]      = getDeviceId();
    doc["name"]    = getDeviceName();
    doc["ip"]      = WiFi.localIP().toString();
    doc["version"] = kQbitVersion;
    String msg;
    serializeJson(doc, msg);
    _wsClient.send(msg);
}

void networkSendDeviceInfo() {
    wsSendDeviceInfo();
}

void networkSendClaimConfirm() {
    if (!_wsConnected) return;
    StaticJsonDocument<64> doc;
    doc["type"] = "claim_confirm";
    String msg;
    serializeJson(doc, msg);
    _wsClient.send(msg);
    Serial.println("Claim confirmed");
}

void networkSendClaimReject() {
    if (!_wsConnected) return;
    StaticJsonDocument<64> doc;
    doc["type"] = "claim_reject";
    String msg;
    serializeJson(doc, msg);
    _wsClient.send(msg);
    Serial.println("Claim rejected (timeout)");
}

// ==========================================================================
//  WebSocket event + message handlers
// ==========================================================================

static void wsEvent(WebsocketsClient &client, WebsocketsEvent event, WSInterfaceString data) {
    (void)client;
    (void)data;
    switch (event) {
        case WebsocketsEvent::ConnectionOpened:
            _wsConnected = true;
            xEventGroupSetBits(connectivityBits, WS_CONNECTED_BIT);
            Serial.println("[WS] Connected to backend");
            wsSendDeviceInfo();
            break;
        case WebsocketsEvent::ConnectionClosed:
            _wsConnected = false;
            xEventGroupClearBits(connectivityBits, WS_CONNECTED_BIT);
            Serial.println("[WS] Disconnected");
            {
                NetworkEvent evt = {};
                evt.kind = NetworkEvent::WS_STATUS;
                evt.connected = false;
                xQueueSend(networkEventQueue, &evt, 0);
            }
            break;
        case WebsocketsEvent::GotPing:
        case WebsocketsEvent::GotPong:
            break;
    }
}

static void wsMessage(WebsocketsClient &client, WebsocketsMessage message) {
    (void)client;
    if (!message.isText()) return;

    String data = message.data();
    StaticJsonDocument<2048> doc;
    if (deserializeJson(doc, data)) return;

    const char *msgType = doc["type"];
    if (!msgType) return;

    if (strcmp(msgType, "poke") == 0) {
        const char *sender = doc["sender"] | "Someone";
        const char *text   = doc["text"]   | "Poke!";

        if (doc["senderBitmap"].is<const char*>() && doc["textBitmap"].is<const char*>()) {
            const char *senderBmp = doc["senderBitmap"];
            uint16_t senderW      = doc["senderBitmapWidth"] | 0;
            const char *textBmp   = doc["textBitmap"];
            uint16_t textW        = doc["textBitmapWidth"] | 0;

            if (senderW > 0 && textW > 0 &&
                senderW <= POKE_BMP_MAX_WIDTH && textW <= POKE_BMP_MAX_WIDTH) {
                size_t sLen = 0, tLen = 0;
                uint8_t *sBmp = decodeBase64Alloc(senderBmp, &sLen);
                uint8_t *tBmp = decodeBase64Alloc(textBmp, &tLen);

                bool valid = sBmp && tBmp &&
                             isValidBitmapSize(senderW, sLen) &&
                             isValidBitmapSize(textW, tLen);

                if (valid) {
                    NetworkEvent evt = {};
                    evt.kind = NetworkEvent::POKE_BITMAP;
                    strncpy(evt.sender, sender, sizeof(evt.sender) - 1);
                    strncpy(evt.text, text, sizeof(evt.text) - 1);
                    evt.senderBmp = sBmp;
                    evt.senderBmpWidth = senderW;
                    evt.senderBmpLen = sLen;
                    evt.textBmp = tBmp;
                    evt.textBmpWidth = textW;
                    evt.textBmpLen = tLen;
                    xQueueSend(networkEventQueue, &evt, pdMS_TO_TICKS(100));
                } else {
                    if (sBmp) free(sBmp);
                    if (tBmp) free(tBmp);
                    NetworkEvent evt = {};
                    evt.kind = NetworkEvent::POKE;
                    strncpy(evt.sender, sender, sizeof(evt.sender) - 1);
                    strncpy(evt.text, text, sizeof(evt.text) - 1);
                    xQueueSend(networkEventQueue, &evt, pdMS_TO_TICKS(100));
                }
            } else {
                NetworkEvent evt = {};
                evt.kind = NetworkEvent::POKE;
                strncpy(evt.sender, sender, sizeof(evt.sender) - 1);
                strncpy(evt.text, text, sizeof(evt.text) - 1);
                xQueueSend(networkEventQueue, &evt, pdMS_TO_TICKS(100));
            }
        } else {
            NetworkEvent evt = {};
            evt.kind = NetworkEvent::POKE;
            strncpy(evt.sender, sender, sizeof(evt.sender) - 1);
            strncpy(evt.text, text, sizeof(evt.text) - 1);
            xQueueSend(networkEventQueue, &evt, pdMS_TO_TICKS(100));
        }

        mqttPublishPokeEvent(sender, text);
    }

    if (strcmp(msgType, "claim_request") == 0) {
        const char *userName = doc["userName"] | "Unknown";
        NetworkEvent evt = {};
        evt.kind = NetworkEvent::CLAIM_REQUEST;
        strncpy(evt.sender, userName, sizeof(evt.sender) - 1);
        xQueueSend(networkEventQueue, &evt, pdMS_TO_TICKS(100));
    }
}

// ==========================================================================
//  Firmware version check (HTTPS GET latest.json), deferred ~15s after WiFi
// ==========================================================================
#define VERSION_CHECK_URL "https://seanchangx.github.io/QBIT/latest.json"
#define VERSION_CHECK_TIMEOUT_MS 45000  // HTTPClient uses ms (compare with millis())

static void checkFirmwareVersionOnce() {
    static bool done = false;
    if (done) return;
    done = true;

    Serial.println("[Version] Checking...");
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(20);
    HTTPClient http;
    if (!http.begin(client, VERSION_CHECK_URL)) {
        Serial.println("[Version] HTTP begin failed");
        return;
    }
    http.setTimeout(VERSION_CHECK_TIMEOUT_MS);
    int code = http.GET();
    if (code != 200) {
        Serial.printf("[Version] GET failed: %d\n", code);
        http.end();
        return;
    }
    String payload = http.getString();
    http.end();

    StaticJsonDocument<384> doc;
    if (deserializeJson(doc, payload)) {
        Serial.println("[Version] JSON parse failed");
        return;
    }
    const char *remoteVer = doc["version"];
    if (!remoteVer || remoteVer[0] == '\0') {
        Serial.println("[Version] No version in JSON");
        return;
    }
    const char *remoteNorm = (remoteVer[0] == 'v' || remoteVer[0] == 'V') ? (remoteVer + 1) : remoteVer;
    const char *localNorm  = (kQbitVersion[0] == 'v' || kQbitVersion[0] == 'V') ? (kQbitVersion + 1) : kQbitVersion;
    if (strcmp(remoteNorm, localNorm) != 0) {
        updateAvailable = true;
        strncpy(updateAvailableVersion, remoteVer, UPDATE_AVAILABLE_VERSION_LEN - 1);
        updateAvailableVersion[UPDATE_AVAILABLE_VERSION_LEN - 1] = '\0';
        Serial.printf("[Version] Update available: %s (current: %s)\n", remoteVer, kQbitVersion);
    } else {
        Serial.printf("[Version] Up to date: %s\n", kQbitVersion);
    }
}

// ==========================================================================
//  MQTT helpers
// ==========================================================================
#define POKE_MQTT_TEXT_MAX 25  // max chars for poke message (no bitmap path)
static char _haStoredPokeText[POKE_MQTT_TEXT_MAX + 1] = {0};  // typed in HA; used when Poke button is pressed

// Sanitize and truncate to maxLen: printable ASCII only, null-terminated.
static void sanitizePokeText(char *dst, size_t dstSize, const char *src, size_t maxLen) {
    if (!dst || dstSize == 0) return;
    size_t di = 0;
    const size_t cap = (maxLen + 1 < dstSize) ? maxLen + 1 : dstSize;
    while (di < cap - 1 && src && *src) {
        unsigned char c = (unsigned char)*src++;
        if (c >= 0x20 && c <= 0x7E) dst[di++] = (char)c;
    }
    dst[di] = '\0';
}

static void mqttCallback(char *topic, byte *payload, unsigned int length) {
    String topicStr = String(topic);
    String prefix   = getMqttPrefix();
    String id       = getDeviceId();

    // Build raw string from payload
    String rawPayload = "";
    for (unsigned int i = 0; i < length; i++) rawPayload += (char)payload[i];

    // Poke command (JSON payload). If user typed in HA text entity, use that; else use payload text (default "Poke!").
    if (topicStr == prefix + "/" + id + "/command") {
        StaticJsonDocument<1024> doc;
        if (deserializeJson(doc, payload, length)) return;
        const char *cmd = doc["command"];
        if (!cmd) return;
        if (strcmp(cmd, "poke") == 0) {
            const char *sender = doc["sender"] | "Home Assistant";
            const char *text   = doc["text"]   | "Poke!";
            NetworkEvent evt = {};
            evt.kind = NetworkEvent::POKE;
            sanitizePokeText(evt.sender, sizeof(evt.sender), sender, POKE_MQTT_TEXT_MAX);
            if (evt.sender[0] == '\0') strcpy(evt.sender, "Home Assistant");
            if (_haStoredPokeText[0] != '\0') {
                strncpy(evt.text, _haStoredPokeText, sizeof(evt.text) - 1);
                evt.text[sizeof(evt.text) - 1] = '\0';
            } else {
                sanitizePokeText(evt.text, sizeof(evt.text), text, POKE_MQTT_TEXT_MAX);
                if (evt.text[0] == '\0') strcpy(evt.text, "Poke!");
            }
            xQueueSend(networkEventQueue, &evt, pdMS_TO_TICKS(100));
            mqttPublishPokeEvent(evt.sender, evt.text);
            Serial.printf("[MQTT] Poke from %s: %s\n", evt.sender, evt.text);
        }
        return;
    }

    // HA text entity: store only (no poke). When user presses Poke button we use this or "Poke!".
    if (topicStr == prefix + "/" + id + "/poke_text/set") {
        const char *textSrc = rawPayload.c_str();
        if (length > 0 && payload[0] == '{') {
            StaticJsonDocument<256> doc;
            if (!deserializeJson(doc, payload, length)) {
                const char *v = doc["value"].as<const char*>();
                if (!v || !v[0]) v = doc["text"].as<const char*>();
                if (!v || !v[0]) v = doc["message"].as<const char*>();
                if (!v || !v[0]) v = doc["state"].as<const char*>();
                if (v && v[0]) textSrc = v;
            }
        }
        sanitizePokeText(_haStoredPokeText, sizeof(_haStoredPokeText), textSrc, POKE_MQTT_TEXT_MAX);
        return;
    }

    // Mute set (plain text: ON/OFF)
    if (topicStr == prefix + "/" + id + "/mute/set") {
        NetworkEvent evt = {};
        evt.kind = NetworkEvent::MQTT_COMMAND;
        strncpy(evt.sender, "mute", sizeof(evt.sender) - 1);
        strncpy(evt.text, rawPayload.c_str(), sizeof(evt.text) - 1);
        xQueueSend(networkEventQueue, &evt, pdMS_TO_TICKS(100));
        return;
    }

    // Animation next (no payload needed)
    if (topicStr == prefix + "/" + id + "/animation/next") {
        NetworkEvent evt = {};
        evt.kind = NetworkEvent::MQTT_COMMAND;
        strncpy(evt.sender, "animation_next", sizeof(evt.sender) - 1);
        xQueueSend(networkEventQueue, &evt, pdMS_TO_TICKS(100));
        return;
    }
}

static void mqttReconnect() {
    if (!getMqttEnabled() || getMqttHost().length() == 0) return;
    if (_mqttClient.connected()) return;

    unsigned long now = millis();
    if (now - _mqttLastReconnect < MQTT_RECONNECT_MS) return;
    _mqttLastReconnect = now;

    _mqttClient.setServer(getMqttHost().c_str(), getMqttPort());
    _mqttClient.setBufferSize(1024);
    _mqttClient.setCallback(mqttCallback);

    String clientId = "qbit-" + getDeviceId();
    String statusTopic = getMqttPrefix() + "/" + getDeviceId() + "/status";
    bool ok;
    if (getMqttUser().length() > 0) {
        ok = _mqttClient.connect(clientId.c_str(),
                                 getMqttUser().c_str(), getMqttPass().c_str(),
                                 statusTopic.c_str(), 0, true, "offline");
    } else {
        ok = _mqttClient.connect(clientId.c_str(),
                                 statusTopic.c_str(), 0, true, "offline");
    }

    if (ok) {
        Serial.printf("[MQTT] Connected to %s:%u\n", getMqttHost().c_str(), getMqttPort());
        xEventGroupSetBits(connectivityBits, MQTT_CONNECTED_BIT);

        // Publish online + info
        _mqttClient.publish(statusTopic.c_str(), "online", true);

        String infoTopic = getMqttPrefix() + "/" + getDeviceId() + "/info";
        StaticJsonDocument<256> info;
        info["id"]   = getDeviceId();
        info["name"] = getDeviceName();
        info["ip"]   = WiFi.localIP().toString();
        String infoStr;
        serializeJson(info, infoStr);
        _mqttClient.publish(infoTopic.c_str(), infoStr.c_str(), true);

        // Subscribe to command topics
        String id = getDeviceId();
        String prefix = getMqttPrefix();
        _mqttClient.subscribe((prefix + "/" + id + "/command").c_str());
        _mqttClient.subscribe((prefix + "/" + id + "/poke_text/set").c_str());
        _mqttClient.subscribe((prefix + "/" + id + "/mute/set").c_str());
        _mqttClient.subscribe((prefix + "/" + id + "/animation/next").c_str());

        // Publish HA discovery
        mqttPublishHADiscovery(&_mqttClient);
    } else {
        Serial.printf("[MQTT] Connection failed (rc=%d)\n", _mqttClient.state());
    }
}

// ==========================================================================
//  Network task main loop
// ==========================================================================

void networkTask(void *param) {
    (void)param;

    // Wait a bit for WiFi to initialize
    vTaskDelay(pdMS_TO_TICKS(500));

    // Set up WebSocket handlers
    if (String(WS_API_KEY).length() > 0) {
        _wsClient.addHeader("Authorization", "Bearer " + String(WS_API_KEY));
    }
    _wsClient.onEvent(wsEvent);
    _wsClient.onMessage(wsMessage);

    // Initial NTP sync
    timeManagerInit();

    for (;;) {
        // --- NetWizard loop ---
        NW.loop();

        // --- WiFi monitoring ---
        if (WiFi.status() != WL_CONNECTED) {
            if (_wifiLostMs == 0) {
                _wifiLostMs = millis();
                if (_wifiLostMs == 0) _wifiLostMs = 1;
                _wifiConnected = false;
                _wsConnected = false;
                xEventGroupClearBits(connectivityBits, WIFI_CONNECTED_BIT | WS_CONNECTED_BIT);
                Serial.println("[WiFi] Connection lost");

                NetworkEvent evt = {};
                evt.kind = NetworkEvent::WIFI_STATUS;
                evt.connected = false;
                xQueueSend(networkEventQueue, &evt, 0);
            }
            if (!_portalRestartedForReconnect &&
                (millis() - _wifiLostMs > WIFI_RECONNECT_TIMEOUT_MS)) {
                _portalRestartedForReconnect = true;
                NW.startPortal();
                Serial.println("[WiFi] Auto-reconnect timeout, restarting AP portal");
            }
        } else {
            if (_wifiLostMs > 0 || !_wifiConnected) {
                // WiFi just connected or reconnected
                if (!_wifiConnected) {
                    _wifiConnected = true;
                    xEventGroupSetBits(connectivityBits, WIFI_CONNECTED_BIT);

                    NetworkEvent evt = {};
                    evt.kind = NetworkEvent::WIFI_STATUS;
                    evt.connected = true;
                    xQueueSend(networkEventQueue, &evt, 0);

                    // Defer timezone and version check so we don't block MQTT/WS (no blocking in this block)
                    if (getTimezoneIANA().length() == 0)
                        _tzCheckAfterMs = millis() + 5000;
                    _versionCheckAfterMs = millis() + 15000;
                }
                if (_portalRestartedForReconnect) {
                    _portalRestartedForReconnect = false;
                    NW.stopPortal();
                    Serial.println("[WiFi] Reconnected, stopping AP portal");
                }
                _wifiLostMs = 0;
            }
        }

        // --- WebSocket ---
        if (_wsConnected) {
            _wsClient.poll();
        } else if (_wifiConnected) {
            unsigned long now = millis();
            if (now - _wsLastReconnect >= WS_RECONNECT_MS) {
                _wsLastReconnect = now;
                wsConnect();
            }
        }

        // --- MQTT ---
        if (getMqttEnabled()) {
            if (!_mqttClient.connected()) {
                xEventGroupClearBits(connectivityBits, MQTT_CONNECTED_BIT);
                mqttReconnect();
            }
            _mqttClient.loop();
        }

        // --- Deferred timezone detection (~5s after WiFi connect) ---
        if (_tzCheckAfterMs > 0 && millis() >= _tzCheckAfterMs) {
            _tzCheckAfterMs = 0;
            if (getTimezoneIANA().length() == 0)
                timeManagerDetectTimezone();
        }
        // --- Deferred version check (~15s after WiFi connect) ---
        if (_versionCheckAfterMs > 0 && millis() >= _versionCheckAfterMs) {
            _versionCheckAfterMs = 0;
            checkFirmwareVersionOnce();
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ==========================================================================
//  MQTT publish helpers (accessible from other modules)
// ==========================================================================

void mqttPublishPokeEvent(const char *sender, const char *text) {
    if (!getMqttEnabled() || !_mqttClient.connected()) return;
    String topic = getMqttPrefix() + "/" + getDeviceId() + "/poke";
    StaticJsonDocument<384> doc;
    doc["sender"] = sender;
    doc["text"]   = text;
    doc["time"]   = timeManagerGetISO8601();
    String payload;
    serializeJson(doc, payload);
    _mqttClient.publish(topic.c_str(), payload.c_str(), true);
}

void mqttPublishMuteState(bool muted) {
    if (!getMqttEnabled() || !_mqttClient.connected()) return;
    String topic = getMqttPrefix() + "/" + getDeviceId() + "/mute/state";
    _mqttClient.publish(topic.c_str(), muted ? "ON" : "OFF", true);
}

void mqttPublishTouchEvent(GestureType type) {
    if (!getMqttEnabled() || !_mqttClient.connected()) return;
    String topic = getMqttPrefix() + "/" + getDeviceId() + "/touch";
    const char *typeStr = "none";
    switch (type) {
        case SINGLE_TAP:  typeStr = "single_tap";  break;
        case DOUBLE_TAP:  typeStr = "double_tap";  break;
        case LONG_PRESS:  typeStr = "long_press";  break;
        default: break;
    }
    StaticJsonDocument<128> doc;
    doc["type"] = typeStr;
    doc["time"] = timeManagerGetISO8601();
    String payload;
    serializeJson(doc, payload);
    _mqttClient.publish(topic.c_str(), payload.c_str(), false);
}

void mqttPublishAnimationState(const String &filename) {
    if (!getMqttEnabled() || !_mqttClient.connected()) return;
    String topic = getMqttPrefix() + "/" + getDeviceId() + "/animation/state";
    _mqttClient.publish(topic.c_str(), filename.c_str(), true);
}
