// ==========================================================================
//  QBIT -- NVS settings
// ==========================================================================
#include "settings.h"
#include "gif_player.h"
#include <Preferences.h>
#include <WiFi.h>

// ==========================================================================
//  Internal state
// ==========================================================================
static Preferences _prefs;
static bool        _prefsReady = false;

// GPIO pin defaults (ESP32-C3 Super Mini)
static uint8_t _pinTouch  = 1;
static uint8_t _pinBuzzer = 2;
static uint8_t _pinSDA    = 20;
static uint8_t _pinSCL    = 21;

// Display
static uint8_t _brightness = 0x80;

// Buzzer
static uint8_t _buzzerVolume = 100;
static uint8_t _savedVolume  = 100;  // stored volume before mute

// Device
static String _deviceId;
static String _deviceName;

// MQTT
static String   _mqttHost;
static uint16_t _mqttPort    = 1883;
static String   _mqttUser;
static String   _mqttPass;
static String   _mqttPrefix;
static bool     _mqttEnabled = false;

// Timezone
static String  _tzIANA;
static int16_t _tzOffset = 0;  // minutes from UTC

// ==========================================================================
//  Device identity
// ==========================================================================

String getDeviceId() {
    if (_deviceId.length() == 0) {
        uint64_t mac = ESP.getEfuseMac();
        char id[13];
        snprintf(id, sizeof(id), "%04X%08X",
                 (uint16_t)(mac >> 32), (uint32_t)mac);
        _deviceId = String(id);
    }
    return _deviceId;
}

String getDeviceName() {
    return _deviceName;
}

void setDeviceName(const String &name) {
    _deviceName = name;
}

// ==========================================================================
//  AP password (derived from MAC — last 8 hex chars)
// ==========================================================================

String getApPassword() {
    uint64_t mac = ESP.getEfuseMac();
    char pwd[9];
    snprintf(pwd, sizeof(pwd), "%08X", (uint32_t)(mac & 0xFFFFFFFF));
    return String(pwd);
}

// ==========================================================================
//  Init & Load
// ==========================================================================

void settingsInit() {
    _prefs.begin("qbit", false);
    _prefsReady = true;

    // Read GPIO pin config first (needed before hardware init)
    _pinTouch  = _prefs.getUChar("pinTouch",  1);
    _pinBuzzer = _prefs.getUChar("pinBuzzer", 2);
    _pinSDA    = _prefs.getUChar("pinSDA",    20);
    _pinSCL    = _prefs.getUChar("pinSCL",    21);

    Serial.printf("GPIO pins: touch=%u buzzer=%u sda=%u scl=%u\n",
                  _pinTouch, _pinBuzzer, _pinSDA, _pinSCL);
}

void loadSettings() {
    if (!_prefsReady) {
        settingsInit();
    }

    _brightness   = _prefs.getUChar("bright", 0x80);
    _buzzerVolume = _prefs.getUChar("volume", 100);
    _savedVolume  = _buzzerVolume > 0 ? _buzzerVolume : 100;
    uint16_t speed = _prefs.getUShort("speed", 5);

    // Device name
    String defaultName = "QBIT-" + getDeviceId().substring(0, 4);
    _deviceName = _prefs.getString("devname", defaultName);

    // MQTT
    _mqttHost    = _prefs.getString("mqttHost", "");
    _mqttPort    = _prefs.getUShort("mqttPort", 1883);
    _mqttUser    = _prefs.getString("mqttUser", "");
    _mqttPass    = _prefs.getString("mqttPass", "");
    _mqttPrefix  = _prefs.getString("mqttPfx",  "qbit");
    _mqttEnabled = _prefs.getBool("mqttOn", false);

    // Timezone
    _tzIANA   = _prefs.getString("tzName", "");
    _tzOffset = _prefs.getShort("tzOffset", 0);

    // Apply speed
    gifPlayerSetSpeed(speed);

    Serial.printf("Settings loaded: bright=%u vol=%u speed=%u\n",
                  _brightness, _buzzerVolume, speed);
    Serial.printf("Device ID: %s  Name: %s\n",
                  getDeviceId().c_str(), _deviceName.c_str());
    if (_mqttEnabled && _mqttHost.length() > 0) {
        Serial.printf("MQTT: %s:%u (prefix: %s)\n",
                      _mqttHost.c_str(), _mqttPort, _mqttPrefix.c_str());
    }
}

