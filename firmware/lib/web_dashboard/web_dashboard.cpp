#include "web_dashboard.h"
#include "gif_player.h"
#include <LittleFS.h>
#include <ArduinoJson.h>
#if defined(ESP32) || defined(ESP8266)
#include <WiFi.h>
#endif

// ==========================================================================
//  Upload state
// ==========================================================================

static File   _uploadFile;
static bool   _uploadOk    = false;
static String _uploadError;

// ==========================================================================
//  Path sanitization (prevent path traversal)
// ==========================================================================

#define MAX_BASENAME_LEN 64

// Returns a safe basename for a file under "/", or empty string if invalid.
// Rejects "..", "/", "\\", NUL, and limits length.
static String sanitizeFileBasename(const String &input) {
    if (input.length() == 0 || input.length() > MAX_BASENAME_LEN)
        return "";
    for (size_t i = 0; i < input.length(); i++) {
        char c = input[i];
        if (c == '\0' || c == '/' || c == '\\')
            return "";
    }
    if (input.indexOf("..") >= 0)
        return "";
    return input;
}

// Normalize request path to a single segment under root for .qgif serving.
// Returns path like "/foo.qgif" or empty if invalid.
static String normalizeQgifPath(const String &url) {
    String path = url;
    path.trim();
    if (path.length() == 0) return "";
    if (path.startsWith("/")) path = path.substring(1);
    if (path.length() == 0 || path.indexOf("..") >= 0 || path.indexOf('/') >= 0)
        return "";
    if (!path.endsWith(".qgif")) return "";
    if (path.length() > MAX_BASENAME_LEN) return "";
    return "/" + path;
}

// ==========================================================================
//  Helpers
// ==========================================================================

// Serve a file from LittleFS with the given content type.
static void serveFile(AsyncWebServerRequest *request,
                      const char *path, const char *contentType) {
    if (LittleFS.exists(path)) {
        request->send(LittleFS, path, contentType);
    } else {
        request->send(404, "text/plain", "File not found");
    }
}

// ==========================================================================
//  Handlers -- static assets
// ==========================================================================

static void handleRoot(AsyncWebServerRequest *request) {
    serveFile(request, "/index.html", "text/html");
}

static void handleCSS(AsyncWebServerRequest *request) {
    serveFile(request, "/style.css", "text/css");
}

static void handleScript(AsyncWebServerRequest *request) {
    serveFile(request, "/script.js", "application/javascript");
}

static void handleFont(AsyncWebServerRequest *request) {
    serveFile(request, "/inter-latin.woff2", "font/woff2");
}

static void handleIcon(AsyncWebServerRequest *request) {
    serveFile(request, "/icon.svg", "image/svg+xml");
}

static void handleFavicon(AsyncWebServerRequest *request) {
    // Browsers auto-request /favicon.ico; redirect to SVG icon
    request->redirect("/icon.svg");
}

// ==========================================================================
//  Handlers -- REST API
// ==========================================================================

