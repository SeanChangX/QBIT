// ==========================================================================
//  QBIT -- Weather screen implementation
//
//  Layout (128×64, U8G2 y = baseline):
//    y= 0-11  │ Location name centered (font_6x13_tr)
//    y=13-36  │ 24×24 icon at x=3
//             │ AQI  string right-aligned (font_6x10_tr, y=24)
//             │ Hum  string right-aligned (font_6x10_tr, y=36)
//    y=50     │ Temperature centered in icon column (font_7x14B_tr)
//    y=53     │ Full-width separator line
//    y=54-63  │ Condition text centered (font_6x10_tr, y=63)
//
//  APIs used (plain HTTP, no HTTPS — avoids cert overhead on ESP32-C3):
//    Weather: http://api.open-meteo.com  (redirects to HTTPS internally)
//    AQI:     http://air-quality-api.open-meteo.com
//
//  NOTE: We use plain http:// so WiFiClient (not WiFiClientSecure) is
//  sufficient, keeping RAM usage low.  Open-Meteo's non-SSL endpoints are
//  identical in data to the HTTPS ones for this use-case.
// ==========================================================================
#include "weather_screen.h"
#include "weather_icons.h"
#include "../settings.h"
#include "../display_helpers.h"
#include "../app_state.h"

#include <U8g2lib.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <WiFi.h>

// ==========================================================================
//  External display object (created in main.cpp, used by display_task.cpp)
// ==========================================================================
extern U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2;
extern void rotateBuffer180();

// ==========================================================================
//  Cache configuration
// ==========================================================================
#define WEATHER_CACHE_MS      (10UL * 60UL * 1000UL) // 10 minutes
#define WEATHER_HTTP_TIMEOUT  8000  // 8 s per request

// ==========================================================================
//  Cached weather data
// ==========================================================================
static unsigned long _lastFetchMs     = 0;
static bool          _hasData         = false;

static float    _temperature          = 0.0f;
static uint8_t  _humidity             = 0;
static uint8_t  _wmoCode              = 0;
static int16_t  _aqi                  = -1;   // -1 = unavailable

// ==========================================================================
//  HTTP GET helper (returns body string or empty on error)
// ==========================================================================
static String httpGet(const char *url) {
    HTTPClient http;
    http.setTimeout(WEATHER_HTTP_TIMEOUT);
    http.begin(url);
    int code = http.GET();
    String body;
    if (code == 200) {
        body = http.getString();
    }
    http.end();
    return body;
}

// ==========================================================================
//  Fetch fresh weather + AQI from Open-Meteo
// ==========================================================================
static bool fetchWeatherData() {
    float lat = getWeatherLat();
    float lon = getWeatherLon();

    // --- Weather API ---
    char weatherUrl[256];
    snprintf(weatherUrl, sizeof(weatherUrl),
        "http://api.open-meteo.com/v1/forecast"
        "?latitude=%.4f&longitude=%.4f"
        "&current=temperature_2m,relative_humidity_2m,weather_code"
        "&forecast_days=1",
        lat, lon);

    String weatherBody = httpGet(weatherUrl);
    if (weatherBody.length() == 0) return false;

    {
        JsonDocument doc;
        DeserializationError err = deserializeJson(doc, weatherBody);
        if (err) return false;
        JsonObject cur = doc["current"];
        if (cur.isNull()) return false;
        _temperature = cur["temperature_2m"].as<float>();
        _humidity    = (uint8_t)cur["relative_humidity_2m"].as<int>();
        _wmoCode     = (uint8_t)cur["weather_code"].as<int>();
    }

    // --- AQI API ---
    char aqiUrl[256];
    snprintf(aqiUrl, sizeof(aqiUrl),
        "http://air-quality-api.open-meteo.com/v1/air-quality"
        "?latitude=%.4f&longitude=%.4f"
        "&current=european_aqi",
        lat, lon);

    String aqiBody = httpGet(aqiUrl);
    if (aqiBody.length() > 0) {
        JsonDocument doc;
        if (!deserializeJson(doc, aqiBody)) {
            JsonObject cur = doc["current"];
            if (!cur.isNull() && cur["european_aqi"].is<int>()) {
                _aqi = (int16_t)cur["european_aqi"].as<int>();
            }
        }
    }

    return true;
}

