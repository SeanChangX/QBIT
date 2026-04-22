// ==========================================================================
//  QBIT -- Weather screen implementation
//
//  Layout (128x64, U8G2 y = baseline):
//    y≈10     : Location title; ~3px gap below, then main content.
//    Left: 2x condition icon from y≈17; temperature baseline ~62 (fits 64 rows).
//    Right: small icons ~x=58, text from x=75 (gap after icons; strings fit <128).
//
//  APIs used (plain HTTP, no HTTPS — avoids cert overhead on ESP32-C3):
//    Weather: http://api.open-meteo.com  (redirects to HTTPS internally)
//    AQI:     http://air-quality-api.open-meteo.com (European AQI index)
//
//  NOTE: We use plain http:// so WiFiClient (not WiFiClientSecure) is
//  sufficient, keeping RAM usage low.  HTTPClient follows redirects like the
//  geocoding handler in web_dashboard.cpp.
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
// Open-Meteo refetch interval (enter screen, background tick while staying on it).
#define WEATHER_CACHE_MS           (60UL * 60UL * 1000UL) // 1 hour
// After a stale fetch fails, wait before retrying (avoids hammering APIs / Wi-Fi).
#define WEATHER_RETRY_INTERVAL_MS  (60UL * 1000UL)        // 1 minute
#define WEATHER_HTTP_TIMEOUT       8000                   // 8 s per request

// ==========================================================================
//  Cached weather data
// ==========================================================================
static unsigned long _lastFetchMs     = 0;
static bool          _hasData         = false;

static float    _temperature          = 0.0f;
static uint8_t  _humidity             = 0;
static uint8_t  _wmoCode              = 0;
static int16_t  _aqi                  = -1;   // European AQI; -1 = unavailable

static void drawXbm2x(int x, int y, uint8_t w, uint8_t h, const uint8_t *bits) {
    uint8_t bytesPerRow = (w + 7) >> 3;
    for (uint8_t py = 0; py < h; py++) {
        for (uint8_t px = 0; px < w; px++) {
            uint16_t idx = (uint16_t)py * bytesPerRow + (px >> 3);
            uint8_t b = pgm_read_byte(bits + idx);
            if (b & (1U << (px & 7))) {
                u8g2.drawBox(x + (px * 2), y + (py * 2), 2, 2);
            }
        }
    }
}

// Map European AQI score to 1..5 quality level (5 = worst).
static uint8_t getAqiLevel(int16_t aqi) {
    if (aqi < 0)   return 0;
    if (aqi <= 20) return 1;
    if (aqi <= 40) return 2;
    if (aqi <= 60) return 3;
    if (aqi <= 80) return 4;
    return 5;
}

// Tiny AQI icon: face-style mood changes with AQI quality.
static void drawAqiIcon(int x, int y, int16_t aqi) {
    u8g2.drawCircle(x + 5, y + 5, 5, U8G2_DRAW_ALL);
    uint8_t level = getAqiLevel(aqi);

    // Eyes
    u8g2.drawPixel(x + 3, y + 4);
    u8g2.drawPixel(x + 7, y + 4);

    if (level == 0) {
        // Unknown AQI: neutral dash mouth.
        u8g2.drawHLine(x + 3, y + 8, 5);
        return;
    }

    if (level <= 2) {
        // Good/Fair: smile
        u8g2.drawPixel(x + 3, y + 7);
        u8g2.drawPixel(x + 4, y + 8);
        u8g2.drawPixel(x + 5, y + 8);
        u8g2.drawPixel(x + 6, y + 8);
        u8g2.drawPixel(x + 7, y + 7);
    } else if (level == 3) {
        // Moderate: flat
        u8g2.drawHLine(x + 3, y + 8, 5);
    } else {
        // Poor/Very poor: sad
        u8g2.drawPixel(x + 3, y + 9);
        u8g2.drawPixel(x + 4, y + 8);
        u8g2.drawPixel(x + 5, y + 8);
        u8g2.drawPixel(x + 6, y + 8);
        u8g2.drawPixel(x + 7, y + 9);
        if (level == 5) {
            // Very poor: add eyebrows
            u8g2.drawLine(x + 2, y + 3, x + 4, y + 2);
            u8g2.drawLine(x + 6, y + 2, x + 8, y + 3);
        }
    }
}

