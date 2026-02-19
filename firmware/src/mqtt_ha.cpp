// ==========================================================================
//  QBIT -- MQTT Home Assistant discovery
// ==========================================================================
#include "mqtt_ha.h"
#include "settings.h"
#include "gif_player.h"
#include <ArduinoJson.h>
#include <WiFi.h>

void mqttPublishHADiscovery(PubSubClient *client) {
    String id    = getDeviceId();
    String idLow = id;
    idLow.toLowerCase();
    String name   = getDeviceName();
    String prefix = getMqttPrefix();

    // Shared device block
    StaticJsonDocument<256> devBlock;
    JsonArray ids = devBlock["ids"].to<JsonArray>();
    ids.add("qbit_" + idLow);
    devBlock["name"] = name;
    devBlock["mf"]   = "SCX.TW";    // manufacturer
    devBlock["mdl"]  = "QBIT";      // model
    devBlock["sw"]   = kQbitVersion;

    // --- Binary sensor: online/offline status ---
    {
        String topic = "homeassistant/binary_sensor/qbit_" + idLow + "/status/config";
        StaticJsonDocument<512> doc;
        doc["name"]             = "Status";
        doc["uniq_id"]          = "qbit_" + idLow + "_status";
        doc["default_entity_id"] = "binary_sensor.qbit_" + idLow + "_status";
        doc["stat_t"]       = prefix + "/" + id + "/status";
        doc["pl_on"]        = "online";
        doc["pl_off"]       = "offline";
        doc["dev_cla"]      = "connectivity";
        doc["dev"]          = devBlock;
        String payload;
        serializeJson(doc, payload);
        client->publish(topic.c_str(), payload.c_str(), true);
    }

    // --- Sensor: IP address ---
    {
        String topic = "homeassistant/sensor/qbit_" + idLow + "/ip/config";
        StaticJsonDocument<512> doc;
        doc["name"]             = "IP Address";
        doc["uniq_id"]          = "qbit_" + idLow + "_ip";
        doc["default_entity_id"] = "sensor.qbit_" + idLow + "_ip";
        doc["stat_t"]       = prefix + "/" + id + "/info";
        doc["val_tpl"]      = "{{ value_json.ip }}";
        doc["icon"]         = "mdi:ip-network";
        doc["dev"]          = devBlock;
        String payload;
        serializeJson(doc, payload);
        client->publish(topic.c_str(), payload.c_str(), true);
    }

    // --- Button: poke trigger ---
    {
        String topic = "homeassistant/button/qbit_" + idLow + "/poke/config";
        StaticJsonDocument<512> doc;
        doc["name"]             = "Poke";
        doc["uniq_id"]          = "qbit_" + idLow + "_poke";
        doc["default_entity_id"] = "button.qbit_" + idLow + "_poke";
        doc["cmd_t"]            = prefix + "/" + id + "/command";

        StaticJsonDocument<128> pressDoc;
        pressDoc["command"] = "poke";
        pressDoc["sender"]  = "Home Assistant";
        pressDoc["text"]    = "Poke!";
        String pressStr;
        serializeJson(pressDoc, pressStr);
        doc["pl_prs"]       = pressStr;

        doc["icon"]         = "mdi:hand-wave";
        doc["dev"]          = devBlock;
        String payload;
        serializeJson(doc, payload);
        client->publish(topic.c_str(), payload.c_str(), true);
    }

    // --- Text: poke message (HA max 64 to avoid ValueError on paste; device uses first 25 only) ---
    {
        String topic = "homeassistant/text/qbit_" + idLow + "/poke_message/config";
        StaticJsonDocument<512> doc;
        doc["name"]              = "Poke message";
        doc["uniq_id"]           = "qbit_" + idLow + "_poke_message";
        doc["default_entity_id"] = "text.qbit_" + idLow + "_poke_message";
        doc["cmd_t"]             = prefix + "/" + id + "/poke_text/set";
        doc["max"]               = 64;
        doc["icon"]              = "mdi:message-text-outline";
        doc["dev"]               = devBlock;
        String payload;
        serializeJson(doc, payload);
        client->publish(topic.c_str(), payload.c_str(), true);
    }

    // --- Sensor: last poke received ---
    {
        String topic = "homeassistant/sensor/qbit_" + idLow + "/last_poke/config";
        StaticJsonDocument<512> doc;
        doc["name"]             = "Last Poke";
        doc["uniq_id"]          = "qbit_" + idLow + "_last_poke";
        doc["default_entity_id"] = "sensor.qbit_" + idLow + "_last_poke";
        doc["stat_t"]        = prefix + "/" + id + "/poke";
        doc["val_tpl"]       = "{{ value_json.sender }}";
        doc["icon"]          = "mdi:message-text";
        doc["json_attr_t"]   = prefix + "/" + id + "/poke";
        doc["json_attr_tpl"] = "{{ {'sender': value_json.sender, 'message': value_json.text, 'time': value_json.time} | tojson }}";
        doc["dev"]           = devBlock;
        String payload;
        serializeJson(doc, payload);
        client->publish(topic.c_str(), payload.c_str(), true);
    }

    // --- Switch: mute ---
    {
        String topic = "homeassistant/switch/qbit_" + idLow + "/mute/config";
        StaticJsonDocument<384> doc;
        doc["name"]             = "Mute";
        doc["uniq_id"]          = "qbit_" + idLow + "_mute";
        doc["default_entity_id"] = "switch.qbit_" + idLow + "_mute";
        doc["stat_t"]    = prefix + "/" + id + "/mute/state";
        doc["cmd_t"]     = prefix + "/" + id + "/mute/set";
        doc["icon"]      = "mdi:volume-off";
        doc["dev"]       = devBlock;
        String payload;
        serializeJson(doc, payload);
        client->publish(topic.c_str(), payload.c_str(), true);
    }

    // --- Sensor: touch ---
    {
        String topic = "homeassistant/sensor/qbit_" + idLow + "/touch/config";
        StaticJsonDocument<384> doc;
        doc["name"]             = "Touch";
        doc["uniq_id"]          = "qbit_" + idLow + "_touch";
        doc["default_entity_id"] = "sensor.qbit_" + idLow + "_touch";
        doc["stat_t"]    = prefix + "/" + id + "/touch";
        doc["val_tpl"]   = "{{ value_json.type }}";
        doc["frc_upd"]   = true;
        doc["icon"]      = "mdi:gesture-tap";
        doc["dev"]       = devBlock;
        String payload;
        serializeJson(doc, payload);
        client->publish(topic.c_str(), payload.c_str(), true);
    }

    // --- Button: next animation ---
    {
        String topic = "homeassistant/button/qbit_" + idLow + "/next/config";
        StaticJsonDocument<384> doc;
        doc["name"]             = "Next Animation";
        doc["uniq_id"]          = "qbit_" + idLow + "_next";
        doc["default_entity_id"] = "button.qbit_" + idLow + "_next";
        doc["cmd_t"]     = prefix + "/" + id + "/animation/next";
        doc["icon"]      = "mdi:skip-next";
        doc["dev"]       = devBlock;
        String payload;
        serializeJson(doc, payload);
        client->publish(topic.c_str(), payload.c_str(), true);
    }

    Serial.println("[MQTT] HA discovery config published");
}
