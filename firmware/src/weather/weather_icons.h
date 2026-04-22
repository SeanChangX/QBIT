// ==========================================================================
//  QBIT -- Weather icon bitmaps (U8G2 XBM format, LSB-first)
//
//  Source bitmaps were supplied in Adafruit GFX format (MSB-first).
//  Conversion: reverse bits of every byte.
//
//  Sizes:
//    Clear / Mist  → 15×16 (2 bytes/row, 32 bytes)
//    Snow          → 16×16 (2 bytes/row, 32 bytes)
//    Clouds / Rain / Storm → 17×16 (3 bytes/row, 48 bytes)
//
//  Usage: u8g2.drawXBM(x, y, ico.width, 16, ico.bits)
// ==========================================================================
#ifndef WEATHER_ICONS_H
#define WEATHER_ICONS_H

#include <Arduino.h>
#include <pgmspace.h>

struct WeatherIconInfo {
    const uint8_t *bits;
    uint8_t width;   // 15, 16, or 17  (height is always 16)
};

// --------------------------------------------------------------------------
//  Clear — sun with rays (15×16)
// --------------------------------------------------------------------------
static const uint8_t WEATHER_ICON_CLEAR[] PROGMEM = {
    0x80,0x00,  // row 0
    0x84,0x10,  // row 1
    0x08,0x08,  // row 2
    0xC0,0x01,  // row 3
    0x31,0x46,  // row 4
    0x12,0x24,  // row 5
    0x08,0x08,  // row 6
    0x08,0x08,  // row 7
    0x08,0x08,  // row 8
    0x12,0x24,  // row 9
    0x31,0x46,  // row 10
    0xC0,0x01,  // row 11
    0x08,0x08,  // row 12
    0x84,0x10,  // row 13
    0x80,0x00,  // row 14
    0x00,0x00,  // row 15
};

// --------------------------------------------------------------------------
//  Clouds — cloud with partial sun (17×16)
// --------------------------------------------------------------------------
static const uint8_t WEATHER_ICON_CLOUDS[] PROGMEM = {
    0x00,0x04,0x00,  // row 0
    0x40,0x40,0x00,  // row 1
    0x00,0x0E,0x00,  // row 2
    0x80,0x31,0x00,  // row 3
    0x90,0x20,0x01,  // row 4
    0x40,0x40,0x00,  // row 5
    0x40,0x40,0x00,  // row 6
    0xE0,0x41,0x00,  // row 7
    0x10,0x22,0x01,  // row 8
    0x08,0x34,0x00,  // row 9
    0x0C,0x0C,0x00,  // row 10
    0x06,0x78,0x00,  // row 11
    0x01,0xC0,0x00,  // row 12
    0x01,0x80,0x00,  // row 13
    0x01,0x80,0x00,  // row 14
    0xFE,0x7F,0x00,  // row 15
};

// --------------------------------------------------------------------------
//  Rain — cloud with rain drops (17×16)
// --------------------------------------------------------------------------
static const uint8_t WEATHER_ICON_RAIN[] PROGMEM = {
    0x00,0x00,0x00,  // row 0
    0xE0,0x03,0x00,  // row 1
    0x10,0x04,0x00,  // row 2
    0x08,0x08,0x00,  // row 3
    0x0C,0x10,0x00,  // row 4
    0x02,0x70,0x00,  // row 5
    0x01,0x80,0x00,  // row 6
    0x01,0x00,0x01,  // row 7
    0x02,0x00,0x01,  // row 8
    0xFC,0xFF,0x00,  // row 9
    0x80,0x08,0x00,  // row 10
    0x44,0x44,0x00,  // row 11
    0x22,0x21,0x00,  // row 12
    0x89,0x14,0x00,  // row 13
    0x44,0x02,0x00,  // row 14
    0x00,0x01,0x00,  // row 15
};

// --------------------------------------------------------------------------
//  Thunderstorm — cloud with lightning bolt (17×16)
// --------------------------------------------------------------------------
static const uint8_t WEATHER_ICON_STORM[] PROGMEM = {
    0x00,0x00,0x00,  // row 0
    0xE0,0x03,0x00,  // row 1
    0x10,0x04,0x00,  // row 2
    0x08,0x08,0x00,  // row 3
    0x0C,0x10,0x00,  // row 4
    0x02,0x70,0x00,  // row 5
    0x01,0x81,0x00,  // row 6
    0x81,0x00,0x01,  // row 7
    0xC2,0x00,0x01,  // row 8
    0x64,0xFC,0x00,  // row 9
    0xF0,0x01,0x00,  // row 10
    0x80,0x01,0x00,  // row 11
    0xC0,0x00,0x00,  // row 12
    0x40,0x00,0x00,  // row 13
    0x20,0x00,0x00,  // row 14
    0x00,0x00,0x00,  // row 15
};