static void handleList(AsyncWebServerRequest *request) {
    StaticJsonDocument<2048> doc;
    JsonArray arr = doc.to<JsonArray>();
    File root = LittleFS.open("/");
    if (root && root.isDirectory()) {
        String current = gifPlayerGetCurrentFile();
        File f = root.openNextFile();
        while (f) {
            String name = String(f.name());
            size_t sz   = f.size();
            f.close();
            if (name.startsWith("/")) name = name.substring(1);
            if (name.endsWith(".qgif")) {
                JsonObject obj = arr.add<JsonObject>();
                obj["name"]    = name;
                obj["size"]    = sz;
                obj["playing"] = (name == current);
            }
            f = root.openNextFile();
        }
        root.close();
    }
    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

static void handleStorage(AsyncWebServerRequest *request) {
    StaticJsonDocument<128> doc;
    doc["total"] = LittleFS.totalBytes();
    doc["used"]  = LittleFS.usedBytes();
    doc["free"]  = LittleFS.totalBytes() - LittleFS.usedBytes();
    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

static void handleUploadDone(AsyncWebServerRequest *request) {
    StaticJsonDocument<256> doc;
    if (_uploadOk) {
        doc["ok"] = true;
    } else {
        doc["error"] = _uploadError;
    }
    String json;
    serializeJson(doc, json);
    request->send(_uploadOk ? 200 : 507, "application/json", json);
}

// Called for each chunk of the multipart file upload.
//   filename -- original file name from the client
//   index    -- byte offset of this chunk within the upload stream
//   data/len -- current chunk payload
//   final    -- true when this is the last chunk
static void handleUploadData(AsyncWebServerRequest *request,
                             const String &filename, size_t index,
                             uint8_t *data, size_t len, bool final) {
    // --- Start of upload (first chunk, index == 0) ---
    if (index == 0) {
        _uploadOk    = true;
        _uploadError = "";

        // Validate extension
        if (!filename.endsWith(".qgif")) {
            _uploadOk    = false;
            _uploadError = "Only .qgif files are accepted";
            return;
        }

        // Path traversal: use basename only and sanitize
        int lastSlash = filename.lastIndexOf('/');
        String basename = lastSlash >= 0 ? filename.substring(lastSlash + 1) : filename;
        basename = sanitizeFileBasename(basename);
        if (basename.length() == 0 || !basename.endsWith(".qgif")) {
            _uploadOk    = false;
            _uploadError = "Invalid filename";
            return;
        }

        // Rough free-space check (exact size unknown at this point)
        size_t freeBytes = LittleFS.totalBytes() - LittleFS.usedBytes();
        if (freeBytes < 2048) {
            _uploadOk    = false;
            _uploadError = "Insufficient storage -- delete some files first";
            return;
        }

        _uploadFile = LittleFS.open("/" + basename, "w");
        if (!_uploadFile) {
            _uploadOk    = false;
            _uploadError = "Failed to create file";
        }
    }

    // --- Write data ---
    if (_uploadOk && _uploadFile && len > 0) {
        if (_uploadFile.write(data, len) != len) {
            _uploadOk    = false;
            _uploadError = "Write failed -- storage may be full";
        }
    }

    // --- End of upload (last chunk) ---
    if (final) {
        if (_uploadFile) _uploadFile.close();

        int lastSlash = filename.lastIndexOf('/');
        String basename = lastSlash >= 0 ? filename.substring(lastSlash + 1) : filename;
        basename = sanitizeFileBasename(basename);
        if (basename.length() == 0) {
            _uploadOk = false;
            _uploadError = "Invalid filename";
            return;
        }
        String path = "/" + basename;

        if (!_uploadOk) {
            LittleFS.remove(path);
            return;
        }

        // Validate .qgif header
        File vf = LittleFS.open(path, "r");
        if (!vf) {
            _uploadOk = false;
            _uploadError = "Cannot reopen file";
        } else {
            uint8_t hdr[QGIF_HEADER_SIZE];
            if (vf.read(hdr, QGIF_HEADER_SIZE) != QGIF_HEADER_SIZE) {
                _uploadOk = false;
                _uploadError = "File too small";
            } else {
                uint8_t  fc = hdr[0];
                uint16_t w  = hdr[1] | ((uint16_t)hdr[2] << 8);
                uint16_t h  = hdr[3] | ((uint16_t)hdr[4] << 8);
                if (fc == 0 || w != QGIF_FRAME_WIDTH || h != QGIF_FRAME_HEIGHT) {
                    _uploadOk    = false;
                    _uploadError = "Invalid .qgif format (bad header)";
                }
            }
            vf.close();
        }

        if (!_uploadOk) {
            LittleFS.remove(path);
            return;
        }

        if (gifPlayerGetCurrentFile().length() == 0)
            gifPlayerSetFile(basename);
    }
}

static void handleDelete(AsyncWebServerRequest *request) {
    if (!request->hasParam("name")) {
        request->send(400, "application/json", "{\"error\":\"Missing name\"}");
        return;
    }
    String name = sanitizeFileBasename(request->getParam("name")->value());
    if (name.length() == 0) {
        request->send(400, "application/json", "{\"error\":\"Invalid name\"}");
        return;
    }

    String path = "/" + name;
    if (!LittleFS.exists(path)) {
        request->send(404, "application/json", "{\"error\":\"File not found\"}");
        return;
    }

    LittleFS.remove(path);

    if (gifPlayerGetCurrentFile() == name) {
        String next = gifPlayerGetFirstFile();
        gifPlayerSetFile(next);
    }

    request->send(200, "application/json", "{\"ok\":true}");
}

// ==========================================================================
//  Handlers -- Settings API
// ==========================================================================

static void handleGetSettings(AsyncWebServerRequest *request) {
    StaticJsonDocument<128> doc;
    doc["speed"]      = getPlaybackSpeed();
    doc["brightness"] = getDisplayBrightness();
    doc["volume"]     = getBuzzerVolume();
    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

static void handlePostSettings(AsyncWebServerRequest *request) {
    if (request->hasParam("speed")) {
        int v = request->getParam("speed")->value().toInt();
        if (v >= 1 && v <= 10) setPlaybackSpeed((uint16_t)v);
    }
    if (request->hasParam("brightness")) {
        int v = request->getParam("brightness")->value().toInt();
        if (v >= 0 && v <= 255) setDisplayBrightness((uint8_t)v);
    }
    if (request->hasParam("volume")) {
        int v = request->getParam("volume")->value().toInt();
        if (v >= 0 && v <= 100) setBuzzerVolume((uint8_t)v);
    }
    // If save=1 is passed, persist to NVS
    if (request->hasParam("save")) {
        saveSettings();
    }

    // Echo back the current state
    handleGetSettings(request);
}

// ==========================================================================
//  Handlers -- Play API
// ==========================================================================

static void handlePlay(AsyncWebServerRequest *request) {
    if (!request->hasParam("name")) {
        request->send(400, "application/json", "{\"error\":\"Missing name\"}");
        return;
    }
    String name = sanitizeFileBasename(request->getParam("name")->value());
    if (name.length() == 0) {
        request->send(400, "application/json", "{\"error\":\"Invalid name\"}");
        return;
    }

    String path = "/" + name;
    if (!LittleFS.exists(path)) {
        request->send(404, "application/json", "{\"error\":\"File not found\"}");
        return;
    }

    gifPlayerSetFile(name);
    request->send(200, "application/json", "{\"ok\":true}");
}

// ==========================================================================
//  Handlers -- Device identity API
// ==========================================================================

static void handleGetDevice(AsyncWebServerRequest *request) {
    StaticJsonDocument<256> doc;
    doc["id"]   = getDeviceId();
    doc["name"] = getDeviceName();
    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

static void handlePostDevice(AsyncWebServerRequest *request) {
    if (request->hasParam("name")) {
        String name = request->getParam("name")->value();
        if (name.length() > 0 && name.length() <= 32) {
            setDeviceName(name);
        }
    }
    if (request->hasParam("save")) {
        saveSettings();
    }
    handleGetDevice(request);
}

// ==========================================================================
//  Handlers -- Local MQTT settings API
// ==========================================================================

static void handleGetMqtt(AsyncWebServerRequest *request) {
    StaticJsonDocument<512> doc;
    doc["enabled"] = getMqttEnabled();
    doc["host"]    = getMqttHost();
    doc["port"]   = getMqttPort();
    doc["user"]   = getMqttUser();
    doc["pass"]   = getMqttPass();
    doc["prefix"] = getMqttPrefix();
    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

static void handlePostMqtt(AsyncWebServerRequest *request) {
    String  host    = request->hasParam("host")   ? request->getParam("host")->value()   : getMqttHost();
    uint16_t port   = request->hasParam("port")   ? request->getParam("port")->value().toInt() : getMqttPort();
    String  user    = request->hasParam("user")   ? request->getParam("user")->value()   : getMqttUser();
    String  pass    = request->hasParam("pass")   ? request->getParam("pass")->value()   : getMqttPass();
    String  prefix  = request->hasParam("prefix") ? request->getParam("prefix")->value() : getMqttPrefix();
    bool    enabled = request->hasParam("enabled") ? (request->getParam("enabled")->value() == "1") : getMqttEnabled();

    if (port == 0) port = 1883;
    if (prefix.length() == 0) prefix = "qbit";

    setMqttConfig(host, port, user, pass, prefix, enabled);

    if (request->hasParam("save")) {
        saveSettings();
    }

    handleGetMqtt(request);
}

// ==========================================================================
//  Handlers -- GPIO Pin Configuration API
// ==========================================================================

// Valid GPIOs for ESP32-C3 Super Mini
static const uint8_t VALID_PINS[] = {0,1,2,3,4,5,6,7,8,9,10,20,21};
static const uint8_t VALID_PINS_COUNT = sizeof(VALID_PINS) / sizeof(VALID_PINS[0]);

static bool isValidPin(uint8_t pin) {
    for (uint8_t i = 0; i < VALID_PINS_COUNT; i++) {
        if (VALID_PINS[i] == pin) return true;
    }
    return false;
}

static void handleGetPins(AsyncWebServerRequest *request) {
    StaticJsonDocument<128> doc;
    doc["touch"]  = getPinTouch();
    doc["buzzer"] = getPinBuzzer();
    doc["sda"]    = getPinSDA();
    doc["scl"]    = getPinSCL();
    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

static void handlePostPins(AsyncWebServerRequest *request) {
    if (!request->hasParam("touch") || !request->hasParam("buzzer") ||
        !request->hasParam("sda")   || !request->hasParam("scl")) {
        request->send(400, "application/json",
                      "{\"error\":\"Missing pin parameters (touch, buzzer, sda, scl)\"}");
        return;
    }

    uint8_t touch  = (uint8_t)request->getParam("touch")->value().toInt();
    uint8_t buzzer = (uint8_t)request->getParam("buzzer")->value().toInt();
    uint8_t sda    = (uint8_t)request->getParam("sda")->value().toInt();
    uint8_t scl    = (uint8_t)request->getParam("scl")->value().toInt();

    // Validate: all pins must be in the allowed set
    if (!isValidPin(touch) || !isValidPin(buzzer) ||
        !isValidPin(sda)   || !isValidPin(scl)) {
        request->send(400, "application/json",
                      "{\"error\":\"Invalid GPIO pin number\"}");
        return;
    }

    // Validate: all 4 pins must be distinct
    if (touch == buzzer || touch == sda || touch == scl ||
        buzzer == sda   || buzzer == scl || sda == scl) {
        request->send(400, "application/json",
                      "{\"error\":\"All four pins must be different\"}");
        return;
    }

    // Send response before reboot
    request->send(200, "application/json", "{\"ok\":true,\"rebooting\":true}");

    // Save and reboot (setPinConfig writes NVS then calls ESP.restart)
    setPinConfig(touch, buzzer, sda, scl);
}

// ==========================================================================
//  Handlers -- Current playing file
// ==========================================================================

static void handleCurrent(AsyncWebServerRequest *request) {
    StaticJsonDocument<256> doc;
    doc["name"] = gifPlayerGetCurrentFile();
    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

// ==========================================================================
//  Handlers -- Timezone API
// ==========================================================================

static void handleGetTimezone(AsyncWebServerRequest *request) {
    StaticJsonDocument<128> doc;
    doc["timezone"] = getTimezoneIANA();
    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
}

static void handlePostTimezone(AsyncWebServerRequest *request) {
    // Accept both "tz" and "iana" param names for the timezone
    String tz;
    if (request->hasParam("tz")) {
        tz = request->getParam("tz")->value();
    } else if (request->hasParam("iana")) {
        tz = request->getParam("iana")->value();
    }
    if (tz.length() > 0) {
        setTimezoneIANA(tz);
        timeManagerSetTimezone(tz);
    } else {
        // Empty value = auto-detect: clear saved timezone
        setTimezoneIANA("");
    }
    saveSettings();
    handleGetTimezone(request);
}

// ==========================================================================
//  Init
// ==========================================================================

void webDashboardInit(AsyncWebServer &server) {
    // Dashboard at "/" only when STA is connected; when in AP mode (e.g. after WiFi lost
    // and portal restarted), "/" is left for NetWizard so opening 192.168.4.1/ shows WiFi setup.
    server.on("/", HTTP_GET, handleRoot).setFilter(ON_STA_FILTER);
    // Static assets (served from LittleFS data/ partition)
    server.on("/icon.svg",          HTTP_GET,  handleIcon);
    server.on("/favicon.ico",       HTTP_GET,  handleFavicon);
    server.on("/style.css",         HTTP_GET,  handleCSS);
    server.on("/script.js",         HTTP_GET,  handleScript);
    server.on("/inter-latin.woff2", HTTP_GET,  handleFont);

    // API endpoints
    server.on("/api/list",    HTTP_GET,  handleList);
    server.on("/api/storage", HTTP_GET,  handleStorage);
    server.on("/api/upload",  HTTP_POST, handleUploadDone, handleUploadData);
    server.on("/api/delete",   HTTP_POST, handleDelete);
    server.on("/api/play",     HTTP_POST, handlePlay);
    server.on("/api/current",  HTTP_GET,  handleCurrent);
    server.on("/api/settings",      HTTP_GET,  handleGetSettings);
    server.on("/api/settings",      HTTP_POST, handlePostSettings);
    server.on("/api/device",        HTTP_GET,  handleGetDevice);
    server.on("/api/device",        HTTP_POST, handlePostDevice);
    server.on("/api/mqtt",          HTTP_GET,  handleGetMqtt);
    server.on("/api/mqtt",          HTTP_POST, handlePostMqtt);
    server.on("/api/pins",          HTTP_GET,  handleGetPins);
    server.on("/api/pins",          HTTP_POST, handlePostPins);
    server.on("/api/timezone",      HTTP_GET,  handleGetTimezone);
    server.on("/api/timezone",      HTTP_POST, handlePostTimezone);

    // Catch-all: serve .qgif files from LittleFS for browser preview (path-normalized)
    server.onNotFound([](AsyncWebServerRequest *request) {
        if (request->method() != HTTP_GET) {
            request->send(404, "text/plain", "Not found");
            return;
        }
        String path = normalizeQgifPath(request->url());
        if (path.length() > 0 && LittleFS.exists(path)) {
            request->send(LittleFS, path, "application/octet-stream");
        } else {
            request->send(404, "text/plain", "Not found");
        }
    });
}