void saveSettings() {
    if (!_prefsReady) return;
    _prefs.putUShort("speed",    gifPlayerGetSpeed());
    _prefs.putUChar("bright",    _brightness);
    _prefs.putUChar("volume",    _buzzerVolume);
    _prefs.putString("devname",  _deviceName);
    _prefs.putString("mqttHost", _mqttHost);
    _prefs.putUShort("mqttPort", _mqttPort);
    _prefs.putString("mqttUser", _mqttUser);
    _prefs.putString("mqttPass", _mqttPass);
    _prefs.putString("mqttPfx",  _mqttPrefix);
    _prefs.putBool("mqttOn",     _mqttEnabled);
    _prefs.putUChar("pinTouch",  _pinTouch);
    _prefs.putUChar("pinBuzzer", _pinBuzzer);
    _prefs.putUChar("pinSDA",    _pinSDA);
    _prefs.putUChar("pinSCL",    _pinSCL);
    _prefs.putString("tzName",   _tzIANA);
    _prefs.putShort("tzOffset",  _tzOffset);
    Serial.println("Settings saved to NVS");
}

// ==========================================================================
//  GPIO pin getters / setters
// ==========================================================================

uint8_t getPinTouch()  { return _pinTouch; }
uint8_t getPinBuzzer() { return _pinBuzzer; }
uint8_t getPinSDA()    { return _pinSDA; }
uint8_t getPinSCL()    { return _pinSCL; }

void setPinConfig(uint8_t touch, uint8_t buzzer, uint8_t sda, uint8_t scl) {
    if (!_prefsReady) return;
    _pinTouch  = touch;
    _pinBuzzer = buzzer;
    _pinSDA    = sda;
    _pinSCL    = scl;
    _prefs.putUChar("pinTouch",  _pinTouch);
    _prefs.putUChar("pinBuzzer", _pinBuzzer);
    _prefs.putUChar("pinSDA",    _pinSDA);
    _prefs.putUChar("pinSCL",    _pinSCL);
    Serial.println("Pin config saved -- rebooting...");
    delay(500);
    ESP.restart();
}

// ==========================================================================
//  Display brightness
// ==========================================================================

void setDisplayBrightnessVal(uint8_t val) { _brightness = val; }
uint8_t getDisplayBrightnessVal() { return _brightness; }

// ==========================================================================
//  Buzzer volume
// ==========================================================================

void setBuzzerVolume(uint8_t pct) {
    _buzzerVolume = pct > 100 ? 100 : pct;
}

uint8_t getBuzzerVolume() { return _buzzerVolume; }

uint8_t getSavedVolume() { return _savedVolume; }
void    setSavedVolume(uint8_t vol) { _savedVolume = vol; }

// ==========================================================================
//  Playback speed
// ==========================================================================

void setPlaybackSpeed(uint16_t val) { gifPlayerSetSpeed(val); }
uint16_t getPlaybackSpeed() { return gifPlayerGetSpeed(); }

// ==========================================================================
//  MQTT configuration
// ==========================================================================

String   getMqttHost()    { return _mqttHost; }
uint16_t getMqttPort()    { return _mqttPort; }
String   getMqttUser()    { return _mqttUser; }
String   getMqttPass()    { return _mqttPass; }
String   getMqttPrefix()  { return _mqttPrefix; }
bool     getMqttEnabled() { return _mqttEnabled; }

void setMqttConfig(const String &host, uint16_t port,
                   const String &user, const String &pass,
                   const String &prefix, bool enabled) {
    _mqttHost    = host;
    _mqttPort    = port;
    _mqttUser    = user;
    _mqttPass    = pass;
    _mqttPrefix  = prefix;
    _mqttEnabled = enabled;
}

// ==========================================================================
//  Timezone
// ==========================================================================

String  getTimezoneIANA()  { return _tzIANA; }
void    setTimezoneIANA(const String &tz) { _tzIANA = tz; }
int16_t getTimezoneOffset() { return _tzOffset; }
void    setTimezoneOffset(int16_t minutes) { _tzOffset = minutes; }
