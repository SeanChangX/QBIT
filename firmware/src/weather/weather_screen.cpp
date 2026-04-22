// ==========================================================================
//  QBIT -- Weather screen implementation
//
//  Layout (128x64, U8G2 y = baseline):
//    y= 0-11  : Bracketed location title centered  [ <location> ]
//    y=14-45  : Left area shows enlarged 2x weather condition icon
//    y=18-58  : Right area shows AQI face icon + AQI value + humidity
//    y=59     : Temperature value only (degree marker drawn manually)
//
//  APIs used (plain HTTP, no HTTPS — avoids cert overhead on ESP32-C3):
//    Weather: http://api.open-meteo.com  (redirects to HTTPS internally)
//    AQI:     http://air-quality-api.open-meteo.com
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
//  Current visual style is intentionally "info-only" (no frame or dividers).
//  Content is arranged in two logical columns using `dividerX`:
//    - Left side: large condition icon and temperature value
//    - Right side: AQI icon/value and humidity
// ==========================================================================
void weatherScreenDraw() {
    if (!_hasData) {
        showText("[ Weather ]", "", "No data.", "TAP = refresh  2x = menu");
        return;
    }

    u8g2.clearBuffer();
    u8g2.setFontMode(1);   // transparent — text doesn't black out background
    u8g2.setBitmapMode(1); // transparent — XBM doesn't black out background

    const uint8_t dividerX = 54;          // logical split; no divider line is drawn
    const uint8_t leftW = dividerX;
    const uint8_t rightX = dividerX + 1;

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
    drawXbm2x(liX, 14, ico.width, 16, ico.bits);

    // --- Right column text (AQI + Humidity) ---
    drawAqiIcon(rightX + 2, 18, _aqi);
    u8g2.drawXBM(rightX + 2, 41, 11, 16, WEATHER_HUMID_ICON);

    u8g2.setFont(u8g2_font_5x8_tr);
    u8g2.drawStr(rightX + 14, 25, "EU AQI");

    char aqiBuf[8];
    if (_aqi >= 0)
        snprintf(aqiBuf, sizeof(aqiBuf), "%d", (int)_aqi);
    else
        strlcpy(aqiBuf, "--", sizeof(aqiBuf));
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(rightX + 14, 35, aqiBuf);

    u8g2.setFont(u8g2_font_5x8_tr);
    u8g2.drawStr(rightX + 14, 48, "Humidity");

    char humBuf[8];
    snprintf(humBuf, sizeof(humBuf), "%u %%", (unsigned)_humidity);
    u8g2.setFont(u8g2_font_6x10_tr);
    u8g2.drawStr(rightX + 14, 58, humBuf);

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
    int tempY = 59;
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
            showText("[ Weather ]", "", "Fetch failed.", "TAP = retry  2x = menu");
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
