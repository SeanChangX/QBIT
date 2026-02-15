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
    JsonDocument doc;
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
    JsonDocument doc;
    doc["type"] = "claim_confirm";
    String msg;
    serializeJson(doc, msg);
    _wsClient.send(msg);
    Serial.println("Claim confirmed");
}

void networkSendClaimReject() {
    if (!_wsConnected) return;
    JsonDocument doc;
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
    JsonDocument doc;
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

            if (senderW > 0 && textW > 0) {
                // Decode bitmaps in this task context, then pass pointers
                size_t sLen = 0, tLen = 0;
                uint8_t *sBmp = decodeBase64Alloc(senderBmp, &sLen);
                uint8_t *tBmp = decodeBase64Alloc(textBmp, &tLen);

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

        // Publish to MQTT
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
//  MQTT helpers
// ==========================================================================

static void mqttCallback(char *topic, byte *payload, unsigned int length) {
    String topicStr = String(topic);
    String prefix   = getMqttPrefix();
    String id       = getDeviceId();

    // Build raw string from payload
    String rawPayload = "";
    for (unsigned int i = 0; i < length; i++) rawPayload += (char)payload[i];

    // Poke command (JSON payload)
    if (topicStr == prefix + "/" + id + "/command") {
        JsonDocument doc;
        if (deserializeJson(doc, payload, length)) return;
        const char *cmd = doc["command"];
        if (!cmd) return;
        if (strcmp(cmd, "poke") == 0) {
            const char *sender = doc["sender"] | "MQTT";
            const char *text   = doc["text"]   | "Poke!";
            NetworkEvent evt = {};
            evt.kind = NetworkEvent::POKE;
            strncpy(evt.sender, sender, sizeof(evt.sender) - 1);
            strncpy(evt.text, text, sizeof(evt.text) - 1);
            xQueueSend(networkEventQueue, &evt, pdMS_TO_TICKS(100));
            mqttPublishPokeEvent(sender, text);
            Serial.printf("[MQTT] Poke from %s: %s\n", sender, text);
        }
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
        JsonDocument info;
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

                    // Detect timezone on first connect (only if user hasn't saved one)
                    static bool tzDetected = false;
                    if (!tzDetected) {
                        tzDetected = true;
                        if (getTimezoneIANA().length() == 0) {
                            timeManagerDetectTimezone();
                        }
                    }
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

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ==========================================================================
//  MQTT publish helpers (accessible from other modules)
// ==========================================================================

void mqttPublishPokeEvent(const char *sender, const char *text) {
    if (!getMqttEnabled() || !_mqttClient.connected()) return;
    String topic = getMqttPrefix() + "/" + getDeviceId() + "/poke";
    JsonDocument doc;
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
    JsonDocument doc;
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
