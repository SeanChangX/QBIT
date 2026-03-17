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
#define WEATHER_ICON_W        24
#define WEATHER_ICON_H        24
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
// ==========================================================================
void weatherScreenDraw() {
    if (!_hasData) {
        showText("[ Weather ]", "", "No data.", "Tap HOLD to retry");
        return;
    }

    u8g2.clearBuffer();

    // ------------------------------------------------------------------
    //  1.  Location name – top, centered
    // ------------------------------------------------------------------
    String locName = getWeatherDisplayName();
    // Truncate to 20 chars to guarantee it fits in 120 px at 6x13
    if (locName.length() > 20) locName = locName.substring(0, 17) + "...";
    u8g2.setFont(u8g2_font_6x13_tr);
    uint8_t locW = u8g2.getStrWidth(locName.c_str());
    u8g2.drawStr((128 - locW) / 2, 11, locName.c_str());

    // ------------------------------------------------------------------
    //  2.  Weather icon – 24×24 at x=3, y=13
    // ------------------------------------------------------------------
    const uint8_t *icon = getWeatherIcon(_wmoCode);
    u8g2.setBitmapMode(1);
    u8g2.drawXBM(3, 13, WEATHER_ICON_W, WEATHER_ICON_H, icon);
    u8g2.setBitmapMode(0);

    // ------------------------------------------------------------------
    //  3.  AQI & Humidity – right side, right-aligned
    // ------------------------------------------------------------------
    u8g2.setFont(u8g2_font_6x10_tr);

    char aqiBuf[12];
    if (_aqi >= 0) {
        snprintf(aqiBuf, sizeof(aqiBuf), "AQI:%d", (int)_aqi);
    } else {
        snprintf(aqiBuf, sizeof(aqiBuf), "AQI:--");
    }
    uint8_t aqiW = u8g2.getStrWidth(aqiBuf);
    u8g2.drawStr(126 - aqiW, 24, aqiBuf);

    char humBuf[10];
    snprintf(humBuf, sizeof(humBuf), "Hum:%u%%", (unsigned)_humidity);
    uint8_t humW = u8g2.getStrWidth(humBuf);
    u8g2.drawStr(126 - humW, 36, humBuf);

    // ------------------------------------------------------------------
    //  4.  Temperature – below icon, centered in icon column (0..30)
    // ------------------------------------------------------------------
    u8g2.setFont(u8g2_font_7x14B_tr);
    char tempBuf[10];
    int tempInt = (int)(_temperature + 0.5f);
    // Degree symbol: font_7x14B_tr is latin1/ISO-8859-1; 0xB0 is the degree glyph.
    snprintf(tempBuf, sizeof(tempBuf), "%d\xB0C", tempInt);
    uint8_t tempW = u8g2.getStrWidth(tempBuf);
    // Center within x=0..29 (icon column + left margin)
    int16_t tempX = (30 - (int16_t)tempW) / 2;
    if (tempX < 0) tempX = 0;
    u8g2.drawStr((uint8_t)tempX, 50, tempBuf);

    // ------------------------------------------------------------------
    //  5.  Separator line
    // ------------------------------------------------------------------
    u8g2.drawHLine(0, 53, 128);

    // ------------------------------------------------------------------
    //  6.  Condition text – bottom, centered
    // ------------------------------------------------------------------
    u8g2.setFont(u8g2_font_6x10_tr);
    const char *cond = getWeatherCondition(_wmoCode);
    // Truncate if needed (max 18 chars at 6px = 108 px wide)
    char condBuf[20];
    strncpy(condBuf, cond, 18);
    condBuf[18] = '\0';
    uint8_t condW = u8g2.getStrWidth(condBuf);
    u8g2.drawStr((128 - condW) / 2, 63, condBuf);

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