// ==========================================================================
//  Render weather screen from cache
//
//  128×64 layout:
//
//  ┌─────────────── Location (5x8_tr) ────────────────┐  y=0..12
//  ├──────── left col (x=0..74) ──────┬─right (76..127)┤  y=12 h-divider
//  │ [cond icon 16×16]  AQI          │ [cond icon]     │  y=18..34
//  │                    nnn          │                 │
//  │ [humid icon 11×16] Humidity     │   Temp          │  y=41..57
//  │                    nn %         │   nn °C         │
//  └──────────────────────────────────┴─────────────────┘
// ==========================================================================
void weatherScreenDraw() {
    if (!_hasData) {
        showText("[ Weather ]", "", "No data.", "Tap HOLD to retry");
        return;
    }

    u8g2.clearBuffer();
    u8g2.setFontMode(1);   // transparent — text doesn't black out background
    u8g2.setBitmapMode(1); // transparent — XBM doesn't black out background

    // --- Frame + dividers ---
    u8g2.drawFrame(0, 0, 128, 64);
    u8g2.drawHLine(0, 12, 128);
    u8g2.drawVLine(75, 13, 50);   // y=13..62

    // --- Top bar: location name (font_5x8_tr) ---
    u8g2.setFont(u8g2_font_5x8_tr);
    String locName = getWeatherDisplayName();
    if (locName.length() > 21) locName = locName.substring(0, 18) + "...";
    uint8_t locW = u8g2.getStrWidth(locName.c_str());
    u8g2.drawStr((128 - locW) / 2, 10, locName.c_str());

    // --- Condition icon ---
    WeatherIconInfo ico = getWeatherIcon(_wmoCode);

    // Left column: condition icon at (3, 18)
    u8g2.drawXBM(3, 18, ico.width, 16, ico.bits);

    // Left column: humidity drop icon at (3, 41)  [11×16]
    u8g2.drawXBM(3, 41, 11, 16, WEATHER_HUMID_ICON);

    // Right column: condition icon centered in x=76..127 (52 px wide)
    uint8_t riX = 76 + (52 - ico.width) / 2;
    u8g2.drawXBM(riX, 18, ico.width, 16, ico.bits);

    // --- Left column text ---
    u8g2.setFont(u8g2_font_4x6_tr);
    u8g2.drawStr(23, 24, "AQI");

    char aqiBuf[8];
    if (_aqi >= 0)
        snprintf(aqiBuf, sizeof(aqiBuf), "%d", (int)_aqi);
    else
        strlcpy(aqiBuf, "--", sizeof(aqiBuf));
    u8g2.setFont(u8g2_font_profont10_tr);
    u8g2.drawStr(23, 33, aqiBuf);

    u8g2.setFont(u8g2_font_4x6_tr);
    u8g2.drawStr(23, 47, "Humidity");

    char humBuf[8];
    snprintf(humBuf, sizeof(humBuf), "%u %%", (unsigned)_humidity);
    u8g2.setFont(u8g2_font_profont10_tr);
    u8g2.drawStr(22, 56, humBuf);

    // --- Right column text ---
    u8g2.setFont(u8g2_font_4x6_tr);
    uint8_t lblW = u8g2.getStrWidth("Temp");
    u8g2.drawStr(76 + (52 - lblW) / 2, 45, "Temp");

    int tempInt = (int)(_temperature + (_temperature >= 0 ? 0.5f : -0.5f));
    char tempBuf[10];
    snprintf(tempBuf, sizeof(tempBuf), "%d \xB0""C", tempInt);
    u8g2.setFont(u8g2_font_profont10_tr);
    uint8_t tempValW = u8g2.getStrWidth(tempBuf);
    u8g2.drawStr(76 + (52 - tempValW) / 2, 53, tempBuf);

    u8g2.setFontMode(0);
    u8g2.setBitmapMode(0);

    rotateBuffer180();
    u8g2.sendBuffer();
}

// ==========================================================================
//  Enter: cache check → optional fetch → draw
// ==========================================================================
void weatherScreenEnter() {
    unsigned long now = millis();
    bool stale = (!_hasData) || (now - _lastFetchMs >= WEATHER_CACHE_MS);

    if (!stale) {
        weatherScreenDraw();
        return;
    }

    // Show loading indicator while fetching
    showText("[ Weather ]", "", "Loading...", "");

    bool ok = fetchWeatherData();
    if (ok) {
        _hasData    = true;
        _lastFetchMs = millis();
    } else {
        // Keep stale data if we have it; otherwise show error
        if (!_hasData) {
            showText("[ Weather ]", "", "Fetch failed.", "Check Wi-Fi");
            return;
        }
        // Draw with stale data
    }

    weatherScreenDraw();
}

// ==========================================================================
//  Invalidate cache (call after location change)
// ==========================================================================
void weatherScreenInvalidateCache() {
    _hasData    = false;
    _lastFetchMs = 0;
}