// --------------------------------------------------------------------------
//  Mist / Wind (15×16)
// --------------------------------------------------------------------------
static const uint8_t WEATHER_ICON_MIST[] PROGMEM = {
    0x00,0x00,  // row 0
    0x00,0x00,  // row 1
    0x00,0x0C,  // row 2
    0xC0,0x11,  // row 3
    0x20,0x22,  // row 4
    0x20,0x22,  // row 5
    0x00,0x22,  // row 6
    0x00,0x11,  // row 7
    0xFF,0x4C,  // row 8
    0x00,0x00,  // row 9
    0xB5,0x41,  // row 10
    0x00,0x06,  // row 11
    0x00,0x08,  // row 12
    0x00,0x08,  // row 13
    0x80,0x04,  // row 14
    0x00,0x03,  // row 15
};

// --------------------------------------------------------------------------
//  Snow — snowflake / cloud (16×16)
// --------------------------------------------------------------------------
static const uint8_t WEATHER_ICON_SNOW[] PROGMEM = {
    0x00,0x00,  // row 0
    0x00,0x00,  // row 1
    0x80,0x0F,  // row 2
    0x00,0x10,  // row 3
    0xE0,0x73,  // row 4
    0x10,0xC4,  // row 5
    0x10,0x9C,  // row 6
    0x0C,0xB0,  // row 7
    0x02,0xE0,  // row 8
    0x02,0x60,  // row 9
    0x02,0x30,  // row 10
    0x06,0x18,  // row 11
    0xFC,0x0F,  // row 12
    0x00,0x00,  // row 13
    0x00,0x00,  // row 14
    0x00,0x00,  // row 15
};

// --------------------------------------------------------------------------
//  Humidity water-drop (11×16, XBM LSB-first)
// --------------------------------------------------------------------------
static const uint8_t WEATHER_HUMID_ICON[] PROGMEM = {
    0x20, 0x00, 0x20, 0x00, 0x30, 0x00, 0x50, 0x00,
    0x48, 0x00, 0x88, 0x00, 0x04, 0x01, 0x04, 0x01,
    0x82, 0x02, 0x02, 0x03, 0x01, 0x05, 0x01, 0x04,
    0x02, 0x02, 0x02, 0x02, 0x0C, 0x01, 0xF0, 0x00,
};

// --------------------------------------------------------------------------
//  Map WMO weather code → icon + width
// --------------------------------------------------------------------------
inline WeatherIconInfo getWeatherIcon(uint8_t wmoCode) {
    if (wmoCode <= 1)                           return { WEATHER_ICON_CLEAR,  15 };
    if (wmoCode <= 3)                           return { WEATHER_ICON_CLOUDS, 17 };
    if (wmoCode == 45 || wmoCode == 48)         return { WEATHER_ICON_MIST,   15 };
    if ((wmoCode >= 51 && wmoCode <= 67) ||
        (wmoCode >= 80 && wmoCode <= 82))       return { WEATHER_ICON_RAIN,   17 };
    if ((wmoCode >= 71 && wmoCode <= 77) ||
        wmoCode == 85 || wmoCode == 86)         return { WEATHER_ICON_SNOW,   16 };
    if (wmoCode == 95 || wmoCode == 96 ||
        wmoCode == 99)                          return { WEATHER_ICON_STORM,  17 };
    return { WEATHER_ICON_CLOUDS, 17 };
}

// --------------------------------------------------------------------------
//  Map WMO code → short condition string (≤ 13 chars at 6x13 = 78 px)
// --------------------------------------------------------------------------
inline const char* getWeatherCondition(uint8_t wmoCode) {
    if (wmoCode == 0)                           return "Clear Sky";
    if (wmoCode == 1)                           return "Mainly Clear";
    if (wmoCode == 2)                           return "Partly Cloudy";
    if (wmoCode == 3)                           return "Overcast";
    if (wmoCode == 45 || wmoCode == 48)         return "Fog";
    if (wmoCode >= 51 && wmoCode <= 55)         return "Drizzle";
    if (wmoCode >= 56 && wmoCode <= 57)         return "Frz. Drizzle";
    if (wmoCode >= 61 && wmoCode <= 65)         return "Rain";
    if (wmoCode >= 66 && wmoCode <= 67)         return "Frz. Rain";
    if (wmoCode >= 71 && wmoCode <= 75)         return "Snow";
    if (wmoCode == 77)                          return "Snow Grains";
    if (wmoCode >= 80 && wmoCode <= 82)         return "Rain Showers";
    if (wmoCode == 85 || wmoCode == 86)         return "Snow Showers";
    if (wmoCode == 95)                          return "Thunderstorm";
    if (wmoCode == 96 || wmoCode == 99)         return "Storm + Hail";
    return "Unknown";
}

#endif // WEATHER_ICONS_H

