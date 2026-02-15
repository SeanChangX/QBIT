// ==========================================================================
//  QBIT -- NTP time & timezone management
// ==========================================================================
#ifndef TIME_MANAGER_H
#define TIME_MANAGER_H

#include <Arduino.h>

// Initialize NTP sync (call after WiFi connects).
void timeManagerInit();

// Returns true if NTP time has been synchronized.
bool timeManagerSynced();

// Set POSIX TZ string and apply it. Also saves IANA name to NVS.
void timeManagerSetTimezone(const String &ianaTz);

// Auto-detect timezone via ip-api.com HTTP request.
// Falls back to NVS-stored value on failure.
void timeManagerDetectTimezone();

// Get formatted local time "HH:MM".
String timeManagerGetFormatted();

// Get formatted local date "YYYY-MM-DD".
String timeManagerGetDateFormatted();

// Get current time_t (UTC).
time_t timeManagerNow();

// Get ISO 8601 timestamp string for MQTT payloads.
String timeManagerGetISO8601();

#endif // TIME_MANAGER_H
