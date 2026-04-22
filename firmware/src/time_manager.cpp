// ==========================================================================
//  QBIT -- NTP time & timezone
// ==========================================================================
#include "time_manager.h"
#include "settings.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <cstring>
#include <time.h>

// ==========================================================================
//  IANA → POSIX TZ lookup (common timezones)
// ==========================================================================

struct TzEntry {
    const char *iana;
    const char *posix;
};

static const TzEntry TZ_TABLE[] = {
    {"Pacific/Midway",       "SST11"},
    {"Pacific/Honolulu",     "HST10"},
    {"America/Anchorage",    "AKST9AKDT,M3.2.0,M11.1.0"},
    {"America/Los_Angeles",  "PST8PDT,M3.2.0,M11.1.0"},
    {"America/Denver",       "MST7MDT,M3.2.0,M11.1.0"},
    {"America/Phoenix",      "MST7"},
    {"America/Chicago",      "CST6CDT,M3.2.0,M11.1.0"},
    {"America/New_York",     "EST5EDT,M3.2.0,M11.1.0"},
    {"America/Sao_Paulo",    "<-03>3"},
    {"Atlantic/Reykjavik",   "GMT0"},
    {"Europe/London",        "GMT0BST,M3.5.0/1,M10.5.0"},
    {"Europe/Paris",         "CET-1CEST,M3.5.0,M10.5.0/3"},
    {"Europe/Berlin",        "CET-1CEST,M3.5.0,M10.5.0/3"},
    {"Europe/Helsinki",      "EET-2EEST,M3.5.0/3,M10.5.0/4"},
    {"Europe/Moscow",        "MSK-3"},
    {"Asia/Dubai",           "<+04>-4"},
    {"Asia/Kolkata",         "IST-5:30"},
    {"Asia/Bangkok",         "<+07>-7"},
    {"Asia/Shanghai",        "CST-8"},
    {"Asia/Taipei",          "CST-8"},
    {"Asia/Hong_Kong",       "HKT-8"},
    {"Asia/Singapore",       "<+08>-8"},
    {"Asia/Tokyo",           "JST-9"},
    {"Asia/Seoul",           "KST-9"},
    {"Australia/Sydney",     "AEST-10AEDT,M10.1.0,M4.1.0/3"},
    {"Australia/Perth",      "AWST-8"},
    {"Pacific/Auckland",     "NZST-12NZDT,M9.5.0,M4.1.0/3"},
    {"Etc/UTC",              "UTC0"},
    {nullptr, nullptr}
};

static const char* ianaToPosix(const String &iana) {
    for (int i = 0; TZ_TABLE[i].iana != nullptr; i++) {
        if (iana == TZ_TABLE[i].iana) {
            return TZ_TABLE[i].posix;
        }
    }
    return nullptr;
}

// ==========================================================================
//  Implementation
// ==========================================================================

void timeManagerInit() {
    configTime(0, 0, "time.google.com", "time.cloudflare.com");

    // Apply stored timezone if available
    String storedTz = getTimezoneIANA();
    if (storedTz.length() > 0) {
        const char *posix = ianaToPosix(storedTz);
        if (posix) {
            setenv("TZ", posix, 1);
            tzset();
        }
    }
}

bool timeManagerSynced() {
    return time(nullptr) > 24 * 3600;
}

void timeManagerSetTimezone(const String &ianaTz) {
    setTimezoneIANA(ianaTz);
    const char *posix = ianaToPosix(ianaTz);
    if (posix) {
        setenv("TZ", posix, 1);
        tzset();
        Serial.printf("[TZ] Set timezone: %s → %s\n", ianaTz.c_str(), posix);
    } else {
        Serial.printf("[TZ] Unknown IANA timezone: %s\n", ianaTz.c_str());
    }
}

void timeManagerDetectTimezone() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[TZ] WiFi not connected, skipping detection");
        return;
    }

    const bool wantTz      = (getTimezoneIANA().length() == 0);
    const bool wantWeather = !getWeatherManual();
    if (!wantTz && !wantWeather) {
        return;
    }

    HTTPClient http;
    http.begin(
        "http://ip-api.com/json/?fields=status,message,timezone,lat,lon,city,countryCode");
    http.setTimeout(5000);
    int httpCode = http.GET();

    if (httpCode == 200) {
        String payload = http.getString();
        StaticJsonDocument<512> doc;
        if (!deserializeJson(doc, payload)) {
            const char *st = doc["status"].is<const char *>() ? doc["status"].as<const char *>() : "";
            if (st[0] != '\0' && strcmp(st, "success") != 0) {
                const char *msg = doc["message"].is<const char *>() ? doc["message"].as<const char *>() : "";
                Serial.printf("[TZ] ip-api status=%s msg=%s\n", st, msg);
            } else {
                bool changed = false;

                if (wantTz) {
                    const char *tz = doc["timezone"].is<const char *>() ? doc["timezone"].as<const char *>() : "";
                    if (tz[0] != '\0') {
                        Serial.printf("[TZ] Detected timezone: %s\n", tz);
                        timeManagerSetTimezone(String(tz));
                        changed = true;
                    }
                }

                if (wantWeather && !doc["lat"].isNull() && !doc["lon"].isNull()) {
                    float lat = doc["lat"].as<float>();
                    float lon = doc["lon"].as<float>();
                    String city;
                    if (doc["city"].is<const char *>()) {
                        city = String(doc["city"].as<const char *>());
                    }
                    city.trim();
                    if (city.length() == 0) {
                        city = "IP";
                    }
                    String disp = city;
                    if (doc["countryCode"].is<const char *>()) {
                        const char *cc = doc["countryCode"].as<const char *>();
                        if (cc && cc[0] != '\0') {
                            disp += ", ";
                            disp += cc;
                        }
                    }
                    Serial.printf("[WEATHER] IP location: %s (%.4f, %.4f)\n",
                                  disp.c_str(), lat, lon);
                    setWeatherLocation(lat, lon, city, disp);
                    changed = true;
                }

                if (changed) {
                    saveSettings();
                    http.end();
                    return;
                }
            }
        }
    }

    http.end();
    Serial.println("[TZ] Auto-detection failed, using NVS fallback");

    // Fallback to stored timezone
    String storedTz = getTimezoneIANA();
    if (storedTz.length() > 0) {
        timeManagerSetTimezone(storedTz);
    }
}

String timeManagerGetFormatted() {
    time_t now = time(nullptr);
    struct tm timeinfo;
    localtime_r(&now, &timeinfo);
    char buf[12];
    if (getTimeFormat24h()) {
        strftime(buf, sizeof(buf), "%H:%M", &timeinfo);
    } else {
        strftime(buf, sizeof(buf), "%I:%M %p", &timeinfo);
    }
    return String(buf);
}

String timeManagerGetDateFormatted() {
    time_t now = time(nullptr);
    struct tm timeinfo;
    localtime_r(&now, &timeinfo);
    char buf[11];
    strftime(buf, sizeof(buf), "%Y-%m-%d", &timeinfo);
    return String(buf);
}

time_t timeManagerNow() {
    return time(nullptr);
}

String timeManagerGetISO8601() {
    time_t now = time(nullptr);
    struct tm timeinfo;
    localtime_r(&now, &timeinfo);
    char buf[25];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &timeinfo);
    return String(buf);
}
