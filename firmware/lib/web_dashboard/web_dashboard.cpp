#include "web_dashboard.h"
#include "gif_player.h"
#include <LittleFS.h>

// ==========================================================================
//  Upload state
// ==========================================================================

static File   _uploadFile;
static bool   _uploadOk    = false;
static String _uploadError;

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
    String json = "[";
    File root = LittleFS.open("/");
    if (root && root.isDirectory()) {
        String current = gifPlayerGetCurrentFile();
        bool first = true;
        File f = root.openNextFile();
        while (f) {
            String name = String(f.name());
            size_t sz   = f.size();
            f.close();
            if (name.startsWith("/")) name = name.substring(1);
            if (name.endsWith(".qgif")) {
                if (!first) json += ",";
                json += "{\"name\":\"" + name + "\",\"size\":" + String(sz);
                json += ",\"playing\":" + String(name == current ? "true" : "false") + "}";
                first = false;
            }
            f = root.openNextFile();
        }
        root.close();
    }
    json += "]";
    request->send(200, "application/json", json);
}

static void handleStorage(AsyncWebServerRequest *request) {
    size_t total = LittleFS.totalBytes();
    size_t used  = LittleFS.usedBytes();
    String json  = "{\"total\":" + String(total) +
                   ",\"used\":"  + String(used)  +
                   ",\"free\":"  + String(total - used) + "}";
    request->send(200, "application/json", json);
}

// Called when the upload POST request completes (after all chunks received).
static void handleUploadDone(AsyncWebServerRequest *request) {
    if (_uploadOk) {
        request->send(200, "application/json", "{\"ok\":true}");
    } else {
        request->send(507, "application/json",
                      "{\"error\":\"" + _uploadError + "\"}");
    }
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

        // Rough free-space check (exact size unknown at this point)
        size_t freeBytes = LittleFS.totalBytes() - LittleFS.usedBytes();
        if (freeBytes < 2048) {
            _uploadOk    = false;
            _uploadError = "Insufficient storage -- delete some files first";
            return;
        }

        _uploadFile = LittleFS.open("/" + filename, "w");
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

        String path = "/" + filename;

        if (!_uploadOk) {
            // Remove partial / invalid file
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

        // Auto-play if nothing is currently playing
        if (gifPlayerGetCurrentFile().length() == 0) {
            String n = filename;
            if (n.startsWith("/")) n = n.substring(1);
            gifPlayerSetFile(n);
        }
    }
}

static void handleDelete(AsyncWebServerRequest *request) {
    if (!request->hasParam("name")) {
        request->send(400, "application/json", "{\"error\":\"Missing name\"}");
        return;
    }
    String name = request->getParam("name")->value();

    String path = "/" + name;
    if (!LittleFS.exists(path)) {
        request->send(404, "application/json", "{\"error\":\"File not found\"}");
        return;
    }

    LittleFS.remove(path);

    // If we deleted the playing file, switch to another or stop
    if (gifPlayerGetCurrentFile() == name) {
        String next = gifPlayerGetFirstFile();
        gifPlayerSetFile(next);  // empty string stops playback
    }

    request->send(200, "application/json", "{\"ok\":true}");
}

// ==========================================================================
//  Handlers -- Settings API
// ==========================================================================

static void handleGetSettings(AsyncWebServerRequest *request) {
    String json = "{\"speed\":"      + String(getPlaybackSpeed())
                + ",\"brightness\":" + String(getDisplayBrightness())
                + ",\"volume\":"     + String(getBuzzerVolume())
                + "}";
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
    String name = request->getParam("name")->value();

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
    String json = "{\"id\":\"" + getDeviceId()
                + "\",\"name\":\"" + getDeviceName() + "\"}";
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
    String json = "{\"enabled\":" + String(getMqttEnabled() ? "true" : "false")
                + ",\"host\":\"" + getMqttHost() + "\""
                + ",\"port\":"   + String(getMqttPort())
                + ",\"user\":\"" + getMqttUser() + "\""
                + ",\"pass\":\"" + getMqttPass() + "\""
                + ",\"prefix\":\"" + getMqttPrefix() + "\""
                + "}";
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
//  Init
// ==========================================================================

void webDashboardInit(AsyncWebServer &server) {
    // Static assets (served from LittleFS data/ partition)
    server.on("/",                  HTTP_GET,  handleRoot);
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
    server.on("/api/settings",      HTTP_GET,  handleGetSettings);
    server.on("/api/settings",      HTTP_POST, handlePostSettings);
    server.on("/api/device",        HTTP_GET,  handleGetDevice);
    server.on("/api/device",        HTTP_POST, handlePostDevice);
    server.on("/api/mqtt",          HTTP_GET,  handleGetMqtt);
    server.on("/api/mqtt",          HTTP_POST, handlePostMqtt);
}