// ==========================================================================
//  HTTP GET helper (returns body string or empty on error)
// ==========================================================================
static String httpGet(const char *url) {
    HTTPClient http;
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.setTimeout(WEATHER_HTTP_TIMEOUT);
    http.begin(url);
    int code = http.GET();
    String body;
    if (code >= 200 && code < 300) {
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

    _aqi = -1;
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
//  Current visual style is intentionally "info-only" (no frame or dividers).
//  Content is arranged in two logical columns using `dividerX`:
//    - Left side: large condition icon and temperature value
//    - Right side: AQI + humidity (icons then spaced text, within 128px width)
// ==========================================================================
void weatherScreenDraw() {
    if (!_hasData) {
        showText("[ Weather ]", "", "No data.", "Re-enter to refresh  2x = menu");
        return;
    }

    u8g2.clearBuffer();
    u8g2.setFontMode(1);   // transparent — text doesn't black out background
    u8g2.setBitmapMode(1); // transparent — XBM doesn't black out background

    const uint8_t dividerX = 54;          // logical split; no divider line is drawn
    const uint8_t leftW = dividerX;
    const uint8_t rightX = dividerX + 1;

    // Vertical: extra space below title before main blocks (~3px).
    const uint8_t kGapBelowTitle = 3;
    const uint8_t yIconMain     = 14 + kGapBelowTitle;   // big condition icon (2x16 → ~48px tall)
    const uint8_t yAqiIcon      = 18 + kGapBelowTitle;
    const uint8_t yAqiLabel     = 25 + kGapBelowTitle;
    const uint8_t yAqiValue     = 35 + kGapBelowTitle;
    const uint8_t yHumidIcon    = 41 + kGapBelowTitle;
    const uint8_t yHumidLabel   = 48 + kGapBelowTitle;
    const uint8_t yHumidValue   = 58 + kGapBelowTitle;

    // Right column: small icons (~11px) then a clear gap before text (fits in 128px).
    const uint8_t rightIconX = rightX + 3;
    const uint8_t rightTextX = rightIconX + 11 + 6; // icon width + gap

    // --- Top bar: location name ---
    u8g2.setFont(u8g2_font_6x10_tr);
    String locName = getWeatherDisplayName();
    String title = "[ " + locName + " ]";
    while (title.length() > 0 && u8g2.getStrWidth(title.c_str()) > 126) {
        if (locName.length() > 3) {
            locName = locName.substring(0, locName.length() - 1);
            title = "[ " + locName + "... ]";
        } else {
            break;
        }
    }
    uint8_t locW = u8g2.getStrWidth(title.c_str());
    u8g2.drawStr((128 - locW) / 2, 10, title.c_str());

    // --- Condition icon ---
    WeatherIconInfo ico = getWeatherIcon(_wmoCode);

    // Left column: enlarged condition icon
    uint8_t iconW = ico.width * 2;
    uint8_t liX = (leftW - iconW) / 2;
    drawXbm2x(liX, yIconMain, ico.width, 16, ico.bits);

    // --- Right column (AQI + Humidity) ---
    drawAqiIcon(rightIconX, yAqiIcon, _aqi);
    u8g2.drawXBM(rightIconX, yHumidIcon, 11, 16, WEATHER_HUMID_ICON);

    u8g2.setFont(u8g2_font_5x8_tr);
    u8g2.drawStr(rightTextX, yAqiLabel, "EU AQI");

    char aqiBuf[8];
    if (_aqi >= 0)
        snprintf(aqiBuf, sizeof(aqiBuf), "%d", (int)_aqi);
    else
        strlcpy(aqiBuf, "--", sizeof(aqiBuf));
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(rightTextX, yAqiValue, aqiBuf);

    u8g2.setFont(u8g2_font_5x8_tr);
    u8g2.drawStr(rightTextX, yHumidLabel, "Humidity");

    char humBuf[8];
    snprintf(humBuf, sizeof(humBuf), "%u%%", (unsigned)_humidity);
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(rightTextX, yHumidValue, humBuf);

    int tempInt = (int)(_temperature + (_temperature >= 0 ? 0.5f : -0.5f));
    char tempNumBuf[8];
    // Some u8g2 fonts don't include the degree glyph; draw it manually.
    snprintf(tempNumBuf, sizeof(tempNumBuf), "%d", tempInt);
    u8g2.setFont(u8g2_font_7x14B_tr);
    uint8_t numW = u8g2.getStrWidth(tempNumBuf);
    uint8_t cW = u8g2.getStrWidth("C");
    const uint8_t unitGap = 4; // visual space between number and C
    uint8_t tempValW = numW + unitGap + cW;
    int tempX = (leftW - tempValW) / 2;
    int tempY = 62;
    int cX = tempX + numW + unitGap;
    u8g2.drawStr(tempX, tempY, tempNumBuf);
    u8g2.drawStr(cX, tempY, "C");
    // Degree marker sits in the gap before 'C' to avoid overlap.
    int degX = cX - 2;
    int degY = tempY - 11;
    u8g2.drawCircle(degX, degY, 1, U8G2_DRAW_ALL);

    u8g2.setFontMode(0);
    u8g2.setBitmapMode(0);

    rotateBuffer180();
    u8g2.sendBuffer();
}

bool weatherScreenRefreshNow() {
    bool ok = fetchWeatherData();
    if (ok) {
        _hasData = true;
        _lastFetchMs = millis();
    }
    return ok;
}

// ==========================================================================
//  While on WEATHER_SCREEN: hourly background refresh (no full-screen "Loading")
// ==========================================================================
void weatherScreenIdleTick() {
    if (WiFi.status() != WL_CONNECTED)
        return;
    if (!_hasData)
        return;

    unsigned long now = millis();
    if ((unsigned long)(now - _lastFetchMs) < WEATHER_CACHE_MS)
        return;

    static unsigned long s_lastAttemptMs = 0;
    if (s_lastAttemptMs != 0 &&
        (unsigned long)(now - s_lastAttemptMs) < WEATHER_RETRY_INTERVAL_MS) {
        return;
    }
    s_lastAttemptMs = now;

    if (weatherScreenRefreshNow())
        weatherScreenDraw();
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

    bool ok = weatherScreenRefreshNow();
    if (!ok) {
        // Keep stale data if we have it; otherwise show error
        if (!_hasData) {
            showText("[ Weather ]", "", "Fetch failed.", "Re-enter to retry");
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
