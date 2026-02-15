#ifndef WEB_DASHBOARD_H
#define WEB_DASHBOARD_H

#include <ESPAsyncWebServer.h>

// Register all QBIT dashboard routes on the shared AsyncWebServer.
//
// Static assets (served from LittleFS):
//   GET  /                  -- dashboard UI
//   GET  /style.css         -- stylesheet
//   GET  /script.js         -- client-side logic
//   GET  /inter-latin.woff2 -- Inter font (latin subset)
//
// REST API:
//   GET  /api/list    -- JSON array of .qgif files
//   GET  /api/storage -- JSON storage info  {total, used, free}
//   POST /api/upload  -- multipart .qgif upload
//   POST /api/delete  -- delete a file      (?name=xxx)
//   POST /api/play    -- select file to play (?name=xxx)
//   GET  /api/settings       -- JSON {speed, brightness, volume}
//   POST /api/settings       -- apply settings live (RAM only)
//   POST /api/settings?save=1 -- also persist current settings to NVS
//   GET  /api/timezone       -- JSON {timezone, offset}
//   POST /api/timezone?tz=   -- set timezone IANA name
void webDashboardInit(AsyncWebServer &server);

// Settings callbacks -- implemented by settings.cpp / display_helpers.cpp.
extern void     setPlaybackSpeed(uint16_t val);
extern uint16_t getPlaybackSpeed();
extern void     setDisplayBrightness(uint8_t val);
extern uint8_t  getDisplayBrightness();
extern void     setBuzzerVolume(uint8_t pct);
extern uint8_t  getBuzzerVolume();
extern void     saveSettings();

// Device identity -- implemented by settings.cpp.
extern String getDeviceId();
extern String getDeviceName();
extern void   setDeviceName(const String &name);

// Local MQTT settings -- implemented by settings.cpp.
extern String   getMqttHost();
extern uint16_t getMqttPort();
extern String   getMqttUser();
extern String   getMqttPass();
extern String   getMqttPrefix();
extern bool     getMqttEnabled();
extern void     setMqttConfig(const String &host, uint16_t port,
                              const String &user, const String &pass,
                              const String &prefix, bool enabled);

// GPIO pin configuration -- implemented by settings.cpp.
extern uint8_t getPinTouch();
extern uint8_t getPinBuzzer();
extern uint8_t getPinSDA();
extern uint8_t getPinSCL();
extern void    setPinConfig(uint8_t touch, uint8_t buzzer,
                            uint8_t sda, uint8_t scl);

// Timezone -- implemented by settings.cpp / time_manager.cpp.
extern String  getTimezoneIANA();
extern void    setTimezoneIANA(const String &tz);
extern int16_t getTimezoneOffset();

// Time manager -- implemented by time_manager.cpp.
extern void timeManagerSetTimezone(const String &ianaTz);

#endif // WEB_DASHBOARD_H
