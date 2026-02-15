// ==========================================================================
//  QBIT -- NVS settings API
// ==========================================================================
#ifndef SETTINGS_H
#define SETTINGS_H

#include <Arduino.h>

// Initialize NVS (opens Preferences namespace "qbit").
// Must be called before any other settings function.
void settingsInit();

// Load all settings from NVS into RAM variables.
void loadSettings();

// Persist current RAM settings to NVS.
void saveSettings();

// --- Device identity ---
String getDeviceId();
String getDeviceName();
void   setDeviceName(const String &name);

// --- AP password (derived from MAC) ---
String getApPassword();

// --- GPIO pin configuration ---
uint8_t getPinTouch();
uint8_t getPinBuzzer();
uint8_t getPinSDA();
uint8_t getPinSCL();
void    setPinConfig(uint8_t touch, uint8_t buzzer, uint8_t sda, uint8_t scl);

// --- Display brightness ---
void    setDisplayBrightnessVal(uint8_t val);
uint8_t getDisplayBrightnessVal();

// --- Buzzer volume ---
void    setBuzzerVolume(uint8_t pct);
uint8_t getBuzzerVolume();

// --- Playback speed ---
void     setPlaybackSpeed(uint16_t val);
uint16_t getPlaybackSpeed();

// --- MQTT configuration ---
String   getMqttHost();
uint16_t getMqttPort();
String   getMqttUser();
String   getMqttPass();
String   getMqttPrefix();
bool     getMqttEnabled();
void     setMqttConfig(const String &host, uint16_t port,
                       const String &user, const String &pass,
                       const String &prefix, bool enabled);

// --- Timezone ---
String  getTimezoneIANA();
void    setTimezoneIANA(const String &tz);

// --- Mute state (saved volume for toggle) ---
uint8_t getSavedVolume();
void    setSavedVolume(uint8_t vol);

#endif // SETTINGS_H
